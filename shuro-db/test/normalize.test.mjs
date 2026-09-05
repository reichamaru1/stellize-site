import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toHalfWidth, katakanaToHiragana, normalizeText, normalizeCorpName,
  splitAddress, normalizeAddress, normalizePhone, parseCapacity,
  parseLatLng, normalizeUrl, PREF_BY_CODE,
} from '../src/ingest/normalize.mjs';

test('全角英数を半角化する（実データは全角名称が多い）', () => {
  assert.equal(toHalfWidth('ｒｅｗａｒｄ株式会社'), 'reward株式会社');
  assert.equal(toHalfWidth('ｈｉｂｉｎｏ−ｓｈｉｇｏｔｏ'), 'hibino-shigoto');
  assert.equal(toHalfWidth('１丁目２−３'), '1丁目2-3');
});

test('カタカナをひらがなに寄せる', () => {
  assert.equal(katakanaToHiragana('リワード'), 'りわーど');
});

test('検索用正規化は全角・大小文字・空白の差を消す', () => {
  assert.equal(normalizeText('ＡＢＣ 就労'), normalizeText('abc就労'));
  assert.equal(normalizeText('ヒビノ'), normalizeText('ひびの'));
});

test('法人格を落として法人名の中核を取り出す', () => {
  assert.equal(normalizeCorpName('社会福祉法人あおぞら'), 'あおぞら');
  assert.equal(normalizeCorpName('(福)あおぞら'), 'あおぞら');
  assert.equal(normalizeCorpName('あおぞら株式会社'), 'あおぞら');
  assert.equal(normalizeCorpName('株式会社あおぞら'), 'あおぞら');
});

test('法人格の除去は1回だけ（中核が消えないこと）', () => {
  // 「株式会社」だけの名前が空にならないことは許容するが、二重除去はしない
  assert.equal(normalizeCorpName('医療法人社団みどり会'), 'みどり会');
});

test('都道府県コードを正として住所を分解する', () => {
  const a = splitAddress('北海道札幌市中央区', '南七条西１丁目２−３', '01100');
  assert.equal(a.prefecture, '北海道');
  assert.equal(a.city, '札幌市中央区');
  assert.equal(a.full, '北海道札幌市中央区南七条西１丁目２−３');
});

test('都道府県名の前方一致は最長一致を選ぶ', () => {
  // 「神奈川県」を「奈良県」等と取り違えない
  const a = splitAddress('神奈川県横浜市西区', '1-1', null);
  assert.equal(a.prefecture, '神奈川県');
  assert.equal(a.city, '横浜市西区');
});

test('コードが欠けていても文字列から都道府県を復元する', () => {
  const a = splitAddress('東京都新宿区', '西新宿1-1', null);
  assert.equal(a.prefecture, '東京都');
  assert.equal(a.city, '新宿区');
});

test('47都道府県コードが揃っている', () => {
  assert.equal(Object.keys(PREF_BY_CODE).length, 47);
  assert.equal(PREF_BY_CODE['13'], '東京都');
  assert.equal(PREF_BY_CODE['47'], '沖縄県');
});

test('住所の番地表記ゆれを吸収する', () => {
  assert.equal(
    normalizeAddress('東京都新宿区西新宿一丁目2番3号'),
    normalizeAddress('東京都新宿区西新宿一丁目2-3'),
  );
});

test('電話番号は表示用と比較用を分けて返す', () => {
  const p = normalizePhone('０１１-５３０-５５７１');
  assert.equal(p.display, '011-530-5571');
  assert.equal(p.digits, '0115305571');
});

test('定員は欠損を null にし 0 と区別する', () => {
  assert.equal(parseCapacity(''), null);
  assert.equal(parseCapacity('20'), 20);
  assert.equal(parseCapacity('２０名'), 20);
  assert.equal(parseCapacity('0'), 0);
});

test('日本の範囲外の緯度経度は捨てる', () => {
  assert.deepEqual(parseLatLng('43.05210820', '141.35833820'), { lat: 43.0521082, lng: 141.3583382 });
  assert.deepEqual(parseLatLng('0', '0'), { lat: null, lng: null });
  assert.deepEqual(parseLatLng('', ''), { lat: null, lng: null });
});

test('URL はスキームを補い、不正なものは null にする', () => {
  assert.equal(normalizeUrl('re-ward.co.jp'), 'https://re-ward.co.jp/');
  assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('なし'), null);
});

/* --- 施設同一性キーの設計判断を固定するテスト ---
   実データ（202509→202603）での検証にもとづき、住所を同一性キーに含めない。
   建物名・階数・部屋番号が頻繁に変わり、同一施設が別レコードに分裂するため。 */
test('住所の建物名・階数の違いは施設の同一性を変えない', () => {
  const a = normalizeText('ワークトピアあすか三笠');
  const b = normalizeText('ワークトピアあすか三笠');
  assert.equal(a, b);
  // 同一施設で階数だけ違う住所は、正規化しても一致しない（＝キーに含めてはいけない）
  const x = normalizeAddress('北海道札幌市南区澄川４条２丁目４番１２号澄川８８ビル２階');
  const y = normalizeAddress('北海道札幌市南区澄川４条２丁目４番１２号澄川８８ビル３階');
  assert.notEqual(x, y);
});

test('全角・半角の違いしかない住所は正規化で一致する', () => {
  assert.equal(
    normalizeAddress('北海道三笠市幾春別栗丘町１６番４'),
    normalizeAddress('北海道三笠市幾春別栗丘町16番4'),
  );
});
