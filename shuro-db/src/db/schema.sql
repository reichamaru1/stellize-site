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

-- 施設。同一性は 事業所番号 + 正規化名称。
-- 事業所番号は一意ではない（同一番号で別名称の事業所が実在する）ため名称を併用する。
-- 住所はキーに含めない：建物名・階数・部屋番号が頻繁に変わり、同一施設が分裂するため。
CREATE TABLE IF NOT EXISTS facilities (
  id              INTEGER PRIMARY KEY,
  facility_key    TEXT NOT NULL UNIQUE,
  office_no       TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_norm       TEXT NOT NULL,      -- 名寄せ・候補提示用の正規化名称
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

-- 名寄せ候補。自動統合はせず、人が判断できるように候補として残す。
-- （事業所番号の変更などで同一施設が別レコードになった疑いのあるもの）
CREATE TABLE IF NOT EXISTS merge_candidates (
  id           INTEGER PRIMARY KEY,
  closed_key   TEXT NOT NULL,
  active_key   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  UNIQUE(closed_key, active_key)
);
CREATE INDEX IF NOT EXISTS idx_mc_closed ON merge_candidates(closed_key);
CREATE INDEX IF NOT EXISTS idx_mc_active ON merge_candidates(active_key);

-- 取り込み時の品質指標。管理画面で欠損を可視化する。
CREATE TABLE IF NOT EXISTS quality_metrics (
  period   TEXT NOT NULL,
  metric   TEXT NOT NULL,
  value    REAL NOT NULL,
  detail   TEXT,
  PRIMARY KEY (period, metric)
);

-- ============================================================
-- 工賃（賃金）実績
-- 国は事業所別に一括公表しておらず、都道府県ごとに様式が異なる。
-- 事業所番号を持たないソースが多いため、突合方法と確度を必ず記録する。
-- ============================================================
CREATE TABLE IF NOT EXISTS wages (
  id            INTEGER PRIMARY KEY,
  facility_key  TEXT REFERENCES facilities(facility_key),  -- 突合できなければ NULL
  prefecture    TEXT NOT NULL,
  fiscal_year   INTEGER NOT NULL,
  service_type  TEXT NOT NULL,
  facility_name TEXT NOT NULL,      -- ソース側の表記（原文）
  corp_name     TEXT,
  corp_no       TEXT,
  office_no     TEXT,
  city          TEXT,
  capacity      INTEGER,
  users         INTEGER,            -- 対象者・利用者延人数
  total_paid    INTEGER,            -- 工賃支払総額（年額）
  avg_monthly   INTEGER NOT NULL,   -- 平均工賃月額
  match_method  TEXT,               -- office_no | corp_no+name | pref+name | pref+city+name | unmatched
  source_url    TEXT NOT NULL,
  source_page   TEXT
);
CREATE INDEX IF NOT EXISTS idx_wage_fac  ON wages(facility_key);
CREATE INDEX IF NOT EXISTS idx_wage_pref ON wages(prefecture, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_wage_avg  ON wages(avg_monthly);

-- ============================================================
-- 生産活動
-- 出所は published（公表データ由来）のみ。推測では入れない。
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY,
  facility_key  TEXT REFERENCES facilities(facility_key),
  prefecture    TEXT NOT NULL,
  facility_name TEXT NOT NULL,
  category      TEXT NOT NULL,      -- 統一分類
  raw_label     TEXT NOT NULL,      -- ソース側の原表記
  detail        TEXT,               -- 製品・サービスの内容（東京都のみ）
  origin        TEXT NOT NULL,      -- 'published'
  match_method  TEXT,
  source_name   TEXT,
  source_url    TEXT NOT NULL,
  source_page   TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_fac  ON activities(facility_key);
CREATE INDEX IF NOT EXISTS idx_act_cat  ON activities(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_act_uniq ON activities(facility_key, category, source_url)
  WHERE facility_key IS NOT NULL;

-- 取り込んだ工賃・生産活動ソースの記録（どの県のいつのデータが入っているか）
CREATE TABLE IF NOT EXISTS extra_sources (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,        -- 'wage' | 'activity'
  prefecture  TEXT NOT NULL,
  fiscal_year INTEGER,
  service_type TEXT,
  format      TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  matched     INTEGER NOT NULL,
  source_url  TEXT NOT NULL,
  source_page TEXT,
  note        TEXT
);
