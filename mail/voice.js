/**
 * 書き方のチェック（日刊メルマガ用）
 *
 * 日刊の目的は「情報を届けること」ではなく「信頼をつくること」なので、
 * 教える構え・誇張・売り込みが混ざると、その号は目的から外れる。
 * 気をつける、では続かないので、機械で拾えるところは拾う。
 *
 * ここも render.js と同じく、ブラウザとGASの両方で動かすため
 * import / export を使わない素の関数だけで書いている。
 * 生成先は gas/newsletter/Voice.gs と mail/builder（node mail/build.mjs）。
 *
 * 注意：これは目安であって、審判ではない。
 * 引っかかっても、必要があってその言葉を選んだのなら、そのまま出してよい。
 */

/** 日刊の枠。曜日ごとに固定して、「今日は何を書くんだっけ」を無くす。 */
const DAILY_FRAMES = [
  {
    key: '現場で見たこと',
    days: [1, 4],                      // 月・木
    target: '両方',
    note: '訪問先で目にした場面をひとつ。解釈は最小限にして、読んだ人が自分で考える余白を残す。',
    wants: ['quote'],
  },
  {
    key: '手を動かしてみた話',
    days: [2],                         // 火
    target: '生産活動を広げたい施設',
    note: '撮り方・値付け・見せ方・作業の切り出し。「こうしましょう」ではなく「こうしたら、こうだった」。',
    wants: ['first-person', 'result'],
  },
  {
    key: 'AIを試してみた話',
    days: [5],                         // 金
    target: 'WelfareAIに関心のある施設',
    note: '自分で試した結果を、うまくいかなかったところから書く。業界の誇張を打ち消す役目も持つ。',
    wants: ['first-person', 'result', 'failure'],
  },
  {
    key: '考えていること',
    days: [3],                         // 水
    target: '両方',
    note: '制度・お金・業界について思っていること。事実解説ではなく意見として書く（解説は正確性の負荷が重く続かない）。',
    wants: ['first-person', 'hedge'],
  },
];

/** その曜日の枠を返す。0=日曜。土日は null。 */
function slzFrameForDay(day) {
  for (let i = 0; i < DAILY_FRAMES.length; i++) {
    if (DAILY_FRAMES[i].days.indexOf(day) >= 0) return DAILY_FRAMES[i];
  }
  return null;
}

/* ============================================================
   拾う言葉
   ============================================================ */

/** 教える構えの言葉。読み手を下に置いてしまう。 */
const SLZ_PREACHY = [
  ['すべきです', '「私はこうした」に置き換える'],
  ['すべきだ', '「私はこうした」に置き換える'],
  ['ましょう', '相手を動かす言い方。「こうしてみたら、こうだった」に'],
  ['ご存じですか', '知らない前提で聞いている。事実を置くだけでよい'],
  ['ご存知ですか', '知らない前提で聞いている。事実を置くだけでよい'],
  ['知っていますか', '知らない前提で聞いている。事実を置くだけでよい'],
  ['が正解', '正解を持っている側に立ってしまう'],
  ['してはいけません', '禁止の口調。「私はやめた」に'],
  ['覚えておいてください', '指示の口調'],
  ['押さえておきたい', '教える構え'],
  ['忘れがちです', '読み手を下に置いている'],
  ['意外と知られていません', '読み手を下に置いている'],
];

/** 誇張。福祉の現場では特に、盛った瞬間に信用が落ちる。 */
const SLZ_HYPE = ['劇的', '圧倒的', '革命', '激変', '一瞬で', '誰でも簡単に',
  '必ず', '絶対', '驚くほど', '話題沸騰', '今すぐ'];

/** 誇張語を「打ち消して」使っている場合は指摘しない（「劇的に楽になる話ではない」など） */
const SLZ_NEGATION = /(ではない|ではありま|わけでは|とは限らな|ことはない|ありません|しも)/;
function slzIsNegated(text, word) {
  let i = text.indexOf(word);
  while (i >= 0) {
    // その語のうしろ20字以内に打ち消しが無ければ、素で使っている
    if (!SLZ_NEGATION.test(text.slice(i + word.length, i + word.length + 20))) return false;
    i = text.indexOf(word, i + 1);
  }
  return true;
}

/** 主語を大きくすると、途端に評論になる。 */
const SLZ_GENERALIZED = ['事業所は', '施設は', '支援員は', '職員は', '皆さんは', 'みなさんは'];

/* ============================================================
   本体
   ============================================================ */

/**
 * @param {Object} o
 *   body    原稿本文
 *   title   大見出し
 *   subject 件名
 *   frame   枠の名前（DAILY_FRAMES の key）。無くてもよい
 *   blocks  slzParseBody() の結果。渡さなければ本文から作る
 * @returns {Array<{level:'ng'|'warn'|'hint', msg:string}>}
 */
function slzVoiceCheck(o) {
  const body = String(o.body || '');
  const all = body + '\n' + String(o.title || '') + '\n' + String(o.subject || '');
  const blocks = o.blocks || slzParseBody(body);
  const out = [];
  const add = function (level, msg) { out.push({ level: level, msg: msg }); };

  /* --- 教える構え --- */
  SLZ_PREACHY.forEach(function (p) {
    if (all.indexOf(p[0]) >= 0) add('ng', '「' + p[0] + '」' + (p[1] ? ' ── ' + p[1] : ''));
  });

  /* --- 誇張 --- */
  SLZ_HYPE.forEach(function (w) {
    if (all.indexOf(w) >= 0 && !slzIsNegated(all, w)) {
      add('warn', '「' + w + '」は盛った言葉に見えます。数字か、実際に起きたことに置き換えられませんか');
    }
  });

  /* --- 主語の大きさ --- */
  SLZ_GENERALIZED.forEach(function (w) {
    if (body.indexOf(w) >= 0) add('warn', '「' + w + '」と主語を大きくしています。見た1件の話として書けませんか');
  });

  /* --- 売り込み --- */
  const ctas = blocks.filter(function (b) { return b.type === 'cta'; }).length;
  const btns = blocks.filter(function (b) { return b.type === 'button'; }).length;
  if (ctas) add('ng', '日刊にCTA帯があります。売り込みは月1の営業レターに任せて、ここでは外してください');
  if (btns > 1) add('warn', 'リンクボタンが' + btns + '個あります。日刊は読み物なので、多くても1つに');
  if (blocks.some(function (b) { return b.type === 'offer'; })) {
    add('ng', '日刊に条件枠（:::offer）があります。価格の話は営業レターの役目です');
  }

  /* --- 一人称で書けているか --- */
  if (!/私|僕|こちら|うち/.test(body)) {
    add('warn', '「私」が一度も出てきません。誰の話なのかが消えると、評論に見えます');
  }

  /* --- 言い切りすぎていないか --- */
  if (!/かもしれ|と思いま|と思って|気がしま|まだ分かり|ように見え|のではない/.test(body)) {
    add('hint', '断定だけで構成されています。「まだ分かりません」「だと思っています」が一つ入ると、対話の距離になります');
  }

  /* --- 現場の言葉があるか --- */
  const quoted = (body.match(/「[^」]{4,}」/g) || []).length;
  if (!quoted) add('hint', '現場の人の言葉（「　」）がありません。自分の説明より、他人の一言のほうが届きます');

  /* --- 長さ --- */
  const len = [...body.replace(/\s/g, '')].length;
  if (len < 400) add('warn', '本文が' + len + '字です。日刊は600〜900字が読みやすい範囲です');
  else if (len > 1200) add('warn', '本文が' + len + '字です。1200字を超えると、毎日は読まれにくくなります');

  /* --- 枠ごとに欲しいもの --- */
  const frame = slzFrameFor(o.frame);
  if (frame) {
    const wants = frame.wants || [];
    if (wants.indexOf('failure') >= 0 && !/うまくいか|できなかった|かえって|失敗|だめ|ダメ|むしろ遅く|時間がかかった/.test(body)) {
      add('hint', '「' + frame.key + '」の回です。うまくいかなかったところから書くと、いちばん信用されます');
    }
    if (wants.indexOf('result') >= 0 && !/[0-9０-９]/.test(body)) {
      add('hint', '試した話には、数字（時間・回数・金額）が1つあると輪郭が出ます');
    }
    if (wants.indexOf('quote') >= 0 && !quoted) {
      add('hint', '「' + frame.key + '」の回です。その場で言われた言葉をそのまま置くと、場面が立ちます');
    }
  }

  return out;
}

/** 枠の名前から定義を引く。 */
function slzFrameFor(key) {
  const k = String(key || '').trim();
  for (let i = 0; i < DAILY_FRAMES.length; i++) if (DAILY_FRAMES[i].key === k) return DAILY_FRAMES[i];
  return null;
}
