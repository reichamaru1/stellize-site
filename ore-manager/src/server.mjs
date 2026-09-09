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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8710);
const SHURO = join(ROOT, '..', 'shuro-db', 'data', 'shuro.db');

const db = new DatabaseSync(join(ROOT, 'data', 'ore.db'));
db.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));

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
      const m = q.get('month');
      return json(res, {
        months: all('SELECT DISTINCT month FROM plan_monthly ORDER BY month').map((r) => r.month),
        rows: m ? all('SELECT * FROM plan_monthly WHERE month=? ORDER BY side, category', m)
                : all('SELECT side, category, SUM(amount) amount FROM plan_monthly GROUP BY 1,2 ORDER BY 1, 3 DESC'),
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
