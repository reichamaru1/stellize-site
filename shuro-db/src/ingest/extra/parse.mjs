/**
 * 工賃・生産活動ソースの解析。
 *
 * 都道府県ごとに様式が違うが、千葉・大阪などは国の標準様式
 * （①都道府県名 ②No. ③法人種別 ④法人番号 ⑤法人名 ⑥事業所名 ⑦定員 …⑬工賃平均額）
 * を使っているため、多段ヘッダを縦に連結してからキーワードで列を特定する
 * 汎用パーサで多くの県を賄える。PDFは県ごとに桁が違うので個別に扱う。
 */
import { readXlsx, mapColumns } from '../xlsx.mjs';
import { pdfToText, pdfTextToRows, pdfToTextAvailable } from '../pdf.mjs';
import { WAGE_COLUMNS, A_TYPE, B_TYPE } from './registry.mjs';
import { toHalfWidth } from '../normalize.mjs';

const num = (s) => {
  if (s == null) return null;
  const t = toHalfWidth(String(s)).replace(/[,\s円人日月時間]/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const int = (s) => { const n = num(s); return n == null ? null : Math.round(n); };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 多段ヘッダを列ごとに縦連結する（「令和６年度」＋「月額」＋「⑬工賃平均額」→ 1つの文字列） */
function combineHeader(rows, start, depth = 4) {
  const width = Math.max(...rows.slice(start, start + depth).map((r) => r?.length ?? 0));
  return Array.from({ length: width }, (_, j) =>
    rows.slice(start, start + depth).map((r) => (r?.[j] ?? '')).join(''));
}

/** 事業所名らしき列を含むヘッダ行を探す */
function findHeaderBlock(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const joined = (rows[i] ?? []).join('');
    if (/事業所名|施設名|事業所の名称|事業所名称/.test(joined)) return i;
  }
  return -1;
}

/** 汎用 XLSX パーサ */
export function parseWageXlsx(src, buf) {
  const out = [], warnings = [];
  for (const sheet of readXlsx(buf)) {
    const sheetType = src.serviceType ?? src.sheetType?.(sheet.name) ?? null;
    // 岡山県のように1シートへA型・B型を並べる様式があるため、
    // 「●就労継続支援Ａ型（雇用型）」のような節見出しでも種別を切り替えられるようにする。
    const sectioned = src.sectioned === true;
    if (!sheetType && !sectioned) continue;
    let serviceType = sheetType;
    const h = findHeaderBlock(sheet.rows);
    if (h < 0) { warnings.push(`${src.prefecture}/${sheet.name}: ヘッダ行を特定できず`); continue; }

    const header = combineHeader(sheet.rows, h);
    const col = mapColumns(header, WAGE_COLUMNS);
    if (col.facility == null || col.avg == null) {
      warnings.push(`${src.prefecture}/${sheet.name}: 事業所名または工賃平均額の列が見つからず`);
      continue;
    }
    let kept = 0;
    for (let i = h + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i];
      if (sectioned) {
        const joined = r.join('');
        if (/就労継続支援[ＡA]型/.test(joined) && !/^\d/.test(clean(r[0]))) { serviceType = A_TYPE; continue; }
        if (/就労継続支援[ＢB]型/.test(joined) && !/^\d/.test(clean(r[0]))) { serviceType = B_TYPE; continue; }
      }
      if (!serviceType) continue;
      const facility = clean(r[col.facility]);
      const avg = num(r[col.avg]);
      if (!facility || avg == null) continue;
      // ヘッダの続きや合計行を除く
      if (/合計|計$|平均$|事業所名|施設名/.test(facility)) continue;
      out.push({
        prefecture: src.prefecture, fiscalYear: src.fiscalYear, serviceType,
        officeNo: col.officeNo != null ? clean(r[col.officeNo]).replace(/\D/g, '') || null : null,
        corpNo: col.corpNo != null ? clean(r[col.corpNo]) || null : findCorpNo(header, r),
        corpName: col.corp != null ? clean(r[col.corp]) || null : null,
        facilityName: facility,
        city: col.city != null ? clean(r[col.city]) || null : null,
        capacity: col.capacity != null ? int(r[col.capacity]) : null,
        users: col.users != null ? int(r[col.users]) : null,
        dailyAvg: col.dailyAvg != null ? num(r[col.dailyAvg]) : null,
        months: col.months != null ? num(r[col.months]) : null,
        totalPaid: col.total != null ? int(r[col.total]) : null,
        avgMonthly: Math.round(avg),
        activities: [],
        sourceUrl: src.url, sourcePage: src.page,
      });
      kept++;
    }
    if (kept === 0) warnings.push(`${src.prefecture}/${sheet.name}: 該当行が0件`);
  }
  return { records: out, warnings };
}

/** 標準様式には「④法人番号」列がある。列名マップに無い場合の保険。 */
function findCorpNo(header, row) {
  const i = header.findIndex((h) => h.includes('法人番号'));
  if (i < 0) return null;
  const v = clean(row[i]).replace(/\D/g, '');
  return v.length === 13 ? v : null;
}

/**
 * 北海道PDF。事業所別に「主な作業内容1〜3」が載っている数少ないソース。
 *  B型: 種別 地区 「市町村 事業所名」 定員 支払総額 延人数 開所日数 1日平均 開所月数 平均額 形態 作業1 作業2 作業3
 *  A型: 種別 地区 「市町村 事業所名」 定員 延人数 支払総額 「平均額 作業1」 作業2 作業3
 */
export function parseHokkaidoPdf(src, buf) {
  const out = [], warnings = [];
  const rows = pdfTextToRows(pdfToText(buf));
  const isB = /B型|Ｂ型/.test(src.serviceType ?? '');
  const PAY_FORM = /^(日給|時給|月給|出来高|その他|時間給)(＋(日給|時給|月給|出来高))*$/;
  let skipped = 0;

  for (const r of rows) {
    if (!/^就労継続支援/.test(r[0] ?? '')) continue;

    // 市町村が独立したセルになる行と、事業所名と同じセルに入る行が混在する。
    // 列位置を決め打ちせず、数値の並びを手がかりに桁を特定する。
    let rec = null;
    if (isB) {
      // 定員/支払総額/延人数/開所日数/1日平均/開所月数/平均額 の7連続数値を探す
      let s0 = -1;
      for (let i = 2; i + 6 < r.length; i++) {
        if (Array.from({ length: 7 }, (_, k) => num(r[i + k])).every((v) => v != null)) { s0 = i; break; }
      }
      if (s0 < 0) { skipped++; continue; }
      const n = Array.from({ length: 7 }, (_, k) => num(r[s0 + k]));
      rec = {
        nameCells: r.slice(2, s0),
        capacity: Math.round(n[0]), totalPaid: Math.round(n[1]), users: Math.round(n[2]),
        dailyAvg: n[4], months: n[5], avgMonthly: Math.round(n[6]),
        activities: r.slice(s0 + 7).map(clean).filter(Boolean),
      };
    } else {
      // A型は「平均額 作業内容」が1セルに入る。小数付きの数値で始まるセルを探して起点にする。
      let i = -1;
      for (let k = 3; k < r.length; k++) {
        if (/^[\d,]+\.\d+(\s|$)/.test(clean(r[k]))) { i = k; break; }
      }
      if (i < 4) { skipped++; continue; }
      const m = clean(r[i]).match(/^([\d,]+\.\d+)\s*(.*)$/);
      const acts = [];
      if (m?.[2]) acts.push(m[2]);
      acts.push(...r.slice(i + 1).map(clean).filter(Boolean));
      rec = {
        nameCells: r.slice(2, i - 3),
        capacity: int(r[i - 3]), users: int(r[i - 2]), totalPaid: int(r[i - 1]),
        avgMonthly: m ? Math.round(Number(m[1].replace(/,/g, ''))) : null,
        activities: acts,
      };
    }
    if (rec.avgMonthly == null) { skipped++; continue; }

    // 名前セルは ["市町村 事業所名"] か ["市町村","事業所名"] のどちらか
    const cells = rec.nameCells.map(clean).filter(Boolean);
    let city = null, facility = '';
    if (cells.length >= 2) { city = cells[0]; facility = cells.slice(1).join(' '); }
    else if (cells.length === 1) {
      const sp = cells[0].indexOf(' ');
      if (sp > 0) { city = cells[0].slice(0, sp); facility = cells[0].slice(sp + 1); }
      else facility = cells[0];
    }
    if (!facility) { skipped++; continue; }

    out.push({
      prefecture: src.prefecture, fiscalYear: src.fiscalYear, serviceType: src.serviceType,
      officeNo: null, corpNo: null, corpName: null, facilityName: facility, city,
      capacity: rec.capacity, users: rec.users, dailyAvg: rec.dailyAvg ?? null, months: rec.months ?? null,
      totalPaid: rec.totalPaid, avgMonthly: rec.avgMonthly,
      activities: [...new Set(rec.activities.filter((a) => !PAY_FORM.test(a)))],
      sourceUrl: src.url, sourcePage: src.page,
    });
  }
  if (skipped) warnings.push(`${src.prefecture} ${src.serviceType}: ${skipped}行を読み取れず除外`);
  if (out.length === 0) warnings.push(`${src.prefecture}: PDFから0件（レイアウト変更の可能性）`);
  return { records: out, warnings };
}

/**
 * 福岡県PDF。行頭に10桁の事業所番号がある。
 * 法人名と事業所名が別セルに分かれる行があるため、数値4つ（定員・延人数・総額・平均額）を
 * 末尾から数えて桁を確定させる。
 */
export function parseFukuokaPdf(src, buf) {
  const out = [], warnings = [];
  let skipped = 0;
  for (const r of pdfTextToRows(pdfToText(buf))) {
    const m = clean(r[0]).match(/^(\d{10})\s*(.*)$/);
    if (!m) continue;
    if (r.length < 5) { skipped++; continue; }
    const tail = r.slice(-4).map(int);
    if (tail.some((v) => v == null)) { skipped++; continue; }
    const [capacity, users, totalPaid, avgMonthly] = tail;

    // 数値の手前は […法人名/事業所名…, 市町村, 圏域]
    const prefix = r.slice(0, r.length - 4).map(clean).filter(Boolean);
    prefix[0] = m[2];                       // 先頭セルから事業所番号を外す
    const city = prefix.length >= 3 ? prefix[prefix.length - 2] : null;
    const nameParts = prefix.length >= 3 ? prefix.slice(0, -2) : prefix.slice(0, 1);
    const facilityName = nameParts.filter(Boolean).join(' ').trim();
    if (!facilityName) { skipped++; continue; }

    out.push({
      prefecture: src.prefecture, fiscalYear: src.fiscalYear, serviceType: src.serviceType,
      officeNo: m[1], corpNo: null, corpName: null, facilityName, city,
      capacity, users, dailyAvg: null, months: null, totalPaid, avgMonthly, activities: [],
      sourceUrl: src.url, sourcePage: src.page,
    });
  }
  if (skipped) warnings.push(`${src.prefecture} ${src.serviceType}: ${skipped}行を読み取れず除外`);
  if (out.length === 0) warnings.push(`${src.prefecture}: PDFから0件`);
  return { records: out, warnings };
}

/**
 * 算術による検証。
 * 平均工賃は「支払総額 ÷ 対象者延人数」であるべきなので、
 * 大きく食い違う行は桁がずれて読めていると判断して落とす。
 * 誤った工賃を表示するより、載せないほうが害が小さい。
 */
export function validateWageRecords(records) {
  const ok = [], rejected = [];
  for (const r of records) {
    if (r.avgMonthly == null || r.avgMonthly < 0) { rejected.push({ r, why: '平均額が読めない' }); continue; }

    // 平均工賃月額の計算式は方式によって分母が違うため、いずれかに合致すればよしとする。
    const expectations = [];
    if (r.totalPaid && r.users > 0) expectations.push(r.totalPaid / r.users);                    // 対象者延人数方式
    if (r.totalPaid && r.dailyAvg > 0 && r.months > 0) expectations.push(r.totalPaid / (r.dailyAvg * r.months)); // 新計算方式

    if (expectations.length) {
      const fits = expectations.some((e) => Math.abs(r.avgMonthly - e) <= Math.max(e * 0.3, 2000));
      if (!fits) {
        rejected.push({ r, why: `平均額${r.avgMonthly}が計算値(${expectations.map((e) => Math.round(e)).join(' / ')})と不整合` });
        continue;
      }
    }
    if (r.avgMonthly > 500000) { rejected.push({ r, why: `平均工賃が非現実的（${r.avgMonthly}円）` }); continue; }
    ok.push(r);
  }
  return { records: ok, rejected };
}

/**
 * 愛知県PDF。国の標準様式をそのままPDF化したもので、
 * 法人番号・事業所番号・主な作業内容①〜③がすべて載っている最も情報量の多いソース。
 * 事業所番号（10桁）の位置を起点にして桁を確定させる。
 */
export function parseAichiPdf(src, buf) {
  const out = [], warnings = [];
  const isB = /B型|Ｂ型/.test(src.serviceType ?? '');
  // 「6クリーニング」「12その他の役務」のように分類名の先頭に番号が付く。
  // 「5.0%」のような収入割合のセルを拾わないよう、続きが日本語であることを条件にする。
  const ACT = /^(\d{1,2})\s*([ぁ-んァ-ヶ一-龠][^%]*)$/;
  let skipped = 0;

  for (const r of pdfTextToRows(pdfToText(buf))) {
    if (clean(r[0]) !== src.prefecture.replace(/[県府都道]$/, '') && clean(r[0]) !== src.prefecture) continue;
    const i = r.findIndex((c) => /^\d{10}$/.test(clean(c)));
    if (i < 0) { skipped++; continue; }

    const officeNo = clean(r[i]);
    const corpNo = [...r.slice(0, i)].map(clean).find((c) => /^\d{13}$/.test(c)) ?? null;
    const corpName = clean(r[i - 2]) || null;
    const facilityName = clean(r[i - 1]);
    const city = clean(r[i + 1]) || null;
    if (!facilityName) { skipped++; continue; }

    const rec = isB
      ? { capacity: int(r[i + 2]), totalPaid: int(r[i + 3]), users: int(r[i + 4]),
          dailyAvg: num(r[i + 6]), months: num(r[i + 7]), avgMonthly: int(r[i + 8]), from: i + 9 }
      : { capacity: int(r[i + 2]), users: int(r[i + 3]), totalPaid: int(r[i + 4]),
          dailyAvg: null, months: null, avgMonthly: int(r[i + 5]), from: i + 6 };
    if (rec.avgMonthly == null) { skipped++; continue; }

    const activities = [];
    for (const cell of r.slice(rec.from).map(clean)) {
      const m = cell.match(ACT);
      if (m) activities.push(m[2].trim());
    }

    out.push({
      prefecture: src.prefecture, fiscalYear: src.fiscalYear, serviceType: src.serviceType,
      officeNo, corpNo, corpName, facilityName, city,
      capacity: rec.capacity, users: rec.users, dailyAvg: rec.dailyAvg, months: rec.months,
      totalPaid: rec.totalPaid, avgMonthly: rec.avgMonthly,
      activities: [...new Set(activities)],
      sourceUrl: src.url, sourcePage: src.page,
    });
  }
  if (skipped) warnings.push(`${src.prefecture} ${src.serviceType}: ${skipped}行を読み取れず除外`);
  if (out.length === 0) warnings.push(`${src.prefecture}: PDFから0件`);
  return { records: out, warnings };
}

const PDF_PARSERS = { 北海道: parseHokkaidoPdf, 福岡県: parseFukuokaPdf, 愛知県: parseAichiPdf };

export function parseWageSource(src, buf) {
  const res = parseWageSourceRaw(src, buf);
  const { records, rejected } = validateWageRecords(res.records);
  const warnings = [...res.warnings];
  if (rejected.length) warnings.push(`${src.prefecture}: 数値の整合が取れない ${rejected.length}件を除外`);
  return { records, warnings, rejected };
}

function parseWageSourceRaw(src, buf) {
  if (src.format === 'xlsx') return parseWageXlsx(src, buf);
  if (src.format === 'pdf') {
    if (!pdfToTextAvailable()) {
      return { records: [], warnings: [`${src.prefecture}: pdftotext が無いためPDFを読めません（brew install poppler）`] };
    }
    const p = PDF_PARSERS[src.prefecture];
    if (!p) return { records: [], warnings: [`${src.prefecture}: このPDFに対応するパーサが未実装（集計値のみの資料の可能性）`] };
    return p(src, buf);
  }
  return { records: [], warnings: [`${src.prefecture}: 未対応の形式 ${src.format}`] };
}

/** 東京都「物品・役務の情報リスト」。事業所別に分類と内容が載っている。 */
export function parseActivityXlsx(src, buf) {
  const out = [], warnings = [];
  const sheet = readXlsx(buf)[0];
  if (!sheet) return { records: [], warnings: ['シートが読めません'] };
  const h = findHeaderBlock(sheet.rows);
  if (h < 0) return { records: [], warnings: ['ヘッダ行を特定できず'] };
  const col = mapColumns(combineHeader(sheet.rows, h, 2), src.columns);
  if (col.facility == null || col.category == null) return { records: [], warnings: ['事業所名または分類の列が見つからず'] };
  for (let i = h + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i];
    const facility = clean(r[col.facility]);
    const category = clean(r[col.category]);
    if (!facility || !category) continue;
    out.push({
      prefecture: src.prefecture, facilityName: facility,
      corpName: col.corp != null ? clean(r[col.corp]) || null : null,
      city: col.city != null ? clean(r[col.city]) || null : null,
      category, detail: col.detail != null ? clean(r[col.detail]) || null : null,
      sourceUrl: src.url, sourcePage: src.page, sourceName: src.name,
    });
  }
  if (out.length === 0) warnings.push(`${src.prefecture}: 生産活動0件`);
  return { records: out, warnings };
}
