#!/usr/bin/env node
/**
 * 日刊メルマガの受け渡し口（手元 → スプレッドシート）
 *
 *   node mail/daily.mjs status              疎通確認。今日の枠、未使用メモ数、直近の号
 *   node mail/daily.mjs memos               未使用のメモを読む
 *   node mail/daily.mjs memo "本文"          メモを1件足す（動作確認用）
 *   node mail/daily.mjs draft 下書き.json    原稿シートに下書きを積む
 *
 * 接続先は、プロジェクト直下の .stellize-mail.json から読む（gitignore済み）。
 *   { "webAppUrl": "https://script.google.com/macros/s/～/exec", "apiToken": "～" }
 * スプレッドシートの「📧 メルマガ」→「ネタ帳のURLと連携キーを表示」で作れます。
 * 環境変数 STELLIZE_MAIL_URL / STELLIZE_MAIL_TOKEN でも上書きできます。
 *
 * このツールは下書きを積むだけで、送信は絶対に行いません。
 * 送るかどうかは、人がスプレッドシートの配信パネルで決めます。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, '.stellize-mail.json');

function config() {
  let c = {};
  try { c = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { /* 環境変数だけでも動く */ }
  const url = process.env.STELLIZE_MAIL_URL || c.webAppUrl;
  const token = process.env.STELLIZE_MAIL_TOKEN || c.apiToken;
  if (!url || !token) {
    console.error(
      '接続先が分かりません。\n' +
      `  ${CONFIG} に次の形で置いてください。\n` +
      '  { "webAppUrl": "https://script.google.com/macros/s/～/exec", "apiToken": "～" }\n\n' +
      '  値はスプレッドシートの「📧 メルマガ」→「ネタ帳のURLと連携キーを表示」で出せます。');
    process.exit(2);
  }
  // localhost は動作確認用（mail/test/daily-e2e.mjs が使う）
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  if (!local && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    console.error(`webAppUrl の形が違います（末尾は /exec）: ${url}`);
    process.exit(2);
  }
  return { url, token };
}

/**
 * GASのWebアプリはPOSTに302を返し、本体は googleusercontent 側で配る。
 * fetch は既定で追うので、そのまま読めばよい。
 */
async function call(payload) {
  const { url, token } = config();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, token }),
      redirect: 'follow',
    });
  } catch (e) {
    console.error('つながりませんでした: ' + e.message);
    process.exit(1);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // HTMLが返るのは、たいてい未デプロイか、アクセス権が「全員」になっていないとき
    console.error(
      `応答がJSONではありませんでした（HTTP ${res.status}）。\n` +
      'デプロイの「アクセスできるユーザー」が「全員」になっているか、\n' +
      'コードを変えたあとに再デプロイ（新バージョン）したかを確認してください。\n\n' +
      text.slice(0, 300));
    process.exit(1);
  }
  if (json.ok === false) {
    if (json.error === 'unauthorized') {
      console.error('連携キーが違います。スプレッドシートの「連携キーを表示」と見比べてください。');
    } else {
      console.error('エラー: ' + json.error);
    }
    process.exit(1);
  }
  return json;
}

/* ------------------------------------------------------------
   各コマンド
   ------------------------------------------------------------ */

async function cmdStatus() {
  const s = await call({ api: 'status' });
  console.log(`\n${s.today}`);
  console.log(s.frame
    ? `今日の枠　　： ${s.frame.key}（${s.frame.target}）\n　　　　　　　 ${s.frame.note}`
    : '今日の枠　　： なし（土日は書かない日です）');
  console.log(`未使用のメモ： ${s.unusedMemos}件`);
  console.log(`日刊の宛先　： ${s.subscribers}件`);
  if (s.recent.length) {
    console.log('\n直近の号');
    for (const r of s.recent) {
      console.log(`  ${r.issue.padEnd(12)} ${r.state.padEnd(5)} ${(r.frame || r.template).padEnd(12)} ${r.subject}`);
    }
  }
  console.log();
}

async function cmdMemos() {
  const { memos } = await call({ api: 'memos' });
  if (!memos.length) {
    console.log('\n未使用のメモはありません。スマホのネタ帳から残してください。\n');
    return;
  }
  console.log(`\n未使用のメモ ${memos.length}件\n`);
  for (const m of memos) {
    console.log(`  [行${m.row}] ${m.at}${m.frame ? '　枠: ' + m.frame : ''}`);
    console.log(`    ${m.text.replace(/\n/g, '\n    ')}\n`);
  }
}

async function cmdMemo(text) {
  if (!text) { console.error('メモの本文を渡してください。'); process.exit(2); }
  await call({ api: 'memo', text, from: '手元' });
  console.log('残しました。');
}

async function cmdDraft(file) {
  if (!file) { console.error('下書きのJSONファイルを渡してください。'); process.exit(2); }
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`${file} を読めませんでした: ${e.message}`); process.exit(2);
  }
  const r = await call({ api: 'draft', from: '手元', ...d });

  console.log(`\n積みました： ${r.issue}（状態は「下書き」。送信はされていません）`);
  if (r.errors?.length) {
    console.log('\n■ このままでは送れません');
    r.errors.forEach((e) => console.log('  ・' + e));
  }
  if (r.warns?.length) {
    console.log('\n■ 確認したい点');
    r.warns.forEach((e) => console.log('  ・' + e));
  }
  if (r.voice?.length) {
    console.log('\n■ 書き方');
    const mark = { ng: '×', warn: '△', hint: '・' };
    r.voice.forEach((v) => console.log(`  ${mark[v.level] || '・'} ${v.msg}`));
  }
  if (!r.errors?.length && !r.warns?.length && !r.voice?.length) console.log('\n指摘はありません。');
  console.log('\nスプレッドシートの配信パネルで、プレビュー → テスト送信 → 送信の順に進めてください。\n');
}

/* ------------------------------------------------------------ */

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  status: cmdStatus,
  memos: cmdMemos,
  memo: () => cmdMemo(rest.join(' ')),
  draft: () => cmdDraft(rest[0]),
};
if (!table[cmd]) {
  // 先頭のコメントをそのまま使い方として出す（説明を2か所に持たないため）
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/'))
    .split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim());
  process.exit(cmd ? 2 : 0);
}
await table[cmd]();
