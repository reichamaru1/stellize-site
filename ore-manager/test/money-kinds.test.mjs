/**
 * お金の区分の検算。
 *
 * 「お金の流れ管理」は、事業用の口座から払った生活費を事業の経費にする。
 * 口座間の移し替えも収入と支出の両方に立つ。区分表がこれを外せているかを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { seedMoneyKinds, DEFAULT_KINDS } from '../src/money-kinds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIND = `COALESCE(NULLIF(t.kind,''), k.kind, '個人')`;
const JOIN = `FROM mf_tx t LEFT JOIN money_kinds k ON k.category = t.category`;

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  const put = db.prepare(`INSERT INTO mf_tx (id,date,entity,type,category,amount) VALUES (?,?,?,?,?,?)`);
  // すべて事業口座から出ている。向こうの仕分けでは全部「事業」になる
  put.run('a', '2026-01-10', 'business', 'income',  'セミナー・研修講師料', 200000);
  put.run('b', '2026-01-11', 'business', 'income',  'チャージ・口座間振替', 500000);
  put.run('c', '2026-01-12', 'business', 'expense', 'チャージ・口座間振替', 500000);
  put.run('d', '2026-01-13', 'business', 'expense', 'その他生活費', 30000);
  put.run('e', '2026-01-14', 'business', 'expense', '会費', 10000);
  put.run('f', '2026-01-15', 'business', 'income',  'ファクタリング入金', 100000);
  put.run('g', '2026-01-16', 'business', 'expense', '借入返済・債務整理', 50000);
  seedMoneyKinds(db);
  return db;
}

const sum = (db, kind, type) => db.prepare(
  `SELECT COALESCE(SUM(t.amount),0) a ${JOIN} WHERE ${KIND}=? AND t.type=?`).get(kind, type).a;

test('口座間の移し替えは売上にも経費にも入らない', () => {
  const db = fixture();
  assert.equal(sum(db, '売上', 'income'), 200000);
  assert.equal(sum(db, '経費', 'expense'), 10000);
  assert.equal(sum(db, '振替', 'income'), 500000);
  assert.equal(sum(db, '振替', 'expense'), 500000);
});

test('事業口座から出た生活費は事業の経費にしない', () => {
  const db = fixture();
  assert.equal(sum(db, '個人', 'expense'), 30000);
});

test('借入とその返済は損益に入れず、資金調達として分ける', () => {
  const db = fixture();
  assert.equal(sum(db, '資金調達', 'income'), 100000);
  assert.equal(sum(db, '資金調達', 'expense'), 50000);
  // 利益は 売上 − 経費 だけで決まる
  assert.equal(sum(db, '売上', 'income') - sum(db, '経費', 'expense'), 190000);
});

test('1件だけの上書きは、カテゴリの区分表より優先される', () => {
  const db = fixture();
  db.prepare("UPDATE mf_tx SET kind='経費' WHERE id='d'").run();
  assert.equal(sum(db, '経費', 'expense'), 40000);
  assert.equal(sum(db, '個人', 'expense'), 0);
});

test('区分表に無いカテゴリが来たら足され、要確認が立つ', () => {
  const db = fixture();
  db.prepare(`INSERT INTO mf_tx (id,date,entity,type,category,amount)
    VALUES ('z','2026-02-01','business','expense','新しい何か',1000)`).run();
  assert.equal(seedMoneyKinds(db), 1);
  const r = db.prepare("SELECT kind, unsure FROM money_kinds WHERE category='新しい何か'").get();
  assert.equal(r.unsure, 1, '人が見ていない印が立っていること');
  // 二度目は増えない
  assert.equal(seedMoneyKinds(db), 0);
});

test('人が直した区分は、取り込み直しても戻らない', () => {
  const db = fixture();
  db.prepare(`UPDATE money_kinds SET kind='経費', edited_at='2026-01-01'
    WHERE category='その他生活費'`).run();
  seedMoneyKinds(db);
  assert.equal(db.prepare("SELECT kind FROM money_kinds WHERE category='その他生活費'").get().kind, '経費');
});

test('初期値の区分は、決めた5つのどれかになっている', () => {
  for (const [cat, kind] of Object.entries(DEFAULT_KINDS)) {
    assert.ok(['売上', '経費', '個人', '振替', '資金調達'].includes(kind), cat + ' が ' + kind);
  }
});
