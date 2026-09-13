/**
 * 俺の事業を管理せよ — アプリ本体
 *
 *   npm start   →  http://localhost:8710
 *
 * 外部ライブラリは使わない（Node 22.5+ 同梱の node:sqlite と標準モジュールのみ）。
 * shuro-db と同じ作りに揃えてあるので、片方を触れるならもう片方も触れる。
 *
 * データの持ち方
 *   data/ore.db          … このアプリの正データ（お金・顧客・案件・KPI）
 *   ../shuro-db/data/    … 事業所3万件。読み取り専用で開く（あちらが正）
 *   GASのWebアプリ       … メルマガ配信。設定した合言葉で叩く
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TABLES, tableOf, columnOf, coerce } from './tables.mjs';
import { migrate } from './db/migrate.mjs';
import { seedMoneyKinds } from './money-kinds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8710);
const SHURO = join(ROOT, '..', 'shuro-db', 'data', 'shuro.db');

const db = new DatabaseSync(join(ROOT, 'data', 'ore.db'));
db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
migrate(db, Object.keys(TABLES));
seedMoneyKinds(db);   // 新しいカテゴリが増えていたら区分表に足す

// 事業所DBは、あちらの取り込みで作り直される。こちらからは書かない。
let shuro = null;
try {
  if (existsSync(SHURO)) shuro = new DatabaseSync(SHURO, { readOnly: true });
} catch (e) {
  console.warn('事業所DBを開けませんでした: ' + e.message);
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

/**
 * 取引1件の区分を表すSQL。
 *   1. その取引だけの上書き（mf_tx.kind）
 *   2. 無ければカテゴリの区分表（money_kinds）
 * 振替・資金調達をここで弾けるので、損益に自分のお金の移し替えが混ざらない。
 */
const KIND = `COALESCE(NULLIF(t.kind,''), k.kind, '個人')`;
const JOIN = `FROM mf_tx t LEFT JOIN money_kinds k ON k.category = t.category`;

/* ============================================================
   設定
   ============================================================ */

function setting(key, fallback = '') {
  const r = one('SELECT value FROM settings WHERE key=?', key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

/* ============================================================
   ダッシュボード
   ============================================================ */

const thisMonth = () => new Date().toISOString().slice(0, 7);

function summary() {
  // 暦の「今月」ではなく、記帳がある最後の月を見せる。
  // 月初や取り込み前は暦の今月が空になり、¥0 が並んで実態と食い違うため。
  // 「お金の流れ管理」を取り込んでいれば、そちらのほうが新しい
  const hasMf = one('SELECT COUNT(*) c FROM mf_tx').c > 0;
  const latest = hasMf
    ? one("SELECT MAX(substr(date,1,7)) m FROM mf_tx")
    : one("SELECT MAX(substr(date,1,7)) m FROM cashflow");
  const m = (latest && latest.m) || thisMonth();
  const year = m.slice(0, 4);
  const stale = m !== thisMonth();
  // 「9月の収支」と言いながら中身が3日分、ということが起きる。
  // 最後の記帳がいつかを一緒に返して、画面に「◯日時点」と出す
  const lastDay = (hasMf ? one('SELECT MAX(date) d FROM mf_tx') : one('SELECT MAX(date) d FROM cashflow'));
  const asOf = (lastDay && lastDay.d) || '';
  const today = new Date().toISOString().slice(0, 10);
  const behindDays = asOf
    ? Math.round((Date.parse(today) - Date.parse(asOf)) / 86400000) : null;

  // 事業のお金だけを見る。
  // 口座間の移し替え・現金引き出し・借入とその返済は、稼いだお金でも
  // 使ったお金でもない。区分表で外さないと売上も経費も倍近くに膨らむ。
  const cf = hasMf
    ? one(`SELECT
        COALESCE(SUM(CASE WHEN substr(t.date,1,7)=? AND ${KIND}='売上' THEN t.amount END),0) AS mIn,
        COALESCE(SUM(CASE WHEN substr(t.date,1,7)=? AND ${KIND}='経費' THEN t.amount END),0) AS mOut,
        COALESCE(SUM(CASE WHEN substr(t.date,1,4)=? AND ${KIND}='売上' THEN t.amount END),0) AS yIn,
        COALESCE(SUM(CASE WHEN substr(t.date,1,4)=? AND ${KIND}='経費' THEN t.amount END),0) AS yOut
      ${JOIN}`, m, m, year, year)
    : one(`SELECT
        COALESCE(SUM(CASE WHEN substr(date,1,7)=? THEN income END),0)  AS mIn,
        COALESCE(SUM(CASE WHEN substr(date,1,7)=? THEN expense END),0) AS mOut,
        COALESCE(SUM(CASE WHEN substr(date,1,4)=? THEN income END),0)  AS yIn,
        COALESCE(SUM(CASE WHEN substr(date,1,4)=? THEN expense END),0) AS yOut
      FROM cashflow`, m, m, year, year);

  const planIn = one(`SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
    WHERE month=? AND side='売上' AND category LIKE '%総売上%'`, m);

  return {
    month: m,
    stale,                       // 画面に「いつ時点か」を出すため
    asOf, behindDays,            // 最後の記帳日と、そこから何日空いているか
    money: {
      monthIncome: cf.mIn, monthExpense: cf.mOut, monthNet: cf.mIn - cf.mOut,
      yearIncome: cf.yIn, yearExpense: cf.yOut, yearNet: cf.yIn - cf.yOut,
      monthPlan: planIn ? planIn.a : 0,
    },
    deals: {
      active: one("SELECT COUNT(*) c FROM deals WHERE status='契約中'").c,
      monthlyRevenue: one("SELECT COALESCE(SUM(monthly),0) a FROM deals WHERE status='契約中'").a,
    },
    pipeline: all(`SELECT status, COUNT(*) n, COALESCE(SUM(quote_month),0) amount
      FROM pipeline GROUP BY status ORDER BY n DESC`),
    // いま追うべき案件。終わったもの（契約・失注・取引なし）を外した残り。
    // これが空でないかぎり、ダッシュボードで最初に目に入るべきはここ
    live: all(`SELECT * FROM pipeline
      WHERE status NOT IN ('契約','失注','取引なし','') 
      ORDER BY (first_met = '') , first_met DESC`),
    contacts: {
      total: one('SELECT COUNT(*) c FROM contacts').c,
      todo: one("SELECT COUNT(*) c FROM contacts WHERE done <> '済み' AND next_action <> ''").c,
    },
    facilities: shuro ? one2(shuro, 'SELECT COUNT(*) c FROM facilities').c : null,
    from: hasMf ? 'money' : 'sheet',
    // 直近の動き。ダッシュボードで「最後に何をしたか」が見えるようにする
    recentCash: hasMf
      ? all(`SELECT t.date, ${KIND} AS kind, t.category,
               CASE WHEN t.type='income' THEN t.amount ELSE 0 END income,
               CASE WHEN t.type='expense' THEN t.amount ELSE 0 END expense,
               t.memo AS summary
             ${JOIN} ORDER BY t.date DESC, t.id DESC LIMIT 8`)
      : all(`SELECT date, kind, category, income, expense, summary
             FROM cashflow ORDER BY date DESC, id DESC LIMIT 8`),
    // 商談は「今どの月に何が動いているか」。累計は判断に使えない
    pipelineMonth: (() => {
      // 今月より先の月は出さない。先の予定を「動いた月」として見せると読み違える
      const mm = one(`SELECT MAX(substr(first_met,1,7)) m FROM pipeline
        WHERE first_met GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*' AND substr(first_met,1,7) <= ?`,
        thisMonth());
      const target = (mm && mm.m) || '';
      return target ? { month: target, rows: all(`SELECT status, COUNT(*) n,
          COALESCE(SUM(quote_month),0) monthly FROM pipeline
        WHERE substr(first_met,1,7)=? GROUP BY 1 ORDER BY n DESC`, target) } : null;
    })(),
  };
}

/**
 * シート自身の食い違いを拾う。
 *
 * 取り込みの誤りと、シートの中で数字が合っていないことは別の話。
 * 混ぜると「どこを直せばいいのか」が分からなくなるので、分けて出す。
 */
function sheetIssues() {
  const out = [];

  // 1. 合計と内訳が合わない
  for (const [kind, label] of [['目標', '収支計画の目標'], ['実績', '収支計画の実績']]) {
    const t = one(`SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
      WHERE kind=? AND side='売上' AND is_total=1`, kind).a;
    const parts = one(`SELECT COALESCE(SUM(amount),0) a FROM plan_monthly
      WHERE kind=? AND side='売上' AND is_total=0`, kind).a;
    if (t && Math.abs(t - parts) > 1) {
      out.push({ where: label, what: '総売上と内訳が合わない',
        detail: `総売上 ${t.toLocaleString('ja-JP')}円 / 内訳の合計 ${parts.toLocaleString('ja-JP')}円`,
        gap: t - parts });
    }
  }

  /*
   * 2. 同じ数字が1ずつ増えて並ぶ行。
   *    セルを下に引っぱった跡で、計画でも実績でもない。
   *    収支ダッシュボードの4月以降が 412,030 / 412,031 / … になっていた。
   */
  const ms = all('SELECT month, income, expense FROM monthly_summary ORDER BY month');
  for (const col of ['income', 'expense']) {
    let run = [];
    const flush = () => {
      if (run.length >= 4) {
        out.push({ where: '月次収支サマリーの' + (col === 'income' ? '収入' : '支出'),
          what: 'セルを下に引っぱった跡（1円ずつ増える並び）',
          detail: `${run[0].month}〜${run[run.length - 1].month} が `
            + `${run[0][col].toLocaleString('ja-JP')}円から1円ずつ増えています`, gap: 0 });
      }
      run = [];
    };
    for (let i = 0; i < ms.length; i++) {
      const prev = ms[i - 1];
      if (prev && ms[i][col] - prev[col] === 1) {
        if (!run.length) run.push(prev);
        run.push(ms[i]);
      } else flush();
    }
    flush();
  }
  return out;
}

/**
 * シートの売上と、口座に実際に入った金額を月ごとに並べる。
 * どちらかが正しいという話ではなく、ずれている月を自分で見に行けるようにする。
 */
function salesVsBank() {
  if (!one('SELECT COUNT(*) c FROM mf_tx').c) return [];
  return all(`SELECT m month,
      COALESCE((SELECT SUM(amount) FROM pl_monthly
        WHERE month=m AND section='売上' AND category='実績合計売上高'),0) sheet,
      COALESCE((SELECT SUM(t.amount) ${JOIN}
        WHERE substr(t.date,1,7)=m AND t.type='income' AND ${KIND}='売上'),0) bank
    FROM (SELECT DISTINCT substr(date,1,7) m FROM mf_tx) ORDER BY m`);
}

const one2 = (conn, sql, ...p) => conn.prepare(sql).get(...p);
const all2 = (conn, sql, ...p) => conn.prepare(sql).all(...p);

/* ============================================================
   各画面のデータ
   ============================================================ */

function money(q) {
  const from = q.get('from') || '0000-00';
  const to = q.get('to') || '9999-99';
  const kw = (q.get('q') || '').trim();
  const like = '%' + kw + '%';

  const rows = kw
    ? all(`SELECT * FROM cashflow WHERE substr(date,1,7) BETWEEN ? AND ?
        AND (summary LIKE ? OR category LIKE ? OR memo LIKE ?)
        ORDER BY date DESC, id DESC LIMIT 500`, from, to, like, like, like)
    : all(`SELECT * FROM cashflow WHERE substr(date,1,7) BETWEEN ? AND ?
        ORDER BY date DESC, id DESC LIMIT 500`, from, to);

  return {
    rows,
    byMonth: all(`SELECT substr(date,1,7) month, SUM(income) income, SUM(expense) expense
      FROM cashflow GROUP BY 1 ORDER BY 1`),
    byCategory: all(`SELECT category,
        SUM(income) income, SUM(expense) expense, COUNT(*) n
      FROM cashflow WHERE substr(date,1,7) BETWEEN ? AND ?
      GROUP BY 1 ORDER BY (SUM(income)+SUM(expense)) DESC LIMIT 30`, from, to),
  };
}

function expenses(q) {
  const from = q.get('from') || '0000-00';
  const to = q.get('to') || '9999-99';
  return {
    rows: all(`SELECT * FROM expenses WHERE substr(date,1,7) BETWEEN ? AND ?
      ORDER BY date DESC, id DESC LIMIT 500`, from, to),
    byAccount: all(`SELECT account, SUM(amount) amount, COUNT(*) n
      FROM expenses WHERE substr(date,1,7) BETWEEN ? AND ?
      GROUP BY 1 ORDER BY amount DESC`, from, to),
    byCategory: all(`SELECT category, SUM(amount) amount, COUNT(*) n
      FROM expenses WHERE substr(date,1,7) BETWEEN ? AND ?
      GROUP BY 1 ORDER BY amount DESC LIMIT 30`, from, to),
  };
}

function facilities(q) {
  if (!shuro) return { error: '事業所DBがありません。shuro-db で npm run build を実行してください。', rows: [] };
  const kw = (q.get('q') || '').trim();
  const pref = (q.get('pref') || '').trim();
  const where = [], args = [];
  if (kw) { where.push('search_text LIKE ?'); args.push('%' + kw + '%'); }
  if (pref) { where.push('prefecture = ?'); args.push(pref); }
  const sql = `SELECT facility_key, name, corp_name, prefecture, city, address_full, phone, fax, url
    FROM facilities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY prefecture, city, name LIMIT 200`;
  return {
    rows: all2(shuro, sql, ...args),
    total: one2(shuro, `SELECT COUNT(*) c FROM facilities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args).c,
    prefs: all2(shuro, 'SELECT prefecture, COUNT(*) n FROM facilities GROUP BY 1 ORDER BY 1'),
  };
}

/* ============================================================
   メルマガ（GASのWebアプリを叩く）
   ============================================================ */

async function mailApi(payload) {
  const url = setting('mail_webapp_url');
  const token = setting('mail_api_token');
  if (!url || !token) {
    return { ok: false, error: '未設定です。設定画面でWebアプリURLと連携キーを入れてください。' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, token }),
      redirect: 'follow',
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: '応答がJSONではありません。再デプロイとアクセス権（全員）を確認してください。' }; }
  } catch (e) {
    return { ok: false, error: 'つながりませんでした: ' + e.message };
  }
}

/* ============================================================
   どの表でも使える 一覧・絞り込み・編集

   表名と列名は tables.mjs に載っているものだけを通す。
   画面から来た文字列をそのままSQLに入れない（値は必ず ? で渡す）。
   ============================================================ */

/**
 * 絞り込みの条件を組み立てる。
 *
 * exceptCol を渡すと、その列の条件だけ外す。
 * 列見出しの選択肢を作るときに使う（自分の条件で自分の選択肢が消えると、
 * 一度絞ったら他の値に切り替えられなくなるため）。
 */
function buildWhere(t, q, exceptCol) {
  const where = [], args = [];

  const kw = (q.get('q') || '').trim();
  if (kw && t.search.length) {
    where.push('(' + t.search.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
    t.search.forEach(() => args.push('%' + kw + '%'));
  }

  for (const col of t.columns) {
    if (col.k === exceptCol) continue;

    // 完全一致（選択肢から選んだとき）
    const eq = q.get('f_' + col.k);
    if (eq != null && eq !== '') { where.push(`${col.k} = ?`); args.push(coerce(col, eq)); }

    // 部分一致（見出しの入力欄に打ったとき）
    const like = (q.get('qc_' + col.k) || '').trim();
    if (like) { where.push(`${col.k} LIKE ?`); args.push('%' + like + '%'); }

    // 月で絞る（日付・月の列）
    const mon = q.get('m_' + col.k);
    if (mon) { where.push(`substr(${col.k},1,7) = ?`); args.push(mon); }

    // 数値・金額の範囲
    const min = q.get('min_' + col.k), max = q.get('max_' + col.k);
    if (min !== null && min !== '') { where.push(`${col.k} >= ?`); args.push(coerce(col, min)); }
    if (max !== null && max !== '') { where.push(`${col.k} <= ?`); args.push(coerce(col, max)); }
  }

  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

/**
 * 列ごとの選択肢。
 * 種類が多すぎる列は選択肢にせず、画面側で入力欄にする（60件を超えたら null）。
 */
function columnOptions(name, t, q) {
  const out = {};
  for (const col of t.columns) {
    if (col.type === 'money' || col.type === 'number') continue;   // 範囲入力にする

    const { where, args } = buildWhere(t, q, col.k);
    const expr = (col.type === 'date' || col.type === 'month')
      ? `substr(${col.k},1,7)`                                      // 日付は月にまとめる
      : col.k;

    // 空欄を除く条件は、既にある WHERE に足す（WHERE を2回書かない）
    const notNull = `${col.k} IS NOT NULL AND ${col.k} <> ''`;
    const clause = where ? `${where} AND ${notNull}` : `WHERE ${notNull}`;

    // 選択肢が多すぎると探せない。日付は月にまとまるので多めに許す
    const cap = (col.type === 'date' || col.type === 'month') ? 60 : 25;
    const n = one(`SELECT COUNT(DISTINCT ${expr}) c FROM ${name} ${clause}`, ...args).c;
    if (n === 0 || n > cap) { out[col.k] = null; continue; }

    const order = (col.type === 'date' || col.type === 'month') ? 'v DESC' : 'n DESC, v';
    out[col.k] = all(
      `SELECT ${expr} AS v, COUNT(*) n FROM ${name} ${clause} GROUP BY 1 ORDER BY ${order}`, ...args);
  }
  return out;
}

function listTable(name, q) {
  const t = tableOf(name);
  if (!t) return null;
  const { where, args } = buildWhere(t, q);
  const limit = Math.min(Number(q.get('limit') || 300), 2000);
  const offset = Math.max(Number(q.get('offset') || 0), 0);

  // 並び替え。画面から来た列名は必ず照合してから使う
  let order = t.order;
  const sort = q.get('sort');
  if (sort) {
    const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';
    const col = columnOf(t, sort);
    if (col) order = `${col.k} ${dir}`;
  }

  const rows = all(`SELECT * FROM ${name} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset);
  const total = one(`SELECT COUNT(*) c FROM ${name} ${where}`, ...args).c;

  // 金額列は合計も出す。絞り込んだ結果がいくらなのかが要るため
  const sums = {};
  for (const col of t.columns) {
    if (col.type !== 'money') continue;
    sums[col.k] = one(`SELECT COALESCE(SUM(${col.k}),0) a FROM ${name} ${where}`, ...args).a;
  }

  // 金額・数値列は範囲入力のために最小最大を返す
  const ranges = {};
  for (const col of t.columns) {
    if (col.type !== 'money' && col.type !== 'number') continue;
    const r = one(`SELECT MIN(${col.k}) lo, MAX(${col.k}) hi FROM ${name}`);
    ranges[col.k] = { lo: r.lo ?? 0, hi: r.hi ?? 0 };
  }

  return {
    name, label: t.label, columns: t.columns,
    options: columnOptions(name, t, q),
    ranges, rows, total, limit, offset, sums,
  };
}

/**
 * 主キーの受け取り方。
 * mf_tx の id は「お金の流れ管理」側の文字列IDなので、数値に変換すると NaN になり
 * 更新も削除も静かに何もしなくなる。数字だけのときに限って数値にする。
 */
const key = (id) => (/^\d+$/.test(String(id)) ? Number(id) : String(id));

/** 1行の作成・更新。tables.mjs に無い列は捨てる。 */
function writeRow(name, id, body) {
  const t = tableOf(name);
  if (!t) return { error: '不明な表です' };
  const pairs = [];
  for (const col of t.columns) {
    if (!Object.prototype.hasOwnProperty.call(body, col.k)) continue;
    pairs.push([col.k, coerce(col, body[col.k])]);
  }
  if (!pairs.length) return { error: '変更する内容がありません' };
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (id) {
    const set = pairs.map(([k]) => `${k}=?`).join(', ');
    db.prepare(`UPDATE ${name} SET ${set}, edited_at=? WHERE id=?`)
      .run(...pairs.map((p) => p[1]), now, key(id));
    return { ok: true, id, row: one(`SELECT * FROM ${name} WHERE id=?`, key(id)) };
  }
  const keys = pairs.map(([k]) => k).concat('edited_at');
  const vals = pairs.map((p) => p[1]).concat(now);
  const r = db.prepare(
    `INSERT INTO ${name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
  const newId = Number(r.lastInsertRowid);
  return { ok: true, id: newId, row: one(`SELECT * FROM ${name} WHERE id=?`, newId) };
}

/* ============================================================
   HTTP
   ============================================================ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, body, code = 200) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  const body = readFileSync(file);
  /*
   * 手元で動かすソフトなので、キャッシュはしない。
   * 画面を直したのに古いままで出る、というのがいちばん困る。
   */
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const readJson = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const q = url.searchParams;
  try {
    if (p === '/api/summary')    return json(res, summary());
    if (p === '/api/money')      return json(res, money(q));
    if (p === '/api/expenses')   return json(res, expenses(q));
    if (p === '/api/facilities') return json(res, facilities(q));

    if (p === '/api/contacts') {
      const kw = (q.get('q') || '').trim(), like = '%' + kw + '%';
      return json(res, {
        rows: kw
          ? all(`SELECT * FROM contacts WHERE company LIKE ? OR name LIKE ? OR industry LIKE ? OR problem LIKE ?
              ORDER BY met_on DESC LIMIT 300`, like, like, like, like)
          : all('SELECT * FROM contacts ORDER BY met_on DESC LIMIT 300'),
        total: one('SELECT COUNT(*) c FROM contacts').c,
      });
    }
    if (p === '/api/deals')    return json(res, { rows: all('SELECT * FROM deals ORDER BY closed_on DESC, id DESC') });
    if (p === '/api/cards') {
      const kw = (q.get('q') || '').trim(), like = '%' + kw + '%';
      return json(res, {
        rows: kw
          ? all(`SELECT * FROM cards WHERE company LIKE ? OR name LIKE ? OR groups LIKE ? OR title LIKE ?
              ORDER BY company, name LIMIT 400`, like, like, like, like)
          : all('SELECT * FROM cards ORDER BY company, name LIMIT 400'),
        total: one('SELECT COUNT(*) c FROM cards').c,
        groups: all(`SELECT groups, COUNT(*) n FROM cards WHERE groups <> '' GROUP BY 1 ORDER BY n DESC LIMIT 20`),
      });
    }
    if (p === '/api/partners') return json(res, { rows: all('SELECT * FROM partners ORDER BY id') });
    if (p === '/api/pricing')  return json(res, { rows: all('SELECT * FROM pricing ORDER BY id') });
    if (p === '/api/events') {
      const rows = all('SELECT * FROM events ORDER BY id');
      // どの交流会に出るかを決めるための集計。単発の回より、会ごとの累計で見る
      const byName = all(`SELECT
          replace(replace(substr(name, 1, instr(name || '】', '】')), '【', ''), '】', '') AS series,
          COUNT(*) n, SUM(fee) fee, SUM(cards_got) cards_got, SUM(appts) appts,
          SUM(closings) closings, SUM(collabs) collabs, SUM(referrals) referrals
        FROM events GROUP BY 1 ORDER BY fee DESC`);
      return json(res, { rows, byName });
    }
    if (p === '/api/pl') {
      const years = all("SELECT DISTINCT substr(month,1,4) y FROM pl_monthly ORDER BY y").map((r) => r.y);
      const year = q.get('year') || years[years.length - 1] || '';
      const like = year + '%';
      return json(res, {
        years, year,
        months: all('SELECT DISTINCT month FROM pl_monthly WHERE month LIKE ? ORDER BY month', like).map((r) => r.month),
        rows: all('SELECT * FROM pl_monthly WHERE month LIKE ? ORDER BY section, category, subcategory, month', like),
        // 年ごとの粗い形。どの年に何で稼いだかを1行で見る
        summary: all(`SELECT substr(month,1,4) y,
            COALESCE(SUM(CASE WHEN is_total=0 AND section='売上' THEN amount END),0) sales,
            COALESCE(SUM(CASE WHEN is_total=0 AND section='事業経費' THEN amount END),0) cost,
            COALESCE(SUM(CASE WHEN is_total=0 AND section='個人支出' THEN amount END),0) personal
          FROM pl_monthly GROUP BY 1 ORDER BY 1`),
        bySource: all(`SELECT subcategory, category, SUM(amount) amount, COUNT(*) n
          FROM pl_monthly WHERE is_total=0 AND section='売上' AND month LIKE ?
          GROUP BY 1,2 ORDER BY amount DESC`, like),
      });
    }
    /**
     * 手残り。
     *
     * 「お金の流れ管理」から取り込んだ実取引を使う。あちらは1件ずつ
     * 事業か個人かを仕分けてあるので、カテゴリ名から推測する必要がない。
     * まだ取り込んでいないときだけ、経費明細＋区分表で代用する。
     */
    if (p === '/api/cash') {
      const hasMf = one('SELECT COUNT(*) c FROM mf_tx').c > 0;

      if (hasMf) {
        // 区分は money_kinds を通す。向こうの business / personal は
        // 「どの口座から出たか」でしかないので、そのままでは損益に使えない
        const sum = (kind, type) =>
          `COALESCE(SUM(CASE WHEN ${KIND} = '${kind}' AND t.type='${type}' THEN t.amount END),0)`;
        const rows = all(`SELECT substr(t.date,1,7) month,
            ${sum('売上', 'income')} sales,
            ${sum('経費', 'expense')} cost,
            ${sum('個人', 'expense')} personal,
            ${sum('資金調達', 'income')} raised,
            ${sum('資金調達', 'expense')} repaid,
            ${sum('振替', 'income')} moveIn,
            ${sum('振替', 'expense')} moveOut
          ${JOIN} GROUP BY 1 ORDER BY 1`);
        const byCat = all(`SELECT ${KIND} kind, t.type, t.category,
            SUM(t.amount) amount, COUNT(*) n, MAX(COALESCE(k.unsure,1)) unsure
          ${JOIN} GROUP BY 1,2,3 ORDER BY amount DESC`);
        return json(res, {
          from: 'money',
          rows, byCat,
          // 人が見ていない区分。ここが多いほど下の数字は当てにならない
          unsure: all(`SELECT k.category, k.kind, COUNT(*) n, SUM(t.amount) amount
            FROM money_kinds k JOIN mf_tx t ON t.category = k.category
            WHERE k.unsure = 1 AND k.edited_at IS NULL
            GROUP BY 1,2 ORDER BY amount DESC`),
          uncertain: one('SELECT COUNT(*) c FROM mf_tx WHERE uncertain=1').c,
          imports: all('SELECT * FROM mf_imports ORDER BY at DESC'),
          latest: one('SELECT MAX(date) d FROM mf_tx').d,
        });
      }

      // 代用：経費明細とカテゴリ区分から出す
      const kindJoin = `LEFT JOIN cost_kinds k ON k.category = e.category`;
      const rows = all(`
        SELECT m AS month,
          COALESCE((SELECT SUM(income) FROM cashflow WHERE substr(date,1,7)=m),0) AS sales,
          COALESCE((SELECT SUM(e.amount) FROM expenses e ${kindJoin}
                    WHERE substr(e.date,1,7)=m AND COALESCE(k.kind,'事業')='事業'),0) AS cost,
          COALESCE((SELECT SUM(e.amount) FROM expenses e ${kindJoin}
                    WHERE substr(e.date,1,7)=m AND COALESCE(k.kind,'事業')='個人'),0) AS personal,
          0 AS raised, 0 AS repaid, 0 AS moveIn, 0 AS moveOut
        FROM (SELECT DISTINCT substr(date,1,7) m FROM expenses
              UNION SELECT DISTINCT substr(date,1,7) FROM cashflow) ORDER BY m`);
      return json(res, {
        from: 'sheet', rows, byCat: [], unsure: [], uncertain: 0, imports: [],
        latest: one('SELECT MAX(date) d FROM cashflow').d,
        guessedPersonal: one("SELECT COUNT(*) c FROM cost_kinds WHERE guessed=1 AND kind='個人'").c,
      });
    }

    /**
     * 商談パイプラインを月で見る。
     * 累計だと「いま何が動いているか」が分からないので、月ごとに切る。
     */
    if (p === '/api/pipeline/months') {
      // 締結日は「未定」「夏以降」も入る。年月の形をしているものだけを月として扱う
      const months = all(`SELECT m, COUNT(*) n FROM (
          SELECT substr(first_met,1,7) m FROM pipeline WHERE first_met <> ''
          UNION ALL
          SELECT substr(closed_on,1,7) m FROM pipeline WHERE closed_on <> ''
        ) WHERE m GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' GROUP BY m ORDER BY m DESC`);
      // 初期表示は「今月か、それより前でいちばん新しい月」。
      // 未来の面談予定が入っていると、開いた瞬間に来月が出て読み違える
      const now = thisMonth();
      const month = q.get('month')
        || (months.find((r) => r.m <= now) || months[0] || {}).m || '';
      // 月が決まらないときに '%' を渡すと全件に当たってしまう。空なら何も返さない
      if (!month) {
        return json(res, { months: [], month: '', met: [], closed: [], byStatus: [] });
      }
      const like = month + '%';
      return json(res, {
        months: months.map((r) => r.m), month,
        met: all(`SELECT * FROM pipeline WHERE first_met LIKE ? ORDER BY first_met`, like),
        closed: all(`SELECT * FROM pipeline WHERE closed_on LIKE ? ORDER BY closed_on`, like),
        byStatus: all(`SELECT status, COUNT(*) n, COALESCE(SUM(quote_month),0) monthly,
            COALESCE(SUM(quote_once),0) once
          FROM pipeline WHERE first_met LIKE ? OR closed_on LIKE ?
          GROUP BY status ORDER BY n DESC`, like, like),
      });
    }

    if (p === '/api/metrics') return json(res, { rows: all('SELECT * FROM metrics ORDER BY scope, id') });
    if (p === '/api/audit') {
      // シートの月次サマリーと、明細から計算した値を並べる。
      // ここが合っているかどうかが、取り込みが正しいことの根拠になる
      const summaryRows = all('SELECT * FROM monthly_summary ORDER BY month').map((r) => ({
        ...r,
        myExpense: one("SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE substr(date,1,7)=?", r.month).a,
        myIncome: one("SELECT COALESCE(SUM(income),0) a FROM cashflow WHERE substr(date,1,7)=?", r.month).a,
      }));
      return json(res, {
        summaryRows,
        pdfLog: all('SELECT * FROM pdf_log ORDER BY imported_at DESC'),
        rules: all('SELECT * FROM category_rules ORDER BY side, subcategory'),
        // 表が増えたときに書き忘れないよう、定義から作る
        counts: Object.entries(TABLES).map(([t, def]) => ({
          label: def.label, n: one(`SELECT COUNT(*) c FROM ${t}`).c,
        })).sort((a, b) => b.n - a.n),
        // 明細が正しく取り込めている根拠として、差引残高の到達点を出す
        balance: one('SELECT COALESCE(SUM(income),0)-COALESCE(SUM(expense),0) a FROM cashflow').a,
        cashflowIncome: one('SELECT COALESCE(SUM(income),0) a FROM cashflow').a,
        cashflowExpense: one('SELECT COALESCE(SUM(expense),0) a FROM cashflow').a,
        expenseTotal: one('SELECT COALESCE(SUM(amount),0) a FROM expenses').a,
        // シートそのものの食い違い。こちらの取り込みの誤りと区別して出す
        sheetIssues: sheetIssues(),
        // シートの売上と、口座に実際に入った金額の突き合わせ
        salesVsBank: salesVsBank(),
      });
    }
    if (p === '/api/pipeline') return json(res, { rows: all('SELECT * FROM pipeline ORDER BY id DESC') });
    if (p === '/api/kpi') {
      const m = q.get('month') || null;
      return json(res, {
        months: all('SELECT DISTINCT month FROM kpi ORDER BY month DESC').map((r) => r.month),
        rows: m ? all('SELECT * FROM kpi WHERE month=? ORDER BY section, metric, week', m)
                : all('SELECT * FROM kpi ORDER BY month DESC, section, metric, week'),
      });
    }
    if (p === '/api/plan') {
      const year = q.get('year') || '';
      const months = all('SELECT DISTINCT month FROM plan_monthly ORDER BY month').map((r) => r.month);
      const years = [...new Set(months.map((m) => m.slice(0, 4)))];
      const y = year || years[years.length - 1] || '';
      return json(res, {
        years, year: y,
        months: months.filter((m) => m.startsWith(y)),
        rows: all(`SELECT * FROM plan_monthly WHERE month LIKE ? ORDER BY kind, side, category, subcategory, month`, y + '%'),
      });
    }

    /* 設定 */
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      for (const [k, v] of Object.entries(body)) setSetting(k, v);
      return json(res, { ok: true });
    }
    if (p === '/api/settings') {
      return json(res, {
        mail_webapp_url: setting('mail_webapp_url'),
        // 合言葉そのものは返さない。入っているかどうかだけ見せる
        mail_api_token_set: !!setting('mail_api_token'),
      });
    }

    /* メルマガ */
    if (p === '/api/mail/status') return json(res, await mailApi({ api: 'status' }));
    if (p === '/api/mail/memos')  return json(res, await mailApi({ api: 'memos' }));
    if (p === '/api/mail/memo' && req.method === 'POST') {
      const b = await readJson(req);
      return json(res, await mailApi({ api: 'memo', text: b.text, frame: b.frame, from: '俺の事業を管理せよ' }));
    }

    /* ------------------------------------------------------------
       SNS運用
       ------------------------------------------------------------ */

    if (p === '/api/sns/overview') {
      const today = new Date().toISOString().slice(0, 10);
      return json(res, {
        accounts: all('SELECT * FROM sns_accounts ORDER BY platform, handle'),
        counts: all(`SELECT status, COUNT(*) n FROM sns_posts GROUP BY 1`),
        upcoming: all(`SELECT * FROM sns_posts
          WHERE status <> '公開' AND status <> '見送り' AND planned_on >= ?
          ORDER BY planned_on LIMIT 12`, today),
        overdue: all(`SELECT * FROM sns_posts
          WHERE status <> '公開' AND status <> '見送り' AND planned_on <> '' AND planned_on < ?
          ORDER BY planned_on LIMIT 12`, today),
        recent: all(`SELECT * FROM sns_posts WHERE status='公開'
          ORDER BY posted_on DESC LIMIT 10`),
        refs: one('SELECT COUNT(*) c FROM sns_refs').c,
        untried: one("SELECT COUNT(*) c FROM sns_refs WHERE tried <> '試した' AND borrow <> ''").c,
      });
    }

    // 投稿カレンダー。月の枡に予定と実績を並べる
    if (p === '/api/sns/calendar') {
      const month = q.get('month') || new Date().toISOString().slice(0, 7);
      return json(res, {
        month,
        months: all(`SELECT m FROM (
            SELECT DISTINCT substr(planned_on,1,7) m FROM sns_posts WHERE planned_on <> ''
            UNION SELECT DISTINCT substr(posted_on,1,7) FROM sns_posts WHERE posted_on <> ''
          ) WHERE m <> '' ORDER BY m DESC`).map((r) => r.m),
        posts: all(`SELECT * FROM sns_posts
          WHERE substr(COALESCE(NULLIF(posted_on,''), planned_on),1,7) = ?
          ORDER BY COALESCE(NULLIF(posted_on,''), planned_on)`, month),
      });
    }

    /**
     * 数値の分析。
     * 平均や率を出すだけで、判断は人に委ねる。
     * 保存率は「保存 ÷ リーチ」。リーチが0の投稿は率の計算から外す
     * （0で割ると無限になり、平均が壊れるため）。
     */
    if (p === '/api/sns/analysis') {
      const acc = q.get('account') || '';
      const where = acc ? `AND account = ?` : '';
      const args = acc ? [acc] : [];

      const agg = (groupBy, label) => all(`
        SELECT ${groupBy} AS key, COUNT(*) n,
          AVG(reach) reach, AVG(views) views,
          AVG(likes) likes, AVG(saves) saves, AVG(follows) follows,
          AVG(CASE WHEN reach > 0 THEN saves * 100.0 / reach END) saveRate,
          AVG(CASE WHEN reach > 0 THEN (likes + comments + saves + shares) * 100.0 / reach END) engRate
        FROM sns_posts WHERE status='公開' ${where}
        GROUP BY 1 HAVING key <> '' ORDER BY saveRate DESC`, ...args);

      const posts = all(`SELECT * FROM sns_posts WHERE status='公開' ${where}
        ORDER BY posted_on DESC`, ...args);

      const rate = (r) => (r.reach > 0 ? (r.saves + r.likes + r.comments + r.shares) * 100 / r.reach : null);
      const ranked = posts.filter((r) => rate(r) != null)
        .map((r) => ({ ...r, engRate: rate(r), saveRate: r.reach > 0 ? r.saves * 100 / r.reach : 0 }))
        .sort((a, b) => b.saveRate - a.saveRate);

      return json(res, {
        account: acc,
        accounts: all("SELECT DISTINCT account FROM sns_posts WHERE account <> ''").map((r) => r.account),
        total: posts.length,
        byFormat: agg('format'),
        byPillar: agg('pillar'),
        byWeekday: agg(`CASE CAST(strftime('%w', posted_on) AS INTEGER)
          WHEN 0 THEN '日' WHEN 1 THEN '月' WHEN 2 THEN '火' WHEN 3 THEN '水'
          WHEN 4 THEN '木' WHEN 5 THEN '金' ELSE '土' END`),
        byMonth: all(`SELECT substr(posted_on,1,7) key, COUNT(*) n,
            AVG(reach) reach, SUM(follows) follows,
            AVG(CASE WHEN reach > 0 THEN saves * 100.0 / reach END) saveRate
          FROM sns_posts WHERE status='公開' AND posted_on <> '' ${where}
          GROUP BY 1 ORDER BY 1`, ...args),
        best: ranked.slice(0, 5),
        worst: ranked.slice(-5).reverse(),
      });
    }

    /**
     * 台本を書くための材料をまとめる。
     * このアプリ自身は文章を作らない。作るのはClaude側なので、
     * アカウント設計とテーマを組み合わせた「渡す文面」を返す。
     */
    if (p === '/api/sns/brief') {
      const id = Number(q.get('id') || 0);
      const post = id ? one('SELECT * FROM sns_posts WHERE id=?', id) : null;
      if (!post) return json(res, { error: '投稿が見つかりません' }, 404);
      const acc = one('SELECT * FROM sns_accounts WHERE handle=?', post.account || '')
        || one('SELECT * FROM sns_accounts LIMIT 1');
      const refs = all(`SELECT account, hook, why, borrow FROM sns_refs
        WHERE borrow <> '' ORDER BY id DESC LIMIT 5`);
      return json(res, { post, account: acc, refs });
    }

    /* 汎用の一覧・絞り込み・編集 */
    if (p === '/api/tables') {
      return json(res, Object.entries(TABLES).map(([k, v]) => ({
        name: k, label: v.label, n: one(`SELECT COUNT(*) c FROM ${k}`).c,
      })));
    }
    if (p.startsWith('/api/table/')) {
      const rest = p.slice('/api/table/'.length).split('/');
      const name = decodeURIComponent(rest[0]);
      if (!tableOf(name)) return json(res, { error: '不明な表です' }, 404);
      const id = rest[1];

      if (req.method === 'GET') return json(res, listTable(name, q));
      // 「シートの値に戻す」。編集の印を外すと、次の取り込みで上書きされるようになる。
      // 汎用の POST（新規作成）より先に見ること
      if (req.method === 'POST' && id && rest[2] === 'release') {
        db.prepare(`UPDATE ${name} SET edited_at=NULL WHERE id=?`).run(key(id));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && !id) return json(res, writeRow(name, null, await readJson(req)), 201);
      if (req.method === 'PATCH' && id) return json(res, writeRow(name, id, await readJson(req)));
      if (req.method === 'DELETE' && id) {
        db.prepare(`DELETE FROM ${name} WHERE id=?`).run(key(id));
        return json(res, { ok: true });
      }
      return json(res, { error: '未対応の操作です' }, 405);
    }

    if (p.startsWith('/api/')) return json(res, { error: '不明なエンドポイント' }, 404);
    return serveStatic(res, p);
  } catch (e) {
    console.error(e);
    return json(res, { error: 'サーバ内部エラー', detail: e.message }, 500);
  }
});

server.listen(PORT, () => {
  const s = summary();
  console.log('俺の事業を管理せよ  →  http://localhost:' + PORT);
  console.log('  今月の収支: ' + s.money.monthNet.toLocaleString('ja-JP') + '円'
    + ' / 事業所 ' + (s.facilities ?? '—') + '件'
    + ' / 人脈 ' + s.contacts.total + '件');
});
