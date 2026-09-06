/**
 * 工賃（賃金）実績・生産活動のソース定義。
 *
 * 工賃は国が事業所別に一括公表しておらず、都道府県ごとに様式も形式も異なる。
 * そのため「1都道府県 = 1エントリ」の宣言的な定義にして、
 * 都道府県を増やすときはここに追記するだけで済むようにしている。
 *
 * URL は年度更新で変わるため、`page` からリンクを再発見できるようにしてある。
 * `url` は確認済みの直リンク（初回はこれを使い、404 なら page から探し直す）。
 */

/** 列名の候補。都道府県ごとに表記が違うので部分一致で拾う。 */
export const WAGE_COLUMNS = {
  officeNo: ['事業所番号', '事業者番号'],
  corp: ['法人名', '法人の名称', '設置主体', '運営法人'],
  facility: ['事業所名', '施設名', '事業所の名称', '事業所名称'],
  city: ['市町村', '所在市町村', '区市町村', '所在地', '圏域'],
  capacity: ['定員'],
  users: ['対象者延人数', '対象延人数', '利用者延人数', '対象者延べ人数'],
  total: ['工賃支払総額', '賃金支払総額', '支払総額'],
  avg: ['工賃平均額', '賃金平均額', '平均工賃', '平均賃金', '工賃月額', '平均工賃月額'],
  // 平均工賃月額の分母。B型の新計算方式は「支払総額 ÷（1日の平均利用者数 × 年間開所月数）」で、
  // A型や旧方式の「支払総額 ÷ 対象者延人数」とは分母が異なる。検証のために両方を拾う。
  dailyAvg: ['１日の平均利用者数', '1日の平均利用者数', '１日の平均', '1日の平均'],
  months: ['年間開所月数'],
};

export const B_TYPE = '就労継続支援Ｂ型';
export const A_TYPE = '就労継続支援Ａ型';
const B = B_TYPE;
const A = A_TYPE;

export const WAGE_SOURCES = [
  {
    prefecture: '千葉県', fiscalYear: 2024, format: 'xlsx',
    page: 'https://www.pref.chiba.lg.jp/shoji/service/shuurou/kouchin/index.html',
    url: 'https://www.pref.chiba.lg.jp/shoji/service/shuurou/kouchin/documents/r6kouchin.xlsx',
    // シート名からサービス種別を決める。該当しないシートは読み飛ばす。
    sheetType: (name) => (/Ａ型|A型/.test(name) ? A : /Ｂ型|B型/.test(name) ? B : null),
  },
  {
    prefecture: '大阪府', fiscalYear: 2024, format: 'xlsx',
    page: 'https://www.pref.osaka.lg.jp/o090060/keikakusuishin/jyusan/kouchinjisseki.html',
    url: 'https://www.pref.osaka.lg.jp/documents/23571/r6kouchinjissekib.xlsx',
    serviceType: B,
  },
  {
    prefecture: '大阪府', fiscalYear: 2024, format: 'xlsx',
    page: 'https://www.pref.osaka.lg.jp/o090060/keikakusuishin/jyusan/kouchinjisseki.html',
    url: 'https://www.pref.osaka.lg.jp/documents/23571/r6kouchinjissekia.xlsx',
    serviceType: A,
  },
  {
    prefecture: '神奈川県', fiscalYear: 2023, format: 'xlsx',
    page: 'https://www.pref.kanagawa.jp/docs/yv4/kouchin2023.html',
    url: 'https://www.pref.kanagawa.jp/documents/112484/r5kouchin-shisetsu.xlsx',
    sheetType: (name) => (/Ａ型|A型/.test(name) ? A : /Ｂ型|B型/.test(name) ? B : null),
  },
  {
    prefecture: '和歌山県', fiscalYear: 2022, format: 'xlsx',
    page: 'https://www.pref.wakayama.lg.jp/prefg/040400/jyusan20/kochinjisseki.html',
    url: 'https://www.pref.wakayama.lg.jp/prefg/040400/jyusan20/kochinjisseki_d/fil/R4koutinitiran.xlsx',
    sheetType: (name) => (/Ａ型|A型/.test(name) ? A : /Ｂ型|B型/.test(name) ? B : null),
  },
  {
    prefecture: '北海道', fiscalYear: 2024, format: 'pdf', serviceType: B,
    page: 'https://www.pref.hokkaido.lg.jp/hf/shf/ko-chin.html',
    url: 'https://www.pref.hokkaido.lg.jp/fs/1/2/9/0/9/0/1/8/_/%E5%B0%B1%E5%8A%B4%E7%B6%99%E7%B6%9A%E6%94%AF%E6%8F%B4B%E5%9E%8B%20%E5%B7%A5%E8%B3%83%E5%AE%9F%E7%B8%BE%E4%B8%80%E8%A6%A7.pdf',
  },
  {
    prefecture: '北海道', fiscalYear: 2024, format: 'pdf', serviceType: A,
    page: 'https://www.pref.hokkaido.lg.jp/hf/shf/ko-chin.html',
    url: 'https://www.pref.hokkaido.lg.jp/fs/1/2/9/0/9/0/1/5/_/%E5%B0%B1%E5%8A%B4%E7%B6%99%E7%B6%9A%E6%94%AF%E6%8F%B4A%E5%9E%8B(%E9%9B%87%E7%94%A8%E5%9E%8B)%E8%B3%83%E9%87%91%E5%AE%9F%E7%B8%BE%E4%B8%80%E8%A6%A7.pdf',
  },
  {
    prefecture: '新潟県', fiscalYear: 2024, format: 'xlsx',
    page: 'https://www.pref.niigata.lg.jp/sec/shougaifukushi/1281038535306.html',
    url: 'https://www.pref.niigata.lg.jp/uploaded/attachment/461324.xlsx',
    sheetType: (name) => (/Ａ型|A型/.test(name) ? A : /Ｂ型|B型/.test(name) ? B : null),
  },
  {
    prefecture: '岡山県', fiscalYear: 2024, format: 'xlsx',
    page: 'https://www.pref.okayama.jp/page/detail-15576.html',
    url: 'https://www.pref.okayama.jp/uploaded/life/945343_9685839_misc.xlsx',
    // 1シートに A型・B型 を節見出しで並べる様式
    sectioned: true,
    sheetType: (name) => (/事業所別/.test(name) ? null : null),
  },
  {
    prefecture: '愛知県', fiscalYear: 2024, format: 'pdf', serviceType: B,
    page: 'https://www.pref.aichi.jp/soshiki/shogai/kouchin-jisseki.html',
    url: 'https://www.pref.aichi.jp/uploaded/attachment/585578.pdf',
  },
  {
    prefecture: '愛知県', fiscalYear: 2024, format: 'pdf', serviceType: A,
    page: 'https://www.pref.aichi.jp/soshiki/shogai/kouchin-jisseki.html',
    url: 'https://www.pref.aichi.jp/uploaded/attachment/585576.pdf',
  },
  {
    prefecture: '奈良県', fiscalYear: 2024, format: 'pdf', serviceType: B,
    page: 'https://www.pref.nara.jp/11907.htm',
    url: 'https://www.pref.nara.jp/secure/210805/R6_B.pdf',
  },
  {
    prefecture: '静岡県', fiscalYear: 2024, format: 'pdf',
    page: 'https://www.pref.shizuoka.jp/sangyoshigoto/shuroshien/shuroshien/1040127/1002999/1023636.html',
    url: 'https://www.pref.shizuoka.jp/_res/projects/default_project/_page_/001/023/636/r6koutinjisseki.pdf',
  },
  {
    prefecture: '福岡県', fiscalYear: 2018, format: 'pdf', serviceType: B,
    page: 'https://www.pref.fukuoka.lg.jp/contents/shogaishisetsukouchin.html',
    url: 'https://www.pref.fukuoka.lg.jp/uploaded/attachment/113955.pdf',
  },
  {
    prefecture: '福岡県', fiscalYear: 2018, format: 'pdf', serviceType: A,
    page: 'https://www.pref.fukuoka.lg.jp/contents/shogaishisetsukouchin.html',
    url: 'https://www.pref.fukuoka.lg.jp/uploaded/attachment/108905.pdf',
  },
];

/**
 * 生産活動のソース。
 * 全国一括の公開データは存在しない。現状は東京都の
 * 「障害者福祉施設が提供できる物品・役務の情報リスト」のみが
 * 事業所別・分類付きで機械可読な形で公開されている。
 */
export const ACTIVITY_SOURCES = [
  {
    prefecture: '東京都', format: 'xlsx', name: '物品・役務の情報リスト（全分類）',
    page: 'https://www.fukushi.metro.tokyo.lg.jp/shougai//shougai_shisaku/sokusin/buppin_ekimulist.html',
    url: 'https://www.fukushi.metro.tokyo.lg.jp/documents/d/fukushi/10_buppinkaiireekimuteikyou_zentai',
    columns: {
      facility: ['事業所名称', '事業所名', '施設名'],
      corp: ['法人名'],
      city: ['区市町村名', '市町村'],
      address: ['所在地'],
      category: ['分類'],
      detail: ['製品・サービスの内容', '内容'],
      url: ['ホームページ'],
    },
  },
];

/** 生産活動の分類。東京都のリストの分類をそのまま全国共通の語彙として使う。 */
export const ACTIVITY_CATEGORIES = [
  '食品', '生活用品', '事務用品', '印刷', '封入・封緘',
  '箱・袋詰', '清掃', 'データ入力', '農業', 'その他',
];
