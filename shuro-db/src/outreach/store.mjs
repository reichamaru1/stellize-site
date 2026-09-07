/**
 * 送付管理（data/outreach.db）。
 * shuro.db を作り直しても消えないよう、別ファイルで持つ。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PATH = path.join(ROOT, 'data', 'outreach.db');

let db;
export function openOutreach() {
  if (db) return db;
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(path.join(ROOT, 'src', 'outreach', 'schema.sql'), 'utf8'));
  return db;
}

const now = () => new Date().toISOString();

export const CHANNELS = {
  post: { label: '郵送', requires: 'address' },
  fax: { label: 'FAX', requires: 'fax' },
  flyer: { label: 'チラシ投函', requires: 'address' },
};

function log(o, campaignId, facilityKey, action, detail) {
  o.prepare('INSERT INTO logs (campaign_id,facility_key,action,detail,created_at) VALUES (?,?,?,?,?)')
    .run(campaignId ?? null, facilityKey ?? null, action, detail ?? null, now());
}

/** 停止依頼に該当するか（事業所・FAX番号のどちらでも止められる） */
export function isSuppressed(o, facility, channel) {
  const row = o.prepare(`
    SELECT 1 FROM suppressions
    WHERE (channel IS NULL OR channel = ?)
      AND (facility_key = ? OR (fax IS NOT NULL AND fax <> '' AND fax = ?))
    LIMIT 1`).get(channel, facility.facility_key, facility.fax ?? '');
  return Boolean(row);
}

/**
 * 送付リストを作る。
 * @param facilities shuro.db から取り出した事業所（抽出済み）
 * @returns 追加件数と、除外した理由の内訳
 */
export function createCampaign(o, { name, channel, filter, note }, facilities) {
  if (!CHANNELS[channel]) throw new Error(`未対応のチャネル: ${channel}`);
  const exists = o.prepare('SELECT id FROM campaigns WHERE name = ?').get(name);
  if (exists) throw new Error(`「${name}」という名前の送付リストがすでにあります`);

  o.exec('BEGIN');
  try {
    o.prepare('INSERT INTO campaigns (name,channel,filter_json,note,created_at) VALUES (?,?,?,?,?)')
      .run(name, channel, filter ? JSON.stringify(filter) : null, note ?? null, now());
    const id = o.prepare('SELECT last_insert_rowid() id').get().id;

    const ins = o.prepare(`INSERT OR IGNORE INTO targets
      (campaign_id,facility_key,office_no,name,corp_name,prefecture,city,address,phone,fax,url,lat,lng)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const skipped = { 停止依頼: 0, 連絡先なし: 0, 同一住所の重複: 0 };
    const seenAddress = new Set();
    let added = 0;

    for (const f of facilities) {
      if (isSuppressed(o, f, channel)) { skipped.停止依頼++; continue; }
      if (channel === 'fax' && !f.fax) { skipped.連絡先なし++; continue; }
      if (channel !== 'fax' && !f.address_full) { skipped.連絡先なし++; continue; }

      // 郵送とチラシ投函は同じ住所に何通も送っても無駄なので1件にまとめる
      if (channel !== 'fax') {
        const k = `${f.address_full}`;
        if (seenAddress.has(k)) { skipped.同一住所の重複++; continue; }
        seenAddress.add(k);
      }
      ins.run(id, f.facility_key, f.office_no, f.name, f.corp_name, f.prefecture, f.city,
        f.address_full, f.phone, f.fax, f.url, f.lat, f.lng);
      added++;
    }
    log(o, id, null, 'キャンペーン作成', `${CHANNELS[channel].label} / ${added}件`);
    o.exec('COMMIT');
    return { id, name, channel, added, skipped };
  } catch (e) { o.exec('ROLLBACK'); throw e; }
}

export function listCampaigns(o) {
  return o.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM targets t WHERE t.campaign_id = c.id) AS total,
      (SELECT count(*) FROM targets t WHERE t.campaign_id = c.id AND t.status = '送付済') AS sent,
      (SELECT count(*) FROM targets t WHERE t.campaign_id = c.id AND t.status = '未着手') AS pending
    FROM campaigns c ORDER BY c.id DESC`).all();
}

export function getCampaign(o, id) {
  const c = o.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!c) return null;
  const targets = o.prepare('SELECT * FROM targets WHERE campaign_id = ? ORDER BY prefecture, city, name').all(id);
  return { ...c, targets };
}

export function deleteCampaign(o, id) {
  o.prepare('DELETE FROM targets WHERE campaign_id = ?').run(id);
  const r = o.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  log(o, id, null, 'キャンペーン削除', null);
  return r.changes > 0;
}

/** 送付状況の更新。実際に送ったあとに記録する。 */
export function markStatus(o, { campaignId, facilityKeys, status, note }) {
  const ok = ['未着手', '送付済', '返信あり', '不達', '対象外'];
  if (!ok.includes(status)) throw new Error(`不明な状況: ${status}`);
  const stmt = o.prepare('UPDATE targets SET status = ?, sent_at = ?, note = ? WHERE campaign_id = ? AND facility_key = ?');
  const at = status === '送付済' ? now() : null;
  o.exec('BEGIN');
  let n = 0;
  for (const k of facilityKeys) { n += stmt.run(status, at, note ?? null, campaignId, k).changes; }
  log(o, campaignId, null, '状況更新', `${status} × ${n}件`);
  o.exec('COMMIT');
  return n;
}

/** 送付停止の登録。以後すべてのキャンペーンで除外される。 */
export function addSuppression(o, { facilityKey, fax, phone, reason, channel }) {
  if (!facilityKey && !fax && !phone) throw new Error('事業所か番号のどちらかを指定してください');
  o.prepare('INSERT INTO suppressions (facility_key,fax,phone,reason,channel,created_at) VALUES (?,?,?,?,?,?)')
    .run(facilityKey ?? null, fax ?? null, phone ?? null, reason, channel ?? null, now());
  // すでにリストに入っているものは対象外にする
  if (facilityKey) {
    o.prepare("UPDATE targets SET status = '対象外', note = ? WHERE facility_key = ? AND status = '未着手'")
      .run(`送付停止: ${reason}`, facilityKey);
  }
  log(o, null, facilityKey, '送付停止を登録', reason);
  return listSuppressions(o).length;
}

export function listSuppressions(o) {
  return o.prepare('SELECT * FROM suppressions ORDER BY id DESC').all();
}
