/**
 * 収支計画の取り込みの検算。
 *
 * このシートは結合セルが多く、行の形だけでは分類が決まらない。
 * 実データで踏んだ間違いを、小さな表に写して固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { importPlan } from '../src/import/sheet.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { TABLES } from '../src/tables.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  migrate(db, Object.keys(TABLES));   // edited_at はここで付く
  return db;
};

/**
 * 実際のシートと同じ形に寄せた2か月ぶんの表。
 *   ・目標側には「経費合計」の区切りが無い
 *   ・支出をぜんぶ足した行には、項目名が入っていない
 *   ・「借金返済 |  | 親族」のあと「| 積立保険 | アクサ生命」が続く
 */
/**
 * 実際のシートと同じ形に寄せた表（見出しは1月〜12月、値は1〜2月だけ）。
 *   ・目標側には「経費合計」の区切りが無い
 *   ・支出をぜんぶ足した行には、項目名が入っていない
 *   ・「借金返済 |  | 親族」のあと「| 積立保険 | アクサ生命」が続く
 */
const MONTHS = Array.from({ length: 12 }, (_, i) => (i + 1) + '月');
/** 3列の見出しと、1月・2月の値から1行を作る。3月以降は空にする */
const row = (a, b, c, v1, v2) =>
  '| ' + [a, b, c].join(' | ') + ' | ' + [v1, v2].concat(Array(10).fill('')).join(' | ') + ' |';

const SHEET = [
  '| 2026年 |  |  |  |',
  '|  |  |  | ' + MONTHS.join(' | ') + ' | 合計 |',
  '|  | 【目標数値】 |  |  |',
  '| 〈売上〉 |  |  |  |',
  row('', '研修売上', '', '¥100,000', '¥200,000'),
  row('', '総売上', '', '¥100,000', '¥200,000'),
  '| 〈支出〉 |  |  |  |',
  row('', '借金返済', '', '¥10,000', '¥10,000'),
  row('借金返済', '', '親族', '¥20,000', '¥20,000'),
  row('', '積立保険', 'アクサ生命', '¥5,000', '¥5,000'),
  row('通信費', 'ケータイ', '', '¥3,000', '¥3,000'),
  row('', 'ソフト経費', '', '¥1,000', '¥1,000'),
  row('家賃光熱費', '', '', '¥50,000', '¥50,000'),
  row('光熱費', '', '', '¥8,000', '¥8,000'),
  row('美容関連費', '', '', '¥2,000', '¥2,000'),
  '| その他雑費 |  |  |  |',
  row('', '', '', '¥99,000', '¥99,000'),          // 名前の無い、支出をぜんぶ足した行
  '|  |  |  |  |',                                 // 空行。引き継ぎが切れる
  row('', '利益', '', '¥1,000', '¥101,000'),
  '|  | 〈結果数値〉 |  |  |',
  '| 〈売上〉 |  |  |  |',
  row('', '研修売上', '', '¥80,000', ''),
  row('', '総売上', '', '¥80,000', ''),
  '| 販売費及び一般管理費 |  |  |  |',
  row('', '借金返済', '', '¥10,000', ''),
  row('通信費', 'ケータイ', '', '¥2,000', ''),
  row('経費合計', '', '', '¥12,000', ''),
  row('家賃光熱費', '', '', '¥50,000', ''),
  row('借金返済', '', '親族', '¥20,000', ''),
  row('', '積立保険', 'アクサ生命', '¥5,000', ''),
];

const run = () => { const db = fresh(); importPlan(db, SHEET); return db; };
const rows = (db, sql, ...p) => db.prepare(sql).all(...p);
const one = (db, kind, side, cat, sub = '') => db.prepare(
  `SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
   WHERE kind=? AND side=? AND category=? AND subcategory=?`).get(kind, side, cat, sub).a;

test('項目名の無い合計行を、経費の明細として数えない', () => {
  const db = run();
  // 「その他雑費」の下の無名行は支出の合計。明細として足すと経費が倍になる
  assert.equal(one(db, '目標', '事業経費', 'その他雑費'), 0);
  const t = rows(db, `SELECT month, amount, is_total FROM plan_monthly
    WHERE kind='目標' AND category='支出合計' ORDER BY month`);
  assert.deepEqual(t.map((r) => r.amount), [99000, 99000]);
  assert.ok(t.every((r) => r.is_total === 1), '合計の印が付いていること');
});

test('事業経費と個人支出を足すと、シートの支出合計になる', () => {
  const db = run();
  const biz = db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
    WHERE kind='目標' AND side='事業経費' AND is_total=0`).get().a;
  const per = db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
    WHERE kind='目標' AND side='個人支出' AND is_total=0`).get().a;
  assert.equal(biz + per, 99000 * 2, '取りこぼしも二重計上も無いこと');
});

test('目標側に区切りが無くても、家賃光熱費から下は生活のお金にする', () => {
  const db = run();
  assert.equal(one(db, '目標', '個人支出', '家賃光熱費'), 100000);
  assert.equal(one(db, '目標', '個人支出', '光熱費'), 16000);
  assert.equal(one(db, '目標', '個人支出', '美容関連費'), 4000);
  // 販管費にも出てくる「借金返済」は、事業の側に残す
  assert.equal(one(db, '目標', '事業経費', '借金返済'), 20000);
  assert.equal(one(db, '目標', '個人支出', '借金返済', '親族'), 40000);
});

test('大分類を飛ばした行の次で、引き継ぎを切る', () => {
  const db = run();
  // 「借金返済 |  | 親族」の次の「| 積立保険 | アクサ生命」は別の項目
  assert.equal(one(db, '目標', '個人支出', '積立保険', 'アクサ生命'), 10000);
  assert.equal(one(db, '目標', '個人支出', '借金返済', '積立保険／アクサ生命'), 0);
});

test('空行で引き継ぎが切れ、利益が前の分類にぶら下がらない', () => {
  const db = run();
  assert.equal(one(db, '目標', '指標', '利益'), 102000);
  assert.equal(one(db, '目標', '指標', 'その他雑費', '利益'), 0);
});

test('実績側は「経費合計」の区切りで事業と個人が分かれる', () => {
  const db = run();
  assert.equal(one(db, '実績', '事業経費', '通信費', 'ケータイ'), 2000);
  assert.equal(one(db, '実績', '個人支出', '家賃光熱費'), 50000);
  assert.equal(one(db, '実績', '個人支出', '積立保険', 'アクサ生命'), 5000);
});

test('総売上には合計の印が付き、内訳と二重に数えない', () => {
  const db = run();
  const t = db.prepare(`SELECT is_total FROM plan_monthly
    WHERE kind='目標' AND category='総売上' LIMIT 1`).get();
  assert.equal(t.is_total, 1);
});
