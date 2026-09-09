/**
 * mail/daily.mjs の通し確認。
 *
 *   node mail/test/daily-e2e.mjs
 *
 * 本物のGASの代わりに、gas-stub の上で doPost を動かす小さなHTTPサーバを立てて、
 * CLIを実際に子プロセスとして走らせる。ネットワークにもGoogleにも触らない。
 * 「手元 → スプレッドシート」の配線が繋がっているかを、貼る前に確かめるためのもの。
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeGasGlobals } from '../../gas/newsletter/test/gas-stub.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const GAS = join(HERE, '..', '..', 'gas', 'newsletter');
const CLI = join(HERE, '..', 'daily.mjs');

/* --- GASを1つのグローバルとして読む（本番と同じ形） --- */
const { g } = makeGasGlobals();
const ctx = vm.createContext(g);
const order = ['Config.gs', 'Templates.gs', 'Render.gs', 'Voice.gs', 'Sheets.gs', 'Compose.gs', 'Send.gs', 'Api.gs', 'Web.gs', 'Menu.gs'];
const files = [...order, ...readdirSync(GAS).filter((f) => f.endsWith('.gs') && !order.includes(f))];
for (const f of files) vm.runInContext(readFileSync(join(GAS, f), 'utf8'), ctx, { filename: f });
const gas = (expr) => vm.runInContext(expr, ctx);

gas('setupSheets()');
gas(`(function(){const sh=sheet(SHEETS.settings);
  sh.getRange(2,1,sh.getLastRow()-1,2).getValues().forEach(function(r,i){
    if(r[0]==='WebアプリURL') sh.getRange(i+2,2).setValue('https://script.google.com/macros/s/X/exec');
  }); _cfgCache=null;})()`);
const TOKEN = gas(`apiToken('api')`);

/* --- GASのWebアプリのふりをするサーバ --- */
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const out = gas(`doPost({postData:{contents:${JSON.stringify(raw)}}}).getContent()`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/exec`;

/* --- 設定ファイルを一時ディレクトリに作り、CLIをそこから走らせる --- */
const dir = mkdtempSync(join(tmpdir(), 'stellize-mail-'));
writeFileSync(join(dir, 'draft.json'), JSON.stringify({
  template: 'daily', frame: '現場で見たこと', segment: '日刊',
  subject: '「私が作ったって、書いていいんですか」',
  preheader: '袋に名前を入れた日の話です。',
  title: '「私が作ったって、書いていいんですか」',
  body: '先週、ある事業所で袋詰めの作業を見ていたときのことです。\n\n' +
        '「これ、私が作ったって書いていいんですか」と聞かれました。\n\n' +
        '私は、そう聞かれた理由のほうが大事だと思っています。まだ答えは出ていません。',
}, null, 2));

const env = { ...process.env, STELLIZE_MAIL_URL: url, STELLIZE_MAIL_TOKEN: TOKEN };
const cli = (...args) => run('node', [CLI, ...args], { env });

let pass = 0;
const ok = async (label, fn) => { await fn(); console.log('  ✓ ' + label); pass++; };

console.log('\n■ CLI 通し確認');

await ok('status がつながる', async () => {
  const { stdout } = await cli('status');
  assert.match(stdout, /未使用のメモ/);
  assert.match(stdout, /日刊の宛先/);
});

await ok('memo でメモを残せる', async () => {
  const { stdout } = await cli('memo', 'テストのメモです');
  assert.match(stdout, /残しました/);
});

await ok('memos で読み返せる', async () => {
  const { stdout } = await cli('memos');
  assert.match(stdout, /テストのメモです/);
});

await ok('draft で下書きが積まれる', async () => {
  const { stdout } = await cli('draft', join(dir, 'draft.json'));
  assert.match(stdout, /積みました/);
  assert.match(stdout, /送信はされていません/);
  assert.equal(gas(`readRows(SHEETS.drafts).length`), 1);
  assert.equal(gas(`readRows(SHEETS.drafts)[0]['状態']`), '下書き');
});

await ok('合言葉が違えば止まる', async () => {
  await assert.rejects(
    () => run('node', [CLI, 'status'], { env: { ...env, STELLIZE_MAIL_TOKEN: 'にせもの' } }),
    (e) => /連携キーが違います/.test(e.stderr));
});

await ok('つながらないURLは分かるように落ちる', async () => {
  await assert.rejects(
    () => run('node', [CLI, 'status'], { env: { ...env, STELLIZE_MAIL_URL: 'http://127.0.0.1:1/exec' } }),
    (e) => /つながりませんでした/.test(e.stderr));
});

await ok('設定が無ければ置き方を教える', async () => {
  const bare = { ...process.env };
  delete bare.STELLIZE_MAIL_URL; delete bare.STELLIZE_MAIL_TOKEN;
  await assert.rejects(
    () => run('node', [CLI, 'status'], { env: bare, cwd: dir }),
    (e) => /接続先が分かりません/.test(e.stderr));
});

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ ${pass}件すべて通りました\n`);
