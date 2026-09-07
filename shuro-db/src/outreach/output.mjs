/**
 * 送付リストからの各種出力。
 * 実際の送信はここでは行わない（理由は README とAPIの説明に書いてある）。
 */
import { toCsv } from '../export.mjs';

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 郵送の宛名ラベル。タックシールの差し込みに使う。 */
export function buildPostalLabels(campaign, targets) {
  const header = ['宛名1（法人名）', '宛名2（事業所名）', '敬称', '住所', '都道府県', '市区町村', '電話番号', '状況', '事業所番号', '内部ID'];
  const rows = targets.map((t) => [
    t.corp_name ?? '', t.name, '御中', t.address ?? '', t.prefecture ?? '', t.city ?? '',
    t.phone ?? '', t.status, t.office_no ?? '', t.facility_key,
  ]);
  return toCsv(header, rows);
}

/** FAX送付リスト。番号を持たない先はそもそもリストに入らない。 */
export function buildFaxList(campaign, targets) {
  const header = ['FAX番号', '事業所名', '法人名', '都道府県', '市区町村', '電話番号', '状況', '送付日時', '事業所番号', '内部ID'];
  const rows = targets.map((t) => [
    t.fax ?? '', t.name, t.corp_name ?? '', t.prefecture ?? '', t.city ?? '',
    t.phone ?? '', t.status, t.sent_at ?? '', t.office_no ?? '', t.facility_key,
  ]);
  return toCsv(header, rows);
}

/**
 * チラシ投函ルート。
 * 市区町村ごとにまとめ、最も北西の地点から最近傍を順にたどる（貪欲法）。
 * 厳密な最短経路ではないが、市区町村内を歩く順としては十分に短くなる。
 */
export function buildFlyerRoute(campaign, targets) {
  const byCity = new Map();
  const noGeo = [];
  for (const t of targets) {
    if (t.lat == null || t.lng == null) { noGeo.push(t); continue; }
    const key = `${t.prefecture}|${t.city}`;
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(t);
  }

  const header = ['エリア', '順番', '事業所名', '法人名', '住所', '前の地点からの距離', '累計距離', '電話番号', '状況', '地図', '内部ID'];
  const rows = [];

  const areas = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of areas) {
    const [pref, city] = key.split('|');
    const area = `${pref}${city}（${list.length}件）`;
    const remaining = [...list];
    // 起点は最も北西にある地点。毎回同じ順になるようにするため。
    remaining.sort((a, b) => (b.lat - a.lat) || (a.lng - b.lng));
    let cur = remaining.shift();
    let total = 0, n = 1;
    const push = (t, d) => {
      total += d;
      rows.push([
        area, n++, t.name, t.corp_name ?? '', t.address ?? '',
        d === 0 ? '起点' : fmtDist(d), fmtDist(total), t.phone ?? '', t.status,
        t.lat != null ? `https://www.google.com/maps?q=${t.lat},${t.lng}` : '',
        t.facility_key,
      ]);
    };
    push(cur, 0);
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = distanceKm(cur.lat, cur.lng, remaining[i].lat, remaining[i].lng);
        if (d < bd) { bd = d; bi = i; }
      }
      const next = remaining.splice(bi, 1)[0];
      push(next, bd);
      cur = next;
    }
  }
  for (const t of noGeo) {
    rows.push([`${t.prefecture}${t.city}（座標なし）`, '', t.name, t.corp_name ?? '', t.address ?? '', '', '', t.phone ?? '', t.status, '', t.facility_key]);
  }
  return toCsv(header, rows);
}

const fmtDist = (km) => (km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(2)}km`);

/** ルートの要約（画面表示用）。総距離が分かると1日で回れるかの判断がつく。 */
export function summarizeRoute(targets) {
  const byCity = new Map();
  for (const t of targets) {
    if (t.lat == null) continue;
    const key = `${t.prefecture}${t.city}`;
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(t);
  }
  const out = [];
  for (const [area, list] of byCity) {
    const rest = [...list].sort((a, b) => (b.lat - a.lat) || (a.lng - b.lng));
    let cur = rest.shift(), total = 0;
    while (rest.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const d = distanceKm(cur.lat, cur.lng, rest[i].lat, rest[i].lng);
        if (d < bd) { bd = d; bi = i; }
      }
      total += bd; cur = rest.splice(bi, 1)[0];
    }
    out.push({ area, count: list.length, distanceKm: Number(total.toFixed(2)) });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * 文面の差し込み。{{事業所名}} のような書き方を置き換える。
 * 値が無い項目は空にせず、そのまま残して気付けるようにする。
 */
export const PLACEHOLDERS = ['事業所名', '法人名', '都道府県', '市区町村', '住所', '電話番号', 'FAX番号', '事業所番号'];

export function renderTemplate(tpl, t) {
  const map = {
    事業所名: t.name, 法人名: t.corp_name, 都道府県: t.prefecture, 市区町村: t.city,
    住所: t.address, 電話番号: t.phone, FAX番号: t.fax, 事業所番号: t.office_no,
  };
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
    const v = map[key];
    return v == null || v === '' ? whole : String(v);
  });
}

/** 差し込み済みの文面を一覧で出す（郵送の本文、FAXの送付状など） */
export function buildMergedDocs(campaign, targets, template) {
  const header = ['事業所名', '宛先', '本文', '状況', '内部ID'];
  const rows = targets.map((t) => [
    t.name,
    campaign.channel === 'fax' ? (t.fax ?? '') : (t.address ?? ''),
    renderTemplate(template, t), t.status, t.facility_key,
  ]);
  return toCsv(header, rows);
}
