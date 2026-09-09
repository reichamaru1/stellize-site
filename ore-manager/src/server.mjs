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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8710);
const SHURO = join(ROOT, '..', 'shuro-db', 'data', 'shuro.db');

const db = new DatabaseSync(join(ROOT, 'data', 'ore.db'));
db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
migrate(db, Object.keys(TABLES));

// 事業所DBは、あちらの取り込みで作り直される。こちらからは書かない。
let shuro = null;
try {
  if (existsSync(SHURO)) shuro = new DatabaseSync(SHURO, { readOnly: true });
} catch (e) {
  console.warn('事業所DBを開けませんでした: ' + e.message);
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

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
  const latest = one("SELECT MAX(substr(date,1,7)) m FROM cashflow");
  const m = (latest && latest.m) || thisMonth();
  const year = m.slice(0, 4);
  const stale = m !== thisMonth();

  const cf = one(`SELECT
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
    contacts: {
      total: one('SELECT COUNT(*) c FROM contacts').c,
      todo: one("SELECT COUNT(*) c FROM contacts WHERE done <> '済み' AND next_action <> ''").c,
    },
    facilities: shuro ? one2(shuro, 'SELECT COUNT(*) c FROM facilities').c : null,
    // 直近の動き。ダッシュボードで「最後に何をしたか」が見えるようにする
    recentCash: all(`SELECT date, kind, category, income, expense, summary
      FROM cashflow ORDER BY date DESC, id DESC LIMIT 8`),
  };
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

    const n = one(`SELECT COUNT(DISTINCT ${expr}) c FROM ${name} ${clause}`, ...args).c;
    if (n === 0 || n > 60) { out[col.k] = null; continue; }

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
      .run(...pairs.map((p) => p[1]), now, Number(id));
    return { ok: true, id: Number(id), row: one(`SELECT * FROM ${name} WHERE id=?`, Number(id)) };
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
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
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
            COALESCE(SUM(CASE WHEN is_total=0 AND section='経費' THEN amount END),0) cost
          FROM pl_monthly GROUP BY 1 ORDER BY 1`),
        bySource: all(`SELECT subcategory, category, SUM(amount) amount, COUNT(*) n
          FROM pl_monthly WHERE is_total=0 AND section='売上' AND month LIKE ?
          GROUP BY 1,2 ORDER BY amount DESC`, like),
      });
    }
    /**
     * 手残り。
     * 事業の収入から事業の経費を引いたものが事業の利益。
     * そこから個人として出ていくお金（返済・貯蓄・保険・住まい）を引くと、
     * 実際に手元に残る額になる。cost_kinds の区分で分けている。
     */
    if (p === '/api/cash') {
      const kindJoin = `LEFT JOIN cost_kinds k ON k.category = e.category`;
      const rows = all(`
        SELECT m AS month,
          COALESCE((SELECT SUM(income) FROM cashflow WHERE substr(date,1,7)=m),0) AS income,
          COALESCE((SELECT SUM(e.amount) FROM expenses e ${kindJoin}
                    WHERE substr(e.date,1,7)=m AND COALESCE(k.kind,'事業')='事業'),0) AS bizCost,
          COALESCE((SELECT SUM(e.amount) FROM expenses e ${kindJoin}
                    WHERE substr(e.date,1,7)=m AND COALESCE(k.kind,'事業')='個人'),0) AS personal
        FROM (SELECT DISTINCT substr(date,1,7) m FROM expenses
              UNION SELECT DISTINCT substr(date,1,7) FROM cashflow) ORDER BY m`);
      const byCat = all(`
        SELECT COALESCE(k.kind,'事業') kind, e.category, SUM(e.amount) amount, COUNT(*) n
        FROM expenses e ${kindJoin} GROUP BY 1,2 ORDER BY amount DESC`);
      const guessed = one("SELECT COUNT(*) c FROM cost_kinds WHERE guessed=1 AND kind='個人'").c;
      return json(res, { rows, byCat, guessedPersonal: guessed });
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
        counts: [
          ['入出金明細', 'cashflow'], ['経費明細', 'expenses'], ['人脈台帳', 'contacts'],
          ['契約一覧', 'deals'], ['商談パイプライン', 'pipeline'], ['名刺', 'cards'],
          ['交流会', 'events'], ['協業先', 'partners'], ['料金表', 'pricing'],
          ['月次損益', 'pl_monthly'], ['月次数値', 'plan_monthly'], ['週次KPI', 'kpi'],
          ['事業パラメータ', 'metrics'], ['月次収支サマリー', 'monthly_summary'],
          ['PDF取込ログ', 'pdf_log'], ['カテゴリ判定ルール', 'category_rules'],
        ].map(([label, t]) => ({ label, n: one(`SELECT COUNT(*) c FROM ${t}`).c })),
        // 明細が正しく取り込めている根拠として、差引残高の到達点を出す
        balance: one('SELECT COALESCE(SUM(income),0)-COALESCE(SUM(expense),0) a FROM cashflow').a,
        cashflowIncome: one('SELECT COALESCE(SUM(income),0) a FROM cashflow').a,
        cashflowExpense: one('SELECT COALESCE(SUM(expense),0) a FROM cashflow').a,
        expenseTotal: one('SELECT COALESCE(SUM(amount),0) a FROM expenses').a,
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
        db.prepare(`UPDATE ${name} SET edited_at=NULL WHERE id=?`).run(Number(id));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && !id) return json(res, writeRow(name, null, await readJson(req)), 201);
      if (req.method === 'PATCH' && id) return json(res, writeRow(name, id, await readJson(req)));
      if (req.method === 'DELETE' && id) {
        db.prepare(`DELETE FROM ${name} WHERE id=?`).run(Number(id));
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
