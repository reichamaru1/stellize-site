#!/usr/bin/env node
/**
 * 「お金の流れ管理」からの取り込み
 *
 *   npm run import:money                    最新のバックアップを自動で探す
 *   npm run import:money -- 別のファイル.json  ファイルを指定する
 *
 * あちらのアプリは取引を entity（business / personal）で仕分けている。
 * こちらで カテゴリ名から推測するより確かなので、手残りの計算はこれを使う。
 *
 * 向こうのIDをそのまま主キーにしているので、何度取り込んでも重複しない。
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.mjs';
import { TABLES } from '../tables.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** バックアップの置き場所。新しいものを選ぶ。 */
function findLatest() {
  const dirs = [
    join(homedir(), 'Desktop', 'お金の流れ管理.app', 'Contents', 'Resources', 'backup', '世代'),
    join(homedir(), 'Desktop', 'お金の流れ管理.app', 'Contents', 'Resources', 'backup'),
    join(homedir(), 'Desktop', '【Stellize】業務管理', 'お金の流れ管理'),
    join(homedir(), 'Desktop'),
  ];
  let best = null;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const full = join(d, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
    }
    if (best) break;   // 上のディレクトリを優先する
  }
  return best ? best.path : null;
}

const src = process.argv[2] || findLatest();
if (!src) {
  console.error('取り込み元が見つかりません。「お金の流れ管理」のバックアップJSONを指定してください。');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(src, 'utf8'));
} catch (e) {
  console.error(`${src} を読めませんでした: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(data.transactions)) {
  console.error('transactions が見つかりません。「お金の流れ管理」の書き出しファイルか確認してください。');
  process.exit(1);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'ore.db'));
db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
migrate(db, Object.keys(TABLES));

const put = db.prepare(`INSERT INTO mf_tx
  (id,date,entity,type,category,amount,memo,recurring,src,uncertain,import_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET date=excluded.date, entity=excluded.entity, type=excluded.type,
    category=excluded.category, amount=excluded.amount, memo=excluded.memo,
    recurring=excluded.recurring, src=excluded.src, uncertain=excluded.uncertain`);

let n = 0, skipped = 0;
for (const t of data.transactions) {
  if (!t || !t.id || !t.date) { skipped++; continue; }
  put.run(String(t.id), String(t.date).slice(0, 10),
    t.entity === 'personal' ? 'personal' : 'business',
    t.type === 'income' ? 'income' : 'expense',
    String(t.category ?? ''), Math.round(Number(t.amount) || 0), String(t.memo ?? ''),
    t.recurring ? 1 : 0, String(t.source ?? ''), t.lowConfidence ? 1 : 0, String(t.importId ?? ''));
  n++;
}

const putImp = db.prepare(`INSERT INTO mf_imports (id,name,entity,rows,from_date,to_date,at)
  VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET rows=excluded.rows, at=excluded.at`);
for (const i of data.imports || []) {
  if (!i || !i.id) continue;
  putImp.run(String(i.id), String(i.name ?? ''), String(i.entity ?? ''),
    Number(i.rows) || 0, String(i.from ?? ''), String(i.to ?? ''), String(i.at ?? ''));
}

const q = (s) => db.prepare(s).get();
const range = q("SELECT MIN(date) a, MAX(date) b FROM mf_tx");
const yen = (v) => '¥' + Number(v || 0).toLocaleString('ja-JP');

console.log(`取り込み元: ${src}`);
console.log(`  ✓ 取引 ${n}件` + (skipped ? `（${skipped}件は日付かIDが無く飛ばしました）` : ''));
console.log(`  期間: ${range.a} 〜 ${range.b}`);
for (const r of db.prepare(`SELECT entity, type, COUNT(*) n, SUM(amount) a
  FROM mf_tx GROUP BY 1,2 ORDER BY 1,2`).all()) {
  const label = (r.entity === 'business' ? '事業' : '個人') + (r.type === 'income' ? 'の収入' : 'の支出');
  console.log(`  ${label.padEnd(8)} ${String(r.n).padStart(5)}件  ${yen(r.a)}`);
}
db.close();
