/**
 * 商談パイプラインの取り込みの検算。
 *
 * このシートの日付には年が書かれていない（「4/3」）。並び順から年を補うが、
 * 途中で月が飛ぶ行があり、そこだけ未来の日付になっていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { importPipeline } from '../src/import/sheet.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { TABLES } from '../src/tables.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = '| No | 案件名 | 企業名 | 担当者名 | 仲介者氏名 | 初回面談 | 進捗 '
  + '| 単発見積 | 月額見積 | 期限 | 契約締結日 | 備考(進捗含む) | 失注理由 |';
const RULE = '| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |';
const deal = (no, name, met, closed = '') =>
  `| ${no} | ${name} | ${name}社 | 担当 |  | ${met} | 商談 |  | ¥10,000 |  | ${closed} |  |  |`;

function run(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  migrate(db, Object.keys(TABLES));
  importPipeline(db, [HEAD, RULE, ...rows]);
  return db.prepare('SELECT title, first_met, closed_on FROM pipeline ORDER BY id').all();
}

test('年の書かれていない日付に、並び順から年を補う', () => {
  const r = run([deal(1, 'あ', '3/27'), deal(2, 'い', '4/4'), deal(3, 'う', '6/1')]);
  assert.deepEqual(r.map((x) => x.first_met), ['2023-03-27', '2023-04-04', '2023-06-01']);
});

test('12月から1〜3月に戻ったら、年をまたいだとみなす', () => {
  const r = run([deal(1, 'あ', '12/7'), deal(2, 'い', '2/28')]);
  assert.equal(r[0].first_met.slice(0, 4), '2023');
  assert.equal(r[1].first_met.slice(0, 4), '2024');
});

test('補った年が未来になったら、1年戻す', () => {
  // 並びの途中で月が飛ぶ行。そのまま年を当てると、済んだ商談が未来の日付になる
  const rows = [];
  let no = 1;
  for (const m of [3, 6, 9, 12]) rows.push(deal(no++, 'y' + m, m + '/1'));
  for (let y = 0; y < 3; y++) for (const m of [2, 5, 8, 11]) rows.push(deal(no++, `z${y}${m}`, m + '/1'));
  rows.push(deal(no++, '飛ぶ行', '10/24'));
  const r = run(rows);
  const today = new Date().toISOString().slice(0, 10);
  for (const x of r) {
    assert.ok(x.first_met <= today, `${x.title} が未来（${x.first_met}）`);
  }
});

test('締結日の「未定」「夏以降」は、勝手に日付にせず書かれたまま残す', () => {
  const r = run([deal(1, 'あ', '4/3', '未定'), deal(2, 'い', '4/4', '夏以降'), deal(3, 'う', '4/5', '5月')]);
  assert.equal(r[0].closed_on, '未定');
  assert.equal(r[1].closed_on, '夏以降');
  assert.equal(r[2].closed_on, '2023-05', '月だけ分かるものは年月にする');
});
