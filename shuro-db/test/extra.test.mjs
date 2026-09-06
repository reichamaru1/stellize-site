import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colIndex, colName, findHeaderRow, mapColumns } from '../src/ingest/xlsx.mjs';
import { classify, toCategory, cleanActivityLabel, CATEGORIES } from '../src/ingest/extra/activity.mjs';
import { validateWageRecords } from '../src/ingest/extra/parse.mjs';
import { buildIndex, matchRecord } from '../src/db/match.mjs';
import { normalizeText } from '../src/ingest/normalize.mjs';

test('列参照と列インデックスが相互変換できる', () => {
  assert.equal(colIndex('A1'), 0);
  assert.equal(colIndex('Z9'), 25);
  assert.equal(colIndex('AA1'), 26);
  assert.equal(colName(0), 'A');
  assert.equal(colName(26), 'AA');
});

test('タイトル行があってもヘッダ行を見つけられる', () => {
  const rows = [
    ['令和６年度　工賃（賃金）実績（就労継続支援B型）事業所別'],
    ['①都道府県名', '②No.', '⑤法人名', '⑥事業所名'],
    ['千葉', '1', '株式会社A', 'サンライズ'],
  ];
  assert.equal(findHeaderRow(rows, ['事業所名', '法人名', '都道府県']), 1);
});

test('列名は部分一致で拾い、最初に当たったものを使う', () => {
  const header = ['①都道府県名', '⑤法人名', '⑥事業所名', '⑬工賃平均額', '旧計算工賃平均額'];
  const col = mapColumns(header, { corp: ['法人名'], facility: ['事業所名'], avg: ['工賃平均額'] });
  assert.equal(col.facility, 2);
  assert.equal(col.avg, 3); // 旧計算ではなく先に出てくる方
});

/* --- 生産活動 --- */
test('支払形態や金額が前置された作業内容を掃除する', () => {
  assert.equal(cleanActivityLabel('日給＋時給 その他サービス・役務'), 'その他サービス・役務');
  assert.equal(cleanActivityLabel('73,257.1 清掃・施設管理'), '清掃・施設管理');
  assert.equal(cleanActivityLabel('日給＋時給'), null);
});

test('都道府県ごとに違う表記を同じ分類に寄せる', () => {
  assert.equal(toCategory('小物雑貨'), '小物雑貨・生活用品');          // 北海道
  assert.equal(toCategory('小物雑貨の製造・販売'), '小物雑貨・生活用品'); // 愛知
  assert.equal(toCategory('生活用品'), '小物雑貨・生活用品');          // 東京
  assert.equal(toCategory('データ入力'), '情報処理・データ入力');
  assert.equal(toCategory('情報処理・テープ起こし'), '情報処理・データ入力');
});

test('対応表にない表記は勝手に分類しない', () => {
  assert.equal(toCategory('未知のことば'), null);
  assert.deepEqual(classify('未知のことば'), { label: '未知のことば', category: null });
});

test('分類はすべて定義済みの語彙に含まれる', () => {
  for (const src of ['小物雑貨', '梱包・発送', 'リサイクル', '農業', 'パン', '封入・封緘']) {
    const c = toCategory(src);
    assert.ok(CATEGORIES.includes(c), `${src} → ${c} が CATEGORIES に無い`);
  }
});

/* --- 工賃の検証 --- */
test('平均工賃は「支払総額÷対象者延人数」と整合すれば通す（A型・旧方式）', () => {
  const { records } = validateWageRecords([
    { avgMonthly: 14104, totalPaid: 6699675, users: 475 },
  ]);
  assert.equal(records.length, 1);
});

test('B型の新計算方式（総額÷(1日平均×開所月数)）でも通す', () => {
  const { records } = validateWageRecords([
    { avgMonthly: 13947, totalPaid: 903802, users: 1342, dailyAvg: 16.2, months: 4 },
  ]);
  assert.equal(records.length, 1, '利用者延人数では合わないが新計算方式では合う');
});

test('桁がずれて支払総額を平均額として読んだ行は落とす', () => {
  const { records, rejected } = validateWageRecords([
    { avgMonthly: 19463307, totalPaid: 294, users: 20 },
  ]);
  assert.equal(records.length, 0);
  assert.match(rejected[0].why, /不整合/);
});

test('検証できる情報が無くても、非現実的な額は落とす', () => {
  const { records } = validateWageRecords([{ avgMonthly: 900000 }]);
  assert.equal(records.length, 0);
});

/* --- 突合 --- */
const FACILITIES = [
  { facility_key: 'k1', office_no: '1234500001', name: 'あおぞら作業所', name_norm: normalizeText('あおぞら作業所'), corp_name: '社会福祉法人あおぞら', corp_no: '1111111111111', prefecture: '千葉県', city: '千葉市中央区' },
  { facility_key: 'k2', office_no: '1234500002', name: 'あおぞら作業所', name_norm: normalizeText('あおぞら作業所'), corp_name: '株式会社そら', corp_no: '2222222222222', prefecture: '千葉県', city: '船橋市' },
];

test('事業所番号があれば確実に突合する', () => {
  const idx = buildIndex(FACILITIES);
  const r = matchRecord({ officeNo: '1234500002', facilityName: 'あおぞら作業所', prefecture: '千葉県' }, idx);
  assert.equal(r.facility.facility_key, 'k2');
  assert.equal(r.method, 'office_no');
});

test('同名が複数あるときは市区町村で絞る', () => {
  const idx = buildIndex(FACILITIES);
  const r = matchRecord({ facilityName: 'あおぞら作業所', prefecture: '千葉県', city: '船橋市' }, idx);
  assert.equal(r.facility.facility_key, 'k2');
  assert.equal(r.method, 'pref+city+name');
});

test('絞り込めないときは突合しない（別事業所に誤って結び付けない）', () => {
  const idx = buildIndex(FACILITIES);
  const r = matchRecord({ facilityName: 'あおぞら作業所', prefecture: '千葉県' }, idx);
  assert.equal(r.facility, null);
  assert.equal(r.method, 'ambiguous');
});

test('法人番号と事業所名の組み合わせで突合できる', () => {
  const idx = buildIndex(FACILITIES);
  const r = matchRecord({ corpNo: '1111111111111', facilityName: 'あおぞら作業所', prefecture: '千葉県' }, idx);
  assert.equal(r.facility.facility_key, 'k1');
  assert.equal(r.method, 'corp_no+name');
});

/* --- 市区町村の照合（実測で見つかった不具合の回帰テスト） --- */
const CITY_FACS = [
  { facility_key: 'a', office_no: '2312102557', name: 'ラポール', name_norm: normalizeText('らぽーる'), corp_name: null, corp_no: null, prefecture: '愛知県', city: '一宮市' },
  { facility_key: 'b', office_no: '2318101405', name: '就労継続支援Ｂ型事業所らぽーる', name_norm: normalizeText('らぽーる'), corp_name: null, corp_no: null, prefecture: '愛知県', city: '名古屋市南区' },
  { facility_key: 'c', office_no: '2313400123', name: 'たいじ', name_norm: normalizeText('たいじ'), corp_name: null, corp_no: null, prefecture: '愛知県', city: '海部郡大治町' },
  { facility_key: 'd', office_no: '0110100001', name: 'そら', name_norm: normalizeText('そら'), corp_name: null, corp_no: null, prefecture: '北海道', city: '札幌市白石区' },
  { facility_key: 'e', office_no: '1510100001', name: 'かがやき', name_norm: normalizeText('かがやき'), corp_name: null, corp_no: null, prefecture: '新潟県', city: '新潟市北区' },
  // 市区町村語彙を作るための実在自治体（実データでは全市区町村が語彙に入る）
  { facility_key: 'f', office_no: '2312000001', name: 'べつ', name_norm: normalizeText('べつ'), corp_name: null, corp_no: null, prefecture: '愛知県', city: '豊橋市' },
];

test('カナ正規化で同名になる別の市の事業所を掴まない', () => {
  // 「らぽーる」と「ラポール」は正規化すると同じ。市区町村で区別できなければならない。
  const idx = buildIndex(CITY_FACS);
  const r = matchRecord({ facilityName: 'らぽーる', prefecture: '愛知県', city: '名古屋市' }, idx);
  assert.equal(r.facility.facility_key, 'b');
});

test('郡の有無が違っても同じ市区町村とみなす', () => {
  // 資料は「大治町」、事業所データは「海部郡大治町」
  const idx = buildIndex(CITY_FACS);
  const r = matchRecord({ facilityName: 'たいじ', prefecture: '愛知県', city: '大治町' }, idx);
  assert.equal(r.facility.facility_key, 'c');
});

test('政令市の粒度差（札幌市 と 札幌市白石区）を吸収する', () => {
  const idx = buildIndex(CITY_FACS);
  const r = matchRecord({ facilityName: 'そら', prefecture: '北海道', city: '札幌市' }, idx);
  assert.equal(r.facility.facility_key, 'd');
});

test('行政コードが前置された市区町村表記を扱える', () => {
  // 新潟県の資料は「01-01新潟市北区」の形
  const idx = buildIndex(CITY_FACS);
  const r = matchRecord({ facilityName: 'かがやき', prefecture: '新潟県', city: '01-01新潟市北区' }, idx);
  assert.equal(r.facility.facility_key, 'e');
});

test('市区町村ではない圏域名は照合条件に使わない', () => {
  // 和歌山県の資料の「圏域」欄は「海草」「那賀」など市区町村ではない。
  // これを市区町村として突き合わせると、正しい事業所まで弾いてしまう。
  const facs = [{ facility_key: 'w', office_no: '3010100001', name: 'うみ', name_norm: normalizeText('うみ'), corp_name: null, corp_no: null, prefecture: '和歌山県', city: '海南市' }];
  const idx = buildIndex(facs);
  const r = matchRecord({ facilityName: 'うみ', prefecture: '和歌山県', city: '海草' }, idx);
  assert.equal(r.facility.facility_key, 'w');
  assert.equal(r.method, 'pref+name', '圏域名は市区町村として使わない');
});

test('市区町村が本当に食い違う場合は突合しない', () => {
  const idx = buildIndex(CITY_FACS);
  const r = matchRecord({ facilityName: 'たいじ', prefecture: '愛知県', city: '豊橋市' }, idx);
  assert.equal(r.facility, null);
  assert.equal(r.method, 'city_mismatch');
});
