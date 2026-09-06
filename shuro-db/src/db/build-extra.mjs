/**
 * 工賃・生産活動を取り込んで facilities に突合する（build.mjs から呼ばれる）。
 * ソースが未取得でも処理は止めず、その旨を報告する。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WAGE_SOURCES, ACTIVITY_SOURCES } from '../ingest/extra/registry.mjs';
import { localName } from '../ingest/extra/fetch.mjs';
import { parseWageSource, parseActivityXlsx } from '../ingest/extra/parse.mjs';
import { classify } from '../ingest/extra/activity.mjs';
import { buildIndex, matchRecord } from './match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data', 'raw', 'extra');

async function readIfExists(p) { try { return await readFile(p); } catch { return null; } }

export async function ingestExtras(db, log = console.log) {
  let available;
  try { available = new Set(await readdir(DIR)); } catch { available = new Set(); }
  if (available.size === 0) {
    log('  工賃・生産活動ソースは未取得です（`npm run fetch:extra` で取得できます）');
    return { wages: 0, activities: 0 };
  }

  const facilities = db.prepare(
    'SELECT facility_key, office_no, name, name_norm, corp_name, corp_no, prefecture, city FROM facilities',
  ).all();
  const svcRows = db.prepare('SELECT facility_key, service_type FROM services').all();
  const servicesByKey = new Map();
  for (const s of svcRows) {
    if (!servicesByKey.has(s.facility_key)) servicesByKey.set(s.facility_key, []);
    servicesByKey.get(s.facility_key).push(s.service_type);
  }
  const index = buildIndex(facilities);

  const insW = db.prepare(`INSERT INTO wages
    (facility_key,prefecture,fiscal_year,service_type,facility_name,corp_name,corp_no,office_no,city,
     capacity,users,total_paid,avg_monthly,match_method,source_url,source_page)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT OR IGNORE INTO activities
    (facility_key,prefecture,facility_name,category,raw_label,detail,origin,match_method,source_name,source_url,source_page)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insS = db.prepare(`INSERT INTO extra_sources
    (kind,prefecture,fiscal_year,service_type,format,rows,matched,source_url,source_page,note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let totalW = 0, totalA = 0, unknownLabels = new Map();

  db.exec('BEGIN');

  // --- 工賃 ---
  for (const src of WAGE_SOURCES) {
    const file = localName(src, 'wage');
    const buf = available.has(file) ? await readIfExists(path.join(DIR, file)) : null;
    if (!buf) { insS.run('wage', src.prefecture, src.fiscalYear ?? null, src.serviceType ?? null, src.format, 0, 0, src.url, src.page ?? null, '未取得'); continue; }

    const { records, warnings } = parseWageSource(src, buf);
    let matched = 0;
    for (const r of records) {
      const { facility, method } = matchRecord(r, index, servicesByKey);
      if (facility) matched++;
      insW.run(facility?.facility_key ?? null, r.prefecture, r.fiscalYear, r.serviceType, r.facilityName,
        r.corpName, r.corpNo, r.officeNo, r.city, r.capacity, r.users, r.totalPaid, r.avgMonthly,
        method, r.sourceUrl, r.sourcePage ?? null);
      totalW++;

      // 北海道の工賃PDFに載っている「主な作業内容」はそのまま生産活動として取り込む
      for (const raw of r.activities ?? []) {
        const { label, category } = classify(raw);
        if (!label) continue;
        if (!category) { unknownLabels.set(label, (unknownLabels.get(label) ?? 0) + 1); continue; }
        insA.run(facility?.facility_key ?? null, r.prefecture, r.facilityName, category, label, null,
          'published', method, `${r.prefecture} 工賃実績（主な作業内容）`, r.sourceUrl, r.sourcePage ?? null);
        totalA++;
      }
    }
    insS.run('wage', src.prefecture, src.fiscalYear ?? null, src.serviceType ?? null, src.format,
      records.length, matched, src.url, src.page ?? null, warnings.join(' / ') || null);
    const pct = records.length ? ((matched / records.length) * 100).toFixed(0) : '0';
    log(`  [工賃] ${src.prefecture} ${src.fiscalYear}年度${src.serviceType ? ` ${src.serviceType}` : ''}: ${records.length}件 → 突合 ${matched}件 (${pct}%)`);
    for (const w of warnings) log(`         ⚠ ${w}`);
  }

  // --- 生産活動 ---
  for (const src of ACTIVITY_SOURCES) {
    const file = localName(src, 'activity');
    const buf = available.has(file) ? await readIfExists(path.join(DIR, file)) : null;
    if (!buf) { insS.run('activity', src.prefecture, null, null, src.format, 0, 0, src.url, src.page ?? null, '未取得'); continue; }
    const { records, warnings } = parseActivityXlsx(src, buf);
    let matched = 0, kept = 0;
    for (const r of records) {
      const { label, category } = classify(r.category);
      if (!label) continue;
      if (!category) { unknownLabels.set(label, (unknownLabels.get(label) ?? 0) + 1); continue; }
      const { facility, method } = matchRecord({ ...r, serviceType: null }, index, servicesByKey);
      if (facility) matched++;
      insA.run(facility?.facility_key ?? null, r.prefecture, r.facilityName, category, label, r.detail,
        'published', method, src.name, r.sourceUrl, r.sourcePage ?? null);
      kept++; totalA++;
    }
    insS.run('activity', src.prefecture, null, null, src.format, records.length, matched, src.url, src.page ?? null, warnings.join(' / ') || null);
    log(`  [生産活動] ${src.prefecture}: ${records.length}件 → 突合 ${matched}件`);
  }

  db.exec('COMMIT');

  if (unknownLabels.size) {
    const top = [...unknownLabels].sort((a, b) => b[1] - a[1]).slice(0, 5);
    log(`  未分類の作業内容表記 ${unknownLabels.size}種: ${top.map(([k, v]) => `${k}(${v})`).join(', ')}`);
  }
  return { wages: totalW, activities: totalA };
}
