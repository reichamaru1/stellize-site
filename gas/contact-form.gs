/**
 * Stellize お問い合わせフォーム受信スクリプト（Google Apps Script）
 *
 * できること:
 *   1. contact.html からの送信をスプレッドシートに1行追記（台帳管理）
 *   2. 管理者（ADMIN_EMAIL）へ通知メールを送信
 *   3. 送信者へ自動返信メール（入力内容の控え付き）を送信
 *
 * 設置方法は同フォルダの SETUP.md を参照。
 * このスクリプトは「スプレッドシートに紐づく（コンテナバインド）」前提です。
 */

// ====== 設定 ======
var ADMIN_EMAIL = 'rei.stella1127@gmail.com';   // 通知の宛先
var SHEET_NAME  = 'お問い合わせ';                // 記録先シート名（無ければ自動作成）
var SITE_NAME   = 'Stellize';

// スプレッドシートの列（この順で記録される）
var HEADERS = [
  '受信日時',
  'お名前',
  '施設名・団体名',
  'メールアドレス',
  '電話番号',
  'お問い合わせ種別',
  'どちらで知ったか',
  'ご紹介者名',
  'お問い合わせ内容',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  '送信元ページ'
];

// ====== 受信（フォームからのPOST） ======
function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // ボット対策（ハニーポット）: 隠しフィールドが埋まっていたら黙って成功を返す
    if (p.website) {
      return jsonResponse({ ok: true });
    }

    // 必須チェック
    var name = (p.name || '').trim();
    var email = (p.email || '').trim();
    var message = (p.message || '').trim();
    if (!name || !email || !message) {
      return jsonResponse({ ok: false, error: 'required' });
    }

    var row = [
      new Date(),
      name,
      p.organization || '',
      email,
      p.phone || '',
      p['inquiry-type'] || '',
      p['referral-source'] || '',
      p['referrer-name'] || '',
      message,
      p.utm_source || '',
      p.utm_medium || '',
      p.utm_campaign || '',
      p.page_url || ''
    ];

    // 1. スプレッドシートへ追記（最優先。ここが成功すればデータは残る）
    appendToSheet(row);

    // 2. 管理者へ通知（失敗しても送信自体は成功扱いにする）
    try { notifyAdmin(p); } catch (err) { console.error('notifyAdmin failed: ' + err); }

    // 3. 送信者へ自動返信
    try { autoReply(p); } catch (err) { console.error('autoReply failed: ' + err); }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: 'server' });
  }
}

// 動作確認用（デプロイURLをブラウザで開くと表示される）
function doGet() {
  return ContentService.createTextOutput('Stellize contact endpoint: OK');
}

// ====== 内部処理 ======
function appendToSheet(row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow(row);
}

function notifyAdmin(p) {
  var subject = '【' + SITE_NAME + '】新しいお問い合わせ：' + (p.name || '(名前なし)') +
    (p.organization ? '（' + p.organization + '）' : '');

  var body =
    'ホームページから新しいお問い合わせが届きました。\n' +
    '（このメールは自動送信です）\n\n' +
    '■ お名前：' + (p.name || '') + '\n' +
    '■ 施設名・団体名：' + (p.organization || '（未記入）') + '\n' +
    '■ メール：' + (p.email || '') + '\n' +
    '■ 電話：' + (p.phone || '（未記入）') + '\n' +
    '■ 種別：' + (p['inquiry-type'] || '') + '\n' +
    '■ どちらで知ったか：' + (p['referral-source'] || '（未選択）') + '\n' +
    '■ ご紹介者名：' + (p['referrer-name'] || '（なし）') + '\n' +
    '■ 送信元ページ：' + (p.page_url || '') + '\n' +
    '----------------------------------------\n' +
    (p.message || '') + '\n' +
    '----------------------------------------\n\n' +
    '▼ 返信するには、このメールにそのまま返信してください\n' +
    '（返信先は自動で ' + (p.email || '') + ' になります）\n';

  MailApp.sendEmail({
    to: ADMIN_EMAIL,
    replyTo: p.email || ADMIN_EMAIL,   // 通知に「返信」するとお客様宛になる
    subject: subject,
    body: body
  });
}

function autoReply(p) {
  if (!p.email) return;

  var subject = '【' + SITE_NAME + '】お問い合わせありがとうございます';

  var body =
    (p.name || '') + ' 様\n\n' +
    'この度は、' + SITE_NAME + 'へお問い合わせいただき誠にありがとうございます。\n' +
    '以下の内容で受け付けいたしました。\n\n' +
    '担当者より3営業日以内にご連絡いたしますので、\n' +
    '今しばらくお待ちくださいませ。\n\n' +
    '＝＝＝＝＝ ご入力内容の控え ＝＝＝＝＝\n' +
    '■ お名前：' + (p.name || '') + '\n' +
    '■ 施設名・団体名：' + (p.organization || '（未記入）') + '\n' +
    '■ お問い合わせ種別：' + (p['inquiry-type'] || '') + '\n' +
    '■ お問い合わせ内容：\n' + (p.message || '') + '\n' +
    '＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝\n\n' +
    '※ このメールは自動送信です。心当たりのない場合は破棄してください。\n' +
    '※ ご返信いただいても差し支えありません（' + ADMIN_EMAIL + ' に届きます）。\n\n' +
    '----------------------------------------\n' +
    'Stellize合同会社\n' +
    '就労継続支援B型事業所向けクリエイティブ講座／SNS・生産活動研修／G-PaC\n' +
    'Mail: ' + ADMIN_EMAIL + '\n' +
    '----------------------------------------\n';

  MailApp.sendEmail({
    to: p.email,
    replyTo: ADMIN_EMAIL,
    subject: subject,
    body: body
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
