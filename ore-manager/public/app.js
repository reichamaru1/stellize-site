/**
 * 俺の事業を管理せよ — 画面
 *
 * 素のJS。フレームワークは入れない（shuro-db と同じ方針）。
 * 画面は PAGES に1つずつ足す。load() が中身を返し、tools() が右上の操作を返す。
 */

/* ---------- 小物 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yen = (n) => (Number(n) || 0).toLocaleString('ja-JP');
const money = (n) => '¥' + yen(n);
const api = (p) => fetch(p).then((r) => r.json());
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** 表を1つ作る。cols は {k,label,r?,fmt?} の配列。 */
function tableOf(cols, rows, opts = {}) {
  if (!rows.length) return el('div', { class: 'empty' }, opts.empty || 'データがありません');
  const thead = el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.r ? 'r' : '' }, c.label))));
  const tbody = el('tbody', {}, rows.map((row) => el('tr', {},
    cols.map((c) => {
      const v = c.fmt ? c.fmt(row[c.k], row) : row[c.k];
      const td = el('td', { class: [c.r ? 'r' : '', c.cls || ''].filter(Boolean).join(' ') });
      if (v && v.nodeType) td.append(v); else td.innerHTML = v == null || v === '' ? '<span class="dim">—</span>' : esc(v);
      return td;
    }))));
  const wrap = el('div', { class: opts.scroll === false ? '' : 'scroll' }, el('table', {}, thead, tbody));
  return wrap;
}

const panel = (title, sub, body) =>
  el('div', { class: 'panel' },
    el('h2', {}, title, sub ? el('span', { class: 'sub' }, sub) : null),
    el('div', { class: 'body' + (body && body.tagName === 'DIV' && body.classList.contains('scroll') ? ' flush' : '') }, body));

const card = (k, v, s, cls = '') =>
  el('div', { class: 'card ' + cls }, el('div', { class: 'k' }, k),
    el('div', { class: 'v num ' + (String(v).startsWith('-¥') ? 'minus' : '') }, v),
    s ? el('div', { class: 's' }, s) : null);

const statusTag = (s) => {
  const t = String(s || '');
  const cls = /契約中|契約|成約|済み/.test(t) ? 'ok' : /失注|終了|満了/.test(t) ? 'ng' : /保留|未/.test(t) ? 'hold' : '';
  return el('span', { class: 'tag ' + cls }, t || '—');
};

/* ============================================================
   画面
   ============================================================ */

const PAGES = {

  dash: {
    icon: '◈', label: 'ダッシュボード',
    async load() {
      const s = await api('/api/summary');
      const box = el('div');
      const net = s.money.monthNet;
      if (s.stale) {
        box.append(el('div', { class: 'err', style: 'background:#FDF6E7;color:#7A5F22' },
          `記帳は ${s.month} までです。最新の月を出すには、スプレッドシートを書き出して npm run import を実行してください。`));
      }
      box.append(el('div', { class: 'cards' },
        card(s.month + ' の収支', (net < 0 ? '-¥' : '¥') + yen(Math.abs(net)),
          '収入 ' + money(s.money.monthIncome) + ' / 支出 ' + money(s.money.monthExpense), 'accent'),
        card(s.month.slice(0, 4) + '年の収入', money(s.money.yearIncome), '支出 ' + money(s.money.yearExpense)),
        card('契約中の月額', money(s.deals.monthlyRevenue), s.deals.active + '件が稼働中'),
        card('フォロー待ち', s.contacts.todo + '件', '人脈 ' + s.contacts.total + '件のうち'),
        card('事業所リスト', s.facilities == null ? '—' : yen(s.facilities) + '件', '全国の就労支援事業所')));

      const cols = [
        { k: 'status', label: '進捗', fmt: (v) => statusTag(v) },
        { k: 'n', label: '件数', r: true },
        { k: 'amount', label: '月額見積', r: true, cls: 'money', fmt: (v) => money(v) },
      ];
      const recent = [
        { k: 'date', label: '日付', cls: 'nowrap' },
        { k: 'summary', label: '摘要' },
        { k: 'category', label: 'カテゴリ' },
        { k: 'income', label: '入', r: true, cls: 'money in', fmt: (v) => (v ? money(v) : '') },
        { k: 'expense', label: '出', r: true, cls: 'money out', fmt: (v) => (v ? money(v) : '') },
      ];
      box.append(el('div', { class: 'split' },
        panel('商談パイプライン', s.pipeline.reduce((a, b) => a + b.n, 0) + '件', tableOf(cols, s.pipeline)),
        panel('直近の入出金', null, tableOf(recent, s.recentCash))));
      return box;
    },
  },

  money: {
    icon: '¥', label: 'お金の流れ',
    state: { from: '2025-01', to: thisMonth(), q: '' },
    tools() {
      const st = PAGES.money.state;
      const mk = (k, type) => el('input', { type, value: st[k], oninput: (e) => { st[k] = e.target.value; }, });
      const from = mk('from', 'month'), to = mk('to', 'month');
      const kw = el('input', { type: 'search', placeholder: '摘要・カテゴリで検索', value: st.q,
        oninput: (e) => { st.q = e.target.value; } });
      const go = () => render('money');
      [from, to, kw].forEach((i) => i.addEventListener('change', go));
      kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return [from, el('span', { class: 'dim' }, '〜'), to, kw, el('button', { class: 'btn', onclick: go }, '絞り込む')];
    },
    async load() {
      const st = PAGES.money.state;
      const d = await api(`/api/money?from=${st.from}&to=${st.to}&q=${encodeURIComponent(st.q)}`);
      const box = el('div');

      const tIn = d.rows.reduce((a, r) => a + r.income, 0);
      const tOut = d.rows.reduce((a, r) => a + r.expense, 0);
      box.append(el('div', { class: 'cards' },
        card('期間の収入', money(tIn), d.rows.length + '件を表示中'),
        card('期間の支出', money(tOut)),
        card('差引', (tIn - tOut < 0 ? '-¥' : '¥') + yen(Math.abs(tIn - tOut)), '', 'accent')));

      // 月次の棒。数字だけだと動きが見えないので簡単な棒を添える
      const max = Math.max(1, ...d.byMonth.map((m) => Math.max(m.income, m.expense)));
      box.append(panel('月ごとの推移', d.byMonth.length + 'か月', tableOf([
        { k: 'month', label: '月', cls: 'nowrap' },
        { k: 'income', label: '収入', r: true, cls: 'money in', fmt: (v) => money(v) },
        { k: 'expense', label: '支出', r: true, cls: 'money out', fmt: (v) => money(v) },
        { k: '_', label: '差引', r: true, cls: 'money', fmt: (v, r) => {
          const n = r.income - r.expense;
          return el('span', { class: n < 0 ? 'out' : 'in' }, (n < 0 ? '-¥' : '¥') + yen(Math.abs(n)));
        } },
        { k: '__', label: '', fmt: (v, r) => el('div', { class: 'bar' },
          el('i', { class: r.income >= r.expense ? 'over' : '', style: `width:${Math.round(Math.max(r.income, r.expense) / max * 100)}%` })) },
      ], d.byMonth)));

      box.append(panel('カテゴリ別', '期間内', tableOf([
        { k: 'category', label: 'カテゴリ' },
        { k: 'n', label: '件', r: true },
        { k: 'income', label: '収入', r: true, cls: 'money in', fmt: (v) => (v ? money(v) : '') },
        { k: 'expense', label: '支出', r: true, cls: 'money out', fmt: (v) => (v ? money(v) : '') },
      ], d.byCategory)));

      box.append(panel('明細', d.rows.length + '件（最大500件）', tableOf([
        { k: 'date', label: '日付', cls: 'nowrap' },
        { k: 'kind', label: '種別', cls: 'nowrap' },
        { k: 'category', label: 'カテゴリ' },
        { k: 'summary', label: '摘要' },
        { k: 'method', label: '支払方法' },
        { k: 'income', label: '収入', r: true, cls: 'money in', fmt: (v) => (v ? money(v) : '') },
        { k: 'expense', label: '支出', r: true, cls: 'money out', fmt: (v) => (v ? money(v) : '') },
      ], d.rows)));
      return box;
    },
  },

  expenses: {
    icon: '▤', label: '経費・勘定',
    state: { from: '2025-01', to: thisMonth() },
    tools() {
      const st = PAGES.expenses.state;
      const go = () => render('expenses');
      const from = el('input', { type: 'month', value: st.from, onchange: (e) => { st.from = e.target.value; go(); } });
      const to = el('input', { type: 'month', value: st.to, onchange: (e) => { st.to = e.target.value; go(); } });
      return [from, el('span', { class: 'dim' }, '〜'), to];
    },
    async load() {
      const st = PAGES.expenses.state;
      const d = await api(`/api/expenses?from=${st.from}&to=${st.to}`);
      const box = el('div');
      const total = d.rows.reduce((a, r) => a + r.amount, 0);
      box.append(el('div', { class: 'cards' },
        card('期間の経費', money(total), d.rows.length + '件', 'accent')));
      box.append(el('div', { class: 'split' },
        panel('勘定科目別', null, tableOf([
          { k: 'account', label: '勘定科目' },
          { k: 'n', label: '件', r: true },
          { k: 'amount', label: '金額', r: true, cls: 'money', fmt: (v) => money(v) },
        ], d.byAccount)),
        panel('経費カテゴリ別', null, tableOf([
          { k: 'category', label: 'カテゴリ' },
          { k: 'n', label: '件', r: true },
          { k: 'amount', label: '金額', r: true, cls: 'money', fmt: (v) => money(v) },
        ], d.byCategory))));
      box.append(panel('明細', null, tableOf([
        { k: 'date', label: '日付', cls: 'nowrap' },
        { k: 'category', label: 'カテゴリ' },
        { k: 'summary', label: '摘要' },
        { k: 'amount', label: '金額', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: 'method', label: '支払方法' },
        { k: 'account', label: '勘定科目' },
        { k: 'tax_class', label: '税区分' },
      ], d.rows)));
      return box;
    },
  },

  customers: {
    icon: '◎', label: '顧客・案件',
    state: { tab: 'pipeline', q: '' },
    tools() {
      const st = PAGES.customers.state;
      if (st.tab !== 'contacts') return [];
      const kw = el('input', { type: 'search', placeholder: '会社・氏名・業種で検索', value: st.q,
        oninput: (e) => { st.q = e.target.value; },
        onchange: () => render('customers') });
      kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') render('customers'); });
      return [kw];
    },
    async load() {
      const st = PAGES.customers.state;
      const box = el('div');
      const tabs = el('div', { class: 'tabs' },
        [['pipeline', '商談パイプライン'], ['deals', '契約一覧'], ['contacts', '人脈台帳']]
          .map(([k, label]) => el('button', {
            class: st.tab === k ? 'on' : '',
            onclick: () => { st.tab = k; render('customers'); },
          }, label)));
      box.append(tabs);

      if (st.tab === 'pipeline') {
        const d = await api('/api/pipeline');
        box.append(panel('商談パイプライン', d.rows.length + '件', tableOf([
          { k: 'title', label: '案件名' },
          { k: 'company', label: '企業名' },
          { k: 'person', label: '担当者' },
          { k: 'broker', label: '仲介' },
          { k: 'status', label: '進捗', fmt: (v) => statusTag(v) },
          { k: 'quote_once', label: '単発', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
          { k: 'quote_month', label: '月額', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
          { k: 'lost_reason', label: '失注理由' },
        ], d.rows)));
      } else if (st.tab === 'deals') {
        const d = await api('/api/deals');
        const active = d.rows.filter((r) => r.status === '契約中');
        box.append(el('div', { class: 'cards' },
          card('契約中', active.length + '件', '月額合計 ' + money(active.reduce((a, r) => a + r.monthly, 0)), 'accent'),
          card('累計受注', money(d.rows.reduce((a, r) => a + r.amount, 0)), d.rows.length + '件')));
        box.append(panel('契約一覧', null, tableOf([
          { k: 'company', label: '会社名' },
          { k: 'person', label: '担当者' },
          { k: 'referrer', label: '紹介者' },
          { k: 'status', label: '状況', fmt: (v) => statusTag(v) },
          { k: 'closed_on', label: '締結日', cls: 'nowrap' },
          { k: 'amount', label: '受注額', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
          { k: 'monthly', label: '月額', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
          { k: 'content', label: '内容' },
        ], d.rows)));
      } else {
        const d = await api('/api/contacts?q=' + encodeURIComponent(st.q));
        box.append(panel('人脈台帳', d.total + '件', tableOf([
          { k: 'met_on', label: '会った日', cls: 'nowrap' },
          { k: 'company', label: '会社名' },
          { k: 'name', label: '氏名' },
          { k: 'industry', label: '業種' },
          { k: 'problem', label: 'お困りごと' },
          { k: 'next_action', label: '次のアクション' },
          { k: 'done', label: '状況', fmt: (v) => statusTag(v) },
        ], d.rows)));
      }
      return box;
    },
  },

  facilities: {
    icon: '⌘', label: '事業所リスト',
    state: { q: '', pref: '' },
    tools() {
      const st = PAGES.facilities.state;
      const kw = el('input', { type: 'search', placeholder: '事業所名・法人名・住所', value: st.q,
        oninput: (e) => { st.q = e.target.value; } });
      kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') render('facilities'); });
      return [kw, el('button', { class: 'btn', onclick: () => render('facilities') }, '検索')];
    },
    async load() {
      const st = PAGES.facilities.state;
      const d = await api(`/api/facilities?q=${encodeURIComponent(st.q)}&pref=${encodeURIComponent(st.pref)}`);
      const box = el('div');
      if (d.error) { box.append(el('div', { class: 'err' }, d.error)); return box; }

      const sel = el('select', { onchange: (e) => { st.pref = e.target.value; render('facilities'); } },
        el('option', { value: '' }, 'すべての都道府県'),
        d.prefs.map((p) => {
          const o = el('option', { value: p.prefecture }, `${p.prefecture}（${yen(p.n)}）`);
          if (p.prefecture === st.pref) o.selected = true;
          return o;
        }));
      box.append(el('div', { class: 'cards' },
        card('該当件数', yen(d.total) + '件', '最大200件を表示', 'accent')));
      box.append(panel('絞り込み', null, sel));
      box.append(panel('事業所', d.rows.length + '件を表示', tableOf([
        { k: 'name', label: '事業所名' },
        { k: 'corp_name', label: '法人名' },
        { k: 'prefecture', label: '都道府県', cls: 'nowrap' },
        { k: 'city', label: '市区町村', cls: 'nowrap' },
        { k: 'phone', label: '電話', cls: 'nowrap' },
        { k: 'url', label: 'サイト', fmt: (v) => (v ? el('a', { href: v, target: '_blank', rel: 'noopener' }, '開く') : '') },
      ], d.rows)));
      return box;
    },
  },

  mail: {
    icon: '✉', label: 'メルマガ',
    async load() {
      const box = el('div');
      const s = await api('/api/mail/status');
      if (!s.ok) {
        box.append(el('div', { class: 'err' }, s.error || 'メルマガに接続できません'));
        box.append(el('p', { class: 'hint' }, '「設定」でスプレッドシートのWebアプリURLと連携キーを入れてください。'));
        return box;
      }
      box.append(el('div', { class: 'cards' },
        card('今日', s.today, s.frame ? s.frame.key : '土日は書かない日', 'accent'),
        card('未使用のメモ', s.unusedMemos + '件'),
        card('配信先', yen(s.subscribers) + '件')));

      if (s.frame) {
        box.append(panel('今日の枠', s.frame.target,
          el('p', { class: 'hint', style: 'margin:0' }, s.frame.note)));
      }

      // メモをここからも残せるようにする（PCの前にいるときはこちらが早い）
      const ta = el('textarea', { rows: '3', placeholder: '見たこと・言われた言葉を、そのまま1行で', style: 'width:100%' });
      const btn = el('button', { class: 'btn pri', onclick: async () => {
        const t = ta.value.trim(); if (!t) return;
        btn.disabled = true; btn.textContent = '残しています…';
        const r = await post('/api/mail/memo', { text: t, frame: s.frame ? s.frame.key : '' });
        btn.disabled = false; btn.textContent = '残す';
        if (r.ok) { ta.value = ''; render('mail'); } else alert(r.error || '残せませんでした');
      } }, '残す');
      box.append(panel('ネタ帳に残す', null, el('div', {}, ta, el('div', { style: 'margin-top:8px' }, btn))));

      const memos = await api('/api/mail/memos');
      box.append(panel('未使用のメモ', (memos.memos || []).length + '件', tableOf([
        { k: 'at', label: '受付', cls: 'nowrap' },
        { k: 'frame', label: '枠', cls: 'nowrap' },
        { k: 'text', label: 'メモ' },
      ], memos.memos || [], { empty: 'メモはありません' })));

      box.append(panel('直近の号', null, tableOf([
        { k: 'issue', label: '号ID', cls: 'nowrap' },
        { k: 'state', label: '状態', fmt: (v) => statusTag(v) },
        { k: 'frame', label: '枠' },
        { k: 'subject', label: '件名' },
      ], s.recent || [])));
      return box;
    },
  },

  kpi: {
    icon: '≡', label: 'KPI',
    state: { month: '' },
    async load() {
      const st = PAGES.kpi.state;
      const d = await api('/api/kpi' + (st.month ? '?month=' + st.month : ''));
      const box = el('div');
      if (!d.rows.length) { box.append(el('div', { class: 'empty' }, 'KPIのデータがありません')); return box; }
      if (!st.month) st.month = d.months[0];

      const sel = el('select', { onchange: (e) => { st.month = e.target.value; render('kpi'); } },
        d.months.map((m) => {
          const o = el('option', { value: m }, m);
          if (m === st.month) o.selected = true;
          return o;
        }));
      box.append(panel('対象月', null, sel));

      // 指標ごとに週を横に並べ直す
      const bySec = {};
      for (const r of d.rows.filter((r) => r.month === st.month)) {
        (bySec[r.section] ||= {});
        (bySec[r.section][r.metric] ||= { metric: r.metric, t: [0, 0, 0, 0], a: [0, 0, 0, 0] });
        bySec[r.section][r.metric].t[r.week - 1] = r.target ?? 0;
        bySec[r.section][r.metric].a[r.week - 1] = r.actual ?? 0;
      }
      for (const [sec, metrics] of Object.entries(bySec)) {
        const rows = Object.values(metrics).map((m) => ({
          metric: m.metric,
          target: m.t.reduce((a, b) => a + b, 0),
          actual: m.a.reduce((a, b) => a + b, 0),
          w: m.t.map((t, i) => `${m.a[i]}/${t}`).join('　'),
        }));
        box.append(panel(sec, null, tableOf([
          { k: 'metric', label: '指標' },
          { k: 'w', label: '週ごと（実績/目標）', cls: 'nowrap num' },
          { k: 'target', label: '目標', r: true, cls: 'num' },
          { k: 'actual', label: '実績', r: true, cls: 'num' },
          { k: '_', label: '達成', fmt: (v, r) => {
            const p = r.target ? Math.round(r.actual / r.target * 100) : 0;
            return el('div', { style: 'display:flex;align-items:center;gap:8px' },
              el('div', { class: 'bar', style: 'flex:1' },
                el('i', { class: p >= 100 ? 'over' : '', style: `width:${Math.min(100, p)}%` })),
              el('span', { class: 'num dim', style: 'min-width:38px;text-align:right' }, p + '%'));
          } },
        ], rows, { scroll: false })));
      }
      return box;
    },
  },

  settings: {
    icon: '⚙', label: '設定',
    async load() {
      const s = await api('/api/settings');
      const box = el('div');
      const url = el('input', { type: 'text', value: s.mail_webapp_url || '', style: 'width:100%',
        placeholder: 'https://script.google.com/macros/s/～/exec' });
      const tok = el('input', { type: 'password', style: 'width:100%',
        placeholder: s.mail_api_token_set ? '設定済み（変更するときだけ入力）' : '連携キー' });
      const msg = el('div', { class: 'hint' });
      const save = el('button', { class: 'btn pri', onclick: async () => {
        const body = { mail_webapp_url: url.value.trim() };
        if (tok.value.trim()) body.mail_api_token = tok.value.trim();
        const r = await post('/api/settings', body);
        msg.textContent = r.ok ? '保存しました。' : '保存できませんでした。';
        tok.value = '';
      } }, '保存');

      box.append(panel('メルマガ連携', 'スプレッドシートの「📧 メルマガ」→「ネタ帳のURLと連携キーを表示」の値',
        el('div', {},
          el('div', { class: 'k', style: 'font-size:10.5px;color:var(--muted);margin-bottom:4px' }, 'WebアプリURL'),
          url,
          el('div', { class: 'k', style: 'font-size:10.5px;color:var(--muted);margin:12px 0 4px' }, '連携キー'),
          tok,
          el('div', { style: 'margin-top:12px' }, save),
          msg,
          el('p', { class: 'hint' }, '連携キーはこのPCのdata/ore.dbにだけ保存されます。画面には出しません。'))));

      box.append(panel('データの取り込み', null, el('div', {},
        el('p', { class: 'hint', style: 'margin:0 0 10px' },
          'スプレッドシートを更新したら、書き出し直して data/sheet-export.md に置き、ターミナルで次を実行してください。'),
        el('code', { style: 'display:block;padding:10px 12px;background:var(--ground);border-radius:6px' },
          'npm run import'))));
      return box;
    },
  },
};

/* ============================================================
   骨組み
   ============================================================ */

const ORDER = [
  ['見る', ['dash', 'money', 'expenses', 'kpi']],
  ['動かす', ['customers', 'facilities', 'mail']],
  ['', ['settings']],
];
let current = 'dash';

function buildNav() {
  const nav = $('#nav');
  nav.replaceChildren();
  for (const [group, keys] of ORDER) {
    if (group) nav.append(el('div', { class: 'sep' }, group));
    for (const k of keys) {
      const p = PAGES[k];
      nav.append(el('button', { class: k === current ? 'on' : '', onclick: () => render(k) },
        el('span', { class: 'ic' }, p.icon), p.label));
    }
  }
}

async function render(key) {
  current = key;
  const p = PAGES[key];
  buildNav();
  $('#page-title').textContent = p.label;
  $('#page-tools').replaceChildren(...(p.tools ? p.tools() : []));
  const view = $('#view');
  view.replaceChildren(el('div', { class: 'loading' }, '読み込み中…'));
  try {
    view.replaceChildren(await p.load());
  } catch (e) {
    view.replaceChildren(el('div', { class: 'err' }, '読み込みに失敗しました: ' + e.message));
  }
  location.hash = key;
}

async function boot() {
  const s = await api('/api/summary').catch(() => null);
  if (s) {
    $('#stat-line').innerHTML = `${s.month} ${s.money.monthNet < 0 ? '-' : ''}¥${yen(Math.abs(s.money.monthNet))}<br>`
      + `契約 ${s.deals.active}件 / 人脈 ${s.contacts.total}件`;
  }
  render(location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'dash');
}
boot();
