/**
 * 工賃・生産活動ソースの取得（raw層）。
 *   node src/ingest/extra/fetch.mjs
 * 取得済みはスキップ。1件ごとに間隔を空ける。
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { USER_AGENT } from '../sources.mjs';
import { WAGE_SOURCES, ACTIVITY_SOURCES } from './registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIR = path.join(ROOT, 'data', 'raw', 'extra');
const DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** ソース1件に対応するローカルファイル名。URLのハッシュで一意にする。 */
export function localName(src, kind) {
  const h = createHash('sha1').update(src.url).digest('hex').slice(0, 8);
  const svc = src.serviceType ? `_${src.serviceType.replace(/[^\wぁ-んァ-ヶ一-龠]/g, '')}` : '';
  const yr = src.fiscalYear ? `_${src.fiscalYear}` : '';
  return `${kind}_${src.prefecture}${yr}${svc}_${h}.${src.format}`;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 形式が期待と違わないか、先頭バイトで確かめる（HTMLのエラーページを掴まないため） */
function looksRight(buf, format) {
  const head = buf.subarray(0, 5).toString('latin1');
  if (format === 'pdf') return head.startsWith('%PDF');
  if (format === 'xlsx') return head.startsWith('PK');
  return true;
}

export async function run() {
  await mkdir(DIR, { recursive: true });
  const all = [
    ...WAGE_SOURCES.map((s) => ({ ...s, kind: 'wage' })),
    ...ACTIVITY_SOURCES.map((s) => ({ ...s, kind: 'activity' })),
  ];
  const results = [];
  for (const src of all) {
    const name = localName(src, src.kind);
    const dest = path.join(DIR, name);
    const label = `${src.prefecture}${src.fiscalYear ? ` ${src.fiscalYear}年度` : ''}${src.serviceType ? ` ${src.serviceType}` : ''}`;
    if (await exists(dest)) { console.log(`  ${label} … 取得済み`); results.push({ src, dest, skipped: true }); continue; }
    try {
      const buf = await download(src.url);
      if (!looksRight(buf, src.format)) throw new Error(`${src.format} ではない応答（HTMLエラーページの可能性）`);
      await writeFile(dest, buf);
      console.log(`  ${label} … ${(buf.length / 1024).toFixed(0)}KB`);
      results.push({ src, dest, bytes: buf.length });
    } catch (e) {
      console.warn(`  ${label} … 取得できず（${e.message}）。このソースはスキップします。`);
      results.push({ src, error: e.message });
    }
    await sleep(DELAY_MS);
  }
  await writeFile(path.join(DIR, 'manifest.json'), JSON.stringify(
    { fetchedAt: new Date().toISOString(), sources: results.map((r) => ({ prefecture: r.src.prefecture, kind: r.src.kind, url: r.src.url, page: r.src.page, fiscalYear: r.src.fiscalYear, serviceType: r.src.serviceType, file: r.dest ? path.basename(r.dest) : null, error: r.error ?? null })) }, null, 2));
  const ok = results.filter((r) => !r.error).length;
  console.log(`\n工賃・生産活動ソース: ${ok}/${all.length} 件を取得`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
}
