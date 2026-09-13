/**
 * 列の追加（マイグレーション）
 *
 * SQLiteに「列が無ければ足す」構文が無いので、pragma で見てから足す。
 * 既存のデータベースを作り直さずに済ませるため。
 */
export function migrate(db, tableNames) {
  for (const t of tableNames) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${t})`).all(); } catch { continue; }
    if (!cols.length) continue;
    // 画面で編集した行の目印。取り込みでこの行を上書きしないために使う
    if (!cols.some((c) => c.name === 'edited_at')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN edited_at TEXT`);
    }
  }
  // 取引1件だけ区分を変えたいときの上書き列
  try {
    const cols = db.prepare('PRAGMA table_info(mf_tx)').all();
    if (cols.length && !cols.some((c) => c.name === 'kind')) {
      db.exec('ALTER TABLE mf_tx ADD COLUMN kind TEXT');
    }
  } catch { /* mf_tx がまだ無いだけ */ }
}
