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
  // 都道府県ごとの「実在する市区町村の表記」。資料のcity欄が市区町村なのか、
  // それ以外（和歌山県の資料は「海草」「那賀」など広域の圏域名）なのかを見分けるために使う。
  const cityVocab = new Map();

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
    if (!cityVocab.has(f.prefecture)) cityVocab.set(f.prefecture, new Set());
    for (const k of cityKeys(f.city)) cityVocab.get(f.prefecture).add(k);
  }
  return { byOfficeNo, byCorpNoName, byPrefName, byPrefCityName, cityVocab };
}

/**
 * 市区町村の照合キー。表記の粒度が資料と事業所データで揃わないため、
 * 比較できる形を複数用意する。
 *   事業所データ: 「海部郡大治町」「札幌市中央区」
 *   資料側      : 「大治町」（郡なし）／「中央区」（政令市名なし）／「札幌市」（区なし）
 */
function cityKeys(c) {
  // 新潟県の資料は「01-01新潟市北区」のように行政コードが前置される
  const n = normalizeText(String(c ?? '').replace(/^[\d\-\s.]+/, ''));
  if (!n) return [];
  const keys = new Set([n]);
  const withoutGun = n.replace(/^.+?郡/, '');       // 海部郡大治町 → 大治町
  if (withoutGun && withoutGun !== n) keys.add(withoutGun);
  const ward = n.match(/^(.+?市)(.+?区)$/);          // 札幌市中央区 → 札幌市 / 中央区
  if (ward) { keys.add(ward[1]); keys.add(ward[2]); }
  return [...keys].filter((k) => k.length >= 2);
}

/**
 * 市区町村が同じ地域を指しているとみなせるか。
 * どちらかがもう一方の前方一致でも同じ地域とする（「札幌市」と「札幌市白石区」）。
 */
function cityCompatible(recCity, facCity) {
  if (!recCity || !facCity) return true;
  const A = cityKeys(recCity), B = cityKeys(facCity);
  if (A.length === 0 || B.length === 0) return true;
  for (const a of A) for (const b of B) {
    if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  }
  return false;
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

  // 資料の city 欄が本当に市区町村を指しているときだけ、整合を要求する。
  // 圏域名や行政コード付きの表記をそのまま条件にすると、正しい事業所まで弾いてしまう。
  const vocab = index.cityVocab?.get(rec.prefecture);
  const cityUsable = Boolean(rec.city) && (!vocab || cityKeys(rec.city).some((k) => vocab.has(k)));
  const effCity = cityUsable ? rec.city : null;

  // 3. 都道府県 + 事業所名。ただし資料に市区町村がある場合は必ず整合を要求する。
  //    ここで県全体へ広げてしまうと、カナ正規化で同名になった別の市の事業所
  //    （「らぽーる」と「ラポール」など）を掴む。実測で誤りの大半がこれだった。
  const inPref = index.byPrefName.get(`${rec.prefecture}|${name}`) ?? [];
  const cityOk = effCity ? inPref.filter((f) => cityCompatible(effCity, f.city)) : inPref;
  const hit = disambiguate(cityOk, rec.serviceType, servicesByKey);
  if (hit.length === 1) {
    return { facility: hit[0], method: effCity ? 'pref+city+name' : 'pref+name' };
  }

  // 4. 法人名も一致するものが1つだけなら採用
  if (rec.corpName && hit.length > 1) {
    const c = normalizeCorpName(rec.corpName);
    const narrowed = hit.filter((f) => normalizeCorpName(f.corp_name) === c);
    if (narrowed.length === 1) return { facility: narrowed[0], method: 'pref+name+corp' };
  }

  // 市区町村が合う候補が無いとき、資料の市区町村が誤っている可能性は残るが、
  // 県内の同名を無条件に採るのは危険なので突合しない。
  return {
    facility: null,
    method: hit.length > 1 ? 'ambiguous' : (effCity && inPref.length > 0 ? 'city_mismatch' : 'unmatched'),
  };
}
