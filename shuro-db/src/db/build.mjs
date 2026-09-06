/**
 * raw（ZIP）→ normalized → merged（SQLite）
 * data/raw/<period>/*.zip をすべて読み、期の古い順に積み上げる。
 * 最新期に存在しないレコードは削除せず 'presumed_closed' に落とす。
 *
 * 冪等：何度実行しても同じ結果になる（DBを作り直す）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsvFromZip } from '../ingest/unzip.mjs';
import { parseCsvObjects } from '../ingest/csv.mjs';
import { TARGET_SERVICE_TYPES, WAMNET_INDEX } from '../ingest/sources.mjs';
import { ingestExtras } from './build-extra.mjs';
import {
  normalizeText, normalizeCorpName, splitAddress,
  normalizePhone, parseCapacity, parseLatLng, normalizeUrl, PREF_BY_CODE,
} from '../ingest/normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const DB_PATH = path.join(ROOT, 'data', 'shuro.db');

const C = {
  prefCode: '都道府県コード又は市区町村コード',
  no: 'NO（※システム内の固有の番号、連番）',
  designator: '指定機関名',
  corpName: '法人の名称', corpKana: '法人の名称_かな', corpNo: '法人番号', corpUrl: '法人URL',
  serviceType: 'サービス種別',
  name: '事業所の名称', nameKana: '事業所の名称_かな', officeNo: '事業所番号',
  city: '事業所住所（市区町村）', detail: '事業所住所（番地以降）',
  phone: '事業所電話番号', fax: '事業所FAX番号', url: '事業所URL',
  lat: '事業所緯度', lng: '事業所経度',
  hWeek: '利用可能な時間帯（平日）', hSat: '利用可能な時間帯（土曜）',
  hSun: '利用可能な時間帯（日曜）', hHol: '利用可能な時間帯（祝日）',
  closed: '定休日', note: '利用可能曜日特記事項（留意事項）', capacity: '定員',
};

const periodLabel = (p) => `${p.slice(0, 4)}年${Number(p.slice(4, 6))}月末時点`;

/**
 * 施設の同一性キー。
 * 事業所番号だけでは一意にならない（同一番号で別事業所が実在する）ため名称を併用する。
 * 住所は含めない：建物名・階数・部屋番号の変更で同一施設が分裂するため。
 * 実データでの検証結果（202509→202603）:
 *   番号+名+住所 … 誤って消失扱い 959件 / 過剰マージ 0
 *   番号+名      … 誤って消失扱い 576件 / 過剰マージ 0  ← これを採用
 *   名+市区町村   … 誤って消失扱い 530件 / 過剰マージ 618（別事業所を混ぜるため不採用）
 */
function facilityKey(officeNo, nameNorm) {
  return createHash('sha1').update(`${officeNo}|${nameNorm}`).digest('hex').slice(0, 16);
}

/** CSV 1行 → 正規化済みレコード。判断に迷う欠損は null のまま残す（推測で埋めない）。 */
export function normalizeRow(r) {
  const officeNo = (r[C.officeNo] ?? '').trim();
  const prefCode = (r[C.prefCode] ?? '').trim().slice(0, 2);
  const addr = splitAddress(r[C.city], r[C.detail], prefCode);
  const nameNorm = normalizeText(r[C.name]);
  const phone = normalizePhone(r[C.phone]);
  const fax = normalizePhone(r[C.fax]);
  const { lat, lng } = parseLatLng(r[C.lat], r[C.lng]);

  const searchText = normalizeText([
    r[C.name], r[C.nameKana], r[C.corpName], r[C.corpKana],
    addr.full, officeNo, phone.digits,
  ].filter(Boolean).join(' '));

  return {
    key: facilityKey(officeNo, nameNorm),
    officeNo,
    nameNorm,
    name: (r[C.name] ?? '').trim(),
    nameKana: (r[C.nameKana] ?? '').trim() || null,
    corpName: (r[C.corpName] ?? '').trim() || null,
    corpKana: (r[C.corpKana] ?? '').trim() || null,
    corpNo: (r[C.corpNo] ?? '').trim() || null,
    corpUrl: normalizeUrl(r[C.corpUrl]),
    designator: (r[C.designator] ?? '').trim() || null,
    prefCode,
    prefecture: addr.prefecture || PREF_BY_CODE[prefCode] || '',
    city: addr.city,
    addressDetail: addr.detail || null,
    addressFull: addr.full,
    phone: phone.display || null,
    fax: fax.display || null,
    url: normalizeUrl(r[C.url]),
    lat, lng,
    searchText,
    corpNorm: normalizeCorpName(r[C.corpName]),
    service: {
      type: (r[C.serviceType] ?? '').trim(),
      sourceNo: (r[C.no] ?? '').trim(),
      capacity: parseCapacity(r[C.capacity]),
      hWeek: (r[C.hWeek] ?? '').trim() || null,
      hSat: (r[C.hSat] ?? '').trim() || null,
      hSun: (r[C.hSun] ?? '').trim() || null,
      hHol: (r[C.hHol] ?? '').trim() || null,
      closed: (r[C.closed] ?? '').trim() || null,
      note: (r[C.note] ?? '').trim() || null,
    },
  };
}

async function readPeriod(period) {
  const dir = path.join(RAW_DIR, period);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.zip')).sort();
  const rows = [];
  for (const f of files) {
    const buf = await readFile(path.join(dir, f));
    const { text } = readCsvFromZip(buf);
    const { records } = parseCsvObjects(text);
    for (const rec of records) {
      const st = (rec[C.serviceType] ?? '').trim();
      if (!TARGET_SERVICE_TYPES.includes(st)) continue;
      rows.push(rec);
    }
  }
  return rows;
}

export async function build({ dbPath = DB_PATH, verbose = true } = {}) {
  const log = verbose ? console.log : () => {};
  let periods;
  try {
    periods = (await readdir(RAW_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name).sort();
  } catch {
    throw new Error('data/raw が見つかりません。先に `npm run fetch` を実行してください。');
  }
  if (periods.length === 0) throw new Error('取り込めるスナップショットがありません。`npm run fetch` を実行してください。');

  await mkdir(path.dirname(dbPath), { recursive: true });
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const db = new DatabaseSync(dbPath);
  const schema = await readFile(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);

  const latest = periods[periods.length - 1];
  log(`スナップショット: ${periods.join(' → ')}（最新: ${latest}）`);

  const facilities = new Map();  // key -> record
  const services = new Map();    // `${key}|${type}` -> record
  const seenByPeriod = new Map();

  for (const period of periods) {
    const raw = await readPeriod(period);
    const keysThisPeriod = new Set();
    let dupes = 0;

    for (const r of raw) {
      const n = normalizeRow(r);
      if (!n.officeNo || !n.name) continue;

      const prev = facilities.get(n.key);
      if (prev) { prev.last_seen = period; Object.assign(prev, pickLive(n), { first_seen: prev.first_seen, last_seen: period }); }
      else facilities.set(n.key, { ...pickLive(n), facility_key: n.key, first_seen: period, last_seen: period });

      const sk = `${n.key}|${n.service.type}`;
      if (keysThisPeriod.has(sk)) { dupes++; continue; }
      keysThisPeriod.add(sk);

      const sprev = services.get(sk);
      if (sprev) { Object.assign(sprev, sliceService(n), { first_seen: sprev.first_seen, last_seen: period }); }
      else services.set(sk, { ...sliceService(n), facility_key: n.key, service_type: n.service.type, first_seen: period, last_seen: period });
    }
    seenByPeriod.set(period, keysThisPeriod);
    log(`  [${period}] ${raw.length}件 読み込み（同一施設・同一種別の重複 ${dupes}件を除外）`);

    db.prepare(`INSERT OR REPLACE INTO snapshots (period,label,source_url,fetched_at,record_count) VALUES (?,?,?,?,?)`)
      .run(period, periodLabel(period), WAMNET_INDEX, new Date().toISOString(), raw.length);
  }

  // 最新期に居ないものは廃止（推定）。削除はしない。
  for (const f of facilities.values()) f.status = f.last_seen === latest ? 'active' : 'presumed_closed';
  for (const s of services.values()) s.status = s.last_seen === latest ? 'active' : 'presumed_closed';

  // 書き込み
  const insF = db.prepare(`INSERT INTO facilities
    (facility_key,office_no,name,name_norm,name_kana,corp_name,corp_kana,corp_no,corp_url,designator,
     pref_code,prefecture,city,address_detail,address_full,phone,fax,url,lat,lng,search_text,
     first_seen,last_seen,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insS = db.prepare(`INSERT INTO services
    (facility_key,service_type,source_no,capacity,hours_weekday,hours_sat,hours_sun,hours_holiday,
     closed_days,hours_note,first_seen,last_seen,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insC = db.prepare(`INSERT INTO changes (period,facility_key,service_type,change,detail) VALUES (?,?,?,?,?)`);

  db.exec('BEGIN');
  for (const f of facilities.values()) {
    insF.run(f.facility_key, f.office_no, f.name, f.name_norm, f.name_kana, f.corp_name, f.corp_kana, f.corp_no,
      f.corp_url, f.designator, f.pref_code, f.prefecture, f.city, f.address_detail, f.address_full,
      f.phone, f.fax, f.url, f.lat, f.lng, f.search_text, f.first_seen, f.last_seen, f.status);
  }
  for (const s of services.values()) {
    insS.run(s.facility_key, s.service_type, s.source_no, s.capacity, s.hours_weekday, s.hours_sat,
      s.hours_sun, s.hours_holiday, s.closed_days, s.hours_note, s.first_seen, s.last_seen, s.status);
  }
  // 差分
  for (let i = 1; i < periods.length; i++) {
    const prev = seenByPeriod.get(periods[i - 1]);
    const cur = seenByPeriod.get(periods[i]);
    for (const k of cur) if (!prev.has(k)) { const [fk, st] = k.split('|'); insC.run(periods[i], fk, st, 'added', null); }
    for (const k of prev) if (!cur.has(k)) { const [fk, st] = k.split('|'); insC.run(periods[i], fk, st, 'disappeared', '前期に存在し当期に消失'); }
  }
  db.exec('COMMIT');

  const candidates = writeMergeCandidates(db);

  log('\n工賃・生産活動の取り込み');
  const extras = await ingestExtras(db, log);

  writeQualityMetrics(db, latest);

  const stats = {
    periods,
    latest,
    facilities: facilities.size,
    services: services.size,
    active: [...facilities.values()].filter((f) => f.status === 'active').length,
    closed: [...facilities.values()].filter((f) => f.status === 'presumed_closed').length,
  };
  log(`\n施設 ${stats.facilities}件（稼働 ${stats.active} / 掲載なし ${stats.closed}）`);
  log(`名寄せ候補（自動統合せず要確認）: ${candidates}件`);
  log(`サービス ${stats.services}件`);
  if (extras.wages || extras.activities) {
    const wm = db.prepare("SELECT count(*) c FROM wages WHERE facility_key IS NOT NULL").get().c;
    const am = db.prepare("SELECT count(DISTINCT facility_key) c FROM activities WHERE facility_key IS NOT NULL").get().c;
    log(`工賃 ${extras.wages}件（うち事業所に紐付いたもの ${wm}件）`);
    log(`生産活動 ${extras.activities}件（${am}事業所に紐付け）`);
  }
  if (periods.length > 1) {
    const added = db.prepare(`SELECT count(*) c FROM changes WHERE change='added' AND period=?`).get(latest).c;
    const gone = db.prepare(`SELECT count(*) c FROM changes WHERE change='disappeared' AND period=?`).get(latest).c;
    log(`差分（${periods[periods.length - 2]} → ${latest}）: 新規 ${added} / 消失 ${gone}`);
  }
  db.close();
  return stats;
}

function pickLive(n) {
  return {
    office_no: n.officeNo, name: n.name, name_norm: n.nameNorm, name_kana: n.nameKana,
    corp_name: n.corpName, corp_kana: n.corpKana, corp_no: n.corpNo, corp_url: n.corpUrl,
    designator: n.designator, pref_code: n.prefCode, prefecture: n.prefecture, city: n.city,
    address_detail: n.addressDetail, address_full: n.addressFull,
    phone: n.phone, fax: n.fax, url: n.url, lat: n.lat, lng: n.lng, search_text: n.searchText,
  };
}
function sliceService(n) {
  return {
    source_no: n.service.sourceNo, capacity: n.service.capacity,
    hours_weekday: n.service.hWeek, hours_sat: n.service.hSat, hours_sun: n.service.hSun,
    hours_holiday: n.service.hHol, closed_days: n.service.closed, hours_note: n.service.note,
  };
}

/**
 * 名寄せ候補の抽出。
 * 「最新データに掲載がない施設」と「同じ名称・同じ市区町村で掲載がある施設」を突き合わせる。
 * 事業所番号の変更や移転で別レコードになったケースを人が確認できるようにする。
 * 自動では統合しない（別法人の同名施設を誤って統合しうるため）。
 */
function writeMergeCandidates(db) {
  const rows = db.prepare(`
    SELECT f.facility_key AS closed_key, g.facility_key AS active_key,
           f.office_no AS o1, g.office_no AS o2
    FROM facilities f
    JOIN facilities g
      ON g.status = 'active' AND g.name_norm = f.name_norm
     AND g.prefecture = f.prefecture AND g.city = f.city
     AND g.facility_key <> f.facility_key
    WHERE f.status = 'presumed_closed'
  `).all();
  const ins = db.prepare('INSERT OR IGNORE INTO merge_candidates (closed_key,active_key,reason) VALUES (?,?,?)');
  db.exec('BEGIN');
  for (const r of rows) {
    const reason = r.o1 === r.o2 ? '同一事業所番号・同一名称・同一市区町村' : `事業所番号が変更された可能性（${r.o1} → ${r.o2}）`;
    ins.run(r.closed_key, r.active_key, reason);
  }
  db.exec('COMMIT');
  return rows.length;
}

function writeQualityMetrics(db, period) {
  const total = db.prepare('SELECT count(*) c FROM facilities').get().c;
  const put = db.prepare('INSERT OR REPLACE INTO quality_metrics (period,metric,value,detail) VALUES (?,?,?,?)');
  const missing = (col) => db.prepare(`SELECT count(*) c FROM facilities WHERE ${col} IS NULL OR ${col}=''`).get().c;
  db.exec('BEGIN');
  for (const col of ['corp_no', 'url', 'phone', 'lat', 'name_kana', 'fax']) {
    const m = missing(col);
    put.run(period, `missing.${col}`, total ? m / total : 0, `${m}/${total}`);
  }
  const capMissing = db.prepare(`SELECT count(*) c FROM services WHERE capacity IS NULL`).get().c;
  const svcTotal = db.prepare(`SELECT count(*) c FROM services`).get().c;
  put.run(period, 'missing.capacity', svcTotal ? capMissing / svcTotal : 0, `${capMissing}/${svcTotal}`);
  const cand = db.prepare('SELECT count(*) c FROM merge_candidates').get().c;
  put.run(period, 'merge_candidates', cand, '自動統合せず要確認');
  put.run(period, 'facilities.total', total, null);
  put.run(period, 'services.total', svcTotal, null);
  db.exec('COMMIT');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((e) => { console.error(`\nエラー: ${e.message}`); process.exit(1); });
}
