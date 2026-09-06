/**
 * 正規化ユーティリティ。
 * 表記ゆれを吸収して検索・名寄せに使う文字列を作る。
 * 原文は決して破壊しない（呼び出し側が別カラムに保持する）。
 */

/** 47都道府県。長い名前から順に照合するため、この配列の順序に依存しないこと。 */
export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/** 都道府県コード（2桁ゼロ埋め）→ 名称 */
export const PREF_BY_CODE = Object.fromEntries(
  PREFECTURES.map((name, i) => [String(i + 1).padStart(2, '0'), name]),
);

/** 全角英数字・記号を半角へ。全角スペースは半角スペースへ。 */
export function toHalfWidth(s) {
  if (!s) return '';
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    // 全角ハイフン類・ダッシュ類を ASCII のハイフンに寄せる。
    // 長音符「ー」(U+30FC) は含めない。名称の一部であり、ハイフンに潰すと
    // 「ラポール」と「ラポ-ル」が同一になって別事業所を取り違える原因になる。
    .replace(/[‐‑‒–—―−－⁃˗]/g, '-');
}

/** カタカナをひらがなへ（半角カナも先に全角化する） */
export function katakanaToHiragana(s) {
  if (!s) return '';
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 検索・比較用の共通正規化：半角化 → 小文字 → ひらがな寄せ → 空白除去 */
export function normalizeText(s) {
  if (!s) return '';
  let t = toHalfWidth(String(s));
  t = t.normalize('NFKC');
  t = katakanaToHiragana(t);
  t = t.toLowerCase();
  t = t.replace(/[\s　]+/g, '');
  return t;
}

/** 法人格の表記ゆれ。名寄せ時のみ落とす（表示には使わない）。 */
const CORP_FORMS = [
  '社会福祉法人', '医療法人社団', '医療法人財団', '医療法人', '特定非営利活動法人',
  '一般社団法人', '公益社団法人', '一般財団法人', '公益財団法人', '株式会社',
  '有限会社', '合同会社', '合資会社', '合名会社', '協同組合', '生活協同組合',
  '事業協同組合', '社団法人', '財団法人', '学校法人', '宗教法人', '農業協同組合',
  'npo法人', '認定npo法人',
];
const CORP_ABBR = { '(福)': '社会福祉法人', '(医)': '医療法人', '(株)': '株式会社', '(有)': '有限会社', '(特非)': '特定非営利活動法人' };

/** 法人名の名寄せキー。法人格・略記・空白を除去した中核部分を返す。 */
export function normalizeCorpName(s) {
  if (!s) return '';
  let t = toHalfWidth(String(s)).normalize('NFKC');
  for (const [abbr, full] of Object.entries(CORP_ABBR)) t = t.split(abbr).join(full);
  t = t.toLowerCase().replace(/[\s　]+/g, '');
  for (const form of CORP_FORMS) {
    const f = form.toLowerCase();
    if (t.startsWith(f)) { t = t.slice(f.length); break; }
    if (t.endsWith(f)) { t = t.slice(0, -f.length); break; }
  }
  return katakanaToHiragana(t);
}

/**
 * 住所の分解。
 * WAM NET の「事業所住所（市区町村）」は都道府県名を含む（例: 北海道札幌市中央区）。
 * prefCode が分かっている場合はそれを正とし、文字列の前方一致は補助に使う。
 */
export function splitAddress(cityField, detailField, prefCode) {
  const raw = String(cityField ?? '').trim();
  let prefecture = prefCode ? PREF_BY_CODE[String(prefCode).slice(0, 2)] : undefined;
  let rest = raw;

  if (prefecture && raw.startsWith(prefecture)) {
    rest = raw.slice(prefecture.length);
  } else {
    // コードが無い／食い違う場合は最長一致で拾う
    const hit = PREFECTURES.filter((p) => raw.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (hit) { prefecture = hit; rest = raw.slice(hit.length); }
  }
  const city = rest.trim();
  const detail = String(detailField ?? '').trim();
  return {
    prefecture: prefecture ?? '',
    city,
    detail,
    full: `${prefecture ?? ''}${city}${detail}`,
  };
}

/** 住所の比較用正規化。番地の表記ゆれ（丁目・番地・ハイフン）を吸収する。 */
export function normalizeAddress(s) {
  if (!s) return '';
  // 住所では「１ー２ー３」のように長音符をハイフン代わりに打つ表記が実在するため、
  // 住所に限ってはハイフンとして扱う。
  let t = normalizeText(String(s).replace(/ー/g, '-'));
  t = t.replace(/大字|字/g, '');
  t = t.replace(/丁目|丁|番地|番|号/g, '-');
  t = t.replace(/-+/g, '-').replace(/-$/, '');
  return t;
}

/** 電話番号。表示用（原文のハイフン維持）と比較用（数字のみ）を返す。 */
export function normalizePhone(s) {
  const half = toHalfWidth(String(s ?? '')).trim();
  const digits = half.replace(/\D/g, '');
  return { display: half, digits };
}

/** 定員。空文字・非数値は null（0 と区別する）。 */
export function parseCapacity(s) {
  const t = toHalfWidth(String(s ?? '')).trim();
  if (!t) return null;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** 緯度経度。範囲外・欠損は null。 */
export function parseLatLng(latStr, lngStr) {
  const lat = Number(toHalfWidth(String(latStr ?? '')).trim());
  const lng = Number(toHalfWidth(String(lngStr ?? '')).trim());
  const ok = Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154; // 日本の範囲
  return ok ? { lat, lng } : { lat: null, lng: null };
}

/** URL。スキームが無いものは https を補う。明らかに不正なものは null。 */
export function normalizeUrl(s) {
  let t = toHalfWidth(String(s ?? '')).trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) {
    if (!/^[\w.-]+\.[a-z]{2,}/i.test(t)) return null;
    t = `https://${t}`;
  }
  try { return new URL(t).toString(); } catch { return null; }
}
