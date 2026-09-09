/**
 * GASのAPIをNode上で真似する最小限の実装。
 * 本物のスプレッドシートを作らずに、配信エンジンの筋道を確かめるためのもの。
 * 本番の挙動を保証するものではないが、「送る前に壊れていないか」は分かる。
 */
import crypto from 'node:crypto';

const noop = () => {};
/** setFontWeight などの見た目系メソッドは、すべて自分を返すだけにする */
function chainable(obj) {
  return new Proxy(obj, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return () => chainable(t);   // 未実装のメソッドは自分を返す
    },
  });
}

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.hidden = false; }
  getName() { return this.name; }
  _ensure(r, c) {
    while (this.cells.length < r) this.cells.push([]);
    for (const row of this.cells) while (row.length < c) row.push('');
  }
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      if (this.cells[i].some((v) => v !== '' && v != null)) return i + 1;
    }
    return 0;
  }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return chainable({
      getValues() {
        sh._ensure(r + nr - 1, c + nc - 1);
        return Array.from({ length: nr }, (_, i) =>
          Array.from({ length: nc }, (_, j) => sh.cells[r - 1 + i][c - 1 + j] ?? ''));
      },
      setValues(v) {
        sh._ensure(r + nr - 1, c + nc - 1);
        v.forEach((row, i) => row.forEach((val, j) => { sh.cells[r - 1 + i][c - 1 + j] = val; }));
        return chainable(this);
      },
      setValue(val) { return this.setValues([[val]]); },
      clearContent() {
        sh._ensure(r + nr - 1, c + nc - 1);
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.cells[r - 1 + i][c - 1 + j] = '';
        return chainable(this);
      },
      setDataValidation() { return chainable(this); },
    });
  }
  appendRow(row) { this.cells.push([...row]); }
  deleteRow(r) { this.cells.splice(r - 1, 1); }
  hideSheet() { this.hidden = true; }
  setFrozenRows() {} setColumnWidth() {} setRowHeight() {} setActiveRange() {}
}

class FakeBook {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  toast() {}
}

export function makeGasGlobals() {
  const book = new FakeBook();
  const sent = [];
  const props = new Map();
  const triggers = [];
  let quota = 1500;

  const g = {
    console,
    SpreadsheetApp: {
      getActive: () => book,
      getActiveSpreadsheet: () => book,
      newDataValidation: () => chainable({ build: () => ({}) }),
      flush: noop,
      getUi: () => chainable({
        createMenu: () => chainable({ addItem: function () { return this; }, addSeparator: function () { return this; }, addToUi: noop }),
        alert: noop, showSidebar: noop, showModalDialog: noop,
        ButtonSet: { OK: 'OK' },
      }),
    },
    MailApp: {
      sendEmail: (o) => {
        if (!o.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) throw new Error('Invalid email: ' + o.to);
        sent.push(o); quota--;
      },
      getRemainingDailyQuota: () => quota,
    },
    Utilities: {
      // 本物は書式文字列に従う。日単位のキー（yyyyMMdd）と秒単位が
      // 混ざると送信枠の計算がずれるので、そこだけは真面目に真似る
      formatDate: (d, tz, fmt) => {
        const t = new Date(d);
        const p2 = (n) => String(n).padStart(2, '0');
        // 長いトークンから順に置換する（MM を先に処理しないと M が食ってしまう）
        const map = [
          ['yyyy', String(t.getFullYear())], ['MM', p2(t.getMonth() + 1)], ['dd', p2(t.getDate())],
          ['HH', p2(t.getHours())], ['mm', p2(t.getMinutes())], ['ss', p2(t.getSeconds())],
          ['M', String(t.getMonth() + 1)], ['d', String(t.getDate())],
        ];
        let out = '', rest = String(fmt || 'yyyy-MM-dd HH:mm:ss');
        outer: while (rest) {
          for (const [tok, val] of map) {
            if (rest.startsWith(tok)) { out += val; rest = rest.slice(tok.length); continue outer; }
          }
          out += rest[0]; rest = rest.slice(1);
        }
        return out;
      },
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (msg, key) => [...crypto.createHmac('sha256', key).update(msg).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      sleep: noop,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => chainable({
        timeBased: () => chainable({ everyMinutes: () => chainable({ create: () => { triggers.push({ getHandlerFunction: () => fn }); } }) }),
      }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'rei.stella1127@gmail.com' }) },
    HtmlService: {
      createHtmlOutput: (h) => chainable({ _html: h, getContent: () => h }),
      createHtmlOutputFromFile: () => chainable({}),
    },
    ContentService: {
      createTextOutput: (t) => chainable({ _text: t, getContent: () => t }),
      MimeType: { JSON: 'json', TEXT: 'text' },
    },
  };
  return { g, book, sent, props, triggers, setQuota: (n) => { quota = n; } };
}
