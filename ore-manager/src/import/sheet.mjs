/**
 * 事業管理シート（Googleスプレッドシート）の取り込み
 *
 *   npm run import                      … data/sheet-export.md を読む
 *   npm run import -- 別のファイル.md    … 取り込み元を指定する
 *
 * スプレッドシートをMarkdownで書き出したものを読み、SQLiteに入れる。
 * 何度実行しても同じ結果になる（source_key で上書きする）ので、
 * シートを更新したら書き出し直して、そのまま流せばよい。
 *
 * 表の見つけ方は「見出し行の列名」で行っている。行番号で決め打ちすると、
 * シートに1行挿入されただけで全部ずれるため。
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = join(ROOT, 'data', 'ore.db');

/* ============================================================
   セルの掃除
   ============================================================ */

/** Markdown書き出しのノイズを落とす。 */
function cell(s) {
  return String(s == null ? '' : s)
    .replace(/\\(.)/g, '$1')              // \[merged\] → [merged]
    .replace(/\[merged\]\s*/g, '')        // 結合セルの印
    .replace(/ /g, ' ')              // ノーブレークスペース
    .trim()
    .replace(/^[-–—]$/, '');    // 「-」だけのセルは空扱い
}

/** 「¥1,234」「1,234円」→ 1234。空や数値でないものは0。 */
function money(s) {
  const t = cell(s).replace(/[¥￥,、\s円]/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return 0;
  return Math.round(Number(t));
}

/** 数値。パーセントや #DIV/0! は null にする。 */
function num(s) {
  const t = cell(s).replace(/[,\s]/g, '');
  if (!t || /DIV|REF|VALUE|N\/A/i.test(t)) return null;
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** 「2025/06/03」「2025-6-3」「6/3」→ YYYY-MM-DD。年が無ければ既定年を使う。 */
function date(s, fallbackYear) {
  const t = cell(s);
  let m = t.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  m = t.match(/^(\d{1,2})[/\-月](\d{1,2})/);
  if (m && fallbackYear) return fallbackYear + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
  return '';
}

const hash = (...parts) => createHash('sha1').update(parts.join(' ')).digest('hex').slice(0, 16);

/* ============================================================
   表の切り出し
   ============================================================ */

/** 1行を列の配列にする。 */
const cols = (line) => line.split('|').slice(1, -1).map(cell);

/**
 * 見出しの列名から表を探し、行を {列名: 値} の配列で返す。
 * 空行が2つ続いたら表の終わりとみなす。
 */
function table(lines, mustHave) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].split('|').length < 3) continue;
    const head = cols(lines[i]);
    if (!mustHave.every((h) => head.includes(h))) continue;

    const rows = [];
    let blanks = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const c = cols(lines[j]);
      if (!c.length) break;
      if (c.every((v) => !v || /^:-+:?$/.test(v))) { if (++blanks >= 2) break; continue; }
      blanks = 0;
      const o = {};
      head.forEach((h, k) => { if (h) o[h] = c[k] ?? ''; });
      rows.push(o);
    }
    return { headerLine: i, head, rows };
  }
  return null;
}

/* ============================================================
   取り込み
   ============================================================ */

function openDb() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  return db;
}

/** 入出金明細 */
function importCashflow(db, lines) {
  const t = table(lines, ['日付', '種別', '収入(円)', '支出(円)']);
  if (!t) return 0;
  const put = db.prepare(`INSERT INTO cashflow
    (source_key,date,kind,category,income,expense,method,summary,memo)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      date=excluded.date, kind=excluded.kind, category=excluded.category,
      income=excluded.income, expense=excluded.expense, method=excluded.method,
      summary=excluded.summary, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const d = date(r['日付']);
    if (!d) continue;
    const key = 'cf:' + (r['No'] || hash(d, r['摘要'] || '', r['収入(円)'] || '', r['支出(円)'] || ''));
    put.run(key, d, cell(r['種別']) || (money(r['収入(円)']) ? '収入' : '支出'),
      cell(r['カテゴリ']), money(r['収入(円)']), money(r['支出(円)']),
      cell(r['支払方法']), cell(r['摘要']), cell(r['メモ']));
    n++;
  }
  return n;
}

/** 経費明細 */
function importExpenses(db, lines) {
  const t = table(lines, ['日付', '経費カテゴリ', '金額(円)', '勘定科目']);
  if (!t) return 0;
  const put = db.prepare(`INSERT INTO expenses
    (source_key,date,category,summary,amount,method,account,tax_class,receipt_no,memo)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      date=excluded.date, category=excluded.category, summary=excluded.summary,
      amount=excluded.amount, method=excluded.method, account=excluded.account,
      tax_class=excluded.tax_class, receipt_no=excluded.receipt_no, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const d = date(r['日付']);
    if (!d) continue;
    const key = 'ex:' + (r['No'] || hash(d, r['摘要'] || '', r['金額(円)'] || ''));
    put.run(key, d, cell(r['経費カテゴリ']), cell(r['摘要']), money(r['金額(円)']),
      cell(r['支払方法']), cell(r['勘定科目']), cell(r['税区分']),
      cell(r['領収書No']), cell(r['メモ']));
    n++;
  }
  return n;
}

/** 人脈台帳 */
function importContacts(db, lines) {
  const t = table(lines, ['日時', '会社名', '氏名', '出会い']);
  if (!t) return 0;
  const put = db.prepare(`INSERT INTO contacts
    (source_key,met_on,company,name,channel,framing,industry,strength,problem,next_action,next_step,done,good_match,memo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      met_on=excluded.met_on, company=excluded.company, name=excluded.name,
      channel=excluded.channel, framing=excluded.framing, industry=excluded.industry,
      strength=excluded.strength, problem=excluded.problem, next_action=excluded.next_action,
      next_step=excluded.next_step, done=excluded.done, good_match=excluded.good_match, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const name = cell(r['氏名']), company = cell(r['会社名']);
    if (!name && !company) continue;
    const d = date(r['日時']);
    put.run('ct:' + hash(d, company, name), d, company, name,
      cell(r['出会い']), cell(r['立て付け']), cell(r['業種']), cell(r['相手の強み']),
      cell(r['お困りごと']), cell(r['ネクストアクション']), cell(r['ネクストステップ']),
      cell(r['完了有無']), cell(r['相性良い会社']), cell(r['備考']));
    n++;
  }
  return n;
}

/** 案件・契約 */
function importDeals(db, lines) {
  const t = table(lines, ['会社名(ジャンル)', '担当者', '契約状況']);
  if (!t) return 0;
  const put = db.prepare(`INSERT INTO deals
    (source_key,company,person,referrer,status,offer_monthly,closed_on,amount,monthly,months,cost,content,next_offer,profit_month,memo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      company=excluded.company, person=excluded.person, referrer=excluded.referrer,
      status=excluded.status, offer_monthly=excluded.offer_monthly, closed_on=excluded.closed_on,
      amount=excluded.amount, monthly=excluded.monthly, months=excluded.months, cost=excluded.cost,
      content=excluded.content, next_offer=excluded.next_offer, profit_month=excluded.profit_month`);
  let n = 0;
  for (const r of t.rows) {
    // 会社名が空でも担当者名だけで管理している行がある（個人事業主など）
    const company = cell(r['会社名(ジャンル)']);
    const person = cell(r['担当者']);
    if (!company && !person) continue;
    const key = 'dl:' + (r['No'] || hash(company, person));
    put.run(key, company, person, cell(r['紹介者']), cell(r['契約状況']),
      money(r['月額オファー']), date(r['締結日']), money(r['受注金額']), money(r['月額金額']),
      num(r['期間']), money(r['払出金']), cell(r['契約内容']), cell(r['今後提案予定']),
      money(r['見込利益(月間)']), cell(r['備考']));
    n++;
  }
  return n;
}

/** 商談パイプライン（契約前の動き） */
function importPipeline(db, lines) {
  const t = table(lines, ['案件名', '企業名', '進捗', '月額見積']);
  if (!t) return 0;
  const put = db.prepare(`INSERT INTO pipeline
    (source_key,title,company,person,broker,first_met,status,quote_once,quote_month,due,closed_on,note,lost_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      title=excluded.title, company=excluded.company, person=excluded.person, broker=excluded.broker,
      first_met=excluded.first_met, status=excluded.status, quote_once=excluded.quote_once,
      quote_month=excluded.quote_month, due=excluded.due, closed_on=excluded.closed_on,
      note=excluded.note, lost_reason=excluded.lost_reason`);
  let n = 0;
  for (const r of t.rows) {
    const title = cell(r['案件名']), company = cell(r['企業名']);
    if (!title && !company) continue;
    const key = 'pl:' + (r['No'] || hash(title, company, cell(r['担当者名'])));
    put.run(key, title, company, cell(r['担当者名']), cell(r['仲介者氏名']),
      date(r['初回面談']), cell(r['進捗']), money(r['単発見積']), money(r['月額見積']),
      cell(r['期限']), date(r['契約締結日']), cell(r['備考(進捗含む)']), cell(r['失注理由']));
    n++;
  }
  return n;
}

/**
 * 週次KPI。
 * 「2026年9月」で月が変わり、「【目標】| 週…」の行から表が始まる。
 * 〈…〉の行が区分の切り替わり。
 */
function importKpi(db, lines) {
  const put = db.prepare(`INSERT INTO kpi (month,week,section,metric,target,actual)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(month,week,section,metric) DO UPDATE SET target=excluded.target, actual=excluded.actual`);
  let month = null, section = null, inBlock = false, n = 0;

  for (const line of lines) {
    const c = cols(line);
    if (!c.length) continue;
    const joined = c.join(' ');

    const ym = joined.match(/(\d{4})年(\d{1,2})月/);
    if (ym && c.filter(Boolean).length <= 3) {
      month = ym[1] + '-' + String(ym[2]).padStart(2, '0');
      inBlock = false;
      continue;
    }
    if (c.includes('【目標】') && c.includes('【結果】')) { inBlock = true; section = null; continue; }
    // 次の見出し（【…】）が来たらKPIブロックは終わり。
    // ここで抜けないと、後ろにある収支計画の〈売上〉〈支出〉まで
    // KPIの区分として拾ってしまう
    if (inBlock && joined.includes('【')) { inBlock = false; continue; }
    if (!inBlock || !month) continue;

    const sec = joined.match(/〈([^〉]+)〉/);
    if (sec) { section = sec[1]; continue; }

    // 目標側: [1]=指標, [2..5]=週 / 結果側: [8]=指標, [9..12]=週
    const metric = c[1];
    if (!metric || !section) continue;
    for (let w = 1; w <= 4; w++) {
      const target = num(c[1 + w]);
      const actual = num(c[8 + w]);
      if (target == null && actual == null) continue;
      put.run(month, w, section, metric, target, actual);
      n++;
    }
  }
  return n;
}

/**
 * 月次の収支計画。「1月…12月」の見出し行を基準に読む。
 * 年はその手前に出てくる「20xx年」を使う。
 */
function importPlan(db, lines) {
  let headIdx = -1, year = new Date().getFullYear();
  for (let i = 0; i < lines.length; i++) {
    const c = cols(lines[i]);
    if (c.includes('1月') && c.includes('12月')) { headIdx = i; break; }
  }
  if (headIdx < 0) return 0;
  for (let i = headIdx; i >= 0 && i > headIdx - 40; i--) {
    const m = lines[i].match(/(\d{4})年/);
    if (m) { year = Number(m[1]); break; }
  }
  const head = cols(lines[headIdx]);
  const monthCols = head.map((h, i) => (/^(\d{1,2})月$/.test(h) ? { i, m: Number(h.replace('月', '')) } : null)).filter(Boolean);

  const put = db.prepare(`INSERT INTO plan_monthly (month,side,category,subcategory,amount)
    VALUES (?,?,?,?,?)
    ON CONFLICT(month,side,category,subcategory) DO UPDATE SET amount=excluded.amount`);
  let side = null, n = 0;

  for (let i = headIdx + 1; i < lines.length; i++) {
    const c = cols(lines[i]);
    if (!c.length) continue;
    const joined = c.join('');
    const sec = joined.match(/〈(売上|支出)〉/);
    if (sec) { side = sec[1]; continue; }
    if (/〈(結果数値|企業情報|目標売上|目安数値)〉/.test(joined)) break;
    if (!side) continue;

    const category = c[1] || '';
    const subcategory = (c[2] && c[2] !== category) ? c[2] : '';
    if (!category && !subcategory) continue;
    for (const mc of monthCols) {
      const v = money(c[mc.i]);
      if (!v) continue;
      put.run(year + '-' + String(mc.m).padStart(2, '0'), side, category, subcategory, v);
      n++;
    }
  }
  return n;
}

/* ============================================================ */

const src = process.argv[2] || join(ROOT, 'data', 'sheet-export.md');
const lines = readFileSync(src, 'utf8').split('\n');
const db = openDb();

console.log('取り込み元: ' + src);
const done = {
  '入出金明細': importCashflow(db, lines),
  '経費明細': importExpenses(db, lines),
  '人脈台帳': importContacts(db, lines),
  '案件・契約': importDeals(db, lines),
  '商談パイプライン': importPipeline(db, lines),
  '週次KPI': importKpi(db, lines),
  '収支計画': importPlan(db, lines),
};
for (const [k, v] of Object.entries(done)) {
  console.log('  ' + (v ? '✓' : '—') + ' ' + k + ' : ' + v + '件');
}
db.close();
