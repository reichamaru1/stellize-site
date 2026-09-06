/* 就労支援事業所DB フロントエンド（ビルド不要・依存なし） */

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, children = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
};
const fmt = (v, fallback = '未公表') => (v == null || v === '' ? fallback : v);

const state = { page: 1, meta: null, items: [], total: 0, pages: 0, view: 'list', near: null };

/* 工賃・生産活動をこの事業所に結び付けた根拠。利用者が確からしさを判断できるように出す。 */
const MATCH_LABEL = {
  'office_no': '事業所番号が一致',
  'office_no+name': '事業所番号と事業所名が一致',
  'corp_no+name': '法人番号と事業所名が一致',
  'pref+city+name': '都道府県・市区町村・事業所名が一致',
  'pref+name': '都道府県と事業所名が一致',
  'pref+name+corp': '都道府県・事業所名・法人名が一致',
};

/* ---------- クエリ組み立て ---------- */
function currentParams() {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  for (const cb of document.querySelectorAll('#service-types input:checked')) p.append('service', cb.value);
  for (const cb of document.querySelectorAll('#activity-cats input:checked')) p.append('activity', cb.value);
  for (const id of ['pref', 'city', 'capacity_min', 'capacity_max', 'wage_min', 'wage_max', 'status', 'sort', 'per']) {
    const v = $('#' + id).value;
    if (v) p.set(id, v);
  }
  if (state.near) {
    p.set('near', `${state.near.lat.toFixed(5)},${state.near.lng.toFixed(5)}`);
    p.set('radius_km', $('#radius_km').value);
  }
  return p;
}

function syncUrl(p) {
  const s = p.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
  $('#csv-now').href = `/api/export.csv?${s}`;
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  $('#q').value = p.get('q') ?? '';
  for (const id of ['pref', 'capacity_min', 'capacity_max', 'wage_min', 'wage_max', 'status', 'sort', 'per', 'radius_km']) {
    if (p.get(id)) $('#' + id).value = p.get(id);
  }
  const near = p.get('near');
  if (near) {
    const [lat, lng] = near.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setNear({ lat, lng }, '共有されたリンクの地点');
  }
  const services = new Set(p.getAll('service'));
  for (const cb of document.querySelectorAll('#service-types input')) cb.checked = services.has(cb.value);
  const acts = new Set(p.getAll('activity'));
  for (const cb of document.querySelectorAll('#activity-cats input')) cb.checked = acts.has(cb.value);
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

  const acts = $('#activity-cats');
  acts.replaceChildren(...m.activityCategories.map((a) => {
    const id = `act-${a.category}`;
    return el('label', { htmlFor: id }, [
      el('input', { type: 'checkbox', id, value: a.category, name: 'activity' }),
      el('span', {}, [a.category, ' ', el('span', { className: 'n', textContent: `(${a.c.toLocaleString()})` })]),
    ]);
  }));

  // どの都道府県のデータが入っているかを、隠さず明示する
  const actPrefs = [...new Set(m.extraSources.filter((s) => s.kind === 'activity' && s.matched > 0).map((s) => s.prefecture))];
  const wagePrefs = [...new Set(m.extraSources.filter((s) => s.kind === 'wage' && s.matched > 0).map((s) => s.prefecture))];
  // 工賃実績に「主な作業内容」が含まれる県も生産活動のソースになる
  const actFromWage = [...new Set(m.extraSources.filter((s) => s.kind === 'wage' && s.prefecture === '北海道').map((s) => s.prefecture))];
  const allActPrefs = [...new Set([...actPrefs, ...actFromWage])];
  $('#activity-coverage').textContent = allActPrefs.length ? allActPrefs.join('・') : '（未取得）';
  $('#wage-coverage').textContent = wagePrefs.length
    ? `工賃を取り込んでいるのは ${wagePrefs.join('・')} です。年度は都道府県ごとに異なります。指定すると、それ以外の事業所は結果から外れます。`
    : '工賃データは未取得です。';

  renderExtraSources(m.extraSources);
  renderExportLinks();
  renderQuality(m.quality);
}

const EXPORT_NOTE = {
  '01_事業所一覧.csv': '1行=1事業所。サービスごとの定員を列に展開済み。まずこれ',
  '02_サービス.csv': '1行=1サービス。営業時間・定休日つき',
  '03_工賃.csv': '1行=公表資料の1行。未突合の行も残してあります',
  '04_生産活動.csv': '1行=公表資料の1項目',
  '05_データソース.csv': 'どの県のいつのデータをどこから取ったか',
  '00_はじめに.csv': '各シートの説明と、精度・注意点',
};

async function renderExportLinks() {
  const box = $('#export-list');
  if (!box) return;
  try {
    const items = await (await fetch('/api/export/list')).json();
    box.replaceChildren(...items.map((it) => el('li', {}, [
      el('a', { href: it.url, download: it.name, textContent: it.name }),
      el('span', { className: 'hint', textContent: EXPORT_NOTE[it.name] ? `　${EXPORT_NOTE[it.name]}` : '' }),
    ])));
  } catch {
    box.replaceChildren(el('li', { className: 'hint', textContent: '書き出しの一覧を取得できませんでした。' }));
  }
}

function renderExtraSources(rows) {
  const box = $('#extra-source-list');
  if (!box) return;
  if (!rows?.length) { box.replaceChildren(el('p', { className: 'hint', textContent: '工賃・生産活動のソースは未取得です。' })); return; }
  const table = el('table', { className: 'q-table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { textContent: '種類' }), el('th', { textContent: '都道府県' }), el('th', { textContent: '年度' }),
      el('th', { textContent: '対象' }), el('th', { textContent: '形式' }),
      el('th', { textContent: '件数' }), el('th', { textContent: '突合' }), el('th', { textContent: '出典' }),
    ])),
    el('tbody', {}, rows.map((r) => el('tr', {}, [
      el('td', { textContent: r.kind === 'wage' ? '工賃' : '生産活動' }),
      el('td', { textContent: r.prefecture }),
      el('td', { textContent: r.fiscal_year ? `${r.fiscal_year}年度` : '—' }),
      el('td', { textContent: r.service_type ?? 'A型・B型' }),
      el('td', { textContent: r.format.toUpperCase() }),
      el('td', { textContent: r.rows.toLocaleString() }),
      el('td', { textContent: r.rows ? `${r.matched.toLocaleString()}（${Math.round((r.matched / r.rows) * 100)}%）` : '—' }),
      el('td', {}, el('a', { href: r.source_page ?? r.source_url, rel: 'noopener', target: '_blank', textContent: '公表元' })),
    ]))),
  ]);
  const note = el('p', { className: 'hint' }, [
    '「突合」は、この一覧の事業所と結び付けられた件数です。事業所番号を持たない資料が多く、',
    '事業所名と所在地で照合しているため、同名の事業所が複数ある場合など、結び付けられないものが残ります。',
    '誤って別の事業所に結び付けるより、結び付けない方を選んでいます。',
  ]);
  box.replaceChildren(table, note);
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
/** 現在地を設定して画面に反映する */
function setNear(pos, label) {
  state.near = pos;
  $('#clear-location').hidden = false;
  $('#near-status').textContent = `${label}から ${$('#radius_km').value}km 以内で絞り込んでいます。`;
}

/**
 * 場所の指定は「現在地から」と「地名・都道府県・市区町村」のどちらか一方だけにする。
 * 両方が同時に効くと、東京駅5km圏かつ横浜市中区、のように必ず0件になるため。
 */
function useAreaFilter() {
  if (state.near) { clearNear(); $('#near-status').textContent = '地名で絞り込んだため、現在地からの絞り込みを解除しました。'; }
}
function useNearFilter() {
  const had = $('#pref').value || $('#city').value || $('#place').value;
  $('#place').value = '';
  $('#pref').value = '';
  loadCities('');
  return Boolean(had);
}

function clearNear() {
  state.near = null;
  $('#clear-location').hidden = true;
  $('#near-status').textContent = '';
}

async function runSearch({ resetPage = true, focus = false } = {}) {
  if (resetPage) state.page = 1;
  const p = currentParams();
  syncUrl(p);
  p.set('page', state.page);

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

function wageBadge(f) {
  if (!f.wage) return null;
  return el('p', { className: 'wage' }, [
    el('span', { className: 'wage-amount', textContent: `平均工賃 月額 ${f.wage.avg_monthly.toLocaleString()}円` }),
    el('span', { className: 'wage-year', textContent: `（${f.wage.fiscal_year}年度・${f.wage.prefecture}公表）` }),
  ]);
}

function card(f) {
  const services = el('ul', { className: 'tags' }, f.services.map((s) =>
    el('li', { className: 'tag', textContent: s.capacity == null ? s.service_type : `${s.service_type}・定員${s.capacity}` })));
  const activities = f.activities?.length
    ? el('ul', { className: 'tags' }, f.activities.map((a) => el('li', { className: 'tag tag-act', textContent: a })))
    : null;

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
    f.distance_km != null
      ? el('p', { className: 'dist', textContent: `現在地から約 ${f.distance_km < 1 ? `${Math.round(f.distance_km * 1000)}m` : `${f.distance_km.toFixed(1)}km`}` })
      : null,
    el('h3', {}, title),
    f.name_kana ? el('p', { className: 'kana', textContent: f.name_kana }) : null,
    services, activities, wageBadge(f), dl,
  ]);
}

function renderResults() {
  const { total, items, page, pages } = state;
  $('#count').replaceChildren(
    total === 0 ? '条件に合う事業所は見つかりませんでした。' : el('span', {}, [
      el('span', { className: 'num', textContent: total.toLocaleString() }),
      ` 件中 ${((page - 1) * state.per + 1).toLocaleString()}〜${Math.min(page * state.per, total).toLocaleString()} 件を表示`,
      state.near ? '（現在地から近い順）' : '',
    ]),
  );

  if (total === 0) {
    $('#cards').replaceChildren(el('li', { className: 'empty' },
      '条件を広げてみてください。キーワードを短くする、都道府県の指定を外す、などが有効です。'));
  } else {
    $('#cards').replaceChildren(...items.map(card));
  }

  const hint = $('#csv-hint');
  if (hint) {
    hint.textContent = total === 0
      ? ''
      : `「この条件をCSV」＝いま絞り込んでいる ${total.toLocaleString()} 件。「全件CSV」＝${(state.meta?.totals?.active ?? 0).toLocaleString()} 件すべて（工賃・生産活動つき、1行=1事業所）。どちらもExcelでそのまま開けます。`;
  }

  $('#pager').hidden = pages <= 1;
  $('#pageinfo').textContent = `${page} / ${pages} ページ`;
  $('#prev').disabled = page <= 1;
  $('#first').disabled = page <= 1;
  $('#next').disabled = page >= pages;
  $('#last').disabled = page >= pages;
  const pi = $('#page-input');
  pi.max = String(pages);
  pi.value = String(page);

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

  // --- 生産活動 ---
  if (f.activities?.length) {
    const byCat = new Map();
    for (const a of f.activities) {
      if (!byCat.has(a.category)) byCat.set(a.category, { details: new Set(), src: a });
      if (a.detail) byCat.get(a.category).details.add(a.detail);
    }
    body.append(el('h3', { textContent: '生産活動' }));
    body.append(el('ul', { className: 'tags' }, [...byCat.keys()].map((c) =>
      el('li', { className: 'tag tag-act', textContent: c }))));
    const withDetail = [...byCat.entries()].filter(([, v]) => v.details.size);
    if (withDetail.length) {
      body.append(el('dl', {}, withDetail.flatMap(([c, v]) => [
        el('dt', { textContent: c }),
        el('dd', { textContent: [...v.details].join('／') }),
      ])));
    }
    const src = f.activities[0];
    body.append(el('p', { className: 'hint' }, [
      `出典：${src.source_name ?? '公表資料'}　`,
      el('a', { href: src.source_page ?? src.source_url, rel: 'noopener', target: '_blank', textContent: '公表元を開く' }),
    ]));
  }

  // --- 工賃 ---
  if (f.wages?.length) {
    body.append(el('h3', { textContent: '平均工賃（月額）' }));
    body.append(el('div', { className: 'table-scroll' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['年度', 'サービス', '平均工賃月額', '支払総額', '対象延人数'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, f.wages.map((w) => el('tr', {}, [
        el('td', { textContent: `${w.fiscal_year}年度` }),
        el('td', { textContent: w.service_type }),
        el('td', { textContent: `${w.avg_monthly.toLocaleString()}円` }),
        el('td', { textContent: w.total_paid == null ? '—' : `${w.total_paid.toLocaleString()}円` }),
        el('td', { textContent: w.users == null ? '—' : `${w.users.toLocaleString()}人` }),
      ]))),
    ])));
    const w0 = f.wages[0];
    body.append(el('p', { className: 'hint' }, [
      `出典：${w0.prefecture}の公表資料　`,
      el('a', { href: w0.source_page ?? w0.source_url, rel: 'noopener', target: '_blank', textContent: '公表元を開く' }),
      `　／　この事業所との突合方法：${MATCH_LABEL[w0.match_method] ?? w0.match_method}`,
    ]));
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

  // 一覧のページ分だけでなく、条件に合う全件を地図に出す
  const p = currentParams();
  p.delete('page'); p.delete('per');
  let data;
  try { data = await (await fetch(`/api/map?${p}`)).json(); }
  catch { data = { points: state.items.filter((f) => f.lat != null), truncated: false }; }
  const pts = data.points ?? [];
  $('#map-note').textContent = pts.length === 0
    ? '座標のある事業所がありません。'
    : data.truncated
      ? `件数が多いため、地図には先頭 ${data.cap.toLocaleString()} 件のみ表示しています。条件を絞ると全件表示できます。`
      : `条件に合う ${pts.length.toLocaleString()} 件すべてを表示しています。`;
  if (pts.length === 0) return;
  const b = new maplibregl.LngLatBounds();
  for (const f of pts) {
    const popup = new maplibregl.Popup({ offset: 20 }).setText(`${f.name}（${f.prefecture ?? ''}${f.city ?? ''}）`);
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
  $('#filters').addEventListener('reset', () => setTimeout(() => { clearNear(); $('#place').value = ''; loadCities(''); runSearch(); }, 0));
  $('#pref').addEventListener('change', async (e) => { useAreaFilter(); $('#place').value = ''; await loadCities(e.target.value); runSearch(); });
  $('#city').addEventListener('change', () => { useAreaFilter(); runSearch(); });
  for (const id of ['status', 'sort']) $('#' + id).addEventListener('change', () => runSearch());
  $('#service-types').addEventListener('change', () => runSearch());

  const goto = (n) => { state.page = Math.min(Math.max(1, n), Math.max(1, state.pages)); runSearch({ resetPage: false, focus: true }); };
  $('#first').addEventListener('click', () => goto(1));
  $('#last').addEventListener('click', () => goto(state.pages));
  $('#go').addEventListener('click', () => goto(Number($('#page-input').value)));
  $('#page-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goto(Number($('#page-input').value)); }
  });
  $('#per').addEventListener('change', () => runSearch());

  /* --- 地名でしぼる --- */
  let placeTimer;
  $('#place').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(placeTimer);
    if (q.length < 2) return;
    placeTimer = setTimeout(async () => {
      const rows = await (await fetch(`/api/places?q=${encodeURIComponent(q)}`)).json();
      $('#place-list').replaceChildren(...rows.map((r) =>
        el('option', { value: `${r.prefecture}${r.city}`, label: `${r.c}件` })));
    }, 200);
  });
  $('#place').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    const rows = await (await fetch(`/api/places?q=${encodeURIComponent(v)}`)).json();
    const hit = rows.find((r) => `${r.prefecture}${r.city}` === v) ?? rows[0];
    if (!hit) { $('#near-status').textContent = `「${v}」に該当する市区町村が見つかりませんでした。`; return; }
    useAreaFilter();
    $('#pref').value = hit.prefecture;
    await loadCities(hit.prefecture, hit.city);
    runSearch({ focus: true });
  });

  /* --- 現在地から探す --- */
  $('#use-location').addEventListener('click', () => {
    if (!navigator.geolocation) { $('#near-status').textContent = 'この端末では現在地を取得できません。地名でしぼる方をお使いください。'; return; }
    $('#near-status').textContent = '現在地を取得しています…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const cleared = useNearFilter();
        setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude }, '現在地');
        if (cleared) $('#near-status').textContent += '（地名・都道府県の指定は解除しました）';
        runSearch({ focus: true });
      },
      (err) => {
        $('#near-status').textContent = err.code === err.PERMISSION_DENIED
          ? '位置情報の利用が許可されませんでした。地名でしぼる方をお使いください。'
          : '現在地を取得できませんでした。地名でしぼる方をお使いください。';
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });
  $('#clear-location').addEventListener('click', () => { clearNear(); runSearch(); });
  $('#radius_km').addEventListener('change', () => { if (state.near) { setNear(state.near, '現在地'); runSearch(); } });

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
