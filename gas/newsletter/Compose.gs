/**
 * Stellize メルマガ配信ツール — 1通ぶんのメールを組み立てる
 *
 * 流れは2段階に分けている。
 *   1. campaignHtml(): 号ごとに1回だけレンダリング。ここでは差し込みタグを残す
 *   2. personalize(): 宛先ごとにタグを置き換える。配信停止URLは署名付きで1人ずつ違う
 *
 * 数千通を送るときに、毎回HTML全体を組み立て直さないための分け方。
 */

/** 原稿シートの1行を取り出す。 */
function draftByIssue(issue) {
  const rows = readRows(SHEETS.drafts);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['号ID']).trim() === String(issue).trim()) return rows[i];
  }
  return null;
}

/** テーマ（配色）を取る。未指定・不明なときは newsletter に落とす。 */
function themeOf(name) {
  const key = String(name || '').trim();
  return TEMPLATE_THEMES[key] || TEMPLATE_THEMES.newsletter;
}

/**
 * 配信停止URL。1人ずつ署名が違う（他人を勝手に停止できないようにするため）。
 * 宛先が特定できないとき（ブラウザ表示）は問い合わせ先に落とす。
 */
function unsubUrl(email, issue) {
  const base = cfg()['WebアプリURL'];
  if (!base || !email) return cfg()['お問い合わせURL'];
  return base + '?a=u&e=' + encodeURIComponent(email) + '&s=' + signEmail(email)
    + (issue ? '&i=' + encodeURIComponent(issue) : '');
}

/** ブラウザで開くURL（画像が出ない環境向け）。 */
function webViewUrl(issue) {
  const base = cfg()['WebアプリURL'];
  return base ? base + '?a=v&c=' + encodeURIComponent(issue) : '';
}

/**
 * 号ごとに1回だけ組み立てる共通HTML。
 * 差し込みタグ（{{宛名}} など）は文字列のまま残る。
 */
function campaignHtml(draft) {
  const c = cfg();
  const issue = String(draft['号ID']).trim();
  const theme = themeOf(draft['テンプレート']);
  const site = c['サイトURL'];

  const webview = webViewUrl(issue)
    ? '<a href="' + webViewUrl(issue) + '" style="color:#8A8378; text-decoration:underline;">画像が表示されない場合はこちら</a>'
    : '';

  const vars = {
    COMPANY: c['会社名'],
    ADDRESS: c['住所'],
    SITE_URL: site,
    SITE_URL_LABEL: String(site).replace(/^https?:\/\//, '').replace(/\/$/, ''),
    CONTACT_URL: c['お問い合わせURL'],
    PRIVACY_URL: c['プライバシーURL'] || c['お問い合わせURL'],
    LOGO_URL: c['ロゴURL'],
    PERMISSION_NOTE: c['既定の許諾文'],
    UNSUB_URL: '{{配信停止URL}}',
    WEBVIEW: webview,
    // 開封計測は入れていない。GASのWebアプリは画像を返せず、
    // 1x1画像の代わりに壊れた画像アイコンが本文に出てしまうため。
    // 反応はUTM付きリンク → GA4 で見る（設定シートの「UTM自動付与」）。
    TRACKING: '',
  };

  let html = slzRenderEmail({
    base: TEMPLATE_BASE,
    blocks: TEMPLATE_BLOCKS,
    theme: theme,
    subject: String(draft['件名'] || ''),
    title: String(draft['大見出し'] || draft['件名'] || ''),
    preheader: String(draft['プリヘッダー'] || ''),
    body: String(draft['本文'] || ''),
    vars: vars,
  });

  if (cfgOn('UTM自動付与')) html = addUtm(html, site, issue);

  const text = slzRenderText({
    title: String(draft['大見出し'] || draft['件名'] || ''),
    body: String(draft['本文'] || ''),
    vars: {
      COMPANY: c['会社名'], ADDRESS: c['住所'], SITE_URL: site,
      CONTACT_URL: c['お問い合わせURL'],
      PERMISSION_NOTE_TEXT: c['既定の許諾文'],
      UNSUB_URL: '{{配信停止URL}}',
    },
  });

  return { html: html, text: text, subject: String(draft['件名'] || ''), issue: issue };
}

/**
 * 自社サイトへのリンクに utm を足す。
 * GA4（サイトに入っている gtag）で、どの号から来たかを見られるようにするため。
 * 外部サイトや配信停止リンクには触らない。
 */
function addUtm(html, siteUrl, issue) {
  let host = '';
  try { host = String(siteUrl).replace(/^https?:\/\//, '').split('/')[0]; } catch (e) { return html; }
  if (!host) return html;
  // href属性の中なので & は &amp; と書く（受信側で & に戻る）
  const tag = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=' + encodeURIComponent(issue);
  const re = new RegExp('href="(https?://' + host.replace(/\./g, '\\.') + '[^"]*)"', 'g');
  return html.replace(re, function (m, url) {
    if (url.indexOf('utm_source=') >= 0) return m;
    return 'href="' + url + (url.indexOf('?') >= 0 ? '&amp;' : '?') + tag + '"';
  });
}

/** 差し込みタグの対応表。空欄のときの逃げ道もここで決める。 */
function mergeMap(rcpt, issue) {
  const name = rcpt['宛名'] || rcpt['事業所名'] || rcpt['法人名'] || 'ご担当者';
  return {
    '宛名': name,
    '法人名': rcpt['法人名'] || '',
    '事業所名': rcpt['事業所名'] || '',
    '都道府県': rcpt['都道府県'] || '',
    '配信停止URL': unsubUrl(rcpt.email, issue),
  };
}

/** 宛先1人ぶんに仕上げる。 */
function personalize(built, rcpt) {
  const map = mergeMap(rcpt, built.issue);
  const apply = function (s, escape) {
    return String(s).replace(/\{\{([^{}]+)\}\}/g, function (m, key) {
      const k = key.trim();
      if (!Object.prototype.hasOwnProperty.call(map, k)) return '';
      const v = String(map[k]);
      return escape ? slzEscapeHtml(v) : v;
    });
  };
  return {
    subject: apply(built.subject, false),
    html: apply(built.html, true),
    text: apply(built.text, false),
  };
}

/**
 * 送信前チェック。ここで止めるべきものを全部返す。
 * 「送ってしまってから気づく」のを避けるための関門。
 */
function validateDraft(draft) {
  const c = cfg();
  const errors = [];
  const warns = [];

  SETTING_DEFS.forEach(function (d) {
    if (d.required && !String(c[d.key] || '').trim()) errors.push('設定シートの「' + d.key + '」が空です');
  });

  if (!draft) { errors.push('原稿が見つかりません'); return { errors: errors, warns: warns }; }
  if (!String(draft['件名'] || '').trim()) errors.push('件名が空です');
  if (!String(draft['本文'] || '').trim()) errors.push('本文が空です');
  if (!TEMPLATE_THEMES[String(draft['テンプレート']).trim()]) errors.push('テンプレートが未選択です');

  const url = String(c['WebアプリURL'] || '');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    errors.push('WebアプリURLが正しくありません（末尾が /exec のデプロイURLを設定シートに貼ってください）。配信停止リンクが作れません');
  }

  const st = String(draft['状態']).trim();
  if (st === '送信済') errors.push('この号はすでに送信済みです');
  if (st === '送信中') errors.push('この号は送信中です');

  // 本文中の差し込みタグが対応表にあるか
  const known = { '宛名': 1, '法人名': 1, '事業所名': 1, '都道府県': 1, '配信停止URL': 1 };
  const used = String(draft['本文'] + ' ' + draft['件名']).match(/\{\{([^{}]+)\}\}/g) || [];
  used.forEach(function (t) {
    const k = t.replace(/[{}]/g, '').trim();
    if (!known[k]) warns.push('差し込みタグ {{' + k + '}} は対応表にありません。空欄になります');
  });

  // Gmailは約102KBを超えたメールを途中で切り、「メッセージ全体を表示」に畳む。
  // 折りたたまれた先には配信停止リンクも入るので、超える前に気づけるようにする
  try {
    const size = campaignHtml(draft).html.length;
    if (size > 92000) warns.push('HTMLが約' + Math.round(size / 1024) + 'KBあります。Gmailは102KBで本文を切るので、画像を減らすか本文を短くしてください');
  } catch (e) { /* 組み立てで落ちる原因は上のチェックで拾えている */ }

  const subject = String(draft['件名'] || '');
  if (subject.length > 40) warns.push('件名が' + subject.length + '文字あります。スマホでは25文字前後までしか表示されません');
  if (!String(draft['プリヘッダー'] || '').trim()) warns.push('プリヘッダーが空です。受信箱の一覧で本文の先頭が拾われます');

  return { errors: errors, warns: warns };
}
