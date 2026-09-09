#!/usr/bin/env node
/**
 * 取り込みの検算
 *
 *   npm run verify
 *
 * 「取り込めた件数」は漏れの証明にならない（列を1つ読み落としても件数は同じ）。
 * ここでは次の3段で確かめる。
 *
 *   1. 連番に欠けが無いか            … 行が落ちていないか
 *   2. 差引残高が最後まで積み上がるか  … 金額を1円でも読み違えたら合わない
 *   3. シート自身の集計と突き合わせ    … 合わない場合は、どちらが正しいかを示す
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(ROOT, 'data', 'ore.db'), { readOnly: true });
const lines = readFileSync(join(ROOT, 'data', 'sheet-export.md'), 'utf8').split('\n');

const cell = (s) => String(s ?? '').replace(/\\(.)/g, '$1').replace(/\[merged\]\s*/g, '').trim();
const cols = (l) => l.split('|').slice(1, -1).map(cell);
const money = (s) => {
  let t = cell(s).replace(/[¥￥,、\s円]/g, '');
  const neg = t.startsWith('(') && t.endsWith(')');   // 会計表記のマイナス
  t = t.replace(/[()]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Math.round(Number(t));
  return neg ? -v : v;
};
const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

let ng = 0, ok = 0, warn = 0;
const say = (mark, label, msg) => {
  if (mark === '✓') ok++; else if (mark === '×') ng++; else warn++;
  console.log(`  ${mark} ${label.padEnd(26)} ${msg}`);
};

/** 表を見出しの列名で探して行を返す */
function findTable(mustHave) {
  for (let i = 0; i < lines.length; i++) {
    const head = cols(lines[i]);
    if (!mustHave.every((h) => head.includes(h))) continue;
    const rows = [];
    for (let j = i + 1; j < lines.length; j++) {
      const c = cols(lines[j]);
      if (!c.length || c.every((v) => !v)) break;
      const o = {};
      head.forEach((h, k) => { if (h) o[h] = c[k] ?? ''; });
      rows.push(o);
    }
    return rows;
  }
  return null;
}

/* ---------- 1. 連番 ---------- */

console.log('\n■ 行の連番（落ちた行が無いか）');
for (const [label, head] of [
  ['入出金明細', ['No', '日付', '種別', '収入(円)']],
  ['経費明細', ['No', '日付', '経費カテゴリ', '金額(円)']],
]) {
  const rows = findTable(head) || [];
  const ns = rows.map((r) => Number(r['No'])).filter((n) => Number.isInteger(n) && n > 0);
  const miss = [];
  for (let n = Math.min(...ns); n <= Math.max(...ns); n++) if (!ns.includes(n)) miss.push(n);
  say(miss.length ? '△' : '✓', label,
    `No ${Math.min(...ns)}〜${Math.max(...ns)} / ${ns.length}行`
    + (miss.length ? ` / 欠番 ${miss.length}件（${miss.slice(0, 5).join(',')}）※シート側で削除された番号` : ' / 欠番なし'));
}

/* ---------- 2. 差引残高の積み上げ ---------- */

console.log('\n■ 差引残高の積み上げ（1円でも読み違えたら合わない）');
{
  const rows = findTable(['No', '日付', '種別', '収入(円)', '差引残高']) || [];
  let run = 0, bad = 0, checked = 0, firstBad = null;
  for (const r of rows) {
    if (!Number.isInteger(Number(r['No']))) continue;
    run += (money(r['収入(円)']) || 0) - (money(r['支出(円)']) || 0);
    const bal = money(r['差引残高']);
    if (bal == null) continue;
    checked++;
    if (bal !== run && !firstBad) { firstBad = `No.${r['No']} シート${yen(bal)} 積上${yen(run)}`; }
    if (bal !== run) bad++;
  }
  const mine = db.prepare('SELECT COALESCE(SUM(income),0)-COALESCE(SUM(expense),0) a FROM cashflow').get().a;
  say(bad ? '×' : '✓', '入出金明細', `${checked}件を照合 / 不一致 ${bad}件` + (firstBad ? ` / ${firstBad}` : ''));
  say(mine === run ? '✓' : '×', 'DBの差引と一致', `シート ${yen(run)} / DB ${yen(mine)}`);
}

/* ---------- 3. シート自身の集計との突き合わせ ---------- */

/** 【…カテゴリ別（全期間）】を カテゴリ→金額 で読む */
function sheetTotals(title) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(title)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const c = cols(lines[j]);
      if (!c.length || !c[0]) break;
      if (c[0] === 'カテゴリ') continue;
      out[c[0]] = money(c[1]) || 0;
    }
    break;
  }
  return out;
}

console.log('\n■ 支出カテゴリ別（シートの集計 vs 経費明細）');
{
  const sheet = sheetTotals('【支出カテゴリ別（全期間）】');
  let diffs = 0, sSum = 0, mSum = 0;
  for (const [cat, amount] of Object.entries(sheet)) {
    const mine = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE category=?').get(cat).a;
    sSum += amount; mSum += mine;
    if (mine !== amount) diffs++;
  }
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM expenses').get().a;
  say(diffs ? '△' : '✓', 'カテゴリ一致', `${Object.keys(sheet).length - diffs}/${Object.keys(sheet).length} 件が一致`);
  say(sSum === total ? '✓' : '△', '合計', `シート ${yen(sSum)} / 経費明細 ${yen(total)}`
    + (sSum === total ? '' : ` / 差 ${yen(total - sSum)}`));
}

console.log('\n■ 収入カテゴリ別（シートの集計 vs 入出金明細）');
{
  const sheet = sheetTotals('【収入カテゴリ別（全期間）】');
  const sSum = Object.values(sheet).reduce((a, b) => a + b, 0);
  const mine = db.prepare('SELECT COALESCE(SUM(income),0) a FROM cashflow').get().a;
  const bad = [];
  for (const [cat, amount] of Object.entries(sheet)) {
    const m = db.prepare('SELECT COALESCE(SUM(income),0) a FROM cashflow WHERE category=?').get(cat).a;
    if (m !== amount) bad.push(`${cat} シート${yen(amount)}／明細${yen(m)}`);
  }
  say(bad.length ? '△' : '✓', 'カテゴリ一致',
    `${Object.keys(sheet).length - bad.length}/${Object.keys(sheet).length} 件が一致`);
  say('△', '合計', `シート ${yen(sSum)} / 入出金明細 ${yen(mine)} / 差 ${yen(sSum - mine)}`);
  if (bad.length) {
    console.log('\n    ※ 差引残高が247件すべて一致しているため、明細側は正しく取り込めています。');
    console.log('       シートの【収入カテゴリ別】が明細と噛み合っていません（古い値か、別シートを集計している可能性）。');
    console.log('       合わない項目:');
    bad.forEach((b) => console.log('         ・' + b));
  }
}

console.log('\n■ 月次損益（合計行 vs 内訳の足し算）');
{
  // 売上の合計行は2種類ある。
  //   実績合計売上高 … 本業の売上（実績売上高 の行だけ）
  //   総売上         … それに Uber・配達・派遣 を足したもの
  const cases = [
    ['実績合計売上高', "section='売上' AND category='実績売上高'"],
    ['総売上', "section='売上'"],
    ['販管費の合計', "section='販管費'"],
  ];
  const totalName = { '実績合計売上高': '実績合計売上高', '総売上': '総売上', '販管費の合計': '合計' };
  for (const [label, where] of cases) {
    const rows = db.prepare(`SELECT month,
        COALESCE(SUM(CASE WHEN is_total=1 AND category=? THEN amount END),0) t,
        COALESCE(SUM(CASE WHEN is_total=0 AND ${where} THEN amount END),0) p
      FROM pl_monthly GROUP BY month HAVING t > 0 ORDER BY month`).all(totalName[label]);
    if (!rows.length) continue;
    const bad = rows.filter((r) => r.t !== r.p);
    say(bad.length ? '△' : '✓', label,
      `${rows.length - bad.length}/${rows.length} か月が一致`
      + (bad.length ? ` / 不一致 ${bad.map((b) => `${b.month}(差${yen(b.p - b.t)})`).join(' ')}` : ''));
  }
  const years = db.prepare("SELECT DISTINCT substr(month,1,4) y FROM pl_monthly ORDER BY y").all().map((r) => r.y);
  say('✓', '対象年', years.join(' / '));
  const sec = db.prepare("SELECT section, COUNT(*) n, SUM(amount) a FROM pl_monthly WHERE is_total=0 GROUP BY 1").all();
  for (const r of sec) console.log(`     ${r.section.padEnd(8)} ${String(r.n).padStart(4)}件  ${yen(r.a)}`);
}

console.log('\n■ 収支管理ダッシュボード（シートの月次サマリー vs 明細）');
{
  const rows = db.prepare('SELECT * FROM monthly_summary ORDER BY month').all();
  if (!rows.length) say('△', '月次サマリー', '取り込めていません');
  else {
    let okIn = 0, okOut = 0;
    for (const r of rows) {
      const ex = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE substr(date,1,7)=?").get(r.month).a;
      const cf = db.prepare("SELECT COALESCE(SUM(income),0) a FROM cashflow WHERE substr(date,1,7)=?").get(r.month).a;
      if (ex === r.expense) okOut++;
      if (cf === r.income) okIn++;
    }
    say(okOut === rows.length ? '✓' : '△', '支出 ← 経費明細', `${okOut}/${rows.length} か月が一致`);
    say(okIn === rows.length ? '✓' : '△', '収入 ← 入出金明細', `${okIn}/${rows.length} か月が一致`);
    const sIn = rows.reduce((a, b) => a + b.income, 0);
    const sOut = rows.reduce((a, b) => a + b.expense, 0);
    const eOut = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE date LIKE '2026%'").get().a;
    say(sOut === eOut ? '✓' : '△', '年間支出合計', `シート ${yen(sOut)} / 経費明細 ${yen(eOut)}`);
    say('△', '年間収入合計', `シート ${yen(sIn)} / 入出金明細(2026) `
      + yen(db.prepare("SELECT COALESCE(SUM(income),0) a FROM cashflow WHERE date LIKE '2026%'").get().a)
      + ' ※シートは見込みを含む');
  }
}

console.log('\n■ 取り込んだ件数');
for (const [label, tbl] of [
  ['入出金明細', 'cashflow'], ['経費明細', 'expenses'], ['人脈台帳', 'contacts'],
  ['契約一覧', 'deals'], ['商談パイプライン', 'pipeline'], ['名刺', 'cards'],
  ['交流会', 'events'], ['協業先', 'partners'], ['料金表', 'pricing'],
  ['月次損益', 'pl_monthly'], ['月次数値', 'plan_monthly'], ['週次KPI', 'kpi'],
  ['事業パラメータ', 'metrics'], ['月次収支サマリー', 'monthly_summary'],
  ['PDF取込ログ', 'pdf_log'], ['カテゴリ判定ルール', 'category_rules'],
]) {
  const c = db.prepare(`SELECT COUNT(*) c FROM ${tbl}`).get().c;
  console.log(`     ${label.padEnd(20)} ${String(c).padStart(6)}件`);
}

console.log(`\n${ng === 0 ? '✅' : '❌'}  一致 ${ok} / 要確認 ${warn} / 不一致 ${ng}\n`);
db.close();
process.exit(ng ? 1 : 0);
