/**
 * 配信エンジンの通し確認。
 *
 *   node gas/newsletter/test/smoke.mjs
 *
 * 本物のスプレッドシートもGmailも使わず、gas-stub.mjs の偽物の上で
 * 「シートを作る → 購読者を入れる → 原稿を書く → チェック → 送信」まで走らせる。
 * GASに貼る前に、ここで落ちないことを確かめる。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// vm の中で作られた配列は別realmのArrayになるため、deepStrictEqual が通らない。
// 中身だけを見たいので JSON にしてから比べる。
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
import vm from 'node:vm';
import { makeGasGlobals } from './gas-stub.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const { g, book, sent, props } = makeGasGlobals();

// .gs は GAS 上で1つのグローバルを共有する。同じ形にするため vm の1コンテキストに全部読む
const ctx = vm.createContext(g);
// Config.gs は他が参照する定数を持つので先に。あとはファイル名順で問題ない
const order = ['Config.gs', 'Templates.gs', 'Render.gs', 'Sheets.gs', 'Compose.gs', 'Send.gs', 'Web.gs', 'Menu.gs'];
const files = [...order, ...readdirSync(DIR).filter((f) => f.endsWith('.gs') && !order.includes(f))];
for (const f of files) vm.runInContext(readFileSync(join(DIR, f), 'utf8'), ctx, { filename: f });

const run = (expr) => vm.runInContext(expr, ctx);
let pass = 0;
const ok = (label, fn) => { fn(); console.log('  ✓ ' + label); pass++; };

console.log('\n■ シートの初期化');
run('setupSheets()');
ok('6枚のシートができる', () => assert.equal(book.getSheets().length, 6));
ok('設定シートに既定値が入る', () => assert.equal(run(`cfg()['会社名']`), 'Stellize合同会社'));
ok('送信キューは隠しシート', () => assert.equal(book.getSheetByName('送信キュー').hidden, true));

console.log('\n■ 設定');
run(`(function(){
  const sh = sheet(SHEETS.settings), map = {};
  const rows = sh.getRange(2,1,sh.getLastRow()-1,2).getValues();
  rows.forEach(function(r,i){ if(r[0]==='WebアプリURL') sh.getRange(i+2,2).setValue('https://script.google.com/macros/s/AKfycbTEST/exec'); });
  _cfgCache = null;
})()`);
ok('WebアプリURLを読み直せる', () => assert.match(run(`cfg()['WebアプリURL']`), /\/exec$/));

console.log('\n■ 購読者の取り込み');
const csv = [
  'メールアドレス,事業所名,法人名,宛名,都道府県',
  'a@example.jp,あおぞら就労支援センター,社会福祉法人あおぞら,佐藤,神奈川県',
  'b@example.jp,ひまわり工房,NPO法人ひまわり,,東京都',
  'a@example.jp,重複してるところ,,,',          // 重複
  'こわれたアドレス,,,,',                        // 不正
  'c@example.jp,みどりの家,,,埼玉県',
].join('\n');
const imported = run(`uiImport(${JSON.stringify(csv)}, {segment:'事業所', basis:'公式サイトに公開されている法人の連絡先'})`);
ok('3件追加・重複1・不正1', () => same(
  { added: imported.added, dup: imported.dup, invalid: imported.invalid }, { added: 3, dup: 1, invalid: 1 }));
ok('宛先が3件に見える', () => assert.equal(run(`recipientsFor('事業所').length`), 3));
ok('別セグメントでは0件', () => assert.equal(run(`recipientsFor('パートナー').length`), 0));

console.log('\n■ 原稿のチェック');
run(`appendRow(SHEETS.drafts, {
  '号ID':'vol001', '状態':'下書き', 'テンプレート':'b2b', 'セグメント':'事業所',
  '件名':'{{事業所名}}さまへ／SNS講座のご案内',
  'プリヘッダー':'1回90分、全3回。作って終わりにしない講座です。',
  '大見出し':'就労支援の現場から、SNSで届ける力を',
  '本文':'{{宛名}}様\\n\\nはじめてご連絡いたします。\\n\\n## 講座の3段階\\n\\n- **学ぶ** … 撮り方と言葉\\n- **ワーク** … その日に1投稿\\n\\n| 費用 | オンライン15,000円／回\\n\\n[無料相談を予約する](https://stellize-site.netlify.app/contact.html)\\n\\n-- Stellize合同会社　菊野 玲',
  '送信済':0, '失敗':0
})`);
const chk = run(`uiCheck('vol001')`);
ok('エラーなし', () => same([...chk.errors], []));
ok('宛先3件', () => assert.equal(chk.count, 3));

const bad = run(`(function(){ appendRow(SHEETS.drafts,{'号ID':'vol999','状態':'下書き','テンプレート':'','件名':'','本文':''}); return uiCheck('vol999'); })()`);
ok('空の原稿は止められる', () => {
  const e = [...bad.errors].join('｜');
  assert.ok(e.includes('件名') && e.includes('本文') && e.includes('テンプレート'), e);
});

console.log('\n■ 組み立て');
const built = run(`(function(){ const b = campaignHtml(draftByIssue('vol001'));
  return { html:b.html, text:b.text, subject:b.subject }; })()`);
ok('差し込みタグが残っている', () => assert.ok(built.html.includes('{{宛名}}')));
ok('UTMが付いている', () => assert.ok(
  built.html.includes('utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=vol001'), 'UTMが見つからない'));
ok('テキスト版がある', () => assert.ok(built.text.includes('無料相談を予約する')));

const one = run(`(function(){ const b = campaignHtml(draftByIssue('vol001'));
  return personalize(b, {email:'a@example.jp', 宛名:'佐藤', 法人名:'社会福祉法人あおぞら', 事業所名:'あおぞら就労支援センター', 都道府県:'神奈川県'}); })()`);
ok('件名に差し込みが効く', () => assert.equal(one.subject, 'あおぞら就労支援センターさまへ／SNS講座のご案内'));
ok('本文の差し込みが埋まる', () => assert.ok(one.html.includes('佐藤様') && !one.html.includes('{{')));
ok('配信停止URLが署名付き', () => assert.match(one.html, /a=u&amp;e=a%40example\.jp&amp;s=[\w-]{22}/));

const anon = run(`(function(){ const b = campaignHtml(draftByIssue('vol001'));
  return personalize(b, {email:'', 宛名:'', 法人名:'', 事業所名:'', 都道府県:''}); })()`);
ok('宛名が空なら「ご担当者」に落ちる', () => assert.ok(anon.html.includes('ご担当者様')));

console.log('\n■ 日刊は別の骨格を使う');
run(`appendRow(SHEETS.drafts, {'号ID':'d001','状態':'下書き','テンプレート':'daily','セグメント':'事業所',
  '件名':'「私が作ったって、書いていいんですか」','プリヘッダー':'袋に名前を入れた日の話です。',
  '大見出し':'「私が作ったって、書いていいんですか」','本文':'先週、ある事業所で袋詰めの作業を見ていたときのことです。','送信済':0,'失敗':0})`);
const daily = run(`campaignHtml(draftByIssue('d001')).html`);
ok('日刊の骨格になっている', () => {
  assert.ok(daily.includes('max-width:580px'), '日刊は580px幅');
  assert.ok(!daily.includes('自分の価値に、気づく。'), '日刊にタグラインは出さない');
});
ok('日付が入る', () => assert.match(daily, /\d{4}年\d{1,2}月\d{1,2}日（[日月火水木金土]）/));
ok('営業レターは従来の骨格のまま', () => {
  const letter = run(`campaignHtml(draftByIssue('vol001')).html`);
  assert.ok(letter.includes('max-width:600px') && letter.includes('自分の価値に、気づく。'));
});

console.log('\n■ 署名の検証');
ok('正しい署名は通る', () => assert.equal(run(`verifyEmail('a@example.jp', signEmail('a@example.jp'))`), true));
ok('他人の署名では通らない', () => assert.equal(run(`verifyEmail('b@example.jp', signEmail('a@example.jp'))`), false));

console.log('\n■ 送信');
const msg = run(`startSending('vol001')`);
ok('3通送られた', () => assert.equal(sent.length, 3));
ok('HTMLとテキストの両方を入れている', () => assert.ok(sent[0].htmlBody && sent[0].body));
ok('差出人名と返信先が付く', () => {
  assert.equal(sent[0].name, 'Stellize合同会社');
  assert.equal(sent[0].replyTo, 'rei.stella1127@gmail.com');
});
ok('宛先ごとに配信停止URLが違う', () => assert.notEqual(
  sent[0].htmlBody.match(/s=([\w-]{22})/)[1], sent[1].htmlBody.match(/s=([\w-]{22})/)[1]));
ok('状態が送信済になる', () => assert.equal(run(`draftByIssue('vol001')['状態']`), '送信済'));
ok('トリガーが片付いている', () => assert.equal(run(`ScriptApp.getProjectTriggers().length`), 0));
ok('二重送信は止まる', () => assert.throws(() => run(`startSending('vol001')`), /すでに送信済/));

console.log('\n■ 配信停止');
const beforeStop = run(`recipientsFor('事業所').length`);
run(`doGet({parameter:{a:'u', e:'a@example.jp', s:signEmail('a@example.jp'), c:'1'}})`);
ok('停止シートに記録される', () => assert.equal(run(`readRows(SHEETS.suppress).length`), 1));
ok('宛先から外れる', () => assert.equal(run(`recipientsFor('事業所').length`), beforeStop - 1));
ok('購読者の状態も停止になる', () => assert.equal(
  run(`readRows(SHEETS.subscribers).filter(function(r){return r['メールアドレス']==='a@example.jp'})[0]['状態']`), '停止'));

run(`doGet({parameter:{a:'u', e:'b@example.jp', s:'にせものの署名', c:'1'}})`);
ok('署名が違えば止まらない', () => assert.equal(run(`readRows(SHEETS.suppress).length`), 1));

// 一度止めた相手は、購読者シートに残っていても・消してあっても取り込みで復活しない
run(`appendRow(SHEETS.suppress, {'メールアドレス':'z@example.jp','停止日時':nowStr(),'経路':'電話','理由':'不要との連絡'})`);
const reimport = run(`uiImport('メールアドレス\\na@example.jp\\nz@example.jp\\nnew@example.jp', {})`);
ok('停止済みは取り込みで復活しない', () => {
  assert.equal(reimport.suppressed, 2, '停止済みが2件はじかれるはず');
  assert.equal(reimport.added, 1, '新規1件だけ追加されるはず');
});

console.log('\n■ 枠が尽きたときの分割送信と再開');
// 送信枠のキーは Asia/Tokyo の日付で作られる。UTCで組むと日付がずれる日がある
const jst = new Date();
const day = 'SENT_' + [jst.getFullYear(), jst.getMonth() + 1, jst.getDate()]
  .map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('');
const setLimit = (n) => run(`(function(){ const sh=sheet(SHEETS.settings);
  sh.getRange(2,1,sh.getLastRow()-1,2).getValues().forEach(function(r,i){
    if(r[0]==='1日の送信上限') sh.getRange(i+2,2).setValue('${n}');
  }); _cfgCache=null; })()`);

// 5人ぶん購読者を足して、上限2通で送り始める
props.set(day, '0');
setLimit(2);
const bulkCsv = ['メールアドレス,事業所名', ...[1, 2, 3, 4, 5].map((i) => `q${i}@example.jp,テスト事業所${i}`)].join('\n');
run(`uiImport(${JSON.stringify(bulkCsv)}, {segment:'分割テスト'})`);
run(`appendRow(SHEETS.drafts, {'号ID':'vol002','状態':'下書き','テンプレート':'partner','セグメント':'分割テスト',
  '件名':'分割送信のテスト','プリヘッダー':'テスト','大見出し':'テスト','本文':'本文です。','送信済':0,'失敗':0})`);

const before = sent.length;
run(`startSending('vol002')`);
ok('上限ぶんだけ送って止まる', () => assert.equal(sent.length - before, 2));
ok('状態は送信中のまま', () => assert.equal(run(`draftByIssue('vol002')['状態']`), '送信中'));
ok('続きのトリガーが残っている', () => assert.equal(run(`ScriptApp.getProjectTriggers().length`), 1));
ok('キューに未送信が3件残る', () => assert.equal(
  run(`readRows(SHEETS.queue).filter(function(r){return r['号ID']==='vol002' && String(r['状態']).trim()===''}).length`), 3));

// 翌日ぶんの枠が空いた想定で再開する
props.set(day, '0');
setLimit(400);
run(`resumeSending()`);
ok('再開して残り3通を送りきる', () => assert.equal(sent.length - before, 5));
ok('同じ相手に二重に送っていない', () => {
  const to = sent.slice(before).map((m) => m.to);
  assert.equal(new Set(to).size, to.length, '重複: ' + to.join(', '));
});
ok('送信済に変わる', () => assert.equal(run(`draftByIssue('vol002')['状態']`), '送信済'));
ok('送信済カウントが5', () => assert.equal(run(`draftByIssue('vol002')['送信済']`), 5));
ok('トリガーが片付く', () => assert.equal(run(`ScriptApp.getProjectTriggers().length`), 0));

console.log('\n■ 読み込み順への非依存');
// GASは編集画面の並び順で全ファイルを読む。順番が変わると落ちる書き方（トップレベルで
// 他ファイルの定数を参照する等）が紛れ込んでいないかを、逆順で読んで確かめる
ok('ファイルを逆順で読んでも初期化できる', () => {
  const other = makeGasGlobals();
  const c2 = vm.createContext(other.g);
  for (const f of [...files].reverse()) vm.runInContext(readFileSync(join(DIR, f), 'utf8'), c2, { filename: f });
  vm.runInContext('setupSheets()', c2);
  assert.equal(other.book.getSheets().length, 6);
});

console.log(`\n✅ ${pass}件すべて通りました（送信 ${sent.length}通 / 宛先: ${sent.map((s) => s.to).join(', ')}）\n`);
