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

-- 月次の数値。目標・実績・目安を1つの表に持つ（並べて比べるため）。
CREATE TABLE IF NOT EXISTS plan_monthly (
  id          INTEGER PRIMARY KEY,
  month       TEXT NOT NULL,            -- YYYY-MM
  kind        TEXT NOT NULL DEFAULT '目標',  -- 目標 / 実績 / 目安
  side        TEXT NOT NULL,            -- 売上 / 事業経費 / 個人支出 / 指標
  category    TEXT NOT NULL,
  subcategory TEXT,
  amount      INTEGER NOT NULL DEFAULT 0,
  is_total    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(month, kind, side, category, subcategory)
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

-- 月次損益（着金ベース）。年ごとに、売上・売上原価・販管費・利益指標が1枚のP/Lになっている。
-- 売上だけの表ではないので、区分（section）を持たせて混ぜないようにする。
CREATE TABLE IF NOT EXISTS pl_monthly (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT UNIQUE,
  month       TEXT NOT NULL,            -- YYYY-MM
  section     TEXT NOT NULL,            -- 売上 / 売上原価 / 経費 / 指標
  category    TEXT,                     -- 中分類（顧問費用・諸会費 など）
  subcategory TEXT,                     -- 明細（会社名・費目）
  amount      INTEGER NOT NULL DEFAULT 0,
  is_total    INTEGER NOT NULL DEFAULT 0 -- 合計・利益の行。内訳と足して二重に数えないため
);
CREATE INDEX IF NOT EXISTS idx_pl_month ON pl_monthly(month);
CREATE INDEX IF NOT EXISTS idx_pl_sec ON pl_monthly(section);

-- 料金表。単価と原価を持つので、見積の根拠になる。
CREATE TABLE IF NOT EXISTS pricing (
  id         INTEGER PRIMARY KEY,
  source_key TEXT UNIQUE,
  category   TEXT,                      -- 科目
  item       TEXT,                      -- 項目
  unit       TEXT,
  price      INTEGER DEFAULT 0,         -- 単価
  cost       INTEGER DEFAULT 0,         -- 原価
  profit     INTEGER DEFAULT 0,
  vendor     TEXT,                      -- 外注先
  note       TEXT
);

-- 名刺。人脈台帳とは別。あちらは「会った記録」、こちらは「連絡先」。
CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY,
  source_key TEXT UNIQUE,
  company    TEXT,
  name       TEXT,
  dept       TEXT,
  title      TEXT,
  email      TEXT,
  zip        TEXT,
  address    TEXT,
  phone      TEXT,
  fax        TEXT,
  mobile     TEXT,
  groups     TEXT,                      -- 所属する交流会など
  wants      TEXT,                      -- 相手が求めているもの
  status     TEXT,                      -- 進捗状況
  memo       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cd_company ON cards(company);
CREATE INDEX IF NOT EXISTS idx_cd_group ON cards(groups);

-- 交流会の費用対効果。どの会に出るかを決めるための表。
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  source_key   TEXT UNIQUE,
  name         TEXT,
  place        TEXT,
  held_on      TEXT,
  hours        REAL,
  attendees    INTEGER DEFAULT 0,
  fee          INTEGER DEFAULT 0,
  cards_got    INTEGER DEFAULT 0,       -- 名刺交換数
  line_got     INTEGER DEFAULT 0,
  appts        INTEGER DEFAULT 0,       -- アポ取り数
  closings     INTEGER DEFAULT 0,       -- 成約数
  collabs      INTEGER DEFAULT 0,       -- 協業
  referrals    INTEGER DEFAULT 0,       -- 紹介
  cost_per_appt    INTEGER DEFAULT 0,
  cost_per_closing INTEGER DEFAULT 0,
  note         TEXT
);

-- 協業先。誰に何を任せられるか。
CREATE TABLE IF NOT EXISTS partners (
  id           INTEGER PRIMARY KEY,
  source_key   TEXT UNIQUE,
  company      TEXT,
  person       TEXT,
  title        TEXT,
  likelihood   TEXT,                    -- 協力角度
  role         TEXT,                    -- 何を任せたい
  industry     TEXT,
  strength     TEXT,
  relationship TEXT,                    -- 自社との関係値
  memo         TEXT
);

-- 事業のパラメータ（原価・平均単価・顧客数・売上見込など）。
CREATE TABLE IF NOT EXISTS metrics (
  id     INTEGER PRIMARY KEY,
  scope  TEXT NOT NULL,                 -- 企業情報 / 目標売上 / 現状 / 売上見込
  key    TEXT NOT NULL,
  value  TEXT,
  UNIQUE(scope, key)
);

-- 通帳PDFの取込ログ。入出金がどこから来たかを追えるようにする。
CREATE TABLE IF NOT EXISTS pdf_log (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT UNIQUE,
  imported_at TEXT,
  filename    TEXT,
  bank        TEXT,
  count       INTEGER DEFAULT 0,
  income      INTEGER DEFAULT 0,
  expense     INTEGER DEFAULT 0,
  memo        TEXT
);

-- カテゴリの自動判定ルール。摘要のどの言葉でどう分類しているか。
CREATE TABLE IF NOT EXISTS category_rules (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT UNIQUE,
  keyword     TEXT,
  side        TEXT,                     -- 収入 / 支出
  subcategory TEXT
);

-- シート側の「収支管理ダッシュボード」が出している月次サマリー。
-- 自分で計算した値と突き合わせるために、シートの言い分をそのまま持っておく。
CREATE TABLE IF NOT EXISTS monthly_summary (
  id        INTEGER PRIMARY KEY,
  month     TEXT NOT NULL UNIQUE,      -- YYYY-MM
  income    INTEGER NOT NULL DEFAULT 0,
  expense   INTEGER NOT NULL DEFAULT 0,
  profit    INTEGER NOT NULL DEFAULT 0,
  cost_rate REAL
);

-- 経費が「事業のお金」か「個人のお金」か。
-- 名前だけでは決められない（社宅は事業のことも個人のこともある）ので、
-- カテゴリごとに人が決められるようにして、その判断をここに残す。
CREATE TABLE IF NOT EXISTS cost_kinds (
  id       INTEGER PRIMARY KEY,
  category TEXT NOT NULL UNIQUE,
  kind     TEXT NOT NULL DEFAULT '事業',   -- 事業 / 個人
  guessed  INTEGER NOT NULL DEFAULT 1,     -- 1 なら名前からの推測。人が直したら 0
  memo     TEXT
);

-- やること。事業を回すための備忘。
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  detail     TEXT,
  area       TEXT,                          -- 営業 / 制作 / 経理 / 発信 / その他
  priority   TEXT NOT NULL DEFAULT '中',    -- 高 / 中 / 低
  due        TEXT,                          -- YYYY-MM-DD
  status     TEXT NOT NULL DEFAULT '未着手', -- 未着手 / 進行中 / 完了 / 見送り
  linked     TEXT,                          -- 関係する相手・案件
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_td_status ON todos(status, due);

-- 「お金の流れ管理」から取り込んだ実取引。
-- 事業か個人かは、あちらで既に仕分けてある（entity）。
-- こちらで名前から推測するより確かなので、手残りの計算はこれを使う。
CREATE TABLE IF NOT EXISTS mf_tx (
  id         TEXT PRIMARY KEY,          -- 向こうのID。取り込み直しても重複しない
  date       TEXT NOT NULL,
  entity     TEXT NOT NULL,             -- business / personal
  type       TEXT NOT NULL,             -- income / expense
  category   TEXT,
  amount     INTEGER NOT NULL DEFAULT 0,
  memo       TEXT,
  recurring  INTEGER NOT NULL DEFAULT 0,
  src        TEXT,                      -- csv / manual など
  uncertain  INTEGER NOT NULL DEFAULT 0, -- 向こうで自動仕分けの確信が低かったもの
  import_id  TEXT,
  kind       TEXT                        -- この1件だけ区分を変えたいとき。空ならカテゴリの表に従う
);
CREATE INDEX IF NOT EXISTS idx_mf_date ON mf_tx(date);
CREATE INDEX IF NOT EXISTS idx_mf_ent ON mf_tx(entity, type);

-- 取り込み元ファイルの記録。どの時点のデータかを追えるようにする。
CREATE TABLE IF NOT EXISTS mf_imports (
  id    TEXT PRIMARY KEY,
  name  TEXT,
  entity TEXT,
  rows  INTEGER,
  from_date TEXT,
  to_date   TEXT,
  at    TEXT
);

-- ============================================================
-- SNS運用
-- ============================================================

-- アカウント設計。誰に何を届けるかを先に決めて、台本と投稿の判断基準にする。
CREATE TABLE IF NOT EXISTS sns_accounts (
  id          INTEGER PRIMARY KEY,
  platform    TEXT NOT NULL DEFAULT 'Instagram',
  handle      TEXT,                      -- @なしのID
  name        TEXT,                      -- 表示名
  purpose     TEXT,                      -- このアカウントで何を達成するのか
  target      TEXT,                      -- 誰に向けるか
  target_pain TEXT,                      -- その人が困っていること
  concept     TEXT,                      -- 一言でいうと何のアカウントか
  value       TEXT,                      -- 見た人が持ち帰れるもの
  tone        TEXT,                      -- 話し方。上から教えないなど
  pillars     TEXT,                      -- 投稿の柱（3〜5本）
  ng          TEXT,                      -- やらないこと
  cta         TEXT,                      -- 最終的にしてほしい行動
  kpi         TEXT,                      -- 追う指標
  kpi_target  TEXT,
  memo        TEXT,
  edited_at   TEXT
);

-- 投稿。案の段階から公開後の数字まで、1行で通して持つ。
-- 予定と実績を別表にすると、予定が実績に化けるときに転記が要って必ずずれる。
CREATE TABLE IF NOT EXISTS sns_posts (
  id           INTEGER PRIMARY KEY,
  account      TEXT,                     -- sns_accounts.handle
  platform     TEXT NOT NULL DEFAULT 'Instagram',
  status       TEXT NOT NULL DEFAULT '案', -- 案 / 台本 / 予約 / 公開 / 見送り
  planned_on   TEXT,                      -- 出す予定の日 YYYY-MM-DD
  posted_on    TEXT,                      -- 実際に出した日
  format       TEXT,                      -- リール / フィード / カルーセル / ストーリー
  pillar       TEXT,                      -- 投稿の柱
  theme        TEXT,                      -- この投稿のテーマ
  hook         TEXT,                      -- 最初の1行・1秒
  script       TEXT,                      -- 台本
  caption      TEXT,
  hashtags     TEXT,
  url          TEXT,
  reach        INTEGER DEFAULT 0,
  impressions  INTEGER DEFAULT 0,
  views        INTEGER DEFAULT 0,
  likes        INTEGER DEFAULT 0,
  comments     INTEGER DEFAULT 0,
  saves        INTEGER DEFAULT 0,
  shares       INTEGER DEFAULT 0,
  profile_hits INTEGER DEFAULT 0,        -- プロフィールへの遷移
  follows      INTEGER DEFAULT 0,        -- この投稿から増えたフォロワー
  memo         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  edited_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sp_plan ON sns_posts(planned_on);
CREATE INDEX IF NOT EXISTS idx_sp_status ON sns_posts(status);

-- 参考事例。伸びている他社の投稿を、理由まで書いて残す。
-- URLと数字だけ集めても使えない。「なぜ伸びたか」「自社なら何を借りるか」が本体。
CREATE TABLE IF NOT EXISTS sns_refs (
  id         INTEGER PRIMARY KEY,
  platform   TEXT NOT NULL DEFAULT 'Instagram',
  account    TEXT,                       -- 相手のアカウント
  industry   TEXT,                       -- 業種。同業か、参考にする他業種か
  url        TEXT,
  posted_on  TEXT,
  format     TEXT,
  theme      TEXT,
  followers  INTEGER DEFAULT 0,
  views      INTEGER DEFAULT 0,
  likes      INTEGER DEFAULT 0,
  comments   INTEGER DEFAULT 0,
  hook       TEXT,                       -- 最初の1行・1秒に何を置いていたか
  why        TEXT,                       -- なぜ伸びたと考えるか
  borrow     TEXT,                       -- 自社に取り込むならどの要素か
  tried      TEXT,                       -- 試した / まだ
  memo       TEXT,
  edited_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sr_acc ON sns_refs(account);

-- ============================================================
-- 設定（連携キーなど）
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- お金の区分表
--
-- 「お金の流れ管理」の business / personal は、どの口座から出たかで
-- 決まっている。事業口座で払った生活費が経費になり、口座間の移し替えが
-- 収入にも支出にも立つ。カテゴリごとに「何のお金か」をこちらで決める。
-- ============================================================

CREATE TABLE IF NOT EXISTS money_kinds (
  id        INTEGER PRIMARY KEY,
  category  TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL,               -- 売上 / 経費 / 個人 / 振替 / 資金調達
  unsure    INTEGER NOT NULL DEFAULT 0,  -- 自動で当てた（人が見ていない）
  note      TEXT,
  edited_at TEXT
);
