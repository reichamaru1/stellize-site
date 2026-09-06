/**
 * 工賃・生産活動レコードを事業所に突合する。
 *
 * 都道府県の工賃資料の多くは事業所番号を持たないため、段階的に照合する。
 * 曖昧なもの（複数一致）は突合しない — 誤って別事業所の工賃を表示するより、
 * 「該当なし」のほうが害が小さいため。
 */
import { normalizeText, normalizeCorpName } from '../ingest/normalize.mjs';

/** facilities から照合用の索引を作る */
export function buildIndex(facilities) {
  const byOfficeNo = new Map();
  const byCorpNoName = new Map();
  const byPrefName = new Map();
  const byPrefCityName = new Map();

  const push = (map, key, f) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  };

  for (const f of facilities) {
    const n = f.name_norm ?? normalizeText(f.name);
    push(byOfficeNo, f.office_no, f);
    if (f.corp_no) push(byCorpNoName, `${f.corp_no}|${n}`, f);
    push(byPrefName, `${f.prefecture}|${n}`, f);
    push(byPrefCityName, `${f.prefecture}|${f.city}|${n}`, f);
  }
  return { byOfficeNo, byCorpNoName, byPrefName, byPrefCityName };
}

/** 候補が複数あるとき、サービス種別が一致するものに絞れれば絞る */
function disambiguate(candidates, serviceType, servicesByKey) {
  if (candidates.length <= 1) return candidates;
  if (!serviceType || !servicesByKey) return candidates;
  const narrowed = candidates.filter((f) => (servicesByKey.get(f.facility_key) ?? []).includes(serviceType));
  return narrowed.length ? narrowed : candidates;
}

/**
 * 1件を突合する。
 * @returns {{facility: object|null, method: string}}
 */
export function matchRecord(rec, index, servicesByKey) {
  const name = normalizeText(rec.facilityName);

  // 1. 事業所番号（最も確実）
  if (rec.officeNo) {
    const hit = disambiguate(index.byOfficeNo.get(rec.officeNo) ?? [], rec.serviceType, servicesByKey);
    if (hit.length === 1) return { facility: hit[0], method: 'office_no' };
    // 番号は一意でないので、名称でさらに絞る
    const byName = hit.filter((f) => (f.name_norm ?? normalizeText(f.name)) === name);
    if (byName.length === 1) return { facility: byName[0], method: 'office_no+name' };
  }

  // 2. 法人番号 + 事業所名
  if (rec.corpNo) {
    const hit = disambiguate(index.byCorpNoName.get(`${rec.corpNo}|${name}`) ?? [], rec.serviceType, servicesByKey);
    if (hit.length === 1) return { facility: hit[0], method: 'corp_no+name' };
  }

  // 3. 都道府県 + 市区町村 + 事業所名
  if (rec.city) {
    // ソース側の市区町村表記は「札幌市」「和歌山市」など粒度が粗いことがあるので前方一致で探す
    const exact = index.byPrefCityName.get(`${rec.prefecture}|${rec.city}|${name}`);
    const hit = disambiguate(exact ?? [], rec.serviceType, servicesByKey);
    if (hit.length === 1) return { facility: hit[0], method: 'pref+city+name' };
  }

  // 4. 都道府県 + 事業所名
  const hit = disambiguate(index.byPrefName.get(`${rec.prefecture}|${name}`) ?? [], rec.serviceType, servicesByKey);
  if (hit.length === 1) return { facility: hit[0], method: 'pref+name' };

  // 5. 法人名も一致するものが1つだけなら採用
  if (rec.corpName && hit.length > 1) {
    const c = normalizeCorpName(rec.corpName);
    const narrowed = hit.filter((f) => normalizeCorpName(f.corp_name) === c);
    if (narrowed.length === 1) return { facility: narrowed[0], method: 'pref+name+corp' };
  }

  return { facility: null, method: hit.length > 1 ? 'ambiguous' : 'unmatched' };
}
