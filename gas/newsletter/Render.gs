/**
 * 【自動生成ファイル】直接編集しないこと。
 * 生成元: mail/render.js
 * 再生成: プロジェクト直下で node mail/build.mjs
 */

/**
 * Stellize HTMLメール レンダラ（原稿記法 → メール用HTML／テキスト）
 *
 * このファイルは1つで2か所で動く。
 *   - ブラウザ: mail/builder/index.html が <script> で読む
 *   - GAS:      node mail/build.mjs で gas/newsletter/Render.gs にそのままコピーされる
 * そのため import / export / module は使わず、素の関数だけで書いている。
 *
 * 原稿記法の一覧は mail/README.md にある。記法を足すときは
 * slzParseBody（読み取り）・slzRenderBlocks（HTML）・slzRenderText（テキスト版）の
 * 3か所と、READMEの表をそろえて直すこと。
 */

/* ============================================================
   1. 文字列ユーティリティ
   ============================================================ */

/** HTMLに入れてよい形にする。差し込み値も原稿も、必ずここを通す。 */
function slzEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** href に入れてよいURLだけ通す。javascript: などを弾く。 */
function slzSafeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return slzEscapeHtml(s);
  // 差し込みタグそのもの（{{配信停止URL}} など）は送信時に置換されるので通す
  if (/^\{\{[^{}]+\}\}$/.test(s)) return s;
  return '';
}

/**
 * {{KEY}} の置換。
 * 置換するのは英大文字のキーだけ。{{宛名}} のような差し込みタグは
 * 送信時に1通ずつ置き換えるため、ここでは触らずに残す。
 */
function slzFill(tpl, vars) {
  return String(tpl).replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : '';
  });
}

/** blocks.html を「名前 → 断片」の連想配列にする。 */
function slzParseBlockLibrary(source) {
  const out = {};
  const parts = String(source).split(/<!--\s*@block\s+([a-z0-9-]+)\s*-->/i);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1].trim();
  return out;
}

/** 「A｜B｜C」を分ける。全角・半角どちらの縦棒でも書けるようにする。 */
function slzSplitBar(line) {
  return String(line).split(/\s*[|｜]\s*/);
}

/* ============================================================
   2. 行内の記法
   ============================================================ */

/**
 * 1行分の装飾。エスケープしてから記法を戻す順で処理する
 * （先に記法を処理すると、原稿中の < > がタグとして生きてしまう）。
 *
 *   **強調**        → 太字
 *   ==マーカー==    → 蛍光ペン風の下線（サイトの marker と同じ役）
 *   [ラベル](URL)   → リンク
 *   改行            → <br />
 */
function slzInline(text, theme) {
  let s = slzEscapeHtml(text);

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
    const safe = slzSafeUrl(url.replace(/&amp;/g, '&'));
    if (!safe) return label;
    return '<a href="' + safe + '" target="_blank" style="color:' + theme.accentDeep + '; text-decoration:underline;">' + label + '</a>';
  });

  // background を2回書いているのは意図的。グラデーションを解さないOutlookは
  // 先の単色を使い、解するGmail等は後のグラデーションで下線風になる
  s = s.replace(/==([^=]+)==/g,
    '<span style="background:#FBEAEF; background:linear-gradient(transparent 58%,#F3CFDB 58%); font-weight:600; color:#2A2A2A;">$1</span>');

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:600; color:#2A2A2A;">$1</strong>');
  s = s.replace(/\n/g, '<br />');
  return s;
}

/* ============================================================
   3. 原稿記法 → ブロック配列
   ============================================================ */

/** 囲みブロック（:::名前）の中身の読み方。名前ごとに違う。 */
const SLZ_FENCES = {
  statement: function (arg, lines) { return { type: 'statement', text: lines.join('\n') }; },
  numbers:   function (arg, lines) {
    return { type: 'numbers', items: lines.map(function (l) {
      const p = slzSplitBar(l);
      // 「41｜件｜投稿が生まれた」でも「41｜投稿が生まれた」でも書ける
      return p.length >= 3 ? { value: p[0], unit: p[1], label: p.slice(2).join(' ') }
                           : { value: p[0], unit: '', label: p.slice(1).join(' ') };
    }) };
  },
  voice: function (arg, lines) {
    const p = slzSplitBar(arg);
    return { type: 'voice', name: p[0] || '', role: p[1] || '', photo: p[2] || '', text: lines.join('\n') };
  },
  offer: function (arg, lines) { return { type: 'offer', title: arg, lines: lines }; },
  cta: function (arg, lines) {
    const p = slzSplitBar(arg);
    const sub = lines.filter(function (l) { return /^※/.test(l.trim()); }).join('\n');
    const main = lines.filter(function (l) { return !/^※/.test(l.trim()); }).join('\n');
    return { type: 'cta', label: p[0] || '詳しく見る', url: p[1] || '', text: main, sub: sub };
  },
  cards: function (arg, lines) { return { type: 'cards', items: lines }; },
  ps:    function (arg, lines) { return { type: 'ps', text: lines.join('\n') }; },
  note:  function (arg, lines) { return { type: 'note', label: arg, text: lines.join('\n') }; },
};

/**
 * 原稿を1行ずつ読んでブロックに畳む。
 * 対応する記法は mail/README.md の表と同じ。増やすときは両方直すこと。
 */
function slzParseBody(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];      // 連続する本文行
  let list = null;    // 箇条書きの収集中（{check:bool, items:[]}）
  let quote = null;   // 引用の収集中
  let spec = null;    // 定義リストの収集中
  let fence = null;   // :::… の収集中

  function flushPara()  { if (para.length) { blocks.push({ type: 'paragraph', text: para.join('\n') }); para = []; } }
  function flushList()  { if (list && list.items.length) blocks.push({ type: 'list', check: list.check, items: list.items }); list = null; }
  function flushQuote() { if (quote && quote.lines.length) blocks.push({ type: 'quote', text: quote.lines.join('\n'), cite: quote.cite }); quote = null; }
  function flushSpec()  { if (spec && spec.length) blocks.push({ type: 'spec', rows: spec }); spec = null; }
  function flushAll()   { flushPara(); flushList(); flushQuote(); flushSpec(); }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    /* --- 囲みブロックの中 --- */
    if (fence) {
      if (/^:::\s*$/.test(line.trim())) {
        blocks.push(SLZ_FENCES[fence.name](fence.arg, fence.lines));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    /* --- 空行：区切り --- */
    if (!line.trim()) { flushAll(); continue; }

    /* --- 囲みブロックの開始（:::名前 引数） --- */
    let m = line.match(/^:::\s*([a-zA-Z]*)\s*(.*)$/);
    if (m) {
      flushAll();
      const name = (m[1] || '').toLowerCase();
      if (SLZ_FENCES[name]) fence = { name: name, arg: m[2].trim(), lines: [] };
      else fence = { name: 'note', arg: (m[1] ? m[1] + ' ' : '') + m[2].trim(), lines: [] };  // 「::: ラベル」は補足枠
      continue;
    }

    /* --- 区切り線 --- */
    if (/^---+\s*$/.test(line)) { flushAll(); blocks.push({ type: 'divider' }); continue; }

    /* --- 署名（-- のあとに文が続く） --- */
    if (/^--\s+/.test(line)) {
      flushAll();
      const sig = [line.replace(/^--\s+/, '')];
      let photo = '';
      while (i + 1 < lines.length && lines[i + 1].trim()) {
        const nx = lines[++i];
        const ph = nx.match(/^!\[[^\]]*\]\(([^)\s]+)\)\s*$/);   // 顔写真を1枚だけ置ける
        if (ph) photo = ph[1]; else sig.push(nx);
      }
      blocks.push({ type: 'signature', text: sig.join('\n'), photo: photo });
      continue;
    }

    /* --- 見出し --- */
    m = line.match(/^###\s+(.+)$/);
    if (m) { flushAll(); blocks.push({ type: 'subheading', text: m[1].trim() }); continue; }
    m = line.match(/^##\s+(.+)$/);
    if (m) { flushAll(); blocks.push({ type: 'heading', text: m[1].trim() }); continue; }

    /* --- 画像（!! は全幅、! は本文幅） --- */
    m = line.match(/^!!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (m) { flushAll(); blocks.push({ type: 'hero', alt: m[1], url: m[2] }); continue; }
    m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/);
    if (m) { flushAll(); blocks.push({ type: 'image', alt: m[1], url: m[2], caption: m[3] || '' }); continue; }

    /* --- ボタン（行がまるごとリンクのときだけ） --- */
    m = line.match(/^\[\[([^\]]+)\]\]\(([^)\s]+)\)\s*$/);
    if (m) { flushAll(); blocks.push({ type: 'button', style: 'outline', label: m[1], url: m[2] }); continue; }
    m = line.match(/^\[([^\]]+)\]\(([^)\s]+)\)\s*$/);
    if (m) { flushAll(); blocks.push({ type: 'button', style: 'solid', label: m[1], url: m[2] }); continue; }

    /* --- 箇条書き（- は列挙、+ はチェック付き） --- */
    m = line.match(/^([-*+])\s+(.+)$/);
    if (m) {
      const check = m[1] === '+';
      flushPara(); flushQuote(); flushSpec();
      if (list && list.check !== check) flushList();
      if (!list) list = { check: check, items: [] };
      list.items.push(m[2].trim());
      continue;
    }

    /* --- 引用 --- */
    m = line.match(/^>\s?(.*)$/);
    if (m) {
      flushPara(); flushList(); flushSpec();
      if (!quote) quote = { lines: [], cite: '' };
      const q = m[1];
      // 「>> 出典」または「> — 出典」を出典行として扱う
      if (/^(>|—|--|―)\s*/.test(q)) quote.cite = q.replace(/^(>|—|--|―)\s*/, '');
      else quote.lines.push(q);
      continue;
    }

    /* --- 定義リスト（| キー | 値） --- */
    m = line.match(/^\|\s*([^|｜]+?)\s*[|｜]\s*(.*)$/);
    if (m) { flushPara(); flushList(); flushQuote(); if (!spec) spec = []; spec.push({ key: m[1], value: m[2] }); continue; }

    /* --- ふつうの本文 --- */
    flushList(); flushQuote(); flushSpec();
    para.push(line);
  }

  if (fence) blocks.push(SLZ_FENCES[fence.name](fence.arg, fence.lines));   // 閉じ忘れても捨てない
  flushAll();

  // 最初の段落だけは「書き出し」として大きく組む
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'paragraph') { blocks[i].type = 'lead'; break; }
    if (['heading', 'subheading', 'statement', 'cta', 'offer'].indexOf(blocks[i].type) >= 0) break;
  }
  return blocks;
}

/* ============================================================
   4. ブロック配列 → HTML
   ============================================================ */

function slzRenderBlocks(blocks, lib, theme) {
  const V = {
    ACCENT: theme.accent, ACCENT_DEEP: theme.accentDeep, ACCENT_SOFT: theme.accentSoft,
    CTA_FROM: theme.ctaFrom || theme.accent, CTA_TO: theme.ctaTo || theme.accentDeep,
  };
  const inl = function (t) { return slzInline(t, theme); };
  const fill = function (name, extra) { return slzFill(lib[name], Object.assign({}, V, extra)); };
  const out = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.type) {

      case 'lead':
      case 'paragraph':
        out.push(fill(b.type, { TEXT: inl(b.text) }));
        break;

      case 'heading':
      case 'subheading':
        out.push(fill(b.type, { TEXT: inl(b.text) }));
        break;

      case 'list': {
        const item = b.check ? 'check-item' : 'list-item';
        const items = b.items.map(function (t) { return fill(item, { TEXT: inl(t) }); }).join('\n');
        out.push(fill('list', { ITEMS: items }));
        break;
      }

      case 'statement':
        out.push(fill('statement', { TEXT: inl(b.text) }));
        break;

      case 'numbers': {
        const cells = b.items.slice(0, 3).map(function (n) {
          return fill('number-cell', {
            VALUE: slzEscapeHtml(n.value), UNIT: slzEscapeHtml(n.unit), LABEL: inl(n.label),
          });
        }).join('');
        out.push(fill('numbers', { COLUMNS: cells }));
        break;
      }

      case 'voice': {
        const url = slzSafeUrl(b.photo);
        const photo = url ? fill('voice-photo', { URL: url, NAME: slzEscapeHtml(b.name) }) : '';
        out.push(fill('voice', {
          PHOTO: photo, NAME: slzEscapeHtml(b.name), ROLE: slzEscapeHtml(b.role), TEXT: inl(b.text),
        }));
        break;
      }

      case 'offer': {
        // 枠の中は「本文」と「| キー | 値」だけを受ける。入れ子は深くしない
        const rows = [], paras = [];
        b.lines.forEach(function (l) {
          const m = l.match(/^\|\s*([^|｜]+?)\s*[|｜]\s*(.*)$/);
          if (m) rows.push(fill('spec-row', { KEY: inl(m[1]), VALUE: inl(m[2]) }));
          else if (l.trim()) paras.push(inl(l));
        });
        let body = paras.length
          ? '<p style="margin:10px 0 0 0; font-family:\'Hiragino Kaku Gothic ProN\',Meiryo,sans-serif; font-size:14px; line-height:1.95; color:#3A3A3A;">' + paras.join('<br />') + '</p>'
          : '';
        if (rows.length) body += fill('spec-bare', { ROWS: rows.join('\n') });
        out.push(fill('offer', { TITLE: inl(b.title), BODY: body }));
        break;
      }

      case 'cta': {
        const url = slzSafeUrl(b.url);
        if (!url) break;
        out.push(fill('cta', {
          TEXT: inl(b.text), LABEL: slzEscapeHtml(b.label), URL: url, SUB: inl(b.sub),
        }));
        break;
      }

      case 'button': {
        const url = slzSafeUrl(b.url);
        if (!url) break;
        out.push(fill(b.style === 'outline' ? 'button-outline' : 'button',
          { LABEL: slzEscapeHtml(b.label), URL: url }));
        break;
      }

      case 'hero': {
        const url = slzSafeUrl(b.url);
        if (url) out.push(fill('hero-image', { URL: url, ALT: slzEscapeHtml(b.alt) }));
        break;
      }

      case 'image': {
        const url = slzSafeUrl(b.url);
        if (!url) break;
        const cap = b.caption ? fill('image-caption', { TEXT: inl(b.caption) }) : '';
        out.push(fill('image', { URL: url, ALT: slzEscapeHtml(b.alt), CAPTION: cap }));
        break;
      }

      case 'note': {
        const label = b.label ? fill('note-label', { TEXT: slzEscapeHtml(b.label) }) : '';
        out.push(fill('note', { LABEL: label, TEXT: inl(b.text) }));
        break;
      }

      case 'spec': {
        const rows = b.rows.map(function (r) { return fill('spec-row', { KEY: inl(r.key), VALUE: inl(r.value) }); }).join('\n');
        out.push(fill('spec', { ROWS: rows }));
        break;
      }

      case 'quote': {
        const cite = b.cite ? fill('quote-cite', { TEXT: inl(b.cite) }) : '';
        out.push(fill('quote', { TEXT: inl(b.text), CITE: cite }));
        break;
      }

      case 'cards': {
        // 「タイトル｜本文」を2列ずつ。奇数個のときは最後の1枚を空セルで埋める
        const cells = b.items.map(function (line) {
          const p = slzSplitBar(line);
          return fill('card-column', { TITLE: inl(p[0] || ''), TEXT: inl(p.slice(1).join(' | ')) });
        });
        const rows = [];
        for (let j = 0; j < cells.length; j += 2) {
          const pair = cells.slice(j, j + 2);
          if (pair.length === 1) pair.push('<td class="sl-stack" width="50%" style="width:50%;">&nbsp;</td>');
          rows.push(fill('cards', { COLUMNS: pair.join('') }));
        }
        out.push(rows.join('\n'));
        break;
      }

      case 'ps':
        out.push(fill('ps', { TEXT: inl(b.text) }));
        break;

      case 'signature': {
        const url = slzSafeUrl(b.photo);
        out.push(fill('signature', {
          TEXT: inl(b.text), PHOTO: url ? fill('signature-photo', { URL: url }) : '',
        }));
        break;
      }

      case 'divider':
        out.push(fill('divider', {}));
        break;
    }
  }
  return out.join('\n');
}

/* ============================================================
   5. まとめ：完成したメールHTML
   ============================================================ */

/**
 * @param {Object} o
 *   base        base.html の中身
 *   blocks      blocks.html の中身
 *   theme       themes.json の1エントリ（accent 等）
 *   subject     件名
 *   title       本文の大見出し
 *   eyebrow     大見出しの上の小さいラベル（省略時はテーマの既定）
 *   preheader   受信箱一覧に出る補足文
 *   body        原稿（記法つきテキスト）
 *   vars        フッター等の差し込み（COMPANY / ADDRESS / UNSUB_URL ...）
 */
function slzRenderEmail(o) {
  const theme = o.theme;
  const lib = slzParseBlockLibrary(o.blocks);
  const blocks = slzParseBody(o.body);

  // 冒頭の全幅画像は見出しより上（カードの一番上）に置くので、本文から抜き出す
  let heroHtml = '';
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'hero') {
      heroHtml = slzRenderBlocks([blocks[i]], lib, theme);
      blocks.splice(i, 1);
      break;
    }
  }

  const vars = Object.assign({
    ACCENT: theme.accent,
    ACCENT_DEEP: theme.accentDeep,
    ACCENT_SOFT: theme.accentSoft,
    EYEBROW: slzEscapeHtml(o.eyebrow || theme.eyebrow),
    SUBJECT: slzEscapeHtml(o.subject || ''),
    TITLE: slzInline(o.title || '', theme),
    PREHEADER: slzEscapeHtml(o.preheader || ''),
    HERO: heroHtml,
    BODY: slzRenderBlocks(blocks, lib, theme),
    YEAR: new Date().getFullYear(),
    WEBVIEW: '',
    TRACKING: '',
    FOOTER_NOTE: '',
  }, o.vars || {});
  return slzFill(o.base, vars);
}

/* ============================================================
   6. テキスト版
   ============================================================ */

/**
 * HTMLを読めない環境と、迷惑メール判定の両方のために必ず添える。
 * 見た目は捨てて、情報の順序だけHTMLと一致させる。
 */
function slzRenderText(o) {
  const blocks = slzParseBody(o.body);
  const plain = function (t) {
    return String(t == null ? '' : t)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1（$2）')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/==([^=]+)==/g, '$1');
  };
  const L = [];
  if (o.title) { L.push(plain(o.title), '='.repeat(30), ''); }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.type) {
      case 'lead':
      case 'paragraph':  L.push(plain(b.text), ''); break;
      case 'heading':    L.push('■ ' + plain(b.text), ''); break;
      case 'subheading': L.push('◇ ' + plain(b.text), ''); break;
      case 'statement':  L.push('', '　' + plain(b.text), ''); break;
      case 'list':       b.items.forEach(function (t) { L.push((b.check ? '✓ ' : '・') + plain(t)); }); L.push(''); break;
      case 'numbers':    b.items.forEach(function (n) { L.push('・' + plain(n.label) + '： ' + n.value + (n.unit || '')); }); L.push(''); break;
      case 'voice':      L.push('［現場の声］' + plain(b.name) + (b.role ? '（' + plain(b.role) + '）' : ''), '「' + plain(b.text) + '」', ''); break;
      case 'offer':      L.push('----------', '【' + plain(b.title) + '】');
                         b.lines.forEach(function (l) {
                           const m = l.match(/^\|\s*([^|｜]+?)\s*[|｜]\s*(.*)$/);
                           L.push(m ? plain(m[1]) + '： ' + plain(m[2]) : plain(l));
                         });
                         L.push('----------', ''); break;
      case 'cta':        L.push('', plain(b.text), '▶ ' + plain(b.label), '  ' + b.url, plain(b.sub), ''); break;
      case 'button':     L.push('▶ ' + plain(b.label), '  ' + b.url, ''); break;
      case 'hero':
      case 'image':      if (b.caption || b.alt) L.push('［画像］' + plain(b.caption || b.alt), ''); break;
      case 'note':       L.push('----------', (b.label ? '【' + plain(b.label) + '】\n' : '') + plain(b.text), '----------', ''); break;
      case 'spec':       b.rows.forEach(function (r) { L.push(plain(r.key) + '： ' + plain(r.value)); }); L.push(''); break;
      case 'quote':      L.push(plain(b.text).split('\n').map(function (l) { return '> ' + l; }).join('\n')); if (b.cite) L.push('> — ' + plain(b.cite)); L.push(''); break;
      case 'cards':      b.items.forEach(function (line) { const p = slzSplitBar(line); L.push('【' + plain(p[0]) + '】 ' + plain(p.slice(1).join(' | '))); }); L.push(''); break;
      case 'ps':         L.push('', '追伸： ' + plain(b.text), ''); break;
      case 'signature':  L.push('--', plain(b.text), ''); break;
      case 'divider':    L.push('- - - - - - - - - - - -', ''); break;
    }
  }

  const f = o.vars || {};
  L.push('', '─────────────────────',
    f.COMPANY || '', f.ADDRESS || '', f.SITE_URL || '',
    'お問い合わせ： ' + (f.CONTACT_URL || ''), '');
  if (f.PERMISSION_NOTE_TEXT) L.push(f.PERMISSION_NOTE_TEXT);
  L.push('配信停止はこちら： ' + (f.UNSUB_URL || ''), '');
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}
