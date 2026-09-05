/**
 * 最小限の ZIP 読み取り（外部依存なし）。
 * 対象は WAM NET の単一CSVを含む ZIP。store(0) と deflate(8) のみ対応。
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** End of Central Directory を末尾から探す */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('ZIPのEOCDが見つかりません（壊れているか、ZIPではありません）');
}

/**
 * ZIP バッファ内のエントリを列挙する。
 * @returns {{name: string, data: Buffer}[]}
 */
export function unzipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error('中央ディレクトリの署名が不正です');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    // ローカルヘッダから実データ位置を割り出す（可変長フィールド長はローカル側を信じる）
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`未対応の圧縮方式: ${method}（${name}）`);

    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** ZIP から最初の .csv を取り出して文字列で返す（BOM付きUTF-8を想定、CP932にも対応） */
export function readCsvFromZip(buf) {
  const entries = unzipEntries(buf);
  const csv = entries.find((e) => e.name.toLowerCase().endsWith('.csv'));
  if (!csv) throw new Error('ZIP内にCSVが見つかりません');
  const bytes = csv.data;
  // BOM付きUTF-8か判定
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { name: csv.name, text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8-sig' };
  }
  const asUtf8 = bytes.toString('utf8');
  if (!asUtf8.includes('�')) return { name: csv.name, text: asUtf8, encoding: 'utf-8' };
  return { name: csv.name, text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
}
