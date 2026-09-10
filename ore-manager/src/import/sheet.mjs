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
import { migrate } from '../db/migrate.mjs';
import { TABLES } from '../tables.mjs';

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
  let t = cell(s).replace(/[¥￥,、\s円]/g, '');
  // 会計表記のマイナス。(¥22,203) は -22203
  const neg = t.startsWith('(') && t.endsWith(')');
  if (neg) t = t.slice(1, -1);
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return 0;
  const v = Math.round(Number(t));
  return neg ? -v : v;
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
  migrate(db, Object.keys(TABLES));
  return db;
}

/**
 * 取り込み用のINSERT文を用意する。
 *
 * 画面で直した行（edited_at が入っている行）は上書きしない。
 * これが無いと、シートを取り込み直すたびに手で直した内容が黙って消える。
 */
function prep(db, sql) {
  const m = sql.match(/INSERT INTO (\w+)/);
  const tail = sql.split('DO UPDATE SET')[1];
  if (m && tail && !/\bWHERE\b/.test(tail)) sql += ` WHERE ${m[1]}.edited_at IS NULL`;
  return db.prepare(sql);
}

/** 入出金明細 */
function importCashflow(db, lines) {
  const t = table(lines, ['日付', '種別', '収入(円)', '支出(円)']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO cashflow
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
  const put = prep(db, `INSERT INTO expenses
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
  const put = prep(db, `INSERT INTO contacts
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
  const put = prep(db, `INSERT INTO deals
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

/**
 * 商談パイプライン（契約前の動き）
 *
 * 日付が「4/3」「5/11」のように月日だけで、年が入っていない。
 * そこで、行の並び順に沿って年を推定する。月が大きく戻ったら年をまたいだとみなす。
 *
 * 起点が2023年であることは、P/Lと突き合わせて確かめてある。
 *   商談 No.8「株式会社Rush 面談5/1 締結5月 月額¥49,000」
 *   P/L  「(株)Rush」の売上が 2023-05 から ¥49,000/月 で立っている
 *
 * 推定なので、違っていたら画面で直せる（直した行は取り込みで上書きされない）。
 */
const PIPELINE_START_YEAR = 2023;

function importPipeline(db, lines) {
  const t = table(lines, ['案件名', '企業名', '進捗', '月額見積']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO pipeline
    (source_key,title,company,person,broker,first_met,status,quote_once,quote_month,due,closed_on,note,lost_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      title=excluded.title, company=excluded.company, person=excluded.person, broker=excluded.broker,
      first_met=excluded.first_met, status=excluded.status, quote_once=excluded.quote_once,
      quote_month=excluded.quote_month, due=excluded.due, closed_on=excluded.closed_on,
      note=excluded.note, lost_reason=excluded.lost_reason`);

  let year = PIPELINE_START_YEAR, lastMonth = 0, n = 0;

  /** 「4/3」→ {m,d}。年が無い月日だけを拾う。 */
  const md = (v) => {
    const m = cell(v).match(/^(\d{1,2})[/\-月](\d{1,2})/);
    return m ? { m: Number(m[1]), d: Number(m[2]) } : null;
  };

  for (const r of t.rows) {
    const title = cell(r['案件名']), company = cell(r['企業名']);
    if (!title && !company) continue;

    const met = md(r['初回面談']);
    const clo = md(r['契約締結日']);
    const lead = met || clo;
    if (lead) {
      /*
       * 年をまたいだとみなすのは「12月あたり → 1〜3月」に落ちたときだけ。
       * 実データを見ると、月が1〜2か月戻るのは入力の並びのゆらぎで、
       * 本当の年またぎは 12月→2月 / 12月→1月 の形をしていた。
       * 緩く判定すると年が増えすぎて、ありもしない未来の年ができる。
       */
      if (lastMonth >= 10 && lead.m <= 3) year++;
      // 過去の商談の表なので、今年より先には進まない
      const thisYear = new Date().getFullYear();
      if (year > thisYear) year = thisYear;
      lastMonth = lead.m;
    }
    const iso = (x) => (x ? year + '-' + String(x.m).padStart(2, '0') + '-' + String(x.d).padStart(2, '0') : '');

    // 締結日は「5月」「夏以降」「未定」も入る。月だけ分かるものは年月にし、
    // それ以外は書かれたまま残す（勝手に日付にしない）
    let closed = iso(clo);
    if (!closed) {
      const onlyMonth = cell(r['契約締結日']).match(/^(\d{1,2})月$/);
      closed = onlyMonth ? year + '-' + String(onlyMonth[1]).padStart(2, '0') : cell(r['契約締結日']);
    }

    const key = 'pl2:' + (r['No'] || hash(title, company, cell(r['担当者名'])));
    put.run(key, title, company, cell(r['担当者名']), cell(r['仲介者氏名']),
      iso(met), cell(r['進捗']), money(r['単発見積']), money(r['月額見積']),
      cell(r['期限']), closed, cell(r['備考(進捗含む)']), cell(r['失注理由']));
    n++;
  }
  return n;
}

/**
 * 「月」の行から、列位置→月 の対応を作る。
 * 期の途中から始まる年（2023年は3月〜）もあるので、12か月ちょうどは求めない。
 */
function monthColumns(c) {
  const out = [];
  c.forEach((v, i) => {
    const m = String(v).match(/^(\d{1,2})月?$/);
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= 12) out.push({ i, m: n }); }
  });
  return out.length >= 3 ? out : null;
}

/**
 * 月次損益（着金ベース）。年ごとに1枚のP/Lが並んでいる。
 *
 * 縦の並びはこうなっている（2026年の例）。
 *
 *   実績合計売上高            ← 売上の合計
 *     実績売上高 | 福祉研修     ← 売上の内訳
 *     Uber / 派遣            ← これも売上
 *   総売上                    ← 売上の総合計
 *   目標売上 / 達成率          ← 指標
 *   販売費及び一般管理費        ← ここから支出
 *     外注費 | コンサル費 | KLP  ← 事業の経費
 *     通信費 | ケータイ
 *   経費合計                  ← 事業の経費の合計。★ここから下は個人のお金
 *     家賃光熱費 | | 家賃
 *     借金返済 | | 親族
 *     積立保険 / 貯蓄
 *   支出合計                  ← 事業＋個人の合計
 *   利益 / 利益率             ← 指標
 *
 * 大事なのは「経費合計」と「支出合計」に挟まれた部分が個人のお金だということ。
 * 名前から推測しなくても、シートの並びがそれを表している。
 *
 * 列の使い方は年によって違う（2024年は c[2] に中分類、2026年は c[1] に大分類）。
 * どちらでも読めるように、c[1] が「合計・指標の名前」かどうかで見分ける。
 */

/** 合計・指標として扱う行の名前。これ以外が c[1] に来たら分類名とみなす。 */
const PL_TOTALS = /^(実績合計売上高|実績合計売上原価|総売上|経費合計|支出合計|合計|営業利益|利益|利益率|目標売上|達成率|売上総利益|販売費及び一般管理費)(\(web\))?$/;
/** そのうち、金額ではなく指標として扱うもの。 */
const PL_METRICS = /^(利益|利益率|営業利益|目標売上|達成率|売上総利益)(\(web\))?$/;

function importPl(db, lines) {
  const put = prep(db, `INSERT INTO pl_monthly (source_key,month,section,category,subcategory,amount,is_total)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET amount=excluded.amount, section=excluded.section,
      category=excluded.category, subcategory=excluded.subcategory, is_total=excluded.is_total`);
  let n = 0;

  for (let i = 0; i < lines.length; i++) {
    const head = cols(lines[i]);
    if (!head.includes('着金ベース') || !head.includes('会社名')) continue;
    const year = Number(head.find((v) => /^20\d\d$/.test(v)) || 0);
    if (!year) continue;

    let mc = null, start = i;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const got = monthColumns(cols(lines[j]));
      if (got) { mc = got; start = j + 1; break; }
    }
    if (!mc) continue;

    let section = '売上';
    let carried = '';            // c[1] は結合セルで下に続く。空なら前の値を使う

    for (let j = start; j < lines.length; j++) {
      const d = cols(lines[j]);
      if (!d.length) break;
      if (d.includes('着金ベース')) break;                 // 次の年のブロック

      const write = (sec, cat, sub, isTotal) => {
        for (const { i: ci, m } of mc) {
          const v = money(d[ci]);
          if (!v) continue;
          const month = year + '-' + String(m).padStart(2, '0');
          put.run(`pl:${month}:${sec}:${cat}:${sub}`, month, sec, cat, sub, v, isTotal ? 1 : 0);
          n++;
        }
      };

      const head1 = d[1] || '';
      if (PL_TOTALS.test(head1)) {
        // 「支出合計」は事業＋個人の総計なので、どちらか一方の区分に入れると
        // その区分の内訳と合わなくなる。指標として別に置く
        const isMetric = PL_METRICS.test(head1) || /^支出合計/.test(head1);
        // 合計行そのものを記録してから、区分を切り替える
        write(isMetric ? '指標' : section, head1, '', true);

        if (/実績合計売上原価/.test(head1)) section = '売上原価';
        else if (/販売費及び一般管理費/.test(head1)) section = '事業経費';
        else if (/^経費合計/.test(head1)) section = '個人支出';   // ここから下は個人のお金
        else if (/^支出合計/.test(head1)) section = '指標';
        else if (/^合計$/.test(head1)) section = '指標';           // 2024年の書き方
        carried = '';
        continue;
      }

      /*
       * 分類の行。列の使い方は3通りある。
       *   外注費 | コンサル費 | KLP   → 大分類 c[1]、中分類 c[2]、明細 c[3]
       *          | ソフト経費 |        → c[1] は結合セルで空。大分類は上から引き継ぐ
       *          | 実績売上高 | 福祉研修 → 大分類が無い並び。c[2] が分類、c[3] が明細
       * 引き継ぐ大分類が無いときだけ、c[2] を分類として扱う。
       */
      if (head1) carried = head1;
      let category, sub;
      if (carried) {
        category = carried;
        sub = [d[2], d[3]].filter(Boolean).join('／');
      } else {
        category = d[2] || '';
        sub = d[3] || '';
      }
      if (!category && !sub) continue;
      write(section, category, sub, false);
    }
    i = start;
  }
  return n;
}

/** 料金表 */
function importPricing(db, lines) {
  const t = table(lines, ['科目', '項目', '単価', '原価']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO pricing (source_key,category,item,unit,price,cost,profit,vendor,note)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET category=excluded.category, item=excluded.item,
      unit=excluded.unit, price=excluded.price, cost=excluded.cost, profit=excluded.profit,
      vendor=excluded.vendor, note=excluded.note`);
  let n = 0, category = '';
  for (const r of t.rows) {
    if (cell(r['科目'])) category = cell(r['科目']);   // 科目は結合セルで下に続く
    const item = cell(r['項目']);
    if (!item) continue;
    put.run('pr:' + hash(category, item), category, item, cell(r['単位']),
      money(r['単価']), money(r['原価']), money(r['利益']), cell(r['外注先']), cell(r['備考']));
    n++;
  }
  return n;
}

/** 名刺 */
function importCards(db, lines) {
  const t = table(lines, ['会社名', '名前', '電子メール', '会社電話']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO cards
    (source_key,company,name,dept,title,email,zip,address,phone,fax,mobile,groups,wants,status,memo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET company=excluded.company, name=excluded.name,
      dept=excluded.dept, title=excluded.title, email=excluded.email, zip=excluded.zip,
      address=excluded.address, phone=excluded.phone, fax=excluded.fax, mobile=excluded.mobile,
      groups=excluded.groups, wants=excluded.wants, status=excluded.status, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const name = cell(r['名前']), company = cell(r['会社名']);
    if (!name && !company) continue;
    put.run('cd:' + hash(company, name, cell(r['電子メール'])), company, name,
      cell(r['部署']), cell(r['役職']), cell(r['電子メール']), cell(r['郵便番号']),
      cell(r['会社住所']), cell(r['会社電話']), cell(r['会社FAX']), cell(r['携帯電話']),
      cell(r['グループ']), cell(r['相手が求めているもの']), cell(r['進捗状況']), cell(r['備考']));
    n++;
  }
  return n;
}

/** 交流会の費用対効果 */
function importEvents(db, lines) {
  const t = table(lines, ['交流会', '参加費用', '名刺交換数', '成約数']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO events
    (source_key,name,place,held_on,hours,attendees,fee,cards_got,line_got,appts,closings,collabs,referrals,cost_per_appt,cost_per_closing,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET name=excluded.name, place=excluded.place, held_on=excluded.held_on,
      hours=excluded.hours, attendees=excluded.attendees, fee=excluded.fee, cards_got=excluded.cards_got,
      line_got=excluded.line_got, appts=excluded.appts, closings=excluded.closings, collabs=excluded.collabs,
      referrals=excluded.referrals, cost_per_appt=excluded.cost_per_appt,
      cost_per_closing=excluded.cost_per_closing, note=excluded.note`);
  let n = 0;
  for (const r of t.rows) {
    const name = cell(r['交流会']);
    if (!name) continue;
    put.run('ev:' + (r['No'] || hash(name, cell(r['日時']))), name, cell(r['場所']), cell(r['日時']),
      num(r['所要時間(h)']), num(r['参加人数']) || 0, money(r['参加費用']),
      num(r['名刺交換数']) || 0, num(r['LINE交換数']) || 0, num(r['アポ取り数']) || 0,
      num(r['成約数']) || 0, num(r['協業']) || 0, num(r['紹介']) || 0,
      money(r['アポ単価']), money(r['成約単価']), cell(r['備考']));
    n++;
  }
  return n;
}

/** 協業先 */
function importPartners(db, lines) {
  const t = table(lines, ['協力角度', '何を任せたい', '自社との関係値']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO partners
    (source_key,company,person,title,likelihood,role,industry,strength,relationship,memo)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET company=excluded.company, person=excluded.person,
      title=excluded.title, likelihood=excluded.likelihood, role=excluded.role, industry=excluded.industry,
      strength=excluded.strength, relationship=excluded.relationship, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const person = cell(r['担当者']), company = cell(r['会社名']);
    if (!person && !company) continue;
    put.run('pt:' + (r['No'] || hash(company, person)), company, person, cell(r['役職']),
      cell(r['協力角度']), cell(r['何を任せたい']), cell(r['業種']),
      cell(r['特に強い分野・業種']), cell(r['自社との関係値']),
      cell(r['備考※今後具体的に全部記載（何で協業するのか否か）']) || cell(r['備考']));
    n++;
  }
  return n;
}

/** 事業のパラメータ（〈企業情報〉〈目標売上〉〈現状〉〈売上見込〉） */
function importMetrics(db, lines) {
  const put = prep(db, `INSERT INTO metrics (scope,key,value) VALUES (?,?,?)
    ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`);
  let n = 0;
  // 〈企業情報〉と〈目標売上〉が左右に並んでいるので、行ごとに両方を読む
  for (let i = 0; i < lines.length; i++) {
    const c = cols(lines[i]);
    const left = c.findIndex((v) => v === '〈企業情報〉' || v === '現状');
    const right = c.findIndex((v) => v === '〈目標売上〉' || v === '売上見込');
    if (left < 0 && right < 0) continue;
    const scopeL = left >= 0 ? c[left].replace(/[〈〉]/g, '') : null;
    const scopeR = right >= 0 ? c[right].replace(/[〈〉]/g, '') : null;

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const d = cols(lines[j]);
      if (!d.length) break;
      if (d.some((v) => /^〈/.test(v))) break;
      if (scopeL && d[left] && d[left + 1] !== undefined && d[left + 1] !== '') {
        put.run(scopeL, d[left], d[left + 1]); n++;
      }
      if (scopeR && right >= 0 && d[right] && d[right + 1] !== undefined && d[right + 1] !== '') {
        put.run(scopeR, d[right], d[right + 1]); n++;
      }
    }
  }
  return n;
}

/** 目安数値（月次の売上見通し）。plan_monthly に kind='目安' で入れる。 */
function importForecast(db, lines) {
  const put = prep(db, `INSERT INTO plan_monthly (month,kind,side,category,subcategory,amount)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(month,kind,side,category,subcategory) DO UPDATE SET amount=excluded.amount`);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!cols(lines[i]).some((v) => v.includes('目安数値'))) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      const c = cols(lines[j]);
      const ym = c[0] && c[0].match(/^(\d{4})年$/);
      const mc = monthColumns(c);
      if (!ym || !mc) continue;
      const year = Number(ym[1]);
      for (let k = j + 1; k < Math.min(j + 8, lines.length); k++) {
        const d = cols(lines[k]);
        const label = d[0];
        if (!label) break;
        // 目安の表にも「営業利益」が並ぶ。売上として足すと二重に数えるので分ける
        const side = PLAN_METRIC.test(label) ? '指標' : '売上';
        for (const { i: ci, m } of mc) {
          const v = money(d[ci]);
          if (!v) continue;
          put.run(year + '-' + String(m).padStart(2, '0'), '目安', side, label, '', v);
          n++;
        }
      }
      break;
    }
  }
  return n;
}

/**
 * 収支管理ダッシュボードの月次サマリー。
 * シートが自分で出している数字なので、こちらで計算した値との照合に使う。
 * 対象年はダッシュボードの「対象年」セルから取る。
 */
function importMonthlySummary(db, lines) {
  let year = null;
  for (let i = 0; i < lines.length; i++) {
    const c = cols(lines[i]);
    const k = c.indexOf('対象年');
    if (k < 0) continue;
    const v = c.slice(k + 1).find((x) => /^20\d\d$/.test(x));
    if (v) { year = Number(v); break; }
  }
  if (!year) return 0;

  // 見出しとデータで列が1つずれている（結合セル由来）。
  // 見出しの位置で読むとすべて隣にずれるので、「1月」のセルを見つけて
  // そこから右に 収入・支出・純利益・経費率 と読む。
  let head = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = cols(lines[i]);
    if (['月', '収入', '支出', '純利益', '経費率'].every((x) => h.includes(x))) { head = i; break; }
  }
  if (head < 0) return 0;

  const put = prep(db, `INSERT INTO monthly_summary (month,income,expense,profit,cost_rate)
    VALUES (?,?,?,?,?)
    ON CONFLICT(month) DO UPDATE SET income=excluded.income, expense=excluded.expense,
      profit=excluded.profit, cost_rate=excluded.cost_rate`);
  let n = 0;
  for (let j = head + 1; j < Math.min(head + 20, lines.length); j++) {
    const c = cols(lines[j]);
    const k = c.findIndex((v) => /^\d{1,2}月$/.test(v));
    if (k < 0) { if (c.some((v) => v === '合計')) break; continue; }
    const m = Number(c[k].replace('月', ''));
    put.run(year + '-' + String(m).padStart(2, '0'),
      money(c[k + 1]), money(c[k + 2]), money(c[k + 3]), num(c[k + 4]));
    n++;
  }
  return n;
}

/** 通帳PDFの取込ログ */
function importPdfLog(db, lines) {
  const t = table(lines, ['取込日時', 'ファイル名', '銀行種別', '収入合計']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO pdf_log (source_key,imported_at,filename,bank,count,income,expense,memo)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET imported_at=excluded.imported_at, count=excluded.count,
      income=excluded.income, expense=excluded.expense, memo=excluded.memo`);
  let n = 0;
  for (const r of t.rows) {
    const f = cell(r['ファイル名']);
    const at = cell(r['取込日時']);
    // 同じ表の下に手順書きが続くので、日時が日付になっている行だけを取る
    if (!f || !/^\d{4}[/\-]\d{1,2}[/\-]\d{1,2}/.test(at)) continue;
    put.run('pdf:' + hash(f, at), at, f, cell(r['銀行種別']),
      num(r['件数']) || 0, money(r['収入合計']), money(r['支出合計']), cell(r['メモ']));
    n++;
  }
  return n;
}

/** カテゴリの自動判定ルール */
function importCategoryRules(db, lines) {
  const t = table(lines, ['代表キーワード', 'サブカテゴリ']);
  if (!t) return 0;
  const put = prep(db, `INSERT INTO category_rules (source_key,keyword,side,subcategory)
    VALUES (?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET side=excluded.side, subcategory=excluded.subcategory`);
  let n = 0;
  for (const r of t.rows) {
    const kw = cell(r['代表キーワード']);
    if (!kw) continue;
    put.run('cr:' + hash(kw), kw, cell(r['収入 / 支出']), cell(r['サブカテゴリ']));
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
  const put = prep(db, `INSERT INTO kpi (month,week,section,metric,target,actual)
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
 * 月次の収支計画（目標と実績）。
 *
 * 「1月…12月」の見出し行から下に、目標と実績が縦に並んでいる。
 *
 *   【目標数値】
 *     〈売上〉  面談アポ数・オファー率…（件数と率）／ 研修売上・総売上…（金額）
 *     〈支出〉  借金返済・外注費・通信費…／ 家賃光熱費・食費・生活費…
 *   〈結果数値〉                      ← ここから実績
 *     〈売上〉  …
 *     販売費及び一般管理費             ← 事業の経費
 *     経費合計 ★                     ← ここから下は個人のお金
 *     支出合計
 *     利益 / 内部留保 / 残額           ← 指標
 *
 * 気をつける点が3つある。
 *
 * 1. 実績側は〈支出〉ではなく「販売費及び一般管理費」で始まる。
 *    〈〉だけを見ていると、経費が売上の続きとして入ってしまう。
 * 2. 目標側には「経費合計」の区切りが無い。そこで、実績側で経費合計より
 *    下に出てきた項目を覚えておき、目標側もそれで分ける。名前から推測する
 *    より確かで、シートを直せば自動で追従する。
 * 3. この表の下には料金表が続く。月の列位置が同じなので、止めないと
 *    単価が「◯月の金額」として入ってくる。罫線行で切る。
 */

/**
 * 件数・率・利益の行。金額の集計に混ぜない。
 * 「研修件数(累計)」のように後ろに注記が付く形があるので、末尾だけを見ない。
 * ただし「研修売上」「その他売上」を巻き込まないよう、語は絞る。
 */
const PLAN_METRIC = /件数|回数|人数|率|利益|内部留保|残額|貯金|仕送り|税金積立|社会還元|数$/;

/** 罫線だけの行か（表の切れ目） */
const isRule = (c) => {
  const v = c.filter(Boolean);
  return v.length > 2 && v.every((x) => /^:-+:?$/.test(x));
};

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
  const monthCols = monthColumns(cols(lines[headIdx]));
  if (!monthCols) return 0;

  // ---- 1回目：実績側を読んで、個人のお金にあたる項目名を覚える ----
  const personal = new Set();
  {
    let inActual = false, afterKeihi = false;
    for (let i = headIdx + 1; i < lines.length; i++) {
      const c = cols(lines[i]);
      if (isRule(c)) break;
      if (/〈結果数値〉/.test(c.join(''))) { inActual = true; continue; }
      if (!inActual) continue;
      const h = (c[0] || '') + (c[1] || '');
      if (/^経費合計/.test(c[0] || '') || /^経費合計/.test(c[1] || '')) { afterKeihi = true; continue; }
      if (/^支出合計/.test(c[0] || '') || /^支出合計/.test(c[1] || '')) break;
      if (!afterKeihi) continue;
      const label = c[0] || c[1] || '';
      if (label && !PLAN_METRIC.test(label)) personal.add(label);
    }
  }

  const put = prep(db, `INSERT INTO plan_monthly (month,kind,side,category,subcategory,amount,is_total)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month,kind,side,category,subcategory) DO UPDATE SET
      amount=excluded.amount, is_total=excluded.is_total`);

  let kind = '目標', side = '売上', carried = '', n = 0;

  for (let i = headIdx + 1; i < lines.length; i++) {
    const c = cols(lines[i]);
    if (!c.length) continue;
    if (isRule(c)) break;                     // ここから下は料金表など別の表

    const joined = c.join('');
    if (/〈結果数値〉/.test(joined)) { kind = '実績'; side = '売上'; carried = ''; continue; }

    const sec = joined.match(/〈(売上|支出)〉/);
    if (sec) { side = sec[1] === '売上' ? '売上' : '事業経費'; carried = ''; continue; }

    const head0 = c[0] || '', head1 = c[1] || '';
    if (/販売費及び一般管理費/.test(head0 + head1)) { side = '事業経費'; carried = ''; continue; }
    if (/^経費合計/.test(head0) || /^経費合計/.test(head1)) { side = '個人支出'; carried = ''; continue; }
    if (/^支出合計/.test(head0) || /^支出合計/.test(head1)) { side = '指標'; carried = ''; continue; }

    // 分類名。1列目が大分類（結合セルで下に続く）、2・3列目が中分類と明細
    if (head0) carried = head0;
    let category, subcategory;
    if (carried) {
      category = carried;
      subcategory = [c[1], c[2]].filter((v) => v && v !== carried).join('／');
    } else {
      category = c[1] || '';
      subcategory = (c[2] && c[2] !== category) ? c[2] : '';
    }
    if (!category && !subcategory) continue;

    const label = subcategory || category;
    let rowSide = side;
    if (PLAN_METRIC.test(label) || PLAN_METRIC.test(category)) rowSide = '指標';
    else if (side === '事業経費' && (personal.has(category) || personal.has(label))) rowSide = '個人支出';

    // 「総売上」は内訳の合計。印を付けないと内訳と一緒に足して二重に数える
    const isTotal = /^(総売上|合計)$/.test(label) ? 1 : 0;

    for (const mc of monthCols) {
      const v = money(c[mc.i]);
      if (!v) continue;
      put.run(year + '-' + String(mc.m).padStart(2, '0'), kind, rowSide, category, subcategory, v, isTotal);
      n++;
    }
  }
  return n;
}


/* ============================================================ */

/**
 * 経費カテゴリに「事業／個人」の初期値を入れる。
 *
 * 名前からの推測なので当たらないものがある。だから guessed=1 を付けておき、
 * 人が直したもの（guessed=0）は二度と上書きしない。
 */
const PERSONAL_HINT = /親族|貯蓄|借金|返済|社宅|家賃|健康保険|生命|保険|水道光熱|積立|小遣|生活/;

function seedCostKinds(db) {
  const cats = new Set();
  for (const r of db.prepare("SELECT DISTINCT category c FROM expenses WHERE category <> ''").all()) cats.add(r.c);
  for (const r of db.prepare("SELECT DISTINCT category c FROM pl_monthly WHERE section='経費' AND category <> ''").all()) cats.add(r.c);
  for (const r of db.prepare("SELECT DISTINCT subcategory c FROM pl_monthly WHERE section='経費' AND subcategory <> ''").all()) cats.add(r.c);

  const put = db.prepare(`INSERT INTO cost_kinds (category, kind, guessed) VALUES (?,?,1)
    ON CONFLICT(category) DO UPDATE SET kind=excluded.kind WHERE cost_kinds.guessed = 1`);
  let n = 0;
  for (const c of cats) { put.run(c, PERSONAL_HINT.test(c) ? '個人' : '事業'); n++; }
  return n;
}


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
  '収支計画・実績': importPlan(db, lines),
  '月次損益': importPl(db, lines),
  '料金表': importPricing(db, lines),
  '名刺': importCards(db, lines),
  '交流会': importEvents(db, lines),
  '協業先': importPartners(db, lines),
  '事業パラメータ': importMetrics(db, lines),
  '目安数値': importForecast(db, lines),
  '月次収支サマリー': importMonthlySummary(db, lines),
  'PDF取込ログ': importPdfLog(db, lines),
  'カテゴリ判定ルール': importCategoryRules(db, lines),
};

// 「販管費」という呼び方はしない。
// source_key に区分名が入っているので、名前を変えるとキーが変わり、
// 古い行が残ったまま新しい行が増えて二重になる。古いキーの行を先に消す。
// source_key に区分名が入っているので、区分の呼び方を変えると古い行が残る。
// 取り込みのたびに、いまの区分名でない行を掃除する。
db.exec(`DELETE FROM pl_monthly WHERE edited_at IS NULL AND section NOT IN
  ('売上','売上原価','事業経費','個人支出','指標')`);
db.exec(`DELETE FROM pl_monthly WHERE edited_at IS NULL AND source_key NOT LIKE
  'pl:%:' || section || ':%'`);
done['経費の事業/個人 区分'] = seedCostKinds(db);
for (const [k, v] of Object.entries(done)) {
  console.log('  ' + (v ? '✓' : '—') + ' ' + k + ' : ' + v + '件');
}

// 画面で直した行は上書きしていない。黙って飛ばすと気づけないので数を出す
const kept = Object.keys(TABLES)
  .map((t) => {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE edited_at IS NOT NULL`).get().c;
      return n ? `${TABLES[t].label} ${n}件` : null;
    } catch { return null; }
  })
  .filter(Boolean);
if (kept.length) {
  console.log('\n  ※ 画面で編集済みのため上書きしませんでした： ' + kept.join(' / '));
  console.log('     シートの値に戻したいときは、その行の編集画面で「シートの値に戻す」を押してください。');
}
db.close();
