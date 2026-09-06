/**
 * スプレッドシート向けの書き出し。
 *   node src/export.mjs            → data/export/ にCSVを出力
 *   node src/export.mjs --dir path → 出力先を指定
 *
 * Excel / Google スプレッドシートのどちらでも文字化けしないよう、
 * BOM付きUTF-8・CRLF で書く。
 *
 * どの行も「出典」「データ基準」「突合方法」を持たせている。
 * 表計算に移したあとでも、その数字がどこから来たのかを辿れるようにするため。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'shuro.db');

const cell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 配列の配列 → BOM付きCSV文字列 */
export function toCsv(header, rows) {
  const lines = [header.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

const SERVICE_COLS = ['就労移行支援', '就労継続支援Ａ型', '就労継続支援Ｂ型', '就労定着支援', '就労選択支援'];

export function buildTables(db) {
  const latest = db.prepare('SELECT period, label FROM snapshots ORDER BY period DESC LIMIT 1').get();
  const basis = latest?.label ?? '不明';
  const SRC = 'WAM NET 障害福祉サービス等情報公表システム オープンデータ';

  /* ---- 1. 事業所一覧（1行 = 1事業所） ---- */
  const facilities = db.prepare(`
    SELECT f.*,
      (SELECT group_concat(s.service_type, ' / ') FROM services s
        WHERE s.facility_key = f.facility_key AND s.status = 'active') AS svc_list,
      (SELECT group_concat(DISTINCT a.category) FROM activities a
        WHERE a.facility_key = f.facility_key) AS act_list
    FROM facilities f ORDER BY f.pref_code, f.city, f.name
  `).all();

  const capByKey = new Map();
  for (const s of db.prepare("SELECT facility_key, service_type, capacity FROM services WHERE status='active'").all()) {
    if (!capByKey.has(s.facility_key)) capByKey.set(s.facility_key, {});
    capByKey.get(s.facility_key)[s.service_type] = s.capacity;
  }
  const wageByKey = new Map();
  for (const w of db.prepare(`
    SELECT facility_key, fiscal_year, service_type, avg_monthly, prefecture, match_method, source_page, source_url
    FROM wages WHERE facility_key IS NOT NULL ORDER BY fiscal_year DESC, avg_monthly DESC`).all()) {
    if (!wageByKey.has(w.facility_key)) wageByKey.set(w.facility_key, w);
  }

  const facHeader = [
    '事業所番号', '事業所名', 'ふりがな', '法人名', '法人番号',
    '都道府県', '市区町村', '住所', '緯度', '経度',
    '電話番号', 'FAX', 'URL',
    '提供サービス',
    ...SERVICE_COLS.map((s) => `定員_${s}`),
    '生産活動', '平均工賃月額', '工賃の年度', '工賃のサービス種別', '工賃の突合方法', '工賃の出典',
    '掲載状況', '初出スナップショット', '最終確認スナップショット',
    '指定機関', 'データ基準', '基本情報の出典', '内部ID',
  ];
  const facRows = facilities.map((f) => {
    const caps = capByKey.get(f.facility_key) ?? {};
    const w = wageByKey.get(f.facility_key);
    return [
      f.office_no, f.name, f.name_kana, f.corp_name, f.corp_no,
      f.prefecture, f.city, f.address_full, f.lat, f.lng,
      f.phone, f.fax, f.url,
      f.svc_list,
      ...SERVICE_COLS.map((s) => caps[s] ?? ''),
      f.act_list, w?.avg_monthly ?? '', w ? `${w.fiscal_year}年度` : '', w?.service_type ?? '',
      w?.match_method ?? '', w?.source_page ?? w?.source_url ?? '',
      f.status === 'active' ? '最新データに掲載あり' : '最新データに掲載なし',
      f.first_seen, f.last_seen,
      f.designator, basis, SRC, f.facility_key,
    ];
  });

  /* ---- 2. サービス（1行 = 1サービス） ---- */
  const services = db.prepare(`
    SELECT f.office_no, f.name, f.prefecture, f.city, s.*
    FROM services s JOIN facilities f ON f.facility_key = s.facility_key
    ORDER BY f.pref_code, f.city, f.name, s.service_type
  `).all();
  const svcHeader = ['事業所番号', '事業所名', '都道府県', '市区町村', 'サービス種別', '定員',
    '平日', '土曜', '日曜', '祝日', '定休日', '備考', '掲載状況', '初出', '最終確認', '内部ID'];
  const svcRows = services.map((s) => [
    s.office_no, s.name, s.prefecture, s.city, s.service_type, s.capacity,
    s.hours_weekday, s.hours_sat, s.hours_sun, s.hours_holiday, s.closed_days, s.hours_note,
    s.status === 'active' ? '掲載あり' : '掲載なし', s.first_seen, s.last_seen, s.facility_key,
  ]);

  /* ---- 3. 工賃（1行 = 1レコード） ---- */
  const wages = db.prepare(`
    SELECT w.*, f.name AS matched_name, f.city AS matched_city
    FROM wages w LEFT JOIN facilities f ON f.facility_key = w.facility_key
    ORDER BY w.prefecture, w.fiscal_year DESC, w.service_type, w.avg_monthly DESC
  `).all();
  const wageHeader = ['都道府県', '年度', 'サービス種別', '資料上の事業所名', '資料上の法人名',
    '資料上の市区町村', '事業所番号', '法人番号', '定員', '対象者延人数', '工賃支払総額', '平均工賃月額',
    '突合できたか', '突合方法', '突合先の事業所名', '突合先の市区町村', '出典', '内部ID'];
  const wageRows = wages.map((w) => [
    w.prefecture, `${w.fiscal_year}年度`, w.service_type, w.facility_name, w.corp_name,
    w.city, w.office_no, w.corp_no, w.capacity, w.users, w.total_paid, w.avg_monthly,
    w.facility_key ? '突合済み' : '未突合', w.match_method, w.matched_name, w.matched_city,
    w.source_page ?? w.source_url, w.facility_key,
  ]);

  /* ---- 4. 生産活動（1行 = 1レコード） ---- */
  const acts = db.prepare(`
    SELECT a.*, f.office_no, f.name AS matched_name, f.city AS matched_city
    FROM activities a LEFT JOIN facilities f ON f.facility_key = a.facility_key
    ORDER BY a.prefecture, a.category, a.facility_name
  `).all();
  const actHeader = ['都道府県', '分類', '資料上の表記', '資料上の事業所名', '製品・サービスの内容',
    '事業所番号', '突合できたか', '突合方法', '突合先の事業所名', '突合先の市区町村', '出所', '資料名', '出典', '内部ID'];
  const actRows = acts.map((a) => [
    a.prefecture, a.category, a.raw_label, a.facility_name, a.detail,
    a.office_no, a.facility_key ? '突合済み' : '未突合', a.match_method, a.matched_name, a.matched_city,
    a.origin === 'published' ? '公表データ' : a.origin, a.source_name, a.source_page ?? a.source_url, a.facility_key,
  ]);

  /* ---- 5. データソース ---- */
  const sources = db.prepare('SELECT * FROM extra_sources ORDER BY kind, prefecture, fiscal_year DESC').all();
  const srcHeader = ['種類', '都道府県', '年度', '対象サービス', '形式', '資料の件数', '突合できた件数', '突合率', '出典ページ', 'ファイルURL', '備考'];
  const srcRows = [
    ['基本情報', '全国', latest?.period ? `${latest.period.slice(0, 4)}年${Number(latest.period.slice(4))}月末` : '', '就労移行/A型/B型/就労定着',
      'ZIP(CSV)', db.prepare("SELECT count(*) c FROM services WHERE status='active'").get().c, '', '',
      'https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/', '', '年2回（3月末・9月末）更新'],
    ...sources.map((s) => [
      s.kind === 'wage' ? '工賃' : '生産活動', s.prefecture, s.fiscal_year ? `${s.fiscal_year}年度` : '',
      s.service_type ?? 'A型・B型', s.format.toUpperCase(), s.rows, s.matched,
      s.rows ? `${Math.round((s.matched / s.rows) * 100)}%` : '', s.source_page, s.source_url, s.note,
    ]),
  ];

  /* ---- 0. 列と精度の説明 ---- */
  const notes = [
    ['シート', '説明'],
    ['01_事業所一覧', '1行 = 1事業所。サービスごとの定員を列に展開してあるので、そのままピボットできます。'],
    ['02_サービス', '1行 = 1サービス。1事業所が複数サービスを持つため、事業所一覧より行数が多くなります。'],
    ['03_工賃', '1行 = 都道府県の公表資料の1行。突合できなかった行も残してあります（突合できたか列で判別）。'],
    ['04_生産活動', '1行 = 公表資料の1項目。同じ事業所が複数の分類を持ちます。'],
    ['05_データソース', 'どの都道府県の何年度のデータを、どこから取り込んだかの一覧。'],
    ['', ''],
    ['項目', '内容'],
    ['データ基準', `基本情報は ${basis}。元データは年2回（3月末・9月末）しか更新されません。`],
    ['掲載状況', '「最新データに掲載なし」は廃止の確認ではありません。番号変更・改称・移転でもこうなります。'],
    ['工賃の年度', '都道府県ごとに公表年度が違います。年度をまたいだ単純比較はできません。'],
    ['工賃の突合方法', 'office_no=事業所番号一致（最も確実）。pref+city+name=都道府県・市区町村・事業所名一致。'],
    ['突合の精度（実測）', '事業所番号を持つ資料を正解として名称突合を検証: 適合率99.94%、誤って別事業所を指した割合0.06%、再現率79.7%。'],
    ['未突合の扱い', '候補が複数残る場合は結び付けていません。誤った事業所に工賃を出すより未突合のほうが害が小さいためです。'],
    ['生産活動の網羅性', '全国一括の公開データが無いため、北海道・愛知県・東京都のみです。'],
    ['緯度経度', '元データに含まれる値をそのまま使っています（欠損0.1%）。'],
    ['注意', '公開データを基にしたものであり、最新性・正確性を保証しません。利用前に各事業所へ直接ご確認ください。'],
  ];

  return {
    '00_はじめに.csv': toCsv(notes[0], notes.slice(1)),
    '01_事業所一覧.csv': toCsv(facHeader, facRows),
    '02_サービス.csv': toCsv(svcHeader, svcRows),
    '03_工賃.csv': toCsv(wageHeader, wageRows),
    '04_生産活動.csv': toCsv(actHeader, actRows),
    '05_データソース.csv': toCsv(srcHeader, srcRows),
  };
}

export async function run(argv = []) {
  const i = argv.indexOf('--dir');
  const outDir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(ROOT, 'data', 'export');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const tables = buildTables(db);
  await mkdir(outDir, { recursive: true });
  for (const [name, csv] of Object.entries(tables)) {
    const p = path.join(outDir, name);
    await writeFile(p, csv, 'utf8');
    const rows = csv.split('\r\n').length - 2;
    console.log(`  ${name.padEnd(22)} ${String(rows).padStart(7)}行`);
  }
  db.close();
  console.log(`\n出力先: ${outDir}`);
  console.log('Googleスプレッドシートなら「ファイル > インポート」、Excelならそのまま開けます（BOM付きUTF-8）。');
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
}
