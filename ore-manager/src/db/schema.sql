-- 俺の事業を管理せよ — データ定義
--
-- 方針
--   ・事業管理シートから取り込むが、以後の正はこちら側に置く
--   ・取り込みは何度やっても同じ結果になる（source_key で上書き）
--   ・金額は円の整数で持つ。小数は使わない（消費税の丸めで必ず事故る）
--   ・日付は 'YYYY-MM-DD' の文字列。SQLiteに日付型は無い

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- お金
-- ============================================================

-- 入出金明細。通帳の動きをそのまま持つ。
CREATE TABLE IF NOT EXISTS cashflow (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT UNIQUE,              -- 取り込み元の行を指す。再取り込みで重複させないため
  date        TEXT NOT NULL,            -- YYYY-MM-DD
  kind        TEXT NOT NULL,            -- 収入 / 支出
  category    TEXT,
  income      INTEGER NOT NULL DEFAULT 0,
  expense     INTEGER NOT NULL DEFAULT 0,
  method      TEXT,                     -- 支払方法
  summary     TEXT,                     -- 摘要
  memo        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cf_date ON cashflow(date);
CREATE INDEX IF NOT EXISTS idx_cf_cat  ON cashflow(category);

-- 経費明細。勘定科目と税区分を持つので、入出金とは別に持つ。
-- （確定申告のときに必要な粒度が違うため、1つの表にまとめない）
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT UNIQUE,
  date        TEXT NOT NULL,
  category    TEXT,                     -- 経費カテゴリ
  summary     TEXT,
  amount      INTEGER NOT NULL DEFAULT 0,
  method      TEXT,
  account     TEXT,                     -- 勘定科目
  tax_class   TEXT,                     -- 税区分
  receipt_no  TEXT,
  memo        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ex_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_ex_cat  ON expenses(category);

-- 月次の収支計画。実績と並べるために持つ。
CREATE TABLE IF NOT EXISTS plan_monthly (
  id          INTEGER PRIMARY KEY,
  month       TEXT NOT NULL,            -- YYYY-MM
  side        TEXT NOT NULL,            -- 売上 / 支出
  category    TEXT NOT NULL,
  subcategory TEXT,
  amount      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(month, side, category, subcategory)
);

-- ============================================================
-- 顧客・案件
-- ============================================================

-- 人脈台帳。会った人を残す。ここから案件が生まれる。
CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY,
  source_key   TEXT UNIQUE,
  met_on       TEXT,                    -- 会った日
  company      TEXT,
  name         TEXT,
  channel      TEXT,                    -- 出会い（ビジネスマッチング等）
  framing      TEXT,                    -- 立て付け
  industry     TEXT,
  strength     TEXT,                    -- 相手の強み
  problem      TEXT,                    -- お困りごと
  next_action  TEXT,
  next_step    TEXT,
  done         TEXT,                    -- 完了有無
  good_match   TEXT,                    -- 相性の良い会社
  memo         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ct_company ON contacts(company);
CREATE INDEX IF NOT EXISTS idx_ct_met ON contacts(met_on);

-- 案件・契約。金額と状況を追う。
CREATE TABLE IF NOT EXISTS deals (
  id            INTEGER PRIMARY KEY,
  source_key    TEXT UNIQUE,
  company       TEXT,
  person        TEXT,                   -- 担当者
  referrer      TEXT,                   -- 紹介者
  status        TEXT,                   -- 契約状況
  offer_monthly INTEGER DEFAULT 0,      -- 月額オファー
  closed_on     TEXT,                   -- 締結日
  amount        INTEGER DEFAULT 0,      -- 受注金額
  monthly       INTEGER DEFAULT 0,      -- 月額金額
  months        INTEGER,                -- 期間
  cost          INTEGER DEFAULT 0,      -- 払出金
  content       TEXT,                   -- 契約内容
  next_offer    TEXT,                   -- 今後提案予定
  profit_month  INTEGER DEFAULT 0,      -- 見込利益(月間)
  memo          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_dl_status ON deals(status);

-- 商談パイプライン。契約前の動きを追う。
-- deals（契約一覧）とは別に持つ。見ている項目が違い、
-- 失注したものも残す必要があるため。
CREATE TABLE IF NOT EXISTS pipeline (
  id           INTEGER PRIMARY KEY,
  source_key   TEXT UNIQUE,
  title        TEXT,                    -- 案件名
  company      TEXT,
  person       TEXT,
  broker       TEXT,                    -- 仲介者
  first_met    TEXT,                    -- 初回面談
  status       TEXT,                    -- 進捗（契約 / 失注 / 保留 …）
  quote_once   INTEGER DEFAULT 0,       -- 単発見積
  quote_month  INTEGER DEFAULT 0,       -- 月額見積
  due          TEXT,                    -- 期限
  closed_on    TEXT,                    -- 契約締結日
  note         TEXT,
  lost_reason  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pl_status ON pipeline(status);

-- ============================================================
-- KPI
-- ============================================================

-- 週次の目標と結果。指標名は自由文字列にする（増えるため）。
CREATE TABLE IF NOT EXISTS kpi (
  id        INTEGER PRIMARY KEY,
  month     TEXT NOT NULL,              -- YYYY-MM
  week      INTEGER NOT NULL,           -- 1..5
  section   TEXT NOT NULL,              -- アポ取り / 営業 / GB
  metric    TEXT NOT NULL,
  target    REAL,
  actual    REAL,
  UNIQUE(month, week, section, metric)
);

-- ============================================================
-- 設定（連携キーなど）
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
