/**
 * Stellize メルマガ配信ツール — 設定
 *
 * 実際の値はスプレッドシートの「設定」シートに置く。
 * ここにあるのは、シートが空のときに使われる初期値と、
 * コードから参照するためのキー名の定義。
 *
 * 設定を変えたいときはシートを直す。ここは触らなくてよい。
 */

/** シート名。日本語のままにしているのは、非エンジニアが直接触るため。 */
const SHEETS = {
  settings:    '設定',
  subscribers: '購読者',
  drafts:      '原稿',
  queue:       '送信キュー',
  log:         '配信ログ',
  suppress:    '配信停止',
};

/**
 * 設定シートの既定値。
 * 「必須」が true のものは、送信前チェックで空だと止める。
 * 特定電子メール法で表示が必要な項目（名称・住所・受信拒否の通知先）が
 * 空のまま送られるのを防ぐため。
 */
const SETTING_DEFS = [
  { key: '差出人名',        def: 'Stellize合同会社',                                        required: true,  help: 'メールの送信者名として表示されます' },
  { key: '返信先',          def: 'rei.stella1127@gmail.com',                                required: true,  help: '受信者が「返信」したときの宛先' },
  { key: '会社名',          def: 'Stellize合同会社',                                        required: true,  help: 'フッターに表示（特定電子メール法で必須）' },
  { key: '住所',            def: '〒236-0021 神奈川県横浜市金沢区寺前2-25-35 クレアT105',    required: true,  help: 'フッターに表示（特定電子メール法で必須）' },
  { key: 'サイトURL',       def: 'https://stellize-site.netlify.app/',                      required: true,  help: '独自ドメインを取ったら差し替える' },
  { key: 'ロゴURL',         def: 'https://stellize-site.netlify.app/assets/images/logo-header.png', required: true, help: 'メール上部のロゴ画像（絶対URL）' },
  { key: 'お問い合わせURL', def: 'https://stellize-site.netlify.app/contact.html',          required: true,  help: '苦情・問い合わせの受付先（法令で必須）' },
  { key: 'プライバシーURL', def: 'https://stellize-site.netlify.app/privacy.html',          required: false, help: 'フッターのリンク先' },
  { key: 'WebアプリURL',    def: '',                                                        required: true,  help: 'デプロイ後の https://script.google.com/macros/s/～/exec を貼る。配信停止リンクに使う' },
  { key: '1日の送信上限',   def: '400',                                                     required: true,  help: 'Gmailの上限は無料100通／Workspace1500通。安全側で少なめに' },
  { key: '予備に残す通数',  def: '30',                                                      required: true,  help: 'お問い合わせフォームの自動返信用に残す枠。ここを割ると送信を止める' },
  { key: '1通ごとの間隔ミリ秒', def: '900',                                                 required: false, help: '連続送信の間隔。詰めすぎると迷惑メール判定されやすい' },
  { key: 'UTM自動付与',     def: 'on',                                                      required: false, help: '本文中のサイトへのリンクに utm パラメータを足し、GA4で流入を見られるようにする' },
  { key: '既定の許諾文',    def: 'このメールは、貴事業所が公式サイト等で公開されているメールアドレス宛に、事業のご案内としてお送りしています。', required: true, help: 'フッターに出る「なぜ届いたか」の説明' },
];

/** 設定シートを読んで連想配列にする。呼び出しごとにキャッシュする。 */
let _cfgCache = null;
function cfg() {
  if (_cfgCache) return _cfgCache;
  const sh = sheet(SHEETS.settings);
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  const map = {};
  SETTING_DEFS.forEach(function (d) { map[d.key] = d.def; });
  rows.forEach(function (r) {
    const k = String(r[0]).trim();
    if (k && String(r[1]).trim() !== '') map[k] = String(r[1]).trim();
  });
  _cfgCache = map;
  return map;
}

/** 数値の設定を読む。 */
function cfgNum(key) {
  const n = Number(String(cfg()[key]).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}

/** on/off の設定を読む。 */
function cfgOn(key) {
  return /^(on|true|1|はい|有効)$/i.test(String(cfg()[key]).trim());
}

/**
 * 配信停止リンクの署名に使う秘密鍵。
 * 初回に自動生成してスクリプトプロパティに保存する。
 * これが無いと、URLのメールアドレスを書き換えて他人を勝手に停止できてしまう。
 */
function secretKey() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('UNSUB_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('UNSUB_SECRET', s);
  }
  return s;
}

/** メールアドレスから配信停止用の署名を作る。 */
function signEmail(email) {
  const raw = Utilities.computeHmacSha256Signature(String(email).toLowerCase().trim(), secretKey());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '').slice(0, 22);
}

/** 署名が正しいか確かめる。 */
function verifyEmail(email, sig) {
  return !!email && !!sig && signEmail(email) === String(sig);
}
