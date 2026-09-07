import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createCampaign, isSuppressed, addSuppression, markStatus, getCampaign } from '../src/outreach/store.mjs';
import { buildFlyerRoute, summarizeRoute, renderTemplate, distanceKm } from '../src/outreach/output.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../src/outreach/schema.sql', import.meta.url), 'utf8').replace(/PRAGMA journal_mode = WAL;/, ''));
  return db;
}

const FACS = [
  { facility_key: 'a', office_no: '1', name: 'あお', corp_name: '法人A', prefecture: '愛知県', city: '刈谷市', address_full: '愛知県刈谷市1-1', phone: '0566-1', fax: '0566-2', url: null, lat: 34.99, lng: 137.00 },
  { facility_key: 'b', office_no: '2', name: 'いお', corp_name: '法人B', prefecture: '愛知県', city: '刈谷市', address_full: '愛知県刈谷市2-2', phone: '0566-3', fax: null, url: null, lat: 34.98, lng: 137.01 },
  // a と同じ住所。郵送・投函では1件にまとめたい
  { facility_key: 'c', office_no: '3', name: 'うお', corp_name: '法人C', prefecture: '愛知県', city: '刈谷市', address_full: '愛知県刈谷市1-1', phone: '0566-5', fax: '0566-6', url: null, lat: 34.99, lng: 137.00 },
];

test('郵送は同じ住所への重複を1件にまとめる', () => {
  const db = freshDb();
  const r = createCampaign(db, { name: 'p', channel: 'post' }, FACS);
  assert.equal(r.added, 2);
  assert.equal(r.skipped['同一住所の重複'], 1);
});

test('FAXは番号のない先を除外し、同一住所でも別々に残す', () => {
  const db = freshDb();
  const r = createCampaign(db, { name: 'f', channel: 'fax' }, FACS);
  assert.equal(r.added, 2, 'FAX番号のある a と c');
  assert.equal(r.skipped['連絡先なし'], 1, 'FAX番号のない b');
  assert.equal(r.skipped['同一住所の重複'], 0, 'FAXは住所で束ねない');
});

test('送付停止に登録した先は以後のリストに入らない', () => {
  const db = freshDb();
  addSuppression(db, { facilityKey: 'a', reason: '先方より不要の申し出' });
  const r = createCampaign(db, { name: 'p2', channel: 'post' }, FACS);
  assert.equal(r.skipped['停止依頼'], 1);
  assert.ok(!r.added || getCampaign(db, r.id).targets.every((t) => t.facility_key !== 'a'));
});

test('FAX番号だけでも送付停止できる（事業所が特定できない問い合わせ用）', () => {
  const db = freshDb();
  addSuppression(db, { fax: '0566-2', reason: '番号のみの申し出' });
  assert.equal(isSuppressed(db, FACS[0], 'fax'), true);
  assert.equal(isSuppressed(db, FACS[1], 'fax'), false);
});

test('停止登録は作成済みリストの未着手分も対象外にする', () => {
  const db = freshDb();
  const r = createCampaign(db, { name: 'p3', channel: 'post' }, FACS);
  addSuppression(db, { facilityKey: 'a', reason: '申し出' });
  const t = getCampaign(db, r.id).targets.find((x) => x.facility_key === 'a');
  assert.equal(t.status, '対象外');
});

test('送付済みにすると日時が記録される', () => {
  const db = freshDb();
  const r = createCampaign(db, { name: 'p4', channel: 'post' }, FACS);
  const n = markStatus(db, { campaignId: r.id, facilityKeys: ['a'], status: '送付済' });
  assert.equal(n, 1);
  const t = getCampaign(db, r.id).targets.find((x) => x.facility_key === 'a');
  assert.equal(t.status, '送付済');
  assert.ok(t.sent_at, '送付日時が入る');
});

test('同じ名前の送付リストは作れない', () => {
  const db = freshDb();
  createCampaign(db, { name: 'dup', channel: 'post' }, FACS);
  assert.throws(() => createCampaign(db, { name: 'dup', channel: 'post' }, FACS), /すでにあります/);
});

test('投函ルートは市区町村ごとに近い順で並ぶ', () => {
  const targets = FACS.map((f) => ({ ...f, address: f.address_full, status: '未着手' }));
  const csv = buildFlyerRoute({ channel: 'flyer' }, targets);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length - 1, 3);
  assert.match(lines[1], /起点/);
});

test('ルートの総距離を要約できる', () => {
  const s = summarizeRoute(FACS);
  assert.equal(s.length, 1);
  assert.equal(s[0].area, '愛知県刈谷市');
  assert.equal(s[0].count, 3);
  assert.ok(s[0].distanceKm >= 0);
});

test('座標のない先もルートから落とさない', () => {
  const targets = [...FACS, { facility_key: 'z', name: 'えお', prefecture: '愛知県', city: '刈谷市', address: '不明', lat: null, lng: null, status: '未着手' }]
    .map((f) => ({ ...f, address: f.address ?? f.address_full, status: '未着手' }));
  const csv = buildFlyerRoute({ channel: 'flyer' }, targets);
  assert.match(csv, /座標なし/);
  assert.equal(csv.split('\r\n').filter(Boolean).length - 1, 4);
});

test('差し込みは値のない項目をそのまま残す（空欄で気付けなくならないように）', () => {
  const t = { name: 'あお', corp_name: null, city: '刈谷市' };
  const out = renderTemplate('{{法人名}}／{{事業所名}}／{{市区町村}}', t);
  assert.equal(out, '{{法人名}}／あお／刈谷市');
});

test('距離計算が妥当（東京駅と横浜駅は約27km）', () => {
  const d = distanceKm(35.6812, 139.7671, 35.4657, 139.6223);
  assert.ok(d > 24 && d < 30, `実際: ${d}`);
});
