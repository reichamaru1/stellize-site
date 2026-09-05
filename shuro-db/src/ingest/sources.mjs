/**
 * データソース定義。
 * 新しいソースを足すときはここにアダプタを1つ追加する（他のコードは触らない）。
 */

export const WAMNET_INDEX =
  'https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/';

export const USER_AGENT =
  'shuro-db/0.1 (welfare facility open-data aggregator; non-commercial research)';

/**
 * 取り込み対象のサービス種別。
 * ZIP のファイル番号はページ側で変わりうるため決め打ちしない。
 * CSV 内の「サービス種別」列の値で判定する（Phase 0 で実データから確認済み）。
 */
export const TARGET_SERVICE_TYPES = [
  '就労移行支援',
  '就労継続支援Ａ型',
  '就労継続支援Ｂ型',
  '就労定着支援',
  // 就労選択支援は2025年10月施行だが、2026年3月末時点のオープンデータには未収載。
  // 収載され次第ここに追加すれば取り込まれる。
  '就労選択支援',
];

/** ZIP のファイル番号 → サービス種別の対応（Phase 0 で実CSVから確認した実測値）。
 *  ページ側の変更に備え、あくまで「どれを落とすかの候補」に使うだけで、
 *  最終判定は CSV 内のサービス種別列で行う。 */
export const KNOWN_ZIP_CODES = {
  '045': '就労継続支援Ａ型',
  '046': '就労継続支援Ｂ型',
  '060': '就労移行支援',
  '062': '就労定着支援',
};

/**
 * オープンデータ一覧ページから ZIP のURLを発見する。
 * URL をハードコードしないこと（年2回の更新で期別ディレクトリが変わるため）。
 */
export function discoverZipLinks(html) {
  const found = new Map(); // `${period}_${code}` -> {period, code, url}
  const re = /href="((?:https?:\/\/www\.wam\.go\.jp)?\/content\/files\/pcpub\/top\/sfkopendata\/(\d{6})\/sfkopendata_\2_(\d+)\.zip)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, href, period, rawCode] = m;
    const code = rawCode.padStart(3, '0');
    const url = href.startsWith('http') ? href : `https://www.wam.go.jp${href}`;
    found.set(`${period}_${code}`, { period, code, url });
  }
  return [...found.values()].sort((a, b) => b.period.localeCompare(a.period) || a.code.localeCompare(b.code));
}

/** 発見したリンクのうち、就労系サービスの候補だけに絞る */
export function selectTargets(links, period) {
  return links.filter((l) => l.period === period && l.code in KNOWN_ZIP_CODES);
}

/** 利用可能な期（新しい順） */
export function listPeriods(links) {
  return [...new Set(links.map((l) => l.period))].sort().reverse();
}
