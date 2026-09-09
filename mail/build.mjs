/**
 * mail/ の素材から、GAS側で使うファイルとプレビューHTMLを生成する。
 *
 *   node mail/build.mjs
 *
 * 生成物（いずれも手で編集しない。直すのは mail/ 側）:
 *   gas/newsletter/Templates.gs  ← base.html / blocks.html / themes.json
 *   gas/newsletter/Render.gs     ← mail/render.js
 *   mail/preview/*.html          ← mail/samples/*.txt をレンダリングした確認用
 *
 * テンプレートの実体を1か所に保つための仕組み。GAS側を直接いじると
 * 次回のビルドで上書きされる。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GAS = join(ROOT, 'gas', 'newsletter');

const read = (p) => readFileSync(join(HERE, p), 'utf8');
// 骨格は用途ごとに分かれている。themes.json の "base" がどれを使うかを指す
const bases = {
  default: read('templates/base.html'),
  daily: read('templates/base-daily.html'),
};
const blocks = read('templates/blocks.html');
const themes = JSON.parse(read('templates/themes.json'));
const renderSrc = read('render.js');
const voiceSrc = read('voice.js');

/* ---------- 1. Templates.gs ---------- */

/** 複数行の文字列を、GASエディタで読める配列リテラルにする */
const asGasString = (s) =>
  s.split('\n').map((l) => JSON.stringify(l)).join(',\n  ') || '""';

mkdirSync(GAS, { recursive: true });

const header = (from) => `/**
 * 【自動生成ファイル】直接編集しないこと。
 * 生成元: mail/${from}
 * 再生成: プロジェクト直下で node mail/build.mjs
 */
`;

writeFileSync(join(GAS, 'Templates.gs'),
  header('templates/（base*.html / blocks.html / themes.json）') + `
/** メール全体の骨格。themes.json の "base" で選ぶ */
const TEMPLATE_BASES = {
${Object.entries(bases).map(([k, v]) => `  ${JSON.stringify(k)}: [
    ${asGasString(v).split('\n').join('\n  ')}
  ].join('\\n')`).join(',\n')}
};

/** 本文ブロック集（blocks.html） */
const TEMPLATE_BLOCKS = [
  ${asGasString(blocks)}
].join('\\n');

/** 配色テーマ（themes.json） */
const TEMPLATE_THEMES = ${JSON.stringify(themes, null, 2)};
`);

/* ---------- 2. Render.gs ---------- */

writeFileSync(join(GAS, 'Render.gs'), header('render.js') + '\n' + renderSrc);
writeFileSync(join(GAS, 'Voice.gs'), header('voice.js') + '\n' + voiceSrc);

/* ---------- 2b. builder/templates.js ---------- */

// エディタは file:// で開くため fetch でテンプレートを読めない。
// Templates.gs と同じ中身を、素の <script> で読める形にも書き出しておく。
writeFileSync(join(HERE, 'builder', 'templates.js'),
  header('templates/（base*.html / blocks.html / themes.json）') + `
const TEMPLATE_BASES = ${JSON.stringify(bases)};
const TEMPLATE_BLOCKS = ${JSON.stringify(blocks)};
const TEMPLATE_THEMES = ${JSON.stringify(themes, null, 2)};
`);

/* ---------- 3. プレビュー ---------- */

// render.js を Node で読み込む（import/export を持たないので eval で足りる）
const sandbox = {};
new Function('exports', renderSrc + `
  exports.slzRenderEmail = slzRenderEmail;
  exports.slzRenderText = slzRenderText;
  exports.slzParseBody = slzParseBody;
`)(sandbox);

const SAMPLE_VARS = {
  COMPANY: 'Stellize合同会社',
  ADDRESS: '〒236-0021 神奈川県横浜市金沢区寺前2-25-35 クレアT105',
  SITE_URL: 'https://stellize-site.netlify.app/',
  SITE_URL_LABEL: 'stellize-site.netlify.app',
  CONTACT_URL: 'https://stellize-site.netlify.app/contact.html',
  PRIVACY_URL: 'https://stellize-site.netlify.app/privacy.html',
  LOGO_URL: 'https://stellize-site.netlify.app/assets/images/logo-header.png',
  UNSUB_URL: '#unsubscribe-preview',
  PERMISSION_NOTE: 'このメールは、貴事業所が公式サイト等で公開されているアドレス宛にお送りしています。',
};

/** サイトの画像を data URI にして、プレビューを1ファイルで開けるようにする */
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function inlineImages(html) {
  return html.split(SAMPLE_VARS.SITE_URL + 'assets/').length === 1 ? html
    : html.replace(new RegExp(SAMPLE_VARS.SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'assets/([^"\\s]+)', 'g'),
      (m, rel) => {
        const file = join(ROOT, 'assets', rel);
        const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
        try {
          return 'data:' + (MIME[ext] || 'image/jpeg') + ';base64,' + readFileSync(file).toString('base64');
        } catch { return m; }   // 無い画像はURLのままにして、抜けが分かるようにする
      });
}

/** 「2026年9月9日（火）」。日刊の題字に出す */
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const dateline = (d) =>
  `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;

const themeFor = (name) =>
  name.startsWith('daily') ? themes.daily
  : name.startsWith('b2b') ? themes.b2b
  : name.startsWith('partner') ? themes.partner
  : name.startsWith('announce') ? themes.announce
  : themes.newsletter;

const previewDir = join(HERE, 'preview');
mkdirSync(previewDir, { recursive: true });

const made = [];
for (const f of readdirSync(join(HERE, 'samples')).filter((f) => f.endsWith('.txt'))) {
  const name = basename(f, '.txt');
  const body = read(join('samples', f));
  const meta = name.startsWith('daily')
    ? { title: '「私が作ったって、書いていいんですか」', pre: '袋に名前を入れることになった日の話です。', eyebrow: '現場で見たこと' }
    : name.startsWith('b2b')
    ? { title: 'その作品は、まだ誰にも見えていない。', pre: '棚に並んだ作品が動かない理由は、たぶん値段ではありません。' }
    : { title: 'Stellize通信　第1号', pre: '現場で起きた小さな変化を3つ。' };
  const title = meta.title;
  const theme = themeFor(name);
  const html = sandbox.slzRenderEmail({
    base: bases[theme.base || 'default'], blocks, theme,
    subject: title, title, preheader: meta.pre, eyebrow: meta.eyebrow,
    body, vars: { ...SAMPLE_VARS, DATELINE: dateline(new Date()) },
  });
  // プレビューは1ファイルで完結させたいので、画像を data URI に埋め込む。
  // 本番（GAS）は絶対URLのまま送る
  writeFileSync(join(previewDir, name + '.html'), inlineImages(html));
  writeFileSync(join(previewDir, name + '.txt'), sandbox.slzRenderText({ title, body, vars: SAMPLE_VARS }));
  made.push(name);
}

/* ---------- 4. プレビュー索引 ---------- */

// PCとスマホを並べて見るための確認用ページ。実際の受信環境の代わりにはならないが、
// 「送る前に自分の目で見る」ための最低限。
const index = `<!doctype html><meta charset="utf-8"><title>Stellize メールプレビュー</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;background:#F0EBE3;font-family:'Hiragino Kaku Gothic ProN','Yu Gothic Medium',Meiryo,sans-serif;color:#3A3A3A}
 header{padding:26px 34px;background:#1F2A54;color:#fff}
 h1{margin:0;font-family:'Hiragino Mincho ProN','Yu Mincho',serif;font-size:18px;font-weight:600;letter-spacing:.08em}
 header p{margin:7px 0 0;font-size:11.5px;line-height:1.8;color:#C6CBDD}
 section{padding:26px 34px;border-bottom:1px solid #E2DACD}
 h2{margin:0 0 4px;font-size:14px;font-weight:600;color:#1F2A54;letter-spacing:.04em}
 .meta{margin:0 0 16px;font-size:11.5px;color:#8A8072}
 .meta a{color:#6F5F96;margin-right:14px}
 .views{display:flex;gap:22px;align-items:flex-start;overflow-x:auto;padding-bottom:6px}
 .view{flex:0 0 auto}
 .view span{display:block;margin:0 0 7px;font-size:10.5px;letter-spacing:.1em;color:#9A9184}
 iframe{border:1px solid #DDD5C8;border-radius:10px;background:#fff;height:1500px}
 .pc iframe{width:640px} .sp iframe{width:375px}
</style>
<header>
 <h1>Stellize HTMLメール プレビュー</h1>
 <p>mail/samples/*.txt をレンダリングしたもの。<code>node mail/build.mjs</code> で再生成されます。<br>
 実際の見え方はメールクライアントごとに違います。送る前に必ず配信パネルからテスト送信して、自分のスマホでも開いてください。</p>
</header>
${made.map((n) => `<section>
 <h2>${n}</h2>
 <p class="meta"><a href="${n}.html" target="_blank">単体で開く</a><a href="${n}.txt" target="_blank">テキスト版を見る</a></p>
 <div class="views">
  <div class="view pc"><span>PC ／ 600px</span><iframe src="${n}.html"></iframe></div>
  <div class="view sp"><span>スマートフォン ／ 375px</span><iframe src="${n}.html"></iframe></div>
 </div>
</section>`).join('\n')}`;
writeFileSync(join(previewDir, 'index.html'), index);

console.log('生成しました:');
console.log('  gas/newsletter/Templates.gs');
console.log('  gas/newsletter/Render.gs');
made.forEach((n) => console.log(`  mail/preview/${n}.html / .txt`));
console.log('  mail/preview/index.html');
