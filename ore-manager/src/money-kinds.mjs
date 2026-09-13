/**
 * お金の「区分」表
 *
 * 「お金の流れ管理」は、取引がどの口座から出たかで business / personal を付けている。
 * 事業用のPayPay銀行から出た生活費が「事業の経費」になり、口座間の移し替えが
 * 「事業の収入」と「事業の支出」の両方に立つ。これでは損益が読めない。
 *
 * そこで、カテゴリごとに「それは何のお金か」を決める表をこちらに持つ。
 *   売上     … 事業で稼いだお金
 *   経費     … 事業のために出ていったお金
 *   個人     … 生活のお金。事業の損益には入れない
 *   振替     … 自分のお金の移し替え。収入でも支出でもないので、どこにも入れない
 *   資金調達 … 借入・ファクタリング・その返済。損益ではなく資金繰りの話
 *
 * この表は画面から直せる。直した行は edited_at が入り、取り込み直しても戻らない。
 * 1件ずつ変えたいときは、取引明細の「区分」を埋めるとそちらが優先される。
 */

export const KINDS = ['売上', '経費', '個人', '振替', '資金調達'];

/** 取り込み時点で分かっているカテゴリの初期値 */
export const DEFAULT_KINDS = {
  // ── 自分のお金の移し替え。ここを収支に入れると二重に数える ──
  'チャージ・口座間振替': '振替',
  '現金引き出し': '振替',
  '個人間送金': '振替',
  '貯蓄・投資': '振替',

  // ── 資金繰り。損益ではない ──
  'ファクタリング入金': '資金調達',
  'ファクタリング': '資金調達',
  '借入返済・債務整理': '資金調達',

  // ── 事業で稼いだお金 ──
  'セミナー・研修講師料': '売上',
  'その他収入': '売上',
  '返金・キャンセル': '売上',
  '配当・利子・投資収益': '売上',

  // ── 事業のために出ていったお金 ──
  '決済・振込手数料': '経費',
  '会費': '経費',
  '通信費（携帯・ネット）': '経費',
  '交際費・会食': '経費',
  '宿泊費': '経費',
  '学び・教育': '経費',
  'コンサル・顧問料': '経費',
  '講座制作費（教材・コンテンツ）': '経費',
  'ツール・サブスク（AI・生成系）': '経費',
  'ツール・サブスク（会計・業務管理）': '経費',
  'ツール・サブスク（SNS運用・分析）': '経費',
  '保険料': '経費',

  // ── 生活のお金 ──
  'その他生活費': '個人',
  '食費': '個人',
  '交通費': '個人',
  '日用品・雑貨': '個人',
  '家賃・住宅ローン': '個人',
  '電気・ガス・水道': '個人',
  '美容・理容': '個人',
  '医療・健康': '個人',
  '交際費・娯楽': '個人',
  'ポイント・還元': '個人',
};

/**
 * まだ表に無いカテゴリを足す。既にある行は触らない（直した内容を消さないため）。
 * 初期値が決まっていないものは、向こうの business / personal から当てて
 * 「要確認」を立てる。放っておいても数字は出るが、画面で気づけるようにする。
 */
export function seedMoneyKinds(db) {
  const known = new Set(db.prepare('SELECT category FROM money_kinds').all().map((r) => r.category));
  const add = db.prepare(`INSERT INTO money_kinds (category, kind, unsure) VALUES (?,?,?)
    ON CONFLICT(category) DO NOTHING`);   // 直した行を消さない
  const seen = db.prepare(`SELECT category,
      SUM(CASE WHEN entity='business' THEN 1 ELSE 0 END) b, COUNT(*) n
    FROM mf_tx WHERE category <> '' GROUP BY 1`).all();
  let added = 0;
  for (const r of seen) {
    if (known.has(r.category)) continue;
    const fixed = DEFAULT_KINDS[r.category];
    add.run(r.category, fixed || (r.b > r.n / 2 ? '経費' : '個人'), fixed ? 0 : 1);
    added++;
  }
  return added;
}

/**
 * SQL の中で「この取引の区分」を表す式。
 * 取引ごとの上書き（mf_tx.kind）があればそれ、無ければカテゴリの表を見る。
 */
export const KIND_EXPR = `COALESCE(NULLIF(t.kind,''), k.kind, '個人')`;
export const KIND_JOIN = `FROM mf_tx t LEFT JOIN money_kinds k ON k.category = t.category`;
