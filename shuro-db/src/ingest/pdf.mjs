/**
 * PDF からの表抽出。
 *
 * 依存: poppler の `pdftotext`（任意）。
 * 無い場合は PDF ソースをスキップし、その旨を報告する（処理は止めない）。
 *   macOS: brew install poppler / Debian: apt install poppler-utils
 *
 * 都道府県の工賃実績PDFは固定幅の表なので `-layout` で桁を保って取り出し、
 * 2個以上の連続スペースを区切りとして列に分解する。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let cached = null;
/** pdftotext が使えるか */
export function pdfToTextAvailable() {
  if (cached !== null) return cached;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); cached = true; }
  catch { cached = false; }
  return cached;
}

/** PDF バッファ → レイアウト保持のテキスト */
export function pdfToText(buf) {
  if (!pdfToTextAvailable()) throw new Error('pdftotext がインストールされていません');
  const dir = mkdtempSync(path.join(tmpdir(), 'shuro-pdf-'));
  const src = path.join(dir, 'in.pdf'), out = path.join(dir, 'out.txt');
  try {
    writeFileSync(src, buf);
    execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', src, out], { stdio: 'ignore' });
    return readFileSync(out, 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * レイアウト保持テキストを行×列に分解する。
 * 2個以上の空白（全角スペース含む）を列区切りとみなす。
 */
export function pdfTextToRows(text) {
  return text.split(/\r?\n/).map((line) =>
    line.trim().split(/[ 　]{2,}/).map((c) => c.trim()).filter((c, i, a) => !(c === '' && i === a.length - 1)),
  ).filter((cells) => cells.length > 1);
}
