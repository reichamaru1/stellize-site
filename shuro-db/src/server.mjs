/**
 * 読み取り専用 API + 静的配信。外部依存なし（node:http / node:sqlite）。
 *   npm start   → http://localhost:8787
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText } from './ingest/normalize.mjs';
import { buildTables } from './export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'shuro.db');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 8787);

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch {
  console.error('data/shuro.db がありません。`npm run fetch && npm run build` を先に実行してください。');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const json = (res, data, status = 200) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'public, max-age=300' });
  res.end(body);
};

/** クエリ文字列から検索条件を組み立てる（SQLは常にプレースホルダ経由） */
function buildWhere(sp) {
  const where = [];
  const params = [];

  const status = sp.get('status') ?? 'active';
  if (status !== 'all') { where.push('f.status = ?'); params.push(status); }

  const q = (sp.get('q') ?? '').trim();
  if (q) { where.push('f.search_text LIKE ?'); params.push(`%${normalizeText(q)}%`); }

  const pref = (sp.get('pref') ?? '').trim();
  if (pref) { where.push('f.prefecture = ?'); params.push(pref); }

  const city = (sp.get('city') ?? '').trim();
  if (city) { where.push('f.city = ?'); params.push(city); }

  const services = sp.getAll('service').filter(Boolean);
  if (services.length) {
    where.push(`EXISTS (SELECT 1 FROM services s WHERE s.facility_key = f.facility_key
      AND s.service_type IN (${services.map(() => '?').join(',')})
      ${status === 'all' ? '' : 'AND s.status = ?'})`);
    params.push(...services);
    if (status !== 'all') params.push(status);
  }

  const capMin = sp.get('capacity_min');
  const capMax = sp.get('capacity_max');
  if (capMin || capMax) {
    const sub = ['s2.facility_key = f.facility_key', 's2.capacity IS NOT NULL'];
    if (capMin) { sub.push('s2.capacity >= ?'); }
    if (capMax) { sub.push('s2.capacity <= ?'); }
    where.push(`EXISTS (SELECT 1 FROM services s2 WHERE ${sub.join(' AND ')})`);
    if (capMin) params.push(Number(capMin));
    if (capMax) params.push(Number(capMax));
  }

  const hasGeo = sp.get('has_geo');
  if (hasGeo === '1') where.push('f.lat IS NOT NULL');

  // 現在地からの距離で絞る。まず外接矩形でSQLを絞り、正確な距離はJS側で出す
  // （SQLiteの数学関数の有無に依存させないため）。
  const near = parseNear(sp);
  if (near) {
    const dLat = near.radiusKm / 111.32;
    const dLng = near.radiusKm / (111.32 * Math.max(0.1, Math.cos((near.lat * Math.PI) / 180)));
    where.push('f.lat IS NOT NULL AND f.lat BETWEEN ? AND ? AND f.lng BETWEEN ? AND ?');
    params.push(near.lat - dLat, near.lat + dLat, near.lng - dLng, near.lng + dLng);
  }

  // 生産活動（統一分類）。公表データがある事業所のみが対象。
  const activities = sp.getAll('activity').filter(Boolean);
  if (activities.length) {
    where.push(`EXISTS (SELECT 1 FROM activities a WHERE a.facility_key = f.facility_key
      AND a.category IN (${activities.map(() => '?').join(',')}))`);
    params.push(...activities);
  }

  // 工賃（平均工賃月額）。事業所ごとに最新年度の値で判定する。
  const wageMin = sp.get('wage_min');
  const wageMax = sp.get('wage_max');
  const hasWage = sp.get('has_wage');
  if (wageMin || wageMax || hasWage === '1') {
    const sub = ['w.facility_key = f.facility_key'];
    if (wageMin) sub.push('w.avg_monthly >= ?');
    if (wageMax) sub.push('w.avg_monthly <= ?');
    where.push(`EXISTS (SELECT 1 FROM wages w WHERE ${sub.join(' AND ')})`);
    if (wageMin) params.push(Number(wageMin));
    if (wageMax) params.push(Number(wageMax));
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** 2点間の距離（km）。ヒュベニの簡易式ではなく素直なハーバサイン。 */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** `near=緯度,経度` と `radius_km` を読む。中心が不正なら null。 */
function parseNear(sp) {
  const raw = (sp.get('near') ?? '').trim();
  if (!raw) return null;
  const [latS, lngS] = raw.split(',');
  const lat = Number(latS), lng = Number(lngS);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return null;
  const radiusKm = Math.min(Math.max(Number(sp.get('radius_km') ?? 10), 0.5), 200);
  return { lat, lng, radiusKm };
}

const SORTS = {
  name: 'f.name COLLATE NOCASE ASC',
  pref: 'f.pref_code ASC, f.city ASC, f.name ASC',
  newest: 'f.first_seen DESC, f.name ASC',
  // 工賃の高い順。工賃データが無い事業所は後ろにまとめる。
  wage_desc: '(SELECT max(w.avg_monthly) FROM wages w WHERE w.facility_key = f.facility_key) DESC NULLS LAST, f.name ASC',
  wage_asc: '(SELECT min(w.avg_monthly) FROM wages w WHERE w.facility_key = f.facility_key) ASC NULLS LAST, f.name ASC',
};

function attachServices(rows) {
  if (rows.length === 0) return rows;
  const keys = rows.map((r) => r.facility_key);
  const ph = keys.map(() => '?').join(',');

  const svc = db.prepare(
    `SELECT facility_key, service_type, capacity, status FROM services
     WHERE facility_key IN (${ph}) ORDER BY service_type`,
  ).all(...keys);
  const byKey = new Map();
  for (const s of svc) {
    if (!byKey.has(s.facility_key)) byKey.set(s.facility_key, []);
    byKey.get(s.facility_key).push({ service_type: s.service_type, capacity: s.capacity, status: s.status });
  }

  // 生産活動（分類の重複は畳む）
  const acts = db.prepare(
    `SELECT DISTINCT facility_key, category FROM activities
     WHERE facility_key IN (${ph}) ORDER BY category`,
  ).all(...keys);
  const actByKey = new Map();
  for (const a of acts) {
    if (!actByKey.has(a.facility_key)) actByKey.set(a.facility_key, []);
    actByKey.get(a.facility_key).push(a.category);
  }

  // 工賃は事業所ごとに最新年度のものを代表値にする
  const wages = db.prepare(
    `SELECT facility_key, service_type, fiscal_year, avg_monthly, prefecture FROM wages
     WHERE facility_key IN (${ph}) ORDER BY fiscal_year DESC, avg_monthly DESC`,
  ).all(...keys);
  const wageByKey = new Map();
  for (const w of wages) if (!wageByKey.has(w.facility_key)) wageByKey.set(w.facility_key, w);

  return rows.map((r) => ({
    ...r,
    services: byKey.get(r.facility_key) ?? [],
    activities: actByKey.get(r.facility_key) ?? [],
    wage: wageByKey.get(r.facility_key) ?? null,
  }));
}

const COLS = `f.facility_key, f.office_no, f.name, f.name_kana, f.corp_name, f.prefecture, f.city,
              f.address_full, f.phone, f.url, f.lat, f.lng, f.status, f.first_seen, f.last_seen`;

function search(sp) {
  const { sql, params } = buildWhere(sp);
  const per = Math.min(Math.max(Number(sp.get('per') ?? 20), 1), 200);
  const page = Math.max(Number(sp.get('page') ?? 1), 1);
  const near = parseNear(sp);

  // 距離で絞る場合は、矩形で絞ったうえで正確な距離を計算し、円の外を落としてから並べ替える
  if (near) {
    const all = db.prepare(`SELECT ${COLS} FROM facilities f ${sql}`).all(...params)
      .map((r) => ({ ...r, distance_km: distanceKm(near.lat, near.lng, r.lat, r.lng) }))
      .filter((r) => r.distance_km <= near.radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);
    const slice = all.slice((page - 1) * per, page * per);
    return {
      total: all.length, page, per, pages: Math.ceil(all.length / per),
      near: { ...near }, items: attachServices(slice),
    };
  }

  const sort = SORTS[sp.get('sort') ?? 'pref'] ?? SORTS.pref;
  const total = db.prepare(`SELECT count(*) c FROM facilities f ${sql}`).get(...params).c;
  const rows = db.prepare(`SELECT ${COLS} FROM facilities f ${sql} ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .all(...params, per, (page - 1) * per);
  return { total, page, per, pages: Math.ceil(total / per), items: attachServices(rows) };
}

/**
 * 地図用。ページに関係なく、条件に合う全件の座標を返す（上限あり）。
 * 一覧が数千件あるのに地図へ20件しか出ないのを避けるため。
 */
function mapPoints(sp) {
  const { sql, params } = buildWhere(sp);
  const CAP = 3000;
  const near = parseNear(sp);
  // buildWhere が WHERE を返すかどうかで繋ぎ方が変わる
  const geo = sql ? `${sql} AND f.lat IS NOT NULL` : 'WHERE f.lat IS NOT NULL';
  let rows = db.prepare(
    `SELECT f.facility_key, f.name, f.prefecture, f.city, f.lat, f.lng FROM facilities f ${geo} LIMIT ?`,
  ).all(...params, CAP + 1);
  if (near) {
    rows = rows
      .map((r) => ({ ...r, distance_km: distanceKm(near.lat, near.lng, r.lat, r.lng) }))
      .filter((r) => r.distance_km <= near.radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);
  }
  const truncated = rows.length > CAP;
  return { points: rows.slice(0, CAP), truncated, cap: CAP };
}

/** 地名（都道府県＋市区町村）の候補。市区町村を全国から直接選べるようにするため。 */
function places(q) {
  const t = normalizeText(q ?? '');
  if (!t) return [];
  return db.prepare(
    `SELECT prefecture, city, count(*) c FROM facilities
     WHERE status='active' AND (replace(prefecture,' ','') || replace(city,' ','')) LIKE ?
     GROUP BY 1,2 ORDER BY c DESC LIMIT 30`,
  ).all(`%${q.trim()}%`);
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv(sp) {
  const { sql, params } = buildWhere(sp);
  const rows = db.prepare(
    `SELECT f.office_no, f.name, f.name_kana, f.corp_name, f.corp_no, f.prefecture, f.city,
            f.address_full, f.phone, f.fax, f.url, f.lat, f.lng, f.status, f.first_seen, f.last_seen,
            (SELECT group_concat(s.service_type || CASE WHEN s.capacity IS NULL THEN '' ELSE '(定員' || s.capacity || ')' END, ' / ')
             FROM services s WHERE s.facility_key = f.facility_key) AS services,
            (SELECT group_concat(DISTINCT a.category) FROM activities a WHERE a.facility_key = f.facility_key) AS activities,
            (SELECT max(w.avg_monthly) FROM wages w WHERE w.facility_key = f.facility_key) AS wage_avg_monthly,
            (SELECT max(w.fiscal_year) FROM wages w WHERE w.facility_key = f.facility_key) AS wage_fiscal_year
     FROM facilities f ${sql} ORDER BY f.pref_code, f.city, f.name LIMIT 60000`,
  ).all(...params);
  const header = ['事業所番号', '事業所名', 'ふりがな', '法人名', '法人番号', '都道府県', '市区町村', '住所', '電話番号', 'FAX', 'URL', '緯度', '経度', '状態', '初出', '最終確認', 'サービス', '生産活動', '平均工賃月額', '工賃の年度'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push(Object.values(r).map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function meta() {
  const snapshots = db.prepare('SELECT period, label, record_count FROM snapshots ORDER BY period DESC').all();
  const serviceTypes = db.prepare("SELECT service_type, count(*) c FROM services WHERE status='active' GROUP BY 1 ORDER BY c DESC").all();
  const prefs = db.prepare("SELECT prefecture, pref_code, count(*) c FROM facilities WHERE status='active' GROUP BY 1,2 ORDER BY pref_code").all();
  const quality = db.prepare('SELECT metric, value, detail FROM quality_metrics ORDER BY metric').all();
  const totals = db.prepare("SELECT count(*) c FROM facilities WHERE status='active'").get().c;
  const closed = db.prepare("SELECT count(*) c FROM facilities WHERE status='presumed_closed'").get().c;

  const activityCategories = db.prepare(
    `SELECT category, count(DISTINCT facility_key) c FROM activities
     WHERE facility_key IS NOT NULL GROUP BY 1 ORDER BY c DESC`,
  ).all();
  const extraSources = db.prepare(
    `SELECT kind, prefecture, fiscal_year, service_type, format, rows, matched, source_page, source_url, note
     FROM extra_sources ORDER BY kind, prefecture, fiscal_year DESC`,
  ).all();
  const wageStats = db.prepare(
    `SELECT count(*) records, count(DISTINCT facility_key) facilities,
            min(avg_monthly) min, max(avg_monthly) max
     FROM wages WHERE facility_key IS NOT NULL`,
  ).get();
  const wageByPref = db.prepare(
    `SELECT prefecture, fiscal_year, service_type, count(*) c, round(avg(avg_monthly)) avg
     FROM wages GROUP BY prefecture, fiscal_year, service_type ORDER BY prefecture`,
  ).all();

  return {
    snapshots, latest: snapshots[0] ?? null, serviceTypes, prefectures: prefs, quality,
    totals: { active: totals, presumedClosed: closed },
    activityCategories, extraSources, wageStats, wageByPref,
  };
}

function cities(pref) {
  return db.prepare("SELECT city, count(*) c FROM facilities WHERE status='active' AND prefecture=? GROUP BY 1 ORDER BY city").all(pref);
}

function detail(key) {
  const f = db.prepare('SELECT * FROM facilities WHERE facility_key=?').get(key);
  if (!f) return null;
  const services = db.prepare('SELECT * FROM services WHERE facility_key=? ORDER BY service_type').all(key);
  // 同一事業所番号の関連事業所（併設・系列）
  const related = db.prepare(
    `SELECT facility_key, name, prefecture, city, status FROM facilities
     WHERE office_no=? AND facility_key<>? ORDER BY name`,
  ).all(f.office_no, key);
  const history = db.prepare(
    "SELECT period, change, service_type FROM changes WHERE facility_key=? ORDER BY period",
  ).all(key);
  // 名寄せ候補（自動統合していないもの）。双方向に引く。
  const candidates = db.prepare(
    `SELECT m.reason,
            CASE WHEN m.closed_key = :k THEN m.active_key ELSE m.closed_key END AS other_key,
            o.name, o.address_full, o.status
     FROM merge_candidates m
     JOIN facilities o ON o.facility_key =
       CASE WHEN m.closed_key = :k THEN m.active_key ELSE m.closed_key END
     WHERE m.closed_key = :k OR m.active_key = :k`,
  ).all({ k: key });
  const wages = db.prepare(
    `SELECT fiscal_year, service_type, prefecture, capacity, users, total_paid, avg_monthly,
            match_method, source_url, source_page
     FROM wages WHERE facility_key=? ORDER BY fiscal_year DESC, service_type`,
  ).all(key);
  const activities = db.prepare(
    `SELECT category, raw_label, detail, origin, source_name, source_url, source_page
     FROM activities WHERE facility_key=? ORDER BY category`,
  ).all(key);
  return { ...f, services, related, history, candidates, wages, activities };
}

function trend() {
  return db.prepare(
    `SELECT s.period, s.label, s.record_count,
            (SELECT count(*) FROM changes c WHERE c.period=s.period AND c.change='added') AS added,
            (SELECT count(*) FROM changes c WHERE c.period=s.period AND c.change='disappeared') AS disappeared
     FROM snapshots s ORDER BY s.period`,
  ).all();
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  } catch {
    // SPA ルーティング: 未知のパスは index.html を返す
    try {
      const body = await readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(body);
    } catch { res.writeHead(404).end('Not Found'); }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/meta') return json(res, meta());
    if (p === '/api/trend') return json(res, trend());
    if (p === '/api/cities') return json(res, cities(url.searchParams.get('pref') ?? ''));
    if (p === '/api/places') return json(res, places(url.searchParams.get('q')));
    if (p === '/api/map') return json(res, mapPoints(url.searchParams));
    if (p === '/api/facilities') return json(res, search(url.searchParams));
    if (p.startsWith('/api/facilities/')) {
      const d = detail(decodeURIComponent(p.slice('/api/facilities/'.length)));
      return d ? json(res, d) : json(res, { error: '該当する事業所が見つかりません' }, 404);
    }
    // スプレッドシート向けの一括書き出し。検索条件に関係なく全件を出す。
    if (p === '/api/export/list') {
      return json(res, Object.keys(buildTables(db)).map((n) => ({ name: n, url: `/api/export/${encodeURIComponent(n)}` })));
    }
    if (p.startsWith('/api/export/')) {
      const name = decodeURIComponent(p.slice('/api/export/'.length));
      const tables = buildTables(db);
      if (!tables[name]) return json(res, { error: '該当する書き出しがありません' }, 404);
      const body = Buffer.from(tables[name], 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    if (p === '/api/export.csv') {
      const body = Buffer.from(exportCsv(url.searchParams), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="shuro-facilities-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    if (p.startsWith('/api/')) return json(res, { error: 'Unknown endpoint' }, 404);
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    return json(res, { error: 'サーバ内部エラー', detail: e.message }, 500);
  }
});

server.listen(PORT, () => {
  const m = meta();
  console.log(`就労支援事業所DB → http://localhost:${PORT}`);
  console.log(`  データ基準: ${m.latest?.label ?? '不明'} / 稼働 ${m.totals.active}件`);
});
