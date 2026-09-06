/**
 * 突合精度の実測。
 * 事業所番号を持つソース（福岡・岡山・愛知）を正解データとして、
 * 番号を隠して名称ベースで突合したときに同じ事業所を選べるかを測る。
 * ここで得た精度を、番号を持たないソース（北海道・千葉・大阪・神奈川・和歌山・新潟）
 * の確からしさの根拠として使う。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { WAGE_SOURCES } from './src/ingest/extra/registry.mjs';
import { localName } from './src/ingest/extra/fetch.mjs';
import { parseWageSource } from './src/ingest/extra/parse.mjs';
import { buildIndex, matchRecord } from './src/db/match.mjs';

const db = new DatabaseSync('data/shuro.db', { readOnly: true });
const facilities = db.prepare(
  'SELECT facility_key, office_no, name, name_norm, corp_name, corp_no, prefecture, city FROM facilities',
).all();
const svc = db.prepare('SELECT facility_key, service_type FROM services').all();
const servicesByKey = new Map();
for (const s of svc) {
  if (!servicesByKey.has(s.facility_key)) servicesByKey.set(s.facility_key, []);
  servicesByKey.get(s.facility_key).push(s.service_type);
}
const index = buildIndex(facilities);

const stats = { truth: 0, agree: 0, disagree: 0, missed: 0, byMethod: new Map() };
const disagreements = [];

for (const src of WAGE_SOURCES) {
  const p = `data/raw/extra/${localName(src, 'wage')}`;
  if (!existsSync(p)) continue;
  const { records } = parseWageSource(src, readFileSync(p));
  for (const r of records) {
    if (!r.officeNo) continue;
    // 正解：事業所番号での突合
    const truth = matchRecord(r, index, servicesByKey);
    if (!truth.facility) continue;
    if (!String(truth.method).startsWith('office_no')) continue;
    stats.truth++;

    // 検証：番号を隠して名称だけで突合
    const blind = matchRecord({ ...r, officeNo: null, corpNo: null }, index, servicesByKey);
    const m = blind.method;
    stats.byMethod.set(m, (stats.byMethod.get(m) ?? 0) + 1);
    if (!blind.facility) { stats.missed++; continue; }
    if (blind.facility.facility_key === truth.facility.facility_key) stats.agree++;
    else if (blind.facility.office_no === truth.facility.office_no) {
      // 事業所番号が同じ＝同じ事業所。名称の揺れでレコードが分かれているだけで、
      // 別の事業所を掴んだわけではない。
      stats.sameOffice = (stats.sameOffice ?? 0) + 1;
    } else {
      stats.disagree++;
      if (disagreements.length < 6) {
        disagreements.push({
          src: `${src.prefecture}`, name: r.facilityName, city: r.city,
          truth: `${truth.facility.name} / ${truth.facility.city} / ${truth.facility.office_no}`,
          blind: `${blind.facility.name} / ${blind.facility.city} / ${blind.facility.office_no}`,
          method: m,
        });
      }
    }
  }
}

stats.sameOffice = stats.sameOffice ?? 0;
const attempted = stats.agree + stats.disagree + stats.sameOffice;
console.log('=== 名称ベース突合の精度（事業所番号での突合を正解とする） ===');
console.log(`  検証対象（番号で確実に突合できた工賃レコード）: ${stats.truth}件`);
console.log(`  名称だけで突合できた                        : ${attempted}件`);
console.log(`    うち正解と一致                            : ${stats.agree}件`);
console.log(`    うち同じ事業所番号の別レコード            : ${stats.sameOffice}件（同一事業所。名称の揺れでレコードが分裂）`);
console.log(`    うち別の事業所を選んだ（真の誤り）        : ${stats.disagree}件`);
console.log(`  名称だけでは突合できなかった                : ${stats.missed}件`);
console.log('');
const correctFacility = stats.agree + stats.sameOffice;
console.log(`  適合率（同一事業所を指していた割合）  : ${attempted ? ((correctFacility / attempted) * 100).toFixed(2) : '—'}%`);
console.log(`  誤って別事業所を指した割合            : ${attempted ? ((stats.disagree / attempted) * 100).toFixed(2) : '—'}%`);
console.log(`  再現率（正解のうち拾えた割合）        : ${stats.truth ? ((correctFacility / stats.truth) * 100).toFixed(2) : '—'}%`);
console.log('');
console.log('  名称突合で選ばれた方法の内訳:');
for (const [k, v] of [...stats.byMethod].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}件`);
if (disagreements.length) {
  console.log('\n  不一致の例:');
  for (const d of disagreements) {
    console.log(`    [${d.src}] 資料「${d.name}」(${d.city})  方法=${d.method}`);
    console.log(`        正解: ${d.truth}`);
    console.log(`        誤答: ${d.blind}`);
  }
}
