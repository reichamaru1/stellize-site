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

/** 商談パイプライン（契約前の動き） */
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


/* ------------------------------------------------------------
   ここから下は「月を横に並べた表」を読むもの。
   見出し行の 1月…12月 や 1…12 の位置を拾って、そこから縦に読む。
   ------------------------------------------------------------ */

/** 「月」の行から、列位置→月 の対応を作る。 */
function monthColumns(c) {
  const out = [];
  c.forEach((v, i) => {
    const m = String(v).match(/^(\d{1,2})月?$/);
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= 12) out.push({ i, m: n }); }
  });
  // 期の途中から始まる年（2023年は3月〜）もあるので、12か月ちょうどは求めない
  return out.length >= 3 ? out : null;
}

/**
 * 月次損益（着金ベース）。年ごとに1枚のP/Lが並んでいる。
 *
 * 行の形は3種類。
 *   ['', '実績合計売上高', '',           '',            ¥…]  ← 合計・指標（2列目にラベル）
 *   ['', '',             '実績売上高',  'SNS運用代行',  ¥…]  ← 売上の内訳
 *   ['', '',             '諸会費',      '真誓会',       ¥…]  ← 販管費の内訳
 *   ['', '',             '',           '水道光熱費',   ¥…]  ← 中分類が結合セルで空（上から引き継ぐ）
 *
 * 売上と経費が同じ表に縦に並んでいるので、区分を取り違えると売上に経費が混ざる。
 */
function importPl(db, lines) {
  const put = prep(db, `INSERT INTO pl_monthly (source_key,month,section,category,subcategory,amount,is_total)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET amount=excluded.amount, section=excluded.section,
      category=excluded.category, subcategory=excluded.subcategory, is_total=excluded.is_total`);
  let n = 0;

  /**
   * 区分の判定。
   * 中分類の名前だけで振り分けると事故る（Uber・配達・派遣は売上だが、
   * 名前からは経費に見える）。区分が変わるのは合計行の見出しに
   * 「実績合計売上原価」「販売費及び一般管理費」が出たときだけにする。
   */
  const sectionOf = (cat, carried) => {
    if (/売上原価/.test(cat)) return '売上原価';
    if (/売上高/.test(cat)) return '売上';
    return carried;
  };

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

    let category = '', section = '売上';
    for (let j = start; j < lines.length; j++) {
      const d = cols(lines[j]);
      if (!d.length) break;
      if (d.includes('着金ベース')) break;            // 次の年のブロック

      const totalLabel = d[1];
      if (totalLabel) {
        // 合計・利益の行。区分の切り替わりも兼ねている
        if (/売上原価/.test(totalLabel)) section = '売上原価';
        else if (/販売費|一般管理費/.test(totalLabel)) section = '販管費';
        const isMetric = /利益|達成率|目標/.test(totalLabel);
        for (const { i: ci, m } of mc) {
          const v = money(d[ci]);
          if (!v) continue;
          const month = year + '-' + String(m).padStart(2, '0');
          put.run('pl:' + month + ':T:' + totalLabel, month, isMetric ? '指標' : section,
            totalLabel, '', v, 1);
          n++;
        }
        if (/営業利益/.test(totalLabel)) break;        // このブロックの最後
        category = '';
        continue;
      }

      if (d[2]) category = d[2];                      // 中分類。空なら上から引き継ぐ
      section = sectionOf(d[2], section);
      const sub = d[3] || '';
      if (!category && !sub) continue;
      for (const { i: ci, m } of mc) {
        const v = money(d[ci]);
        if (!v) continue;
        const month = year + '-' + String(m).padStart(2, '0');
        put.run('pl:' + month + ':' + section + ':' + category + ':' + sub,
          month, section, category, sub, v, 0);
        n++;
      }
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
        for (const { i: ci, m } of mc) {
          const v = money(d[ci]);
          if (!v) continue;
          put.run(year + '-' + String(m).padStart(2, '0'), '目安', '売上', label, '', v);
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

  const put = prep(db, `INSERT INTO plan_monthly (month,kind,side,category,subcategory,amount)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(month,kind,side,category,subcategory) DO UPDATE SET amount=excluded.amount`);
  let side = null, kind = '目標', n = 0;

  for (let i = headIdx + 1; i < lines.length; i++) {
    const c = cols(lines[i]);
    if (!c.length) continue;
    const joined = c.join('');
    // 〈結果数値〉から下は同じ形の実績。目標と並べて比べられるよう kind で分ける
    if (/〈結果数値〉/.test(joined)) { kind = '実績'; side = null; continue; }
    if (/〈(企業情報|目標売上|目安数値)〉/.test(joined)) break;
    const sec = joined.match(/〈(売上|支出)〉/);
    if (sec) { side = sec[1]; continue; }
    if (!side) continue;

    // 科目が結合セルで空になっている行がある。空のまま入れると分類が消えるので寄せる
    let category = c[1] || '';
    let subcategory = (c[2] && c[2] !== category) ? c[2] : '';
    if (!category && subcategory) { category = subcategory; subcategory = ''; }
    if (!category) continue;
    for (const mc of monthCols) {
      const v = money(c[mc.i]);
      if (!v) continue;
      put.run(year + '-' + String(mc.m).padStart(2, '0'), kind, side, category, subcategory, v);
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
for (const [k, v] of Object.entries(done)) {
  console.log('  ' + (v ? '✓' : '—') + ' ' + k + ' : ' + v + '件');
}
db.close();
