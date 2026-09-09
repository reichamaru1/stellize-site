/**
 * Stellize メルマガ配信ツール — 外部連携の受け口
 *
 * 「毎朝、手元のClaudeがメモを取りに来て、下書きを原稿シートに積む」ための口。
 * Googleの認証（OAuth）は使わない。Webアプリは「アクセス: 全員」で公開する必要があるので、
 * 代わりに合言葉（連携キー）を必須にしている。詳しくは Config.gs の apiToken() を参照。
 *
 * すべて POST で受ける。GETのクエリに合言葉を載せると、
 * 履歴やログに残ってしまうため。
 *
 *   POST { api:'status',  token }                      … 疎通確認。今日の枠と直近の号を返す
 *   POST { api:'memos',   token, limit? }              … 未使用のメモを読む
 *   POST { api:'memo',    token, text, frame? }        … メモを1件足す（memoキーでも可）
 *   POST { api:'draft',   token, ... }                 … 原稿シートに下書きを積む
 *   POST { api:'usedMemo',token, rows[], issue, state? }… メモを採用済み／没にする
 */

/** APIの入口。Web.gs の doPost から呼ばれる。 */
function apiHandle(body) {
  const op = String(body.api || '');
  // メモを足す口だけは、権限の弱い memo キーでも通す
  const kind = (op === 'memo') ? 'memo' : 'api';
  if (!tokenOk(body.token, kind) && !(op === 'memo' && tokenOk(body.token, 'api'))) {
    return { ok: false, error: 'unauthorized' };
  }

  switch (op) {
    case 'status':   return apiStatus();
    case 'memos':    return apiMemos(body);
    case 'memo':     return apiAddMemo(body);
    case 'draft':    return apiAddDraft(body);
    case 'usedMemo': return apiMarkMemos(body);
    default:         return { ok: false, error: 'unknown api: ' + op };
  }
}

/* ------------------------------------------------------------
   疎通確認
   ------------------------------------------------------------ */

function apiStatus() {
  const now = new Date();
  const frame = slzFrameForDay(now.getDay());
  const drafts = readRows(SHEETS.drafts).filter(function (r) { return String(r['号ID']).trim(); });
  const memos = readRows(SHEETS.memos).filter(function (r) { return String(r['状態']).trim() === '未使用'; });

  return {
    ok: true,
    today: dateline(now),
    // 土日は枠が無い。書かない日として扱う
    frame: frame ? { key: frame.key, target: frame.target, note: frame.note, wants: frame.wants } : null,
    frames: DAILY_FRAMES.map(function (f) { return { key: f.key, days: f.days, target: f.target, note: f.note }; }),
    unusedMemos: memos.length,
    subscribers: recipientsFor('').length,
    recent: drafts.slice(-8).reverse().map(function (r) {
      return {
        issue: String(r['号ID']), state: String(r['状態']), template: String(r['テンプレート']),
        frame: String(r['枠'] || ''), subject: String(r['件名'] || ''),
      };
    }),
  };
}

/* ------------------------------------------------------------
   ネタ帳
   ------------------------------------------------------------ */

function apiMemos(body) {
  const limit = Number(body.limit || 30);
  const rows = readRows(SHEETS.memos)
    .filter(function (r) { return String(r['状態']).trim() === '未使用' && String(r['メモ']).trim(); })
    .slice(0, limit)
    .map(function (r) {
      return {
        row: r._row,
        at: String(r['受付日時'] || ''),
        text: String(r['メモ']),
        frame: String(r['枠の候補'] || ''),
      };
    });
  return { ok: true, memos: rows };
}

function apiAddMemo(body) {
  const text = String(body.text || '').trim();
  if (!text) return { ok: false, error: 'empty' };
  appendRow(SHEETS.memos, {
    '受付日時': nowStr(),
    'メモ': text.slice(0, 2000),
    '枠の候補': String(body.frame || '').trim(),
    '状態': '未使用',
    '元': String(body.from || 'メモ帳'),
  });
  return { ok: true };
}

/** 使ったメモに印をつける。同じネタで二度書かないようにするため。 */
function apiMarkMemos(body) {
  const rows = body.rows || [];
  const state = String(body.state || '採用');
  const sh = sheet(SHEETS.memos);
  const map = headerMap(sh);
  let n = 0;
  rows.forEach(function (r) {
    const row = Number(r);
    if (!(row > 1) || row > sh.getLastRow()) return;
    sh.getRange(row, map['状態'] + 1).setValue(state);
    if (body.issue) sh.getRange(row, map['使った号ID'] + 1).setValue(String(body.issue));
    n++;
  });
  return { ok: true, updated: n };
}

/* ------------------------------------------------------------
   下書きを積む
   ------------------------------------------------------------ */

/**
 * 原稿シートに1行足す。状態は必ず「下書き」。
 * ここから勝手に送ることは絶対にしない（送信は人が配信パネルで押す）。
 */
function apiAddDraft(body) {
  const template = String(body.template || 'daily').trim();
  if (!TEMPLATE_THEMES[template]) return { ok: false, error: 'unknown template: ' + template };

  const issue = String(body.issue || '').trim() || nextIssueId(template);
  if (draftByIssue(issue)) return { ok: false, error: 'すでに同じ号IDがあります: ' + issue };

  const rec = {
    '号ID': issue,
    '状態': '下書き',
    'テンプレート': template,
    '枠': String(body.frame || '').trim(),
    'セグメント': String(body.segment || '').trim(),
    '件名': String(body.subject || '').trim(),
    'プリヘッダー': String(body.preheader || '').trim(),
    '大見出し': String(body.title || body.subject || '').trim(),
    '本文': String(body.body || ''),
    '送信済': 0, '失敗': 0,
  };
  appendRow(SHEETS.drafts, rec);

  if (body.memoRows && body.memoRows.length) {
    apiMarkMemos({ rows: body.memoRows, issue: issue, state: '採用' });
  }

  // 書いた側がその場で直せるように、チェック結果を返す
  const draft = draftByIssue(issue);
  const v = validateDraft(draft);
  const voice = template === 'daily'
    ? slzVoiceCheck({ body: rec['本文'], title: rec['大見出し'], subject: rec['件名'], frame: rec['枠'] })
    : [];

  log(issue, '', '下書き投入', '外部から積みました（' + (body.from || 'api') + '）');
  return { ok: true, issue: issue, errors: v.errors, warns: v.warns, voice: voice };
}

/** 号IDを決める。日刊は日付、それ以外は連番。 */
function nextIssueId(template) {
  if (template === 'daily') {
    const base = 'd' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    let id = base, n = 1;
    while (draftByIssue(id)) { id = base + '-' + (++n); }   // 同じ日に2本書くことはある
    return id;
  }
  const nums = readRows(SHEETS.drafts).map(function (r) {
    const m = String(r['号ID']).match(/^vol(\d+)$/);
    return m ? Number(m[1]) : 0;
  });
  return 'vol' + String(Math.max.apply(null, [0].concat(nums)) + 1).padStart(3, '0');
}

/* ------------------------------------------------------------
   スマホから使うメモ帳の画面

   ホーム画面に追加して使う想定。URLに memo キーが入るので、
   このURLは人に見せない。漏れてもメモが増えるだけで、
   購読者や原稿には触れない（キーを2本に分けている理由）。
   ------------------------------------------------------------ */

function memoPage(k) {
  if (!tokenOk(k, 'memo') && !tokenOk(k, 'api')) {
    return page('開けませんでした', '<p>メモ帳のURLをご確認ください。</p>');
  }
  const frame = slzFrameForDay(new Date().getDay());
  const opts = DAILY_FRAMES.map(function (f) {
    return '<option value="' + esc(f.key) + '"' + (frame && frame.key === f.key ? ' selected' : '') + '>' + esc(f.key) + '</option>';
  }).join('');

  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>ネタ帳 | Stellize</title><style>' +
    'body{margin:0;background:#F2EDE5;font-family:-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;color:#3A3A3A}' +
    '.b{max-width:520px;margin:0 auto;padding:22px 18px 40px}' +
    'h1{margin:0 0 4px;font-family:"Hiragino Mincho ProN",serif;font-size:17px;font-weight:600;letter-spacing:.08em;color:#41564C}' +
    'p.s{margin:0 0 16px;font-size:12px;line-height:1.8;color:#8A8072}' +
    'textarea{width:100%;box-sizing:border-box;height:190px;padding:14px;font:16px/1.85 inherit;' +
    'border:1px solid #DDD5C8;border-radius:10px;background:#fff;-webkit-appearance:none}' +
    'select{width:100%;box-sizing:border-box;margin-top:10px;padding:12px;font-size:15px;font-family:inherit;' +
    'border:1px solid #DDD5C8;border-radius:10px;background:#fff}' +
    'button{width:100%;margin-top:14px;padding:16px;font:600 16px inherit;color:#fff;background:#41564C;' +
    'border:0;border-radius:10px;-webkit-appearance:none}' +
    'button:disabled{opacity:.45}' +
    '#m{margin-top:14px;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.8;display:none}' +
    '.ok{background:#EDF2F0;color:#3E5A4C}.ng{background:#FBEFF3;color:#8A3A54}' +
    '.t{margin-top:26px;padding-top:16px;border-top:1px solid #E2DACD;font-size:11.5px;line-height:1.9;color:#9A9184}' +
    '</style></head><body><div class="b">' +
    '<h1>ネタ帳</h1>' +
    '<p class="s">見たこと・言われた言葉を、そのまま1行で。整えなくて大丈夫です。</p>' +
    '<textarea id="t" placeholder="例）A事業所、クッキーの袋詰めしてる人が「これ、私が作ったって書いていいんですか」って聞いてきた" autofocus></textarea>' +
    '<select id="f"><option value="">枠はおまかせ</option>' + opts + '</select>' +
    '<button id="b" onclick="go()">残す</button>' +
    '<div id="m"></div>' +
    '<div class="t">言われた言葉は、要約せずそのまま書き写すほど後で使えます。<br>' +
    '固有名詞（事業所名・お名前）は、伏せるか記号で構いません。</div>' +
    '</div><script>' +
    'function go(){' +
    ' var t=document.getElementById("t").value.trim();' +
    ' if(!t){msg("ng","何か書いてください。");return}' +
    ' document.getElementById("b").disabled=true; msg("ok","残しています…");' +
    ' google.script.run.withSuccessHandler(function(r){' +
    '   document.getElementById("b").disabled=false;' +
    '   if(r&&r.ok){document.getElementById("t").value="";msg("ok","残しました。")}' +
    '   else{msg("ng","残せませんでした。")}' +
    ' }).withFailureHandler(function(e){' +
    '   document.getElementById("b").disabled=false; msg("ng",e.message);' +
    ' }).addMemoFromPage(' + JSON.stringify(String(k)) + ',t,document.getElementById("f").value);' +
    '}' +
    'function msg(c,s){var m=document.getElementById("m");m.className=c;m.textContent=s;m.style.display="block"}' +
    '<\/script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('ネタ帳 | Stellize')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** メモ帳の画面から呼ばれる。合言葉はここでも必ず見る。 */
function addMemoFromPage(k, text, frame) {
  if (!tokenOk(k, 'memo') && !tokenOk(k, 'api')) return { ok: false, error: 'unauthorized' };
  return apiAddMemo({ text: text, frame: frame, from: 'スマホ' });
}
