/* 就労支援事業所DB フロントエンド（ビルド不要・依存なし） */

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, children = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
};
const fmt = (v, fallback = '未公表') => (v == null || v === '' ? fallback : v);

const state = { page: 1, meta: null, items: [], total: 0, pages: 0, view: 'list' };

/* ---------- クエリ組み立て ---------- */
function currentParams() {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  for (const cb of document.querySelectorAll('#service-types input:checked')) p.append('service', cb.value);
  for (const id of ['pref', 'city', 'capacity_min', 'capacity_max', 'status', 'sort']) {
    const v = $('#' + id).value;
    if (v) p.set(id, v);
  }
  return p;
}

function syncUrl(p) {
  const s = p.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
  $('#csv-link').href = `/api/export.csv?${s}`;
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  $('#q').value = p.get('q') ?? '';
  for (const id of ['pref', 'capacity_min', 'capacity_max', 'status', 'sort']) {
    if (p.get(id)) $('#' + id).value = p.get(id);
  }
  const services = new Set(p.getAll('service'));
  for (const cb of document.querySelectorAll('#service-types input')) cb.checked = services.has(cb.value);
  return p;
}

/* ---------- メタ情報 ---------- */
async function loadMeta() {
  const m = await (await fetch('/api/meta')).json();
  state.meta = m;

  $('#freshness').textContent =
    `データ基準：${m.latest?.label ?? '不明'}　掲載事業所 ${m.totals.active.toLocaleString()}件（元データは年2回更新）`;

  const box = $('#service-types');
  box.replaceChildren(...m.serviceTypes.map((s) => {
    const id = `svc-${s.service_type}`;
    return el('label', { htmlFor: id }, [
      el('input', { type: 'checkbox', id, value: s.service_type, name: 'service' }),
      el('span', {}, [s.service_type, ' ', el('span', { className: 'n', textContent: `(${s.c.toLocaleString()})` })]),
    ]);
  }));

  $('#pref').append(...m.prefectures.map((p) =>
    el('option', { value: p.prefecture, textContent: `${p.prefecture}（${p.c.toLocaleString()}）` })));

  renderQuality(m.quality);
}

function renderQuality(rows) {
  const labels = {
    'missing.corp_no': '法人番号', 'missing.url': '事業所URL', 'missing.phone': '電話番号',
    'missing.lat': '緯度経度', 'missing.name_kana': 'ふりがな', 'missing.fax': 'FAX',
    'missing.capacity': '定員（サービス単位）',
  };
  const miss = rows.filter((r) => r.metric.startsWith('missing.'));
  $('#quality-body').replaceChildren(
    el('p', { className: 'hint', textContent: '元データに値が入っていない割合です。当サイトで推測して補完することはしていません。' }),
    el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { textContent: '項目' }), el('th', { textContent: '欠損率' }), el('th', { textContent: '件数' })])),
      el('tbody', {}, miss.map((r) => el('tr', {}, [
        el('td', { textContent: labels[r.metric] ?? r.metric }),
        el('td', { textContent: `${(r.value * 100).toFixed(1)}%` }),
        el('td', { textContent: r.detail ?? '' }),
      ]))),
    ]),
  );
}

/* ---------- 市区町村（都道府県に連動） ---------- */
async function loadCities(pref, preselect) {
  const sel = $('#city');
  if (!pref) {
    sel.replaceChildren(el('option', { value: '', textContent: '都道府県を先に選んでください' }));
    sel.disabled = true;
    return;
  }
  sel.disabled = true;
  sel.replaceChildren(el('option', { value: '', textContent: '読み込み中…' }));
  const rows = await (await fetch(`/api/cities?pref=${encodeURIComponent(pref)}`)).json();
  sel.replaceChildren(
    el('option', { value: '', textContent: `すべて（${pref}）` }),
    ...rows.map((r) => el('option', { value: r.city, textContent: `${r.city}（${r.c}）` })),
  );
  sel.disabled = false;
  if (preselect) sel.value = preselect;
}

/* ---------- 検索 ---------- */
async function runSearch({ resetPage = true, focus = false } = {}) {
  if (resetPage) state.page = 1;
  const p = currentParams();
  syncUrl(p);
  p.set('page', state.page);
  p.set('per', '20');

  $('#count').textContent = '検索しています…';
  const data = await (await fetch(`/api/facilities?${p}`)).json();
  Object.assign(state, data);
  renderResults();
  if (focus) $('#results').focus();
}

function statusBadge(f) {
  if (f.status === 'active') return null;
  return el('span', { className: 'badge', textContent: `最新データに掲載なし（${f.last_seen.slice(0, 4)}年${Number(f.last_seen.slice(4))}月が最後）` });
}

function card(f) {
  const services = el('ul', { className: 'tags' }, f.services.map((s) =>
    el('li', { className: 'tag', textContent: s.capacity == null ? s.service_type : `${s.service_type}・定員${s.capacity}` })));

  const dl = el('dl', {}, [
    el('dt', { textContent: '所在地' }), el('dd', { textContent: f.address_full }),
    el('dt', { textContent: '法人' }), el('dd', { textContent: fmt(f.corp_name) }),
    el('dt', { textContent: '電話' }), el('dd', {}, f.phone ? el('a', { href: `tel:${f.phone.replace(/-/g, '')}`, textContent: f.phone }) : '未公表'),
  ]);
  if (f.url) dl.append(el('dt', { textContent: 'サイト' }), el('dd', {}, el('a', { href: f.url, rel: 'noopener', target: '_blank', textContent: f.url })));

  const title = el('button', { type: 'button', textContent: f.name });
  title.addEventListener('click', () => openDetail(f.facility_key));

  return el('li', { className: 'card' }, [
    statusBadge(f),
    el('h3', {}, title),
    f.name_kana ? el('p', { className: 'kana', textContent: f.name_kana }) : null,
    services, dl,
  ]);
}

function renderResults() {
  const { total, items, page, pages } = state;
  $('#count').replaceChildren(
    total === 0 ? '条件に合う事業所は見つかりませんでした。' : el('span', {}, [
      el('span', { className: 'num', textContent: total.toLocaleString() }), ` 件中 ${(page - 1) * 20 + 1}〜${Math.min(page * 20, total)} 件を表示`,
    ]),
  );

  if (total === 0) {
    $('#cards').replaceChildren(el('li', { className: 'empty' },
      '条件を広げてみてください。キーワードを短くする、都道府県の指定を外す、などが有効です。'));
  } else {
    $('#cards').replaceChildren(...items.map(card));
  }

  $('#pager').hidden = pages <= 1;
  $('#pageinfo').textContent = `${page} / ${pages} ページ`;
  $('#prev').disabled = page <= 1;
  $('#next').disabled = page >= pages;

  if (state.view === 'map') drawMap();
}

/* ---------- 詳細 ---------- */
const SERVICE_NOTE = {
  '就労移行支援': '一般企業への就職を目指して、訓練や就職活動の支援を受けるサービスです（原則2年）。',
  '就労継続支援Ａ型': '雇用契約を結んで働きながら支援を受けるサービスです。最低賃金が適用されます。',
  '就労継続支援Ｂ型': '雇用契約を結ばず、体調や希望に合わせて働きながら工賃を受け取るサービスです。',
  '就労定着支援': '就職した後に、職場に定着できるよう相談・調整を受けられるサービスです。',
  '就労選択支援': '本人に合った働き方を選ぶために、短期間のアセスメントを受けるサービスです。',
};

async function openDetail(key) {
  const dlg = $('#detail');
  $('#detail-body').replaceChildren(el('p', { textContent: '読み込んでいます…' }));
  if (!dlg.open) dlg.showModal();
  const f = await (await fetch(`/api/facilities/${encodeURIComponent(key)}`)).json();
  if (f.error) { $('#detail-body').replaceChildren(el('p', { textContent: f.error })); return; }

  const body = el('div', {}, [
    statusBadge(f),
    el('h2', { id: 'detail-title', textContent: f.name }),
    f.name_kana ? el('p', { className: 'kana', textContent: f.name_kana }) : null,
    el('h3', { textContent: '基本情報' }),
    el('dl', {}, [
      el('dt', { textContent: '事業所番号' }), el('dd', { textContent: f.office_no }),
      el('dt', { textContent: '法人名' }), el('dd', { textContent: fmt(f.corp_name) }),
      el('dt', { textContent: '法人番号' }), el('dd', { textContent: fmt(f.corp_no) }),
      el('dt', { textContent: '所在地' }), el('dd', { textContent: f.address_full }),
      el('dt', { textContent: '電話' }), el('dd', { textContent: fmt(f.phone) }),
      el('dt', { textContent: 'FAX' }), el('dd', { textContent: fmt(f.fax) }),
      el('dt', { textContent: 'サイト' }), el('dd', {}, f.url ? el('a', { href: f.url, rel: 'noopener', target: '_blank', textContent: f.url }) : '未公表'),
      el('dt', { textContent: '指定機関' }), el('dd', { textContent: fmt(f.designator) }),
    ]),
  ]);

  body.append(el('h3', { textContent: `提供サービス（${f.services.length}件）` }));
  for (const s of f.services) {
    body.append(
      el('p', { style: 'margin:10px 0 4px;font-weight:700', textContent: `${s.service_type}${s.capacity == null ? '' : `（定員 ${s.capacity}名）`}` }),
      SERVICE_NOTE[s.service_type] ? el('p', { className: 'hint', textContent: SERVICE_NOTE[s.service_type] }) : null,
      el('div', { className: 'table-scroll' }, el('table', {}, [
        el('thead', {}, el('tr', {}, ['平日', '土曜', '日曜', '祝日', '定休日'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, el('tr', {}, [s.hours_weekday, s.hours_sat, s.hours_sun, s.hours_holiday, s.closed_days]
          .map((v) => el('td', { textContent: fmt(v, '—') })))),
      ])),
      s.hours_note ? el('p', { className: 'hint', textContent: `備考：${s.hours_note}` }) : null,
    );
  }

  if (f.candidates?.length) {
    body.append(el('h3', { textContent: '同一施設の可能性がある記録' }));
    body.append(el('p', { className: 'hint', textContent: '事業所番号の変更や移転により、別の記録として登録されている可能性があります。自動では統合していません。' }));
    const ul = el('ul');
    for (const c of f.candidates) {
      const b = el('button', { type: 'button', className: 'btn small', textContent: `${c.name}（${c.status === 'active' ? '最新データに掲載あり' : '最新データに掲載なし'}）` });
      b.addEventListener('click', () => openDetail(c.other_key));
      ul.append(el('li', { style: 'margin-bottom:8px' }, [b, el('p', { className: 'hint', style: 'margin:2px 0 0', textContent: `${c.address_full}／${c.reason}` })]));
    }
    body.append(ul);
  }

  if (f.related.length) {
    body.append(el('h3', { textContent: `同じ事業所番号の関連事業所（${f.related.length}件）` }));
    const ul = el('ul');
    for (const r of f.related) {
      const b = el('button', { type: 'button', className: 'btn small', textContent: `${r.name}（${r.prefecture}${r.city}）` });
      b.addEventListener('click', () => openDetail(r.facility_key));
      ul.append(el('li', { style: 'margin-bottom:6px' }, b));
    }
    body.append(ul, el('p', { className: 'hint', textContent: '事業所番号は事業所ごとに一意ではないため、別法人・別施設が含まれることがあります。' }));
  }

  body.append(
    el('h3', { textContent: '掲載の履歴' }),
    el('p', {}, `${f.first_seen.slice(0, 4)}年${Number(f.first_seen.slice(4))}月のデータから掲載。最終確認は ${f.last_seen.slice(0, 4)}年${Number(f.last_seen.slice(4))}月。`),
    el('p', { className: 'source-note' }, [
      '出典：WAM NET 障害福祉サービス等情報公表システム オープンデータ／',
      `データ基準：${state.meta?.latest?.label ?? '不明'}。`,
      '掲載内容は変更されている場合があります。利用前に事業所へ直接ご確認ください。',
    ]),
  );

  $('#detail-body').replaceChildren(body);
  $('#detail-close').focus();
}

/* ---------- 地図（MapLibre を必要時にだけ読み込む） ---------- */
let map = null, markers = [];
async function ensureMap() {
  if (map) return map;
  if (!window.maplibregl) {
    await new Promise((resolve, reject) => {
      const css = el('link', { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css' });
      const js = el('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js', onload: resolve, onerror: () => reject(new Error('地図ライブラリの読み込みに失敗しました')) });
      document.head.append(css, js);
    });
  }
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { gsi: { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'], tileSize: 256, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>' } },
      layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
    },
    center: [138.5, 37.5], zoom: 4,
  });
  map.addControl(new maplibregl.NavigationControl({}), 'top-right');
  return map;
}

async function drawMap() {
  let m;
  try { m = await ensureMap(); }
  catch (e) { $('#map').textContent = `${e.message} 一覧表示をご利用ください。`; return; }
  for (const mk of markers) mk.remove();
  markers = [];
  const pts = state.items.filter((f) => f.lat != null);
  if (pts.length === 0) return;
  const b = new maplibregl.LngLatBounds();
  for (const f of pts) {
    const popup = new maplibregl.Popup({ offset: 20 }).setText(`${f.name}（${f.address_full}）`);
    markers.push(new maplibregl.Marker().setLngLat([f.lng, f.lat]).setPopup(popup).addTo(m));
    b.extend([f.lng, f.lat]);
  }
  m.fitBounds(b, { padding: 48, maxZoom: 14, duration: 0 });
  setTimeout(() => m.resize(), 0);
}

/* ---------- 起動 ---------- */
(async function init() {
  await loadMeta();
  const p = restoreFromUrl();
  if (p.get('pref')) await loadCities(p.get('pref'), p.get('city'));

  $('#filters').addEventListener('submit', (e) => { e.preventDefault(); runSearch({ focus: true }); });
  $('#filters').addEventListener('reset', () => setTimeout(() => { loadCities(''); runSearch(); }, 0));
  $('#pref').addEventListener('change', async (e) => { await loadCities(e.target.value); runSearch(); });
  $('#city').addEventListener('change', () => runSearch());
  for (const id of ['status', 'sort']) $('#' + id).addEventListener('change', () => runSearch());
  $('#service-types').addEventListener('change', () => runSearch());

  $('#prev').addEventListener('click', () => { state.page--; runSearch({ resetPage: false, focus: true }); });
  $('#next').addEventListener('click', () => { state.page++; runSearch({ resetPage: false, focus: true }); });

  $('#view-list').addEventListener('click', () => setView('list'));
  $('#view-map').addEventListener('click', () => setView('map'));
  $('#detail-close').addEventListener('click', () => $('#detail').close());

  await runSearch();
})();

function setView(v) {
  state.view = v;
  $('#view-list').setAttribute('aria-pressed', String(v === 'list'));
  $('#view-map').setAttribute('aria-pressed', String(v === 'map'));
  $('#map-panel').hidden = v !== 'map';
  if (v === 'map') drawMap();
}
