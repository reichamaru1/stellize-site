/**
 * 表の定義（1か所にまとめる）
 *
 * 画面・検索・絞り込み・編集のすべてがここを見る。
 * 列を足すときは schema.sql とここの2か所を直す。
 *
 * SQLの識別子（表名・列名）は絶対に画面から受け取った文字列をそのまま使わない。
 * ここに載っているものだけを通す。
 */

const T = (label, opts) => ({ label, ...opts });

/** 型は画面での見せ方と、保存するときの変換に使う */
// text | money | number | date（YYYY-MM-DD）| month（YYYY-MM）| bool

export const TABLES = {
  cashflow: T('入出金明細', {
    order: 'date DESC, id DESC',
    dateCol: 'date',
    search: ['summary', 'category', 'memo', 'method'],
    filters: ['kind', 'category', 'method'],
    columns: [
      { k: 'date', label: '日付', type: 'date', w: 110 },
      { k: 'kind', label: '種別', type: 'text', w: 80 },
      { k: 'category', label: 'カテゴリ', type: 'text', w: 150 },
      { k: 'summary', label: '摘要', type: 'text' },
      { k: 'method', label: '支払方法', type: 'text', w: 120 },
      { k: 'income', label: '収入', type: 'money' },
      { k: 'expense', label: '支出', type: 'money' },
      { k: 'memo', label: 'メモ', type: 'text' },
    ],
  }),

  expenses: T('経費明細', {
    order: 'date DESC, id DESC',
    dateCol: 'date',
    search: ['summary', 'category', 'account', 'memo'],
    filters: ['category', 'account', 'tax_class', 'method'],
    columns: [
      { k: 'date', label: '日付', type: 'date', w: 110 },
      { k: 'category', label: '経費カテゴリ', type: 'text', w: 150 },
      { k: 'summary', label: '摘要', type: 'text' },
      { k: 'amount', label: '金額', type: 'money' },
      { k: 'method', label: '支払方法', type: 'text', w: 120 },
      { k: 'account', label: '勘定科目', type: 'text', w: 130 },
      { k: 'tax_class', label: '税区分', type: 'text', w: 100 },
      { k: 'receipt_no', label: '領収書No', type: 'text', w: 100 },
      { k: 'memo', label: 'メモ', type: 'text' },
    ],
  }),

  contacts: T('人脈台帳', {
    order: 'met_on DESC, id DESC',
    dateCol: 'met_on',
    search: ['company', 'name', 'industry', 'problem', 'next_action', 'memo'],
    filters: ['channel', 'done', 'industry'],
    columns: [
      { k: 'met_on', label: '会った日', type: 'date', w: 110 },
      { k: 'company', label: '会社名', type: 'text' },
      { k: 'name', label: '氏名', type: 'text', w: 120 },
      { k: 'channel', label: '出会い', type: 'text', w: 130 },
      { k: 'industry', label: '業種', type: 'text', w: 120 },
      { k: 'problem', label: 'お困りごと', type: 'text' },
      { k: 'next_action', label: '次のアクション', type: 'text' },
      { k: 'next_step', label: 'ネクストステップ', type: 'text', w: 130 },
      { k: 'done', label: '状況', type: 'text', w: 90 },
      { k: 'good_match', label: '相性の良い会社', type: 'text' },
      { k: 'memo', label: '備考', type: 'text' },
    ],
  }),

  cards: T('名刺', {
    order: 'company, name',
    search: ['company', 'name', 'title', 'email', 'groups', 'wants'],
    filters: ['groups', 'status', 'title'],
    columns: [
      { k: 'company', label: '会社名', type: 'text' },
      { k: 'name', label: '名前', type: 'text', w: 120 },
      { k: 'dept', label: '部署', type: 'text', w: 130 },
      { k: 'title', label: '役職', type: 'text', w: 120 },
      { k: 'email', label: 'メール', type: 'text' },
      { k: 'phone', label: '電話', type: 'text', w: 130 },
      { k: 'mobile', label: '携帯', type: 'text', w: 130 },
      { k: 'zip', label: '郵便番号', type: 'text', w: 90 },
      { k: 'address', label: '住所', type: 'text' },
      { k: 'groups', label: 'グループ', type: 'text' },
      { k: 'wants', label: '求めているもの', type: 'text' },
      { k: 'status', label: '進捗', type: 'text', w: 120 },
      { k: 'memo', label: '備考', type: 'text' },
    ],
  }),

  deals: T('契約一覧', {
    order: 'closed_on DESC, id DESC',
    dateCol: 'closed_on',
    search: ['company', 'person', 'content', 'referrer', 'memo'],
    filters: ['status', 'referrer'],
    columns: [
      { k: 'company', label: '会社名', type: 'text' },
      { k: 'person', label: '担当者', type: 'text', w: 110 },
      { k: 'referrer', label: '紹介者', type: 'text', w: 110 },
      { k: 'status', label: '契約状況', type: 'text', w: 100 },
      { k: 'closed_on', label: '締結日', type: 'date', w: 110 },
      { k: 'amount', label: '受注金額', type: 'money' },
      { k: 'monthly', label: '月額', type: 'money' },
      { k: 'months', label: '期間(月)', type: 'number', w: 80 },
      { k: 'cost', label: '払出金', type: 'money' },
      { k: 'profit_month', label: '見込利益(月)', type: 'money' },
      { k: 'content', label: '契約内容', type: 'text' },
      { k: 'next_offer', label: '今後の提案', type: 'text' },
      { k: 'memo', label: '備考', type: 'text' },
    ],
  }),

  pipeline: T('商談パイプライン', {
    order: 'id DESC',
    dateCol: 'first_met',
    search: ['title', 'company', 'person', 'note', 'lost_reason'],
    filters: ['status', 'broker'],
    columns: [
      { k: 'title', label: '案件名', type: 'text' },
      { k: 'company', label: '企業名', type: 'text' },
      { k: 'person', label: '担当者', type: 'text', w: 110 },
      { k: 'broker', label: '仲介者', type: 'text', w: 110 },
      { k: 'first_met', label: '初回面談', type: 'date', w: 110 },
      { k: 'status', label: '進捗', type: 'text', w: 90 },
      { k: 'quote_once', label: '単発見積', type: 'money' },
      { k: 'quote_month', label: '月額見積', type: 'money' },
      { k: 'due', label: '期限', type: 'text', w: 90 },
      { k: 'closed_on', label: '締結日', type: 'date', w: 110 },
      { k: 'note', label: '備考', type: 'text' },
      { k: 'lost_reason', label: '失注理由', type: 'text' },
    ],
  }),

  partners: T('協業先', {
    order: 'id',
    search: ['company', 'person', 'role', 'strength', 'memo'],
    filters: ['likelihood', 'relationship', 'role'],
    columns: [
      { k: 'company', label: '会社名', type: 'text' },
      { k: 'person', label: '担当者', type: 'text', w: 110 },
      { k: 'title', label: '役職', type: 'text', w: 100 },
      { k: 'likelihood', label: '協力角度', type: 'text', w: 130 },
      { k: 'role', label: '何を任せたい', type: 'text' },
      { k: 'industry', label: '業種', type: 'text', w: 110 },
      { k: 'strength', label: '強い分野', type: 'text' },
      { k: 'relationship', label: '関係値', type: 'text', w: 100 },
      { k: 'memo', label: '備考', type: 'text' },
    ],
  }),

  events: T('交流会', {
    order: 'id',
    search: ['name', 'place', 'note'],
    filters: ['name', 'place'],
    columns: [
      { k: 'held_on', label: '日時', type: 'text', w: 90 },
      { k: 'name', label: '交流会', type: 'text' },
      { k: 'place', label: '場所', type: 'text', w: 110 },
      { k: 'hours', label: '時間', type: 'number', w: 70 },
      { k: 'attendees', label: '人数', type: 'number', w: 70 },
      { k: 'fee', label: '参加費', type: 'money' },
      { k: 'cards_got', label: '名刺', type: 'number', w: 70 },
      { k: 'line_got', label: 'LINE', type: 'number', w: 70 },
      { k: 'appts', label: 'アポ', type: 'number', w: 70 },
      { k: 'closings', label: '成約', type: 'number', w: 70 },
      { k: 'collabs', label: '協業', type: 'number', w: 70 },
      { k: 'referrals', label: '紹介', type: 'number', w: 70 },
      { k: 'note', label: '備考', type: 'text' },
    ],
  }),

  pricing: T('料金表', {
    order: 'id',
    search: ['category', 'item', 'vendor', 'note'],
    filters: ['category', 'unit', 'vendor'],
    columns: [
      { k: 'category', label: '科目', type: 'text', w: 140 },
      { k: 'item', label: '項目', type: 'text' },
      { k: 'unit', label: '単位', type: 'text', w: 80 },
      { k: 'price', label: '単価', type: 'money' },
      { k: 'cost', label: '原価', type: 'money' },
      { k: 'profit', label: '利益', type: 'money' },
      { k: 'vendor', label: '外注先', type: 'text', w: 130 },
      { k: 'note', label: '備考', type: 'text' },
    ],
  }),

  pl_monthly: T('月次損益', {
    order: 'month, section, category, subcategory',
    monthCol: 'month',
    search: ['category', 'subcategory'],
    filters: ['section', 'category', 'is_total'],
    columns: [
      { k: 'month', label: '月', type: 'month', w: 90 },
      { k: 'section', label: '区分', type: 'text', w: 100 },
      { k: 'category', label: '中分類', type: 'text', w: 160 },
      { k: 'subcategory', label: '明細', type: 'text' },
      { k: 'amount', label: '金額', type: 'money' },
      { k: 'is_total', label: '合計行', type: 'bool', w: 80 },
    ],
  }),

  plan_monthly: T('月次の目標・実績', {
    order: 'month, kind, side, category',
    monthCol: 'month',
    search: ['category', 'subcategory'],
    filters: ['kind', 'side', 'category'],
    columns: [
      { k: 'month', label: '月', type: 'month', w: 90 },
      { k: 'kind', label: '区分', type: 'text', w: 80 },
      { k: 'side', label: '売上/支出', type: 'text', w: 90 },
      { k: 'category', label: '項目', type: 'text' },
      { k: 'subcategory', label: '内訳', type: 'text' },
      { k: 'amount', label: '金額', type: 'money' },
    ],
  }),

  kpi: T('週次KPI', {
    order: 'month DESC, section, metric, week',
    monthCol: 'month',
    search: ['metric', 'section'],
    filters: ['month', 'section', 'metric'],
    columns: [
      { k: 'month', label: '月', type: 'month', w: 90 },
      { k: 'week', label: '週', type: 'number', w: 60 },
      { k: 'section', label: '区分', type: 'text', w: 110 },
      { k: 'metric', label: '指標', type: 'text' },
      { k: 'target', label: '目標', type: 'number' },
      { k: 'actual', label: '実績', type: 'number' },
    ],
  }),

  monthly_summary: T('月次収支サマリー', {
    order: 'month',
    monthCol: 'month',
    search: [],
    filters: [],
    columns: [
      { k: 'month', label: '月', type: 'month', w: 90 },
      { k: 'income', label: '収入', type: 'money' },
      { k: 'expense', label: '支出', type: 'money' },
      { k: 'profit', label: '純利益', type: 'money' },
      { k: 'cost_rate', label: '経費率', type: 'number' },
    ],
  }),

  metrics: T('事業パラメータ', {
    order: 'scope, id',
    search: ['scope', 'key', 'value'],
    filters: ['scope'],
    columns: [
      { k: 'scope', label: '区分', type: 'text', w: 130 },
      { k: 'key', label: '項目', type: 'text' },
      { k: 'value', label: '値', type: 'text' },
    ],
  }),

  category_rules: T('カテゴリ判定ルール', {
    order: 'side, subcategory',
    search: ['keyword', 'subcategory'],
    filters: ['side', 'subcategory'],
    columns: [
      { k: 'keyword', label: '代表キーワード', type: 'text' },
      { k: 'side', label: '収入/支出', type: 'text', w: 100 },
      { k: 'subcategory', label: 'サブカテゴリ', type: 'text' },
    ],
  }),

  pdf_log: T('PDF取込ログ', {
    order: 'imported_at DESC',
    search: ['filename', 'bank', 'memo'],
    filters: ['bank'],
    columns: [
      { k: 'imported_at', label: '取込日時', type: 'text', w: 140 },
      { k: 'filename', label: 'ファイル名', type: 'text' },
      { k: 'bank', label: '銀行', type: 'text', w: 120 },
      { k: 'count', label: '件数', type: 'number', w: 70 },
      { k: 'income', label: '収入', type: 'money' },
      { k: 'expense', label: '支出', type: 'money' },
      { k: 'memo', label: 'メモ', type: 'text' },
    ],
  }),
};

/** 画面から来た表名を検証する。ここを通ったものだけSQLに埋めてよい。 */
export function tableOf(name) {
  return Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name] : null;
}

/** 画面から来た列名を検証する。 */
export function columnOf(table, key) {
  return table.columns.find((c) => c.k === key) || null;
}

/** 保存する形に直す。金額は円の整数、空欄は空文字かnull。 */
export function coerce(col, v) {
  if (v == null || v === '') return col.type === 'money' || col.type === 'number' || col.type === 'bool' ? 0 : '';
  switch (col.type) {
    case 'money': {
      const t = String(v).replace(/[¥￥,、\s円]/g, '');
      const n = Number(t);
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
    case 'number': {
      const n = Number(String(v).replace(/[,\s%]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    default: return String(v);
  }
}
