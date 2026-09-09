/**
 * Stellize メルマガ配信ツール — 画面まわり
 *
 * スプレッドシートのメニューと、操作用のサイドバー。
 * 送信の判断に必要な数字（宛先数・本日の残枠・チェック結果）を
 * 押す前に全部見せる、という方針で組んでいる。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📧 メルマガ')
    .addItem('配信パネルを開く', 'showSidebar')
    .addSeparator()
    .addItem('購読者をまとめて取り込む', 'showImport')
    .addItem('新しい号の行を作る', 'newDraftRow')
    .addSeparator()
    .addItem('ネタ帳のURLと連携キーを表示', 'showKeys')
    .addItem('初期セットアップ（シートを整える）', 'runSetup')
    .addItem('連携キーを作り直す', 'rotateKeys')
    .addToUi();
}

function runSetup() {
  const msg = setupSheets();
  SpreadsheetApp.getUi().alert('初期セットアップ', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * スマホ用のネタ帳URLと、手元のClaudeが使う連携キーを見せる。
 * キーは画面に出すだけで、シートには書かない（シートを共有したときに漏れるため）。
 */
function showKeys() {
  const base = cfg()['WebアプリURL'];
  if (!base) {
    SpreadsheetApp.getUi().alert('先に「設定」シートの WebアプリURL を入れてください。');
    return;
  }
  const memoUrl = base + '?a=memo&k=' + encodeURIComponent(apiToken('memo'));
  const html = HtmlService.createHtmlOutput(
    '<div style="font:13px/1.9 -apple-system,\'Hiragino Kaku Gothic ProN\',sans-serif;padding:20px 22px;color:#3A3A3A">'
    + '<p style="margin:0 0 6px;font-weight:600;color:#1F2A54">スマホのネタ帳（ホーム画面に追加して使う）</p>'
    + '<textarea readonly style="width:100%;height:56px;font:11px/1.7 ui-monospace,monospace;padding:8px;'
    + 'border:1px solid #E2DACD;border-radius:6px" onclick="this.select()">' + esc(memoUrl) + '</textarea>'
    + '<p style="margin:6px 0 20px;font-size:11px;color:#8A8072">このURLは人に見せないでください。'
    + '漏れてもメモが増えるだけですが、キーを作り直したいときは「連携キーを作り直す」を実行します。</p>'
    + '<p style="margin:0 0 6px;font-weight:600;color:#1F2A54">連携キー（手元の設定ファイルにだけ置く）</p>'
    + '<textarea readonly style="width:100%;height:44px;font:11px/1.7 ui-monospace,monospace;padding:8px;'
    + 'border:1px solid #E2DACD;border-radius:6px" onclick="this.select()">'
    + esc(JSON.stringify({ webAppUrl: base, apiToken: apiToken('api') }, null, 2)) + '</textarea>'
    + '<p style="margin:6px 0 0;font-size:11px;color:#8A8072">プロジェクト直下の <code>.stellize-mail.json</code> に貼ります。'
    + 'このキーは原稿を積める強い権限なので、リポジトリには入れないでください（gitignore済み）。</p>'
    + '</div>').setWidth(560).setHeight(400);
  SpreadsheetApp.getUi().showModalDialog(html, '連携キー');
}

/** キーを作り直す。漏れたときや、担当が変わったときに使う。 */
function rotateKeys() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('連携キーを作り直す',
    '作り直すと、いまのネタ帳URLと手元の設定は使えなくなります。よろしいですか？', ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  PropertiesService.getScriptProperties().deleteProperty('MEMO_TOKEN');
  showKeys();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('メルマガ配信');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showImport() {
  const html = HtmlService.createHtmlOutputFromFile('Import').setWidth(620).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, '購読者をまとめて取り込む');
}

/** 原稿シートに、次の号IDを振った行を用意する。 */
function newDraftRow() {
  const sh = sheet(SHEETS.drafts);
  const rows = readRows(SHEETS.drafts);
  const nums = rows.map(function (r) { return Number(String(r['号ID']).replace(/\D/g, '')) || 0; });
  const next = 'vol' + String(Math.max.apply(null, [0].concat(nums)) + 1).padStart(3, '0');
  appendRow(SHEETS.drafts, {
    '号ID': next, '状態': '下書き', 'テンプレート': 'newsletter', 'セグメント': '',
    '件名': '', 'プリヘッダー': '', '大見出し': '', '本文': '', '送信済': 0, '失敗': 0,
  });
  sh.setActiveRange(sh.getRange(sh.getLastRow(), 1));
  SpreadsheetApp.getActive().toast(next + ' の行を作りました。件名と本文を書いてください。', 'メルマガ', 5);
}

/* ============================================================
   サイドバーから呼ばれる関数
   ============================================================ */

/** パネルを開いたときの状態一式。 */
function uiState() {
  const running = PropertiesService.getScriptProperties().getProperty(PROP_ISSUE) || '';
  const drafts = readRows(SHEETS.drafts)
    .filter(function (r) { return String(r['号ID']).trim(); })
    .map(function (r) {
      return {
        issue: String(r['号ID']).trim(),
        subject: String(r['件名'] || '（件名未記入）'),
        state: String(r['状態'] || '下書き'),
        sent: Number(r['送信済'] || 0),
        total: Number(r['対象数'] || 0),
        failed: Number(r['失敗'] || 0),
      };
    });
  return {
    drafts: drafts.reverse(),
    running: running,
    quota: MailApp.getRemainingDailyQuota(),
    sendable: sendableNow(),
    sentToday: sentToday(0),
    me: Session.getEffectiveUser().getEmail(),
    themes: Object.keys(TEMPLATE_THEMES).map(function (k) {
      return { key: k, label: TEMPLATE_THEMES[k].label };
    }),
  };
}

/** 送信前チェック。宛先数もここで数える。 */
function uiCheck(issue) {
  const draft = draftByIssue(issue);
  const v = validateDraft(draft);
  let count = 0, segment = '';
  if (draft) {
    segment = String(draft['セグメント'] || '（購読中の全員）');
    try { count = recipientsFor(draft['セグメント']).length; } catch (e) { /* 集計できなくてもチェックは返す */ }
  }
  if (draft && count === 0) v.errors.push('宛先が0件です。購読者シートの「状態」と「セグメント」を確認してください');
  return { errors: v.errors, warns: v.warns, count: count, segment: segment };
}

/** プレビューを別窓で開く。実際に送るHTMLそのものを出す。 */
function uiPreview(issue) {
  const draft = draftByIssue(issue);
  if (!draft) throw new Error('原稿が見つかりません。');
  const built = campaignHtml(draft);
  const one = personalize(built, {
    email: 'preview@example.com', 宛名: '（宛名が入ります）',
    法人名: '社会福祉法人サンプル会', 事業所名: 'サンプル就労支援センター', 都道府県: '神奈川県',
  });
  const wrapper = HtmlService.createHtmlOutput(
    '<div style="font:12px/1.8 sans-serif;color:#6B6B6B;padding:6px 10px;background:#F5F1EB;border-bottom:1px solid #E2DACD">'
    + '件名： <strong style="color:#1F2A54">' + esc(one.subject) + '</strong></div>'
    + '<iframe style="width:100%;height:calc(100% - 34px);border:0" srcdoc="' + esc(one.html) + '"></iframe>'
  ).setWidth(760).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(wrapper, 'プレビュー — ' + issue);
  return 'ok';
}

/** テキスト版だけを見る。HTMLを読めない環境での見え方の確認用。 */
function uiPreviewText(issue) {
  const draft = draftByIssue(issue);
  if (!draft) throw new Error('原稿が見つかりません。');
  const built = campaignHtml(draft);
  const one = personalize(built, {
    email: 'preview@example.com', 宛名: '（宛名が入ります）',
    法人名: '', 事業所名: 'サンプル就労支援センター', 都道府県: '',
  });
  const out = HtmlService.createHtmlOutput(
    '<pre style="font:13px/1.9 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;padding:20px">'
    + esc(one.text) + '</pre>'
  ).setWidth(680).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(out, 'テキスト版 — ' + issue);
  return 'ok';
}

/* ============================================================
   購読者の取り込み
   ============================================================ */

/**
 * CSV / TSV を貼り付けて購読者に足す。
 * 1行目はヘッダー。「メールアドレス」列は必須。
 * 既にあるアドレスは上書きせず、件数だけ返す（手作業の修正を消さないため）。
 */
function uiImport(text, opts) {
  opts = opts || {};
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim(); });
  if (lines.length < 2) throw new Error('1行目にヘッダー、2行目以降にデータを貼ってください。');

  const sep = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
  const split = function (line) {
    if (sep === '\t') return line.split('\t');
    // カンマ区切りは引用符に対応する
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const head = split(lines[0]).map(function (h) { return h.replace(/^﻿/, '').trim(); });
  const idx = {};
  head.forEach(function (h, i) { idx[h] = i; });

  // よくある別名を吸収する
  const pick = function (cols, names) {
    for (let i = 0; i < names.length; i++) if (names[i] in idx) return String(cols[idx[names[i]]] || '').trim();
    return '';
  };
  if (!head.some(function (h) { return ['メールアドレス', 'email', 'Email', 'E-mail', 'mail'].indexOf(h) >= 0; })) {
    throw new Error('「メールアドレス」列が見つかりません。1行目のヘッダーを確認してください。');
  }

  const existing = {};
  readRows(SHEETS.subscribers).forEach(function (r) { existing[normEmail(r['メールアドレス'])] = true; });
  const stopped = suppressedSet();

  const sh = sheet(SHEETS.subscribers);
  const map = headerMap(sh);
  const width = sh.getLastColumn();
  const add = [];
  let dup = 0, bad = 0, sup = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = split(lines[i]);
    const email = normEmail(pick(cols, ['メールアドレス', 'email', 'Email', 'E-mail', 'mail']));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { bad++; continue; }
    // 停止の判定を先に置く。購読者シートに残っている相手でも、
    // 「重複」ではなく「配信停止済み」と数えたほうが、あとで見て意味が分かる
    if (stopped[email]) { sup++; continue; }   // 一度止めた相手を取り込みで復活させない
    if (existing[email]) { dup++; continue; }
    existing[email] = true;

    const row = new Array(width).fill('');
    row[map['メールアドレス']] = email;
    row[map['宛名']]       = pick(cols, ['宛名', '担当者名', '氏名', 'name']);
    row[map['法人名']]     = pick(cols, ['法人名', '法人', 'corp']);
    row[map['事業所名']]   = pick(cols, ['事業所名', '事業所', '施設名', 'office']);
    row[map['都道府県']]   = pick(cols, ['都道府県', '県', 'prefecture']);
    row[map['セグメント']] = opts.segment || pick(cols, ['セグメント', 'segment']);
    row[map['状態']]       = opts.state || '購読中';
    row[map['取得元']]     = opts.source || 'CSV取り込み';
    row[map['許諾の根拠']] = opts.basis || '';
    row[map['登録日']]     = nowStr();
    row[map['送信回数']]   = 0;
    add.push(row);
  }

  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, width).setValues(add);
  log('', '', '取り込み', '追加 ' + add.length + ' / 重複 ' + dup + ' / 停止済 ' + sup + ' / 不正 ' + bad);
  return { added: add.length, dup: dup, suppressed: sup, invalid: bad };
}
