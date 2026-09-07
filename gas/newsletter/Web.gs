/**
 * Stellize メルマガ配信ツール — Webアプリ（配信停止・購読登録・ブラウザ表示）
 *
 * デプロイ設定は「実行するユーザー: 自分」「アクセス: 全員」。
 * メールの受信者は Google にログインしていないので、ここは必ず「全員」にする。
 *
 * 配信停止は2段階にしている（リンクを踏む → ボタンを押す）。
 * 迷惑メール対策のスキャナがメール内のリンクを機械的に開くことがあり、
 * 1クリックで確定にすると、本人の意思と関係なく止まってしまうため。
 */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.a) {
      case 'u': return unsubscribePage(p);
      case 's': return confirmSubscribePage(p);
      case 'v': return webViewPage(p);
      default:  return page('Stellize', '<p>このページは、Stellizeからのメール内のリンクからご利用ください。</p>');
    }
  } catch (err) {
    return page('エラー', '<p>処理できませんでした。お手数ですが ' +
      '<a href="' + esc(cfg()['お問い合わせURL']) + '">お問い合わせフォーム</a> よりご連絡ください。</p>');
  }
}

/**
 * サイトの購読フォームからの登録受け口（任意）。
 * いきなり購読中にはせず「保留」で入れ、本人が確認メールのリンクを
 * 押してはじめて購読中になる（ダブルオプトイン）。
 * 他人のアドレスを勝手に登録されるのを防ぐため。
 */
function doPost(e) {
  const p = (e && e.parameter) || {};
  const out = function (o) {
    return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  };
  try {
    if (p.website) return out({ ok: true });          // ハニーポット（ボット除け）
    const email = normEmail(p.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out({ ok: false, error: 'invalid_email' });

    const existing = readRows(SHEETS.subscribers).filter(function (r) { return normEmail(r['メールアドレス']) === email; })[0];
    if (existing && String(existing['状態']).trim() === '購読中') return out({ ok: true, already: true });

    const rec = {
      'メールアドレス': email,
      '宛名': String(p.name || '').trim(),
      '法人名': String(p.corp || '').trim(),
      '事業所名': String(p.office || '').trim(),
      'セグメント': String(p.segment || '').trim(),
      '状態': '保留',
      '取得元': 'Webフォーム',
      '許諾の根拠': '本人がフォームから登録（確認メール未応答）',
      '登録日': nowStr(),
      '送信回数': 0,
    };
    if (existing) setCells(SHEETS.subscribers, existing._row, rec);
    else appendRow(SHEETS.subscribers, rec);

    const url = cfg()['WebアプリURL'] + '?a=s&e=' + encodeURIComponent(email) + '&s=' + signEmail(email);
    MailApp.sendEmail({
      to: email,
      subject: '【' + cfg()['会社名'] + '】メール配信のご登録確認',
      name: cfg()['差出人名'],
      replyTo: cfg()['返信先'],
      body: 'メール配信のご登録ありがとうございます。\n\n'
        + '下記のURLを開くと登録が完了します。\n' + url + '\n\n'
        + 'このメールに心当たりがない場合は、何もせずに破棄してください。登録は完了しません。\n\n'
        + '─────────\n' + cfg()['会社名'] + '\n' + cfg()['住所'] + '\n' + cfg()['サイトURL'] + '\n',
    });
    log('', email, '登録受付', 'ダブルオプトインの確認メールを送信');
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err.message || err) });
  }
}

/* ============================================================
   画面
   ============================================================ */

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** サイトのトーンに合わせた簡素なページ。メールの受信者が見る唯一の画面。 */
function page(title, bodyHtml) {
  const c = cfg();
  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + ' | Stellize</title><style>' +
    'body{margin:0;background:#F0EBE3;font-family:"Hiragino Kaku Gothic ProN","Yu Gothic Medium",Meiryo,sans-serif;color:#3A3A3A;line-height:2}' +
    '.box{max-width:520px;margin:8vh auto;padding:40px 36px;background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(31,42,84,.07)}' +
    'h1{margin:0 0 20px;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:21px;font-weight:600;color:#1F2A54;line-height:1.6}' +
    'p{margin:0 0 16px;font-size:14px}' +
    '.btn{display:inline-block;margin:12px 0 4px;padding:14px 32px;background:#1F2A54;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600}' +
    '.sub{margin-top:28px;padding-top:20px;border-top:1px solid #EDE7DD;font-size:11px;color:#8A8378;line-height:1.9}' +
    'a{color:#5A4C7D}</style></head><body><div class="box"><h1>' + esc(title) + '</h1>' + bodyHtml +
    '<div class="sub">' + esc(c['会社名']) + '<br>' + esc(c['住所']) +
    '<br><a href="' + esc(c['サイトURL']) + '">' + esc(c['サイトURL']) + '</a></div></div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title + ' | Stellize')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- 配信停止 ---------- */

function unsubscribePage(p) {
  const email = normEmail(p.e);
  if (!verifyEmail(email, p.s)) {
    return page('リンクを確認できませんでした',
      '<p>お手数ですが、最新のメールに記載された配信停止リンクからお試しください。' +
      'うまくいかない場合は <a href="' + esc(cfg()['お問い合わせURL']) + '">お問い合わせフォーム</a> よりご連絡ください。</p>');
  }

  // 1段階目：確認だけ
  if (p.c !== '1') {
    const go = cfg()['WebアプリURL'] + '?a=u&e=' + encodeURIComponent(email) + '&s=' + encodeURIComponent(p.s)
      + (p.i ? '&i=' + encodeURIComponent(p.i) : '') + '&c=1';
    return page('配信を停止しますか',
      '<p><strong>' + esc(email) + '</strong> 宛のメール配信を停止します。</p>' +
      '<p>下のボタンを押すと、以後このアドレスにはお送りしません。</p>' +
      '<a class="btn" href="' + esc(go) + '">配信を停止する</a>');
  }

  // 2段階目：実際に止める
  const already = readRows(SHEETS.suppress).some(function (r) { return normEmail(r['メールアドレス']) === email; });
  if (!already) {
    appendRow(SHEETS.suppress, {
      'メールアドレス': email, '停止日時': nowStr(), '経路': 'メール内リンク',
      '号ID': String(p.i || ''), '理由': '受信者本人による停止',
    });
  }
  readRows(SHEETS.subscribers).forEach(function (r) {
    if (normEmail(r['メールアドレス']) === email) setCell(SHEETS.subscribers, r._row, '状態', '停止');
  });
  log('', email, '配信停止', 'メール内リンクから');

  return page('配信を停止しました',
    '<p><strong>' + esc(email) + '</strong> 宛の配信を停止しました。今後このアドレスにメールをお送りすることはありません。</p>' +
    '<p>これまでお読みいただき、ありがとうございました。</p>');
}

/* ---------- 購読の確認（ダブルオプトイン） ---------- */

function confirmSubscribePage(p) {
  const email = normEmail(p.e);
  if (!verifyEmail(email, p.s)) return page('リンクを確認できませんでした', '<p>お手数ですが、確認メールのリンクをもう一度お試しください。</p>');

  let found = false;
  readRows(SHEETS.subscribers).forEach(function (r) {
    if (normEmail(r['メールアドレス']) !== email) return;
    found = true;
    setCells(SHEETS.subscribers, r._row, {
      '状態': '購読中',
      '許諾の根拠': '本人が確認メールのリンクで同意（' + nowStr() + '）',
    });
  });
  if (!found) return page('登録が見つかりませんでした', '<p>お手数ですが、もう一度フォームからご登録ください。</p>');

  log('', email, '購読開始', 'ダブルオプトイン完了');
  return page('ご登録が完了しました',
    '<p><strong>' + esc(email) + '</strong> でのメール配信登録が完了しました。</p>' +
    '<p>配信の停止は、いつでも各メールの末尾のリンクから行えます。</p>');
}

/* ---------- ブラウザで見る ---------- */

function webViewPage(p) {
  const draft = draftByIssue(String(p.c || ''));
  if (!draft) return page('お探しの号が見つかりません', '<p>URLをご確認ください。</p>');
  const built = campaignHtml(draft);
  // 宛先が分からないので、差し込みは一般的な値にし、
  // 配信停止リンクは unsubUrl() 側で問い合わせ先に落ちる
  const one = personalize(built, { email: '', 宛名: 'ご担当者', 法人名: '', 事業所名: '', 都道府県: '' });
  return HtmlService.createHtmlOutput(one.html).setTitle(String(draft['件名'] || 'Stellize'));
}
