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
   どの表でも使える 一覧＋検索＋絞り込み＋編集

   サーバの /api/table/<表名> を叩くだけなので、表が増えても
   ここは触らなくてよい（列の定義は src/tables.mjs にある）。
   ============================================================ */

const fmtCell = (col, v) => {
  if (v == null || v === '') return '';
  if (col.type === 'money') return money(v);
  if (col.type === 'bool') return v ? '✓' : '';
  if (col.type === 'number') return String(v);
  return String(v);
};

function dataTable(name, opts = {}) {
  const st = { q: '', f: {}, from: '', to: '', offset: 0, limit: 200, sort: '', dir: 'asc' };
  const root = el('div', { class: 'dt' });

  const draw = async () => {
    const p = new URLSearchParams({ q: st.q, limit: st.limit, offset: st.offset });
    for (const [k, v] of Object.entries(st.f)) if (v) p.set('f_' + k, v);
    if (st.from) p.set('from', st.from);
    if (st.to) p.set('to', st.to);
    if (st.sort) { p.set('sort', st.sort); p.set('dir', st.dir); }

    root.replaceChildren(el('div', { class: 'loading' }, '読み込み中…'));
    const d = await api(`/api/table/${encodeURIComponent(name)}?` + p);
    root.replaceChildren(render(d));
    if (opts.onLoaded) opts.onLoaded(d);
  };

  /* --- 1行を直す（右から出るフォーム） --- */
  const openEditor = (d, row) => {
    const isNew = !row;
    const vals = {};
    const fields = d.columns.map((c) => {
      const v = row ? (row[c.k] ?? '') : '';
      const input = c.type === 'bool'
        ? el('select', {}, el('option', { value: '0' }, 'いいえ'), el('option', { value: '1' }, 'はい'))
        : el('input', { type: c.type === 'date' ? 'date' : c.type === 'month' ? 'month' : 'text', value: v });
      if (c.type === 'bool') input.value = String(v ? 1 : 0);
      vals[c.k] = input;
      return el('div', { class: 'fld' },
        el('label', {}, c.label + (c.type === 'money' ? '（円）' : '')), input);
    });

    const msg = el('div', { class: 'hint' });
    const save = el('button', { class: 'btn pri', onclick: async () => {
      const body = {};
      for (const [k, input] of Object.entries(vals)) body[k] = input.value;
      save.disabled = true;
      const r = isNew
        ? await post(`/api/table/${encodeURIComponent(name)}`, body)
        : await patch(`/api/table/${encodeURIComponent(name)}/${row.id}`, body);
      save.disabled = false;
      if (r.error) { msg.textContent = r.error; return; }
      closeDrawer(); draw();
    } }, isNew ? '追加する' : '保存する');

    const del = isNew ? null : el('button', { class: 'btn warn', onclick: async () => {
      if (!confirm('この行を削除します。取り消せません。よろしいですか？')) return;
      await del2(`/api/table/${encodeURIComponent(name)}/${row.id}`);
      closeDrawer(); draw();
    } }, '削除');

    openDrawer((isNew ? '新しい行を追加' : d.label + ' を編集'),
      el('div', {}, fields, msg,
        el('div', { class: 'drawer-actions' }, save, del,
          el('button', { class: 'btn', onclick: closeDrawer }, 'とじる'))),
      row && row.edited_at ? `この行は ${row.edited_at} にこのアプリで編集済みです。取り込み直しても上書きされません。` : null);
  };

  /* --- 画面 --- */
  const render = (d) => {
    const box = el('div');

    /* 検索と絞り込み */
    const kw = el('input', { type: 'search', class: 'dt-search',
      placeholder: (d.columns.slice(0, 3).map((c) => c.label).join('・')) + ' などで検索',
      value: st.q });
    kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.q = kw.value; st.offset = 0; draw(); } });
    kw.addEventListener('search', () => { st.q = kw.value; st.offset = 0; draw(); });

    const controls = [kw];
    for (const key of d.filters) {
      const col = d.columns.find((c) => c.k === key);
      const opts = d.options[key] || [];
      if (!col || !opts.length) continue;
      const sel = el('select', { onchange: (e) => { st.f[key] = e.target.value; st.offset = 0; draw(); } },
        el('option', { value: '' }, col.label + '：すべて'),
        opts.map((o) => {
          const label = col.type === 'bool' ? (o.v ? 'はい' : 'いいえ') : String(o.v);
          const op = el('option', { value: String(o.v) }, `${label.slice(0, 22)}（${o.n}）`);
          if (String(st.f[key] ?? '') === String(o.v)) op.selected = true;
          return op;
        }));
      controls.push(sel);
    }
    if (d.hasRange) {
      const t = d.rangeKind === 'month' ? 'month' : 'month';
      controls.push(el('input', { type: t, value: st.from, title: '開始',
        onchange: (e) => { st.from = e.target.value; st.offset = 0; draw(); } }));
      controls.push(el('span', { class: 'dim' }, '〜'));
      controls.push(el('input', { type: t, value: st.to, title: '終了',
        onchange: (e) => { st.to = e.target.value; st.offset = 0; draw(); } }));
    }
    const active = st.q || st.from || st.to || Object.values(st.f).some(Boolean);
    if (active) {
      controls.push(el('button', { class: 'btn', onclick: () => {
        st.q = ''; st.f = {}; st.from = ''; st.to = ''; st.offset = 0; draw();
      } }, '条件をクリア'));
    }
    controls.push(el('span', { style: 'flex:1' }));
    controls.push(el('button', { class: 'btn pri', onclick: () => openEditor(d, null) }, '＋ 追加'));
    box.append(el('div', { class: 'dt-bar' }, controls));

    /* 件数と金額 */
    const sumTexts = Object.entries(d.sums)
      .filter(([, v]) => v)
      .map(([k, v]) => {
        const col = d.columns.find((c) => c.k === k);
        return `${col ? col.label : k} ${money(v)}`;
      });
    box.append(el('div', { class: 'dt-info' },
      el('b', {}, yen(d.total) + '件'),
      d.total > d.rows.length ? el('span', { class: 'dim' }, `（${yen(d.rows.length)}件を表示）`) : null,
      sumTexts.length ? el('span', { class: 'dt-sums' }, sumTexts.join('　/　')) : null));

    /* 表 */
    if (!d.rows.length) {
      box.append(el('div', { class: 'empty' }, active ? '条件に合う行がありません' : 'データがありません'));
    } else {
      const th = d.columns.map((c) => el('th', {
        class: (c.type === 'money' || c.type === 'number' ? 'r ' : '') + 'sortable',
        style: c.w ? `width:${c.w}px` : '',
        onclick: () => {
          st.dir = st.sort === c.k && st.dir === 'asc' ? 'desc' : 'asc';
          st.sort = c.k; draw();
        },
      }, c.label + (st.sort === c.k ? (st.dir === 'asc' ? ' ↑' : ' ↓') : '')));
      th.push(el('th', { style: 'width:52px' }, ''));

      const body = d.rows.map((row) => el('tr', { class: row.edited_at ? 'edited' : '' },
        d.columns.map((c) => el('td', {
          class: (c.type === 'money' || c.type === 'number' ? 'r money ' : '')
            + (c.type === 'date' || c.type === 'month' ? 'nowrap' : ''),
        }, fmtCell(c, row[c.k]) || el('span', { class: 'dim' }, '—'))).concat(
          el('td', { class: 'nowrap' },
            el('button', { class: 'btn tiny', onclick: () => openEditor(d, row) }, '編集')))));

      box.append(el('div', { class: 'scroll tall' },
        el('table', {}, el('thead', {}, el('tr', {}, th)), el('tbody', {}, body))));
    }

    /* ページ送り */
    if (d.total > d.limit) {
      const page = Math.floor(d.offset / d.limit) + 1;
      const last = Math.ceil(d.total / d.limit);
      box.append(el('div', { class: 'dt-page' },
        el('button', { class: 'btn', disabled: d.offset === 0 ? '' : null,
          onclick: () => { st.offset = Math.max(0, st.offset - st.limit); draw(); } }, '← 前'),
        el('span', { class: 'dim' }, `${page} / ${last} ページ`),
        el('button', { class: 'btn', disabled: page >= last ? '' : null,
          onclick: () => { st.offset += st.limit; draw(); } }, '次 →')));
    }
    return box;
  };

  draw();
  return root;
}

/* --- 右から出るフォーム --- */
function openDrawer(title, body, note) {
  closeDrawer();
  const back = el('div', { class: 'drawer-back', onclick: closeDrawer });
  const box = el('div', { class: 'drawer' },
    el('h3', {}, title),
    note ? el('div', { class: 'drawer-note' }, note) : null,
    el('div', { class: 'drawer-body' }, body));
  document.body.append(back, box);
  requestAnimationFrame(() => box.classList.add('open'));
  document.addEventListener('keydown', escClose);
}
function closeDrawer() {
  document.querySelectorAll('.drawer, .drawer-back').forEach((n) => n.remove());
  document.removeEventListener('keydown', escClose);
}
const escClose = (e) => { if (e.key === 'Escape') closeDrawer(); };

const patch = (p, body) => fetch(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const del2 = (p) => fetch(p, { method: 'DELETE' }).then((r) => r.json());


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
      if (st.tab !== 'contacts' && st.tab !== 'cards') return [];
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
        [['pipeline', '商談パイプライン'], ['deals', '契約一覧'], ['contacts', '人脈台帳'],
         ['cards', '名刺'], ['partners', '協業先']]
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
      } else if (st.tab === 'cards') {
        const d = await api('/api/cards?q=' + encodeURIComponent(st.q));
        box.append(panel('所属グループ', null, tableOf([
          { k: 'groups', label: 'グループ' },
          { k: 'n', label: '人数', r: true },
        ], d.groups)));
        box.append(panel('名刺', d.total + '件', tableOf([
          { k: 'company', label: '会社名' },
          { k: 'name', label: '名前', cls: 'nowrap' },
          { k: 'title', label: '役職' },
          { k: 'email', label: 'メール' },
          { k: 'phone', label: '電話', cls: 'nowrap' },
          { k: 'mobile', label: '携帯', cls: 'nowrap' },
          { k: 'groups', label: 'グループ' },
          { k: 'status', label: '進捗' },
        ], d.rows)));
      } else if (st.tab === 'partners') {
        const d = await api('/api/partners');
        box.append(panel('協業先', d.rows.length + '件', tableOf([
          { k: 'company', label: '会社名' },
          { k: 'person', label: '担当者', cls: 'nowrap' },
          { k: 'title', label: '役職', cls: 'nowrap' },
          { k: 'likelihood', label: '協力角度', cls: 'nowrap' },
          { k: 'role', label: '何を任せたい' },
          { k: 'relationship', label: '関係値', fmt: (v) => statusTag(v) },
          { k: 'memo', label: '備考' },
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


  pl: {
    icon: '▲', label: '月次損益',
    state: { year: '' },
    async load() {
      const st = PAGES.pl.state;
      const d = await api('/api/pl' + (st.year ? '?year=' + st.year : ''));
      st.year = d.year;
      const box = el('div');

      const sel = el('select', { onchange: (e) => { st.year = e.target.value; render('pl'); } },
        d.years.map((y) => {
          const o = el('option', { value: y }, y + '年');
          if (y === st.year) o.selected = true;
          return o;
        }));
      box.append(panel('対象年', null, sel));

      box.append(panel('年ごとの推移', '売上と販管費（内訳の合計）', tableOf([
        { k: 'y', label: '年', cls: 'nowrap' },
        { k: 'sales', label: '売上', r: true, cls: 'money in', fmt: (v) => money(v) },
        { k: 'cost', label: '販管費', r: true, cls: 'money out', fmt: (v) => money(v) },
        { k: '_p', label: '差引', r: true, cls: 'money', fmt: (v, r) => {
          const n = r.sales - r.cost;
          return el('span', { class: n < 0 ? 'out' : 'in' }, (n < 0 ? '-¥' : '¥') + yen(Math.abs(n)));
        } },
      ], d.summary, { scroll: false })));

      box.append(panel('売上の出どころ', st.year + '年', tableOf([
        { k: 'subcategory', label: '出どころ', fmt: (v, r) => v || r.category },
        { k: 'category', label: '区分', cls: 'nowrap' },
        { k: 'n', label: '月数', r: true },
        { k: 'amount', label: '合計', r: true, cls: 'money', fmt: (v) => money(v) },
      ], d.bySource)));

      // 区分ごとに、月を横に並べた表を出す
      const months = d.months;
      const grid = (rows) => {
        const keys = [...new Set(rows.map((r) => (r.category || '') + '｜' + (r.subcategory || '')))];
        return keys.map((k) => {
          const [cat, sub] = k.split('｜');
          const row = { label: sub ? (cat ? cat + '／' + sub : sub) : cat };
          let sum = 0;
          for (const m of months) {
            const hit = rows.find((r) => r.month === m && (r.category || '') === cat && (r.subcategory || '') === sub);
            row[m] = hit ? hit.amount : 0;
            sum += row[m];
          }
          row._sum = sum;
          return row;
        });
      };
      const monthCols = (extra = {}) => [{ k: 'label', label: '項目', cls: 'nowrap' }]
        .concat(months.map((m) => ({ k: m, label: m.slice(5) + '月', r: true, cls: 'money',
          fmt: (v) => (v ? yen(v) : '') })))
        .concat([{ k: '_sum', label: '年計', r: true, cls: 'money', fmt: (v) => money(v) }]);

      for (const [sec, title] of [['売上', '売上の内訳'], ['売上原価', '売上原価'], ['販管費', '販管費の内訳']]) {
        const rows = d.rows.filter((r) => r.section === sec && !r.is_total);
        if (!rows.length) continue;
        const g = grid(rows);
        box.append(panel(title, g.length + '項目', tableOf(monthCols(), g)));
      }

      const totals = d.rows.filter((r) => r.is_total);
      if (totals.length) {
        box.append(panel('合計・利益（シート側の集計値）', null, tableOf(monthCols(), grid(totals))));
      }
      return box;
    },
  },

  plan: {
    icon: '◇', label: '計画と実績',
    state: { year: '' },
    async load() {
      const st = PAGES.plan.state;
      const d = await api('/api/plan' + (st.year ? '?year=' + st.year : ''));
      st.year = d.year;
      const box = el('div');

      const sel = el('select', { onchange: (e) => { st.year = e.target.value; render('plan'); } },
        d.years.map((y) => {
          const o = el('option', { value: y }, y + '年');
          if (y === st.year) o.selected = true;
          return o;
        }));
      box.append(panel('対象年', null, sel));

      const months = d.months;
      // 目標・実績・目安 を、区分ごとに月で横に並べる
      for (const kind of ['目標', '実績', '目安']) {
        for (const side of ['売上', '支出']) {
          const rows = d.rows.filter((r) => r.kind === kind && r.side === side);
          if (!rows.length) continue;
          const keys = [...new Set(rows.map((r) => (r.category || '') + '｜' + (r.subcategory || '')))];
          const grid = keys.map((k) => {
            const [cat, sub] = k.split('｜');
            const row = { label: sub ? cat + '／' + sub : cat };
            let sum = 0;
            for (const m of months) {
              const hit = rows.find((r) => r.month === m && (r.category || '') === cat && (r.subcategory || '') === sub);
              row[m] = hit ? hit.amount : 0;
              sum += row[m];
            }
            row._sum = sum;
            return row;
          });
          const cols2 = [{ k: 'label', label: '項目', cls: 'nowrap' }]
            .concat(months.map((m) => ({ k: m, label: m.slice(5) + '月', r: true, cls: 'money',
              fmt: (v) => (v ? yen(v) : '') })))
            .concat([{ k: '_sum', label: '年計', r: true, cls: 'money', fmt: (v) => money(v) }]);
          box.append(panel(`${kind}　${side}`, grid.length + '項目', tableOf(cols2, grid)));
        }
      }

      const met = await api('/api/metrics');
      const scopes = [...new Set(met.rows.map((r) => r.scope))];
      if (scopes.length) {
        box.append(panel('事業のパラメータ', null, tableOf([
          { k: 'scope', label: '区分', cls: 'nowrap' },
          { k: 'key', label: '項目' },
          { k: 'value', label: '値', r: true, cls: 'num' },
        ], met.rows)));
      }
      return box;
    },
  },

  events: {
    icon: '◍', label: '交流会',
    async load() {
      const d = await api('/api/events');
      const box = el('div');
      const fee = d.rows.reduce((a, r) => a + r.fee, 0);
      const appts = d.rows.reduce((a, r) => a + r.appts, 0);
      const closings = d.rows.reduce((a, r) => a + r.closings, 0);
      box.append(el('div', { class: 'cards' },
        card('参加費の合計', money(fee), d.rows.length + '回の参加', 'accent'),
        card('アポ', appts + '件', appts ? '1件あたり ' + money(Math.round(fee / appts)) : ''),
        card('成約', closings + '件', closings ? '1件あたり ' + money(Math.round(fee / closings)) : ''),
        card('名刺', d.rows.reduce((a, r) => a + r.cards_got, 0) + '枚')));

      box.append(panel('会ごとの費用対効果', 'どこに出続けるかを決めるための表', tableOf([
        { k: 'series', label: '交流会' },
        { k: 'n', label: '回', r: true },
        { k: 'fee', label: '参加費計', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: 'cards_got', label: '名刺', r: true },
        { k: 'appts', label: 'アポ', r: true },
        { k: 'closings', label: '成約', r: true },
        { k: 'collabs', label: '協業', r: true },
        { k: '_cpa', label: 'アポ単価', r: true, cls: 'money',
          fmt: (v, r) => (r.appts ? money(Math.round(r.fee / r.appts)) : '—') },
        { k: '_cpc', label: '成約単価', r: true, cls: 'money',
          fmt: (v, r) => (r.closings ? money(Math.round(r.fee / r.closings)) : '—') },
      ], d.byName)));

      box.append(panel('参加の記録', d.rows.length + '回', tableOf([
        { k: 'held_on', label: '日時', cls: 'nowrap' },
        { k: 'name', label: '交流会' },
        { k: 'place', label: '場所' },
        { k: 'attendees', label: '人数', r: true },
        { k: 'fee', label: '参加費', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
        { k: 'cards_got', label: '名刺', r: true },
        { k: 'appts', label: 'アポ', r: true },
        { k: 'closings', label: '成約', r: true },
        { k: 'note', label: '備考' },
      ], d.rows)));
      return box;
    },
  },

  pricing: {
    icon: '＄', label: '料金表',
    async load() {
      const d = await api('/api/pricing');
      const box = el('div');
      box.append(panel('料金表', d.rows.length + '項目', tableOf([
        { k: 'category', label: '科目', cls: 'nowrap' },
        { k: 'item', label: '項目' },
        { k: 'unit', label: '単位', cls: 'nowrap' },
        { k: 'price', label: '単価', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
        { k: 'cost', label: '原価', r: true, cls: 'money', fmt: (v) => (v ? money(v) : '') },
        { k: '_m', label: '粗利', r: true, cls: 'money',
          fmt: (v, r) => (r.price ? money(r.price - r.cost) : '') },
        { k: '_r', label: '粗利率', r: true, cls: 'num',
          fmt: (v, r) => (r.price ? Math.round((r.price - r.cost) / r.price * 100) + '%' : '') },
        { k: 'vendor', label: '外注先' },
        { k: 'note', label: '備考' },
      ], d.rows)));
      return box;
    },
  },

  audit: {
    icon: '✓', label: '取り込みの検算',
    async load() {
      const d = await api('/api/audit');
      const box = el('div');
      box.append(el('div', { class: 'cards' },
        card('入出金の差引', (d.balance < 0 ? '-¥' : '¥') + yen(Math.abs(d.balance)),
          '明細から積み上げた到達点', 'accent'),
        card('収入合計', money(d.cashflowIncome)),
        card('支出合計', money(d.cashflowExpense)),
        card('経費明細', money(d.expenseTotal))));

      box.append(panel('シートの月次サマリーとの突き合わせ',
        '一致していれば、明細が正しく取り込めている根拠になる', tableOf([
        { k: 'month', label: '月', cls: 'nowrap' },
        { k: 'expense', label: 'シートの支出', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: 'myExpense', label: '経費明細から', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: '_e', label: '', fmt: (v, r) => el('span', { class: 'tag ' + (r.expense === r.myExpense ? 'ok' : 'ng') },
          r.expense === r.myExpense ? '一致' : '差 ' + money(r.myExpense - r.expense)) },
        { k: 'income', label: 'シートの収入', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: 'myIncome', label: '入出金明細から', r: true, cls: 'money', fmt: (v) => money(v) },
        { k: '_i', label: '', fmt: (v, r) => el('span', { class: 'tag ' + (r.income === r.myIncome ? 'ok' : 'hold') },
          r.income === r.myIncome ? '一致' : '差 ' + money(r.myIncome - r.income)) },
      ], d.summaryRows || [], { scroll: false })));
      box.append(el('p', { class: 'hint' },
        '支出はすべて一致します。収入がずれる月があるのは、シート側が4月以降を見込み額で埋めているためで、'
        + '取り込みの漏れではありません。'));

      box.append(panel('取り込んだ件数', '全' + d.counts.length + '表', tableOf([
        { k: 'label', label: '表' },
        { k: 'n', label: '件数', r: true, cls: 'num', fmt: (v) => yen(v) },
      ], d.counts, { scroll: false })));

      box.append(panel('通帳PDFの取込ログ', null, tableOf([
        { k: 'imported_at', label: '取込日時', cls: 'nowrap' },
        { k: 'filename', label: 'ファイル名' },
        { k: 'bank', label: '銀行', cls: 'nowrap' },
        { k: 'count', label: '件数', r: true },
        { k: 'income', label: '収入', r: true, cls: 'money in', fmt: (v) => (v ? money(v) : '') },
        { k: 'expense', label: '支出', r: true, cls: 'money out', fmt: (v) => (v ? money(v) : '') },
        { k: 'memo', label: 'メモ' },
      ], d.pdfLog)));

      box.append(panel('カテゴリの自動判定ルール', d.rules.length + '件', tableOf([
        { k: 'keyword', label: '代表キーワード' },
        { k: 'side', label: '収入/支出', cls: 'nowrap' },
        { k: 'subcategory', label: 'サブカテゴリ' },
      ], d.rules)));

      box.append(el('p', { class: 'hint' },
        'より詳しい検算（連番の欠け・差引残高の積み上げ・シート集計との突き合わせ）は、'
        + 'ターミナルで npm run verify を実行すると出ます。'));
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
      // 「率」で終わる指標は週をまたいで足せない（率の合計は意味を持たない）ので平均にする
      const isRate = (name) => /率$/.test(name);
      const avg = (xs) => { const v = xs.filter((x) => x); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
      const fmtVal = (name, v) => (isRate(name) ? Math.round(v * 100) + '%' : String(Math.round(v * 100) / 100));

      for (const [sec, metrics] of Object.entries(bySec)) {
        const rows = Object.values(metrics).map((m) => {
          const rate = isRate(m.metric);
          return {
            metric: m.metric,
            target: rate ? avg(m.t) : m.t.reduce((a, b) => a + b, 0),
            actual: rate ? avg(m.a) : m.a.reduce((a, b) => a + b, 0),
            rate,
            w: m.t.map((t, i) => (rate ? fmtVal(m.metric, m.a[i]) : `${m.a[i]}/${t}`)).join('　'),
          };
        });
        box.append(panel(sec, null, tableOf([
          { k: 'metric', label: '指標' },
          { k: 'w', label: '週ごと', cls: 'nowrap num' },
          { k: 'target', label: '目標', r: true, cls: 'num', fmt: (v, r) => fmtVal(r.metric, v) },
          { k: 'actual', label: '実績', r: true, cls: 'num', fmt: (v, r) => fmtVal(r.metric, v) },
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
  ['お金', ['dash', 'money', 'pl', 'expenses', 'plan']],
  ['売る', ['customers', 'events', 'facilities', 'mail']],
  ['調べる', ['kpi', 'pricing', 'audit']],
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

// URLのハッシュで画面が決まるようにする。
// ブラウザの戻る/進むと、リンクの共有（#money など）を効かせるため。
window.addEventListener('hashchange', () => {
  const key = location.hash.slice(1);
  if (key in PAGES && key !== current) render(key);
});

async function boot() {
  const s = await api('/api/summary').catch(() => null);
  if (s) {
    $('#stat-line').innerHTML = `${s.month} ${s.money.monthNet < 0 ? '-' : ''}¥${yen(Math.abs(s.money.monthNet))}<br>`
      + `契約 ${s.deals.active}件 / 人脈 ${s.contacts.total}件`;
  }
  render(location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'dash');
}
boot();
