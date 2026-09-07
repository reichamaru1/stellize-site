-- 送付管理データベース（data/outreach.db）
--
-- shuro.db とは別ファイルにしている。shuro.db は取り込みのたびに作り直すため、
-- 送付履歴や停止依頼をそこに置くと消えてしまう。運用データは分けて持つ。

PRAGMA journal_mode = WAL;

-- 送付リスト。どの条件で誰に送るかを1件として管理する。
CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  channel     TEXT NOT NULL,          -- 'post'（郵送） | 'fax' | 'flyer'（チラシ投函）
  filter_json TEXT,                   -- 対象を抽出した検索条件（再現できるように残す）
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(name)
);

-- 送付先。1キャンペーン内で同じ事業所を重複させない。
CREATE TABLE IF NOT EXISTS targets (
  id           INTEGER PRIMARY KEY,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  facility_key TEXT NOT NULL,
  -- 抽出時点の事業所情報を写し取る。shuro.db を作り直しても
  -- 「誰に送ったか」が失われないようにするため。
  office_no    TEXT,
  name         TEXT NOT NULL,
  corp_name    TEXT,
  prefecture   TEXT,
  city         TEXT,
  address      TEXT,
  phone        TEXT,
  fax          TEXT,
  url          TEXT,
  lat          REAL,
  lng          REAL,
  status       TEXT NOT NULL DEFAULT '未着手',  -- 未着手 / 送付済 / 返信あり / 不達 / 対象外
  sent_at      TEXT,
  note         TEXT,
  UNIQUE(campaign_id, facility_key)
);
CREATE INDEX IF NOT EXISTS idx_t_campaign ON targets(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_t_facility ON targets(facility_key);

-- 送付停止。全キャンペーンに横断で効かせる。
-- 一度「送らないでほしい」と言われた相手に再送しないための土台。
CREATE TABLE IF NOT EXISTS suppressions (
  id           INTEGER PRIMARY KEY,
  facility_key TEXT,
  fax          TEXT,        -- 事業所が特定できない場合は番号だけでも止められるように
  phone        TEXT,
  reason       TEXT NOT NULL,
  channel      TEXT,        -- NULL は全チャネル停止
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sup_fac ON suppressions(facility_key);
CREATE INDEX IF NOT EXISTS idx_sup_fax ON suppressions(fax);

-- 操作の記録。誰にいつ何をしたかを後から追えるようにする。
CREATE TABLE IF NOT EXISTS logs (
  id           INTEGER PRIMARY KEY,
  campaign_id  INTEGER,
  facility_key TEXT,
  action       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_campaign ON logs(campaign_id, created_at);
