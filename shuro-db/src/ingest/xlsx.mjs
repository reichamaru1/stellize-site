/**
 * 最小限の XLSX 読み取り（外部依存なし）。
 * XLSX は ZIP + XML なので既存の unzip.mjs で開ける。
 *
 * 対応しているもの: 共有文字列、インライン文字列、数値、複数シート、ルビ(<rPh>)の除去。
 * 対応していないもの: 数式の再計算（キャッシュ値を読む）、日付シリアルの自動変換。
 */
import { unzipEntries } from './unzip.mjs';

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/**
 * <si> や <is> の中身をテキスト化する。
 * ふりがな（<rPh>）は本文ではないので必ず落とす。
 * これを忘れると「事業所名ジギョウショメイ」のような文字列になる。
 */
function richText(xml) {
  const withoutRuby = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr[^>]*\/>/g, '');
  const parts = [...withoutRuby.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return decode(parts.join(''));
}

/** 列参照 'AB12' → 列インデックス（0始まり） */
export function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 列インデックス → 'A','B',... */
export function colName(i) {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * XLSX を読み、シートごとに二次元配列（文字列）を返す。
 * @returns {{name: string, rows: string[][]}[]}
 */
export function readXlsx(buf) {
  const entries = new Map(unzipEntries(buf).map((e) => [e.name, e.data]));

  const sstXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sst = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1]));

  const wbXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relTarget = new Map(
    [...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map((m) => [m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, '')]),
  );
  const sheetDefs = [...wbXml.matchAll(/<sheet[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"[^>]*\/?>/g)]
    .map((m) => ({ name: decode(m[1]), path: `xl/${relTarget.get(m[2]) ?? ''}` }));

  // workbook.xml が読めない場合はシートファイルを直接拾う
  const fallback = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  const sheets = sheetDefs.length
    ? sheetDefs.filter((s) => entries.has(s.path))
    : fallback.map((p, i) => ({ name: `Sheet${i + 1}`, path: p }));

  return sheets.map(({ name, path }) => ({ name, rows: parseSheet(entries.get(path).toString('utf8'), sst) }));
}

function parseSheet(xml, sst) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(rm[1]) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let text = '';
      if (type === 'inlineStr') {
        text = richText(inner);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v != null) text = type === 's' ? (sst[Number(v)] ?? '') : decode(v);
      }
      if (ref) cells[colIndex(ref)] = text;
    }
    rows[rowIndex] = cells;
  }
  // 疎配列を埋める
  const width = rows.reduce((w, r) => Math.max(w, r?.length ?? 0), 0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    rows[i] = Array.from({ length: width }, (_, j) => (r[j] ?? '').trim());
  }
  return rows;
}

/**
 * ヘッダ行を自動検出する。
 * 都道府県のExcelはタイトル行・注記行が上にあり、ヘッダ位置が一定しないため、
 * 指定したキーワードを最も多く含む行をヘッダとみなす。
 */
export function findHeaderRow(rows, keywords, { maxScan = 15 } = {}) {
  let best = { index: -1, score: 0 };
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const joined = (rows[i] ?? []).join('');
    const score = keywords.filter((k) => joined.includes(k)).length;
    if (score > best.score) best = { index: i, score };
  }
  return best.score >= 2 ? best.index : -1;
}

/** ヘッダ行のラベル → 列インデックスの対応表を作る（部分一致、最初に当たったものを採用） */
export function mapColumns(headerRow, spec) {
  const out = {};
  for (const [key, patterns] of Object.entries(spec)) {
    for (let i = 0; i < headerRow.length; i++) {
      const cell = (headerRow[i] ?? '').replace(/\s+/g, '');
      if (!cell) continue;
      if (patterns.some((p) => cell.includes(p))) { out[key] = i; break; }
    }
  }
  return out;
}
