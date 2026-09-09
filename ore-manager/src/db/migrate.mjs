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
}
