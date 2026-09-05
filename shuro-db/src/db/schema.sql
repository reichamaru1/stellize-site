-- 全国就労支援事業所データベース
-- 出典: WAM NET 障害福祉サービス等情報公表システム オープンデータ
-- 年2回（3月末・9月末）のスナップショットを積み上げる構造。

PRAGMA journal_mode = WAL;

-- 取り込んだスナップショット。全レコードはこれを参照して鮮度を示す。
CREATE TABLE IF NOT EXISTS snapshots (
  period       TEXT PRIMARY KEY,      -- 'YYYYMM'（データ基準月）
  label        TEXT NOT NULL,         -- '2026年3月末時点'
  source_url   TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  record_count INTEGER NOT NULL
);

-- 施設。同一性は 事業所番号 + 正規化名称 + 正規化住所。
-- （事業所番号は一意ではない。同一番号で別名称・別住所の事業所が実在する）
CREATE TABLE IF NOT EXISTS facilities (
  id              INTEGER PRIMARY KEY,
  facility_key    TEXT NOT NULL UNIQUE,
  office_no       TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_kana       TEXT,
  corp_name       TEXT,
  corp_kana       TEXT,
  corp_no         TEXT,
  corp_url        TEXT,
  designator      TEXT,               -- 指定機関名
  pref_code       TEXT NOT NULL,
  prefecture      TEXT NOT NULL,
  city            TEXT NOT NULL,
  address_detail  TEXT,
  address_full    TEXT NOT NULL,
  phone           TEXT,
  fax             TEXT,
  url             TEXT,
  lat             REAL,
  lng             REAL,
  search_text     TEXT NOT NULL,      -- 正規化済み検索用（名称/かな/法人/住所/番号を連結）
  first_seen      TEXT NOT NULL,      -- 初出スナップショット period
  last_seen       TEXT NOT NULL,      -- 最終確認スナップショット period
  status          TEXT NOT NULL       -- 'active' | 'presumed_closed'
);

CREATE INDEX IF NOT EXISTS idx_fac_pref    ON facilities(pref_code);
CREATE INDEX IF NOT EXISTS idx_fac_city    ON facilities(prefecture, city);
CREATE INDEX IF NOT EXISTS idx_fac_status  ON facilities(status);
CREATE INDEX IF NOT EXISTS idx_fac_office  ON facilities(office_no);
CREATE INDEX IF NOT EXISTS idx_fac_geo     ON facilities(lat, lng);

-- 施設が提供するサービス。1施設が複数種別を持つのが普通。
CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY,
  facility_key  TEXT NOT NULL REFERENCES facilities(facility_key),
  service_type  TEXT NOT NULL,
  source_no     TEXT NOT NULL,        -- CSV の NO（期内で一意）
  capacity      INTEGER,
  hours_weekday TEXT,
  hours_sat     TEXT,
  hours_sun     TEXT,
  hours_holiday TEXT,
  closed_days   TEXT,
  hours_note    TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  status        TEXT NOT NULL,
  UNIQUE(facility_key, service_type)
);

CREATE INDEX IF NOT EXISTS idx_svc_type ON services(service_type);
CREATE INDEX IF NOT EXISTS idx_svc_fac  ON services(facility_key);

-- スナップショット間の差分。新規・消失を人が確認できるように残す。
CREATE TABLE IF NOT EXISTS changes (
  id           INTEGER PRIMARY KEY,
  period       TEXT NOT NULL,
  facility_key TEXT NOT NULL,
  service_type TEXT,
  change       TEXT NOT NULL,         -- 'added' | 'disappeared'
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_chg_period ON changes(period, change);

-- 取り込み時の品質指標。管理画面で欠損を可視化する。
CREATE TABLE IF NOT EXISTS quality_metrics (
  period   TEXT NOT NULL,
  metric   TEXT NOT NULL,
  value    REAL NOT NULL,
  detail   TEXT,
  PRIMARY KEY (period, metric)
);
