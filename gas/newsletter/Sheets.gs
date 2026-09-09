/**
 * Stellize メルマガ配信ツール — スプレッドシートの読み書き
 *
 * 列は「名前」で引く（getCol）。列を入れ替えたり間に挿したりしても
 * 壊れないようにするため。ヘッダー行の文言だけは変えないこと。
 */

function ss()            { return SpreadsheetApp.getActive(); }
function sheet(name)     { return ss().getSheetByName(name) || ss().insertSheet(name); }
function nowStr()        { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'); }
function normEmail(e)    { return String(e == null ? '' : e).trim().toLowerCase(); }

/** シートのヘッダー行を読み、{列名: 0始まりの位置} を返す。 */
function headerMap(sh) {
  const last = sh.getLastColumn();
  if (last < 1) return {};
  const head = sh.getRange(1, 1, 1, last).getValues()[0];
  const map = {};
  head.forEach(function (h, i) { const k = String(h).trim(); if (k) map[k] = i; });
  return map;
}

/** データ行を「列名で引けるオブジェクト」の配列にする。row は実際の行番号。 */
function readRows(name) {
  const sh = sheet(name);
  if (sh.getLastRow() < 2) return [];
  const map = headerMap(sh);
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  return values.map(function (v, i) {
    const o = { _row: i + 2 };
    Object.keys(map).forEach(function (k) { o[k] = v[map[k]]; });
    return o;
  });
}

/** 1セルだけ書き換える。 */
function setCell(name, row, col, value) {
  const sh = sheet(name);
  const map = headerMap(sh);
  if (!(col in map)) return;
  sh.getRange(row, map[col] + 1).setValue(value);
}

/** 複数列をまとめて書き換える（1行分）。API呼び出しを減らすため。 */
function setCells(name, row, obj) {
  const sh = sheet(name);
  const map = headerMap(sh);
  Object.keys(obj).forEach(function (k) {
    if (k in map) sh.getRange(row, map[k] + 1).setValue(obj[k]);
  });
}

/** 末尾に1行足す。obj のキーはヘッダー名。 */
function appendRow(name, obj) {
  const sh = sheet(name);
  const map = headerMap(sh);
  const width = sh.getLastColumn();
  const row = new Array(width).fill('');
  Object.keys(obj).forEach(function (k) { if (k in map) row[map[k]] = obj[k]; });
  sh.appendRow(row);
}

/* ============================================================
   初期化：シートを作る
   ============================================================ */

/**
 * シートの定義。定数ではなく関数にしてある。
 * GASは全ファイルを1つのグローバルとして読むが、その順番は編集画面の並び順で決まる。
 * トップレベルで他ファイルの定数（SHEETS）を参照すると、順番次第で読み込みに失敗する。
 */
function sheetDefs() { return [
  {
    name: SHEETS.settings,
    header: ['項目', '値', '説明'],
    widths: [180, 420, 460],
    frozen: 1,
  },
  {
    name: SHEETS.subscribers,
    header: ['メールアドレス', '宛名', '法人名', '事業所名', '都道府県', 'セグメント', '状態', '取得元', '許諾の根拠', '登録日', '最終送信日', '送信回数', 'メモ'],
    widths: [230, 130, 180, 200, 90, 120, 90, 140, 260, 110, 110, 80, 240],
    frozen: 1,
  },
  {
    name: SHEETS.drafts,
    header: ['号ID', '状態', 'テンプレート', '枠', 'セグメント', '件名', 'プリヘッダー', '大見出し', '本文', '対象数', '送信済', '失敗', '送信開始', '送信完了'],
    widths: [110, 90, 130, 150, 120, 320, 260, 300, 620, 70, 70, 60, 140, 140],
    frozen: 1,
  },
  {
    name: SHEETS.queue,
    header: ['号ID', 'メールアドレス', '宛名', '法人名', '事業所名', '状態', '処理日時', '詳細'],
    widths: [110, 230, 130, 180, 200, 80, 140, 300],
    frozen: 1,
    hidden: true,
  },
  {
    name: SHEETS.memos,
    header: ['受付日時', 'メモ', '枠の候補', '状態', '使った号ID', '元'],
    widths: [140, 560, 150, 90, 110, 110],
    frozen: 1,
  },
  {
    name: SHEETS.log,
    header: ['日時', '号ID', 'メールアドレス', '結果', '詳細'],
    widths: [140, 110, 230, 90, 420],
    frozen: 1,
  },
  {
    name: SHEETS.suppress,
    header: ['メールアドレス', '停止日時', '経路', '号ID', '理由'],
    widths: [230, 140, 110, 110, 320],
    frozen: 1,
  },
]; }

/**
 * 初回セットアップ。メニューから実行する。
 * 何度実行しても壊れない（既にあるシートはヘッダーだけ整える）。
 */
function setupSheets() {
  const book = ss();

  sheetDefs().forEach(function (d) {
    let sh = book.getSheetByName(d.name);
    if (!sh) sh = book.insertSheet(d.name);

    sh.getRange(1, 1, 1, d.header.length).setValues([d.header])
      .setFontWeight('bold').setBackground('#1F2A54').setFontColor('#FFFFFF')
      .setVerticalAlignment('middle');
    sh.setRowHeight(1, 30);
    if (d.frozen) sh.setFrozenRows(d.frozen);
    d.widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    if (d.hidden) sh.hideSheet();
  });

  // 設定シートの初期値。既に値が入っている項目は上書きしない。
  const st = sheet(SHEETS.settings);
  const existing = {};
  if (st.getLastRow() > 1) {
    st.getRange(2, 1, st.getLastRow() - 1, 2).getValues()
      .forEach(function (r) { if (String(r[0]).trim()) existing[String(r[0]).trim()] = r[1]; });
  }
  const rows = SETTING_DEFS.map(function (d) {
    const cur = Object.prototype.hasOwnProperty.call(existing, d.key) && String(existing[d.key]).trim() !== ''
      ? existing[d.key] : d.def;
    return [d.key, cur, (d.required ? '【必須】' : '') + d.help];
  });
  if (st.getLastRow() > 1) st.getRange(2, 1, st.getLastRow() - 1, 3).clearContent();
  st.getRange(2, 1, rows.length, 3).setValues(rows);
  st.getRange(2, 3, rows.length, 1).setFontColor('#8A8378').setFontSize(9);
  st.getRange(2, 1, rows.length, 3).setVerticalAlignment('middle').setWrap(true);

  // 購読者シートの入力規則。状態を手で打ち間違えると抽出から漏れるため。
  const sub = sheet(SHEETS.subscribers);
  const stateRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['購読中', '停止', '保留', 'エラー'], true).setAllowInvalid(false).build();
  sub.getRange(2, headerMap(sub)['状態'] + 1, 2000, 1).setDataValidation(stateRule);

  const dr = sheet(SHEETS.drafts);
  const draftRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['下書き', '送信待ち', '送信中', '送信済', '中止'], true).setAllowInvalid(false).build();
  dr.getRange(2, headerMap(dr)['状態'] + 1, 500, 1).setDataValidation(draftRule);
  const tplRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(TEMPLATE_THEMES), true).setAllowInvalid(false).build();
  dr.getRange(2, headerMap(dr)['テンプレート'] + 1, 500, 1).setDataValidation(tplRule);
  dr.getRange(2, headerMap(dr)['本文'] + 1, 500, 1).setWrap(false);
  // 日刊の枠。曜日で固定してあるので、選ぶだけで済むようにする
  const frameRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(DAILY_FRAMES.map(function (f) { return f.key; }), true).setAllowInvalid(true).build();
  dr.getRange(2, headerMap(dr)['枠'] + 1, 500, 1).setDataValidation(frameRule);

  const mm = sheet(SHEETS.memos);
  mm.getRange(2, headerMap(mm)['枠の候補'] + 1, 1000, 1).setDataValidation(frameRule);
  mm.getRange(2, headerMap(mm)['状態'] + 1, 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['未使用', '採用', '没'], true).setAllowInvalid(false).build());
  mm.getRange(2, headerMap(mm)['メモ'] + 1, 1000, 1).setWrap(true);

  // 空の「シート1」が残っていたら消す
  const blank = book.getSheetByName('シート1') || book.getSheetByName('Sheet1');
  if (blank && book.getSheets().length > 1 && blank.getLastRow() === 0) book.deleteSheet(blank);

  _cfgCache = null;
  secretKey();  // 署名鍵をここで作っておく
  return '完了しました。「設定」シートの必須項目を埋めてください。';
}

/* ============================================================
   購読者
   ============================================================ */

/** 配信停止されているアドレスの集合。 */
function suppressedSet() {
  const s = {};
  readRows(SHEETS.suppress).forEach(function (r) { s[normEmail(r['メールアドレス'])] = true; });
  return s;
}

/**
 * ある号の宛先を決める。
 * セグメントが空欄なら「購読中の全員」。カンマ区切りで複数指定できる。
 * 配信停止・状態が購読中以外・重複アドレスは、ここで確実に落とす。
 */
function recipientsFor(segment) {
  const want = String(segment == null ? '' : segment).split(/[,、]/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
  const stopped = suppressedSet();
  const seen = {};
  const out = [];

  readRows(SHEETS.subscribers).forEach(function (r) {
    const email = normEmail(r['メールアドレス']);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    if (String(r['状態']).trim() !== '購読中') return;
    if (stopped[email]) return;
    if (seen[email]) return;
    if (want.length) {
      const segs = String(r['セグメント']).split(/[,、]/).map(function (s) { return s.trim(); });
      if (!want.some(function (w) { return segs.indexOf(w) >= 0; })) return;
    }
    seen[email] = true;
    out.push({
      row: r._row,
      email: email,
      宛名: String(r['宛名'] || '').trim(),
      法人名: String(r['法人名'] || '').trim(),
      事業所名: String(r['事業所名'] || '').trim(),
      都道府県: String(r['都道府県'] || '').trim(),
    });
  });
  return out;
}

/** 配信ログに1行残す。何が起きたかを後から追えるようにする。 */
function log(issue, email, result, detail) {
  appendRow(SHEETS.log, {
    '日時': nowStr(), '号ID': issue || '', 'メールアドレス': email || '',
    '結果': result, '詳細': String(detail == null ? '' : detail).slice(0, 500),
  });
}
