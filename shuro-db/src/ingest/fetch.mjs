/**
 * ソース取得（raw 層）。
 * - 一覧ページをパースして ZIP を発見する（URLはハードコードしない）
 * - 取得済みのファイルは再取得しない（年2回しか更新されないため）
 * - 1リクエストごとに間隔を空ける
 *
 * 使い方:
 *   node src/ingest/fetch.mjs            最新期を取得
 *   node src/ingest/fetch.mjs --all      利用可能な全期を取得（差分検証用）
 *   node src/ingest/fetch.mjs 202509     期を指定して取得
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WAMNET_INDEX, USER_AGENT, discoverZipLinks, selectTargets, listPeriods, KNOWN_ZIP_CODES } from './sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const POLITE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) { try { await access(p); return true; } catch { return false; } }

/** 一覧ページは CP932。Node の TextDecoder で復号する。 */
async function fetchIndexHtml() {
  const res = await fetch(WAMNET_INDEX, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`一覧ページの取得に失敗: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('shift_jis').decode(buf);
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`取得失敗 ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

export async function run(argv = []) {
  await mkdir(RAW_DIR, { recursive: true });

  console.log(`一覧ページを取得: ${WAMNET_INDEX}`);
  const html = await fetchIndexHtml();
  const links = discoverZipLinks(html);
  const periods = listPeriods(links);
  if (periods.length === 0) {
    throw new Error('ZIPリンクが1件も見つかりませんでした。ページ構造が変わった可能性があります。中断します。');
  }
  console.log(`  発見: ${links.length}リンク / 期: ${periods.join(', ')}`);

  const explicit = argv.find((a) => /^\d{6}$/.test(a));
  const wanted = argv.includes('--all') ? periods : [explicit ?? periods[0]];

  const manifest = [];
  for (const period of wanted) {
    const targets = selectTargets(links, period);
    if (targets.length === 0) {
      console.warn(`  [${period}] 就労系の対象ZIPが見つかりません。スキップします。`);
      continue;
    }
    const dir = path.join(RAW_DIR, period);
    await mkdir(dir, { recursive: true });
    for (const t of targets) {
      const dest = path.join(dir, `sfkopendata_${period}_${t.code}.zip`);
      if (await exists(dest)) {
        console.log(`  [${period}] ${KNOWN_ZIP_CODES[t.code]} … 取得済みのためスキップ`);
        manifest.push({ ...t, dest, skipped: true });
        continue;
      }
      const info = await download(t.url, dest);
      console.log(`  [${period}] ${KNOWN_ZIP_CODES[t.code]} … ${(info.bytes / 1024).toFixed(0)}KB`);
      manifest.push({ ...t, dest, ...info });
      await sleep(POLITE_DELAY_MS);
    }
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ period, source: WAMNET_INDEX, fetchedAt: new Date().toISOString(), files: manifest.filter((m) => m.period === period) }, null, 2),
    );
  }
  console.log('完了。次は `npm run build` でDBを構築してください。');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((e) => { console.error(`\nエラー: ${e.message}`); process.exit(1); });
}
