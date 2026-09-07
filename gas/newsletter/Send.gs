/**
 * Stellize メルマガ配信ツール — 送信エンジン
 *
 * GASには「1回の実行は6分まで」「1日に送れる通数に上限がある」という制約がある。
 * そこで、宛先を送信キューに書き出してから少しずつ処理し、
 * 続きは5分おきのトリガーが引き継ぐ形にしている。
 * 途中で止まっても、キューの状態を見れば続きから再開できる。
 */

const MAX_RUN_MS = 4.5 * 60 * 1000;   // 6分の制限に対する安全余裕
const FLUSH_EVERY = 20;               // 何通ごとにキューの状態を書き戻すか
const TRIGGER_FN = 'processQueue';
const PROP_ISSUE = 'CURRENT_ISSUE';

/* ============================================================
   テスト送信
   ============================================================ */

/**
 * 自分宛に1通だけ送る。宛先の差し込みはダミー値で埋める。
 * 本番送信の前に必ず通す。
 */
function sendTest(issue, toEmail) {
  const draft = draftByIssue(issue);
  const v = validateDraft(draft);
  // テストでは「送信済」などの状態エラーは無視する（何度でも試せるように）
  const blocking = v.errors.filter(function (e) { return e.indexOf('すでに送信済') < 0 && e.indexOf('送信中です') < 0; });
  if (blocking.length) throw new Error('送信できません:\n・' + blocking.join('\n・'));

  const to = normEmail(toEmail || Session.getEffectiveUser().getEmail());
  const built = campaignHtml(draft);
  const one = personalize(built, {
    email: to, 宛名: 'テスト太郎', 法人名: '社会福祉法人テスト会',
    事業所名: 'テスト就労支援センター', 都道府県: '神奈川県',
  });

  MailApp.sendEmail({
    to: to,
    subject: '【テスト送信】' + one.subject,
    htmlBody: one.html,
    body: one.text,
    name: cfg()['差出人名'],
    replyTo: cfg()['返信先'],
  });
  log(issue, to, 'テスト', '注意事項: ' + (v.warns.join(' / ') || 'なし'));
  return to + ' にテスト送信しました。' + (v.warns.length ? '\n\n【確認したい点】\n・' + v.warns.join('\n・') : '');
}

/* ============================================================
   本番送信
   ============================================================ */

/** その日にこのツールで送った通数（1日の送信上限の判定に使う）。 */
function sentToday(delta) {
  const props = PropertiesService.getScriptProperties();
  const key = 'SENT_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const n = Number(props.getProperty(key) || 0) + (delta || 0);
  if (delta) props.setProperty(key, String(n));
  return n;
}

/** あと何通送れるか。Gmail側の残数と、設定の上限の小さいほうを取る。 */
function sendableNow() {
  const gmailLeft = MailApp.getRemainingDailyQuota() - cfgNum('予備に残す通数');
  const ownLeft = cfgNum('1日の送信上限') - sentToday(0);
  return Math.max(0, Math.min(gmailLeft, ownLeft));
}

/**
 * 送信を開始する。
 * 宛先をこの時点で送信キューに写し取る（あとから購読者シートを編集しても
 * 送信中の宛先がずれないようにするため）。
 */
function startSending(issue) {
  const draft = draftByIssue(issue);
  const v = validateDraft(draft);
  if (v.errors.length) throw new Error('送信できません:\n・' + v.errors.join('\n・'));

  const running = PropertiesService.getScriptProperties().getProperty(PROP_ISSUE);
  if (running && running !== issue) throw new Error('別の号（' + running + '）が送信中です。先にそちらを終わらせてください。');

  const rcpts = recipientsFor(draft['セグメント']);
  if (!rcpts.length) throw new Error('宛先が0件です。購読者シートの「状態」と「セグメント」を確認してください。');

  // 既存のキューを消してから積み直す
  clearQueue(issue);
  const qsh = sheet(SHEETS.queue);
  const map = headerMap(qsh);
  const width = qsh.getLastColumn();
  const rows = rcpts.map(function (r) {
    const a = new Array(width).fill('');
    a[map['号ID']] = issue;
    a[map['メールアドレス']] = r.email;
    a[map['宛名']] = r['宛名'];
    a[map['法人名']] = r['法人名'];
    a[map['事業所名']] = r['事業所名'];
    return a;
  });
  qsh.getRange(qsh.getLastRow() + 1, 1, rows.length, width).setValues(rows);

  setCells(SHEETS.drafts, draft._row, {
    '状態': '送信中', '対象数': rcpts.length, '送信済': 0, '失敗': 0,
    '送信開始': nowStr(), '送信完了': '',
  });
  PropertiesService.getScriptProperties().setProperty(PROP_ISSUE, issue);
  log(issue, '', '開始', '宛先 ' + rcpts.length + '件をキューに積みました');

  ensureTrigger();
  const done = processQueue();
  return '送信を開始しました（宛先 ' + rcpts.length + '件）。\n' + done;
}

/** 5分おきの継続トリガーを1本だけ用意する。 */
function ensureTrigger() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === TRIGGER_FN; });
  if (!has) ScriptApp.newTrigger(TRIGGER_FN).timeBased().everyMinutes(5).create();
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}

/** 送信を止める。キューは残すので、あとから再開できる。 */
function stopSending() {
  const issue = PropertiesService.getScriptProperties().getProperty(PROP_ISSUE);
  removeTrigger();
  PropertiesService.getScriptProperties().deleteProperty(PROP_ISSUE);
  if (issue) {
    const d = draftByIssue(issue);
    if (d) setCell(SHEETS.drafts, d._row, '状態', '中止');
    log(issue, '', '中止', '手動で停止しました');
  }
  return issue ? issue + ' の送信を止めました。' : '送信中の号はありません。';
}

/** キューから、その号の行を消す。 */
function clearQueue(issue) {
  const qsh = sheet(SHEETS.queue);
  if (qsh.getLastRow() < 2) return;
  const map = headerMap(qsh);
  const col = map['号ID'] + 1;
  const values = qsh.getRange(2, col, qsh.getLastRow() - 1, 1).getValues();
  // 下から消す。上から消すと行番号がずれる
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() === String(issue).trim()) qsh.deleteRow(i + 2);
  }
}

/**
 * キューを処理する。トリガーからも、画面の「続きを送る」からも呼ばれる。
 * 二重に走らないようロックを取る。
 */
function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return '別の送信処理が動いています。';

  try {
    const props = PropertiesService.getScriptProperties();
    const issue = props.getProperty(PROP_ISSUE);
    if (!issue) { removeTrigger(); return '送信中の号はありません。'; }

    const draft = draftByIssue(issue);
    if (!draft) { finish(issue, '原稿が見つかりません'); return '原稿が見つかりません。'; }

    const qsh = sheet(SHEETS.queue);
    const map = headerMap(qsh);
    if (qsh.getLastRow() < 2) { finish(issue, 'キューが空です'); return 'キューが空です。'; }

    const all = qsh.getRange(2, 1, qsh.getLastRow() - 1, qsh.getLastColumn()).getValues();
    // この号の未送信行だけを、シート上の行番号つきで拾う
    const pending = [];
    for (let i = 0; i < all.length; i++) {
      if (String(all[i][map['号ID']]).trim() !== issue) continue;
      if (String(all[i][map['状態']]).trim() !== '') continue;
      pending.push({ row: i + 2, v: all[i] });
    }
    if (!pending.length) { finish(issue, '完了'); return issue + ' の送信が完了しました。'; }

    let budget = sendableNow();
    if (budget <= 0) {
      log(issue, '', '待機', '本日の送信枠を使い切りました。翌日に自動で再開します。');
      return '本日の送信枠を使い切りました。残り ' + pending.length + '件は翌日に自動で続きます。';
    }

    const built = campaignHtml(draft);
    const stopped = suppressedSet();
    const wait = cfgNum('1通ごとの間隔ミリ秒');
    const started = Date.now();
    const updates = [];   // [row, 状態, 処理日時, 詳細]
    let ok = 0, ng = 0, skip = 0;

    for (let i = 0; i < pending.length; i++) {
      if (Date.now() - started > MAX_RUN_MS) break;
      if (budget <= 0) break;

      const p = pending[i];
      const email = normEmail(p.v[map['メールアドレス']]);
      const rcpt = {
        email: email,
        宛名: p.v[map['宛名']], 法人名: p.v[map['法人名']], 事業所名: p.v[map['事業所名']], 都道府県: '',
      };

      // キューに積んだあとで配信停止が入ることがある。送る直前にもう一度見る
      if (stopped[email]) {
        updates.push([p.row, 'スキップ', nowStr(), '配信停止済み']);
        skip++;
        continue;
      }

      try {
        const one = personalize(built, rcpt);
        MailApp.sendEmail({
          to: email, subject: one.subject, htmlBody: one.html, body: one.text,
          name: cfg()['差出人名'], replyTo: cfg()['返信先'],
        });
        updates.push([p.row, '送信済', nowStr(), '']);
        ok++; budget--; sentToday(1);
        if (wait > 0) Utilities.sleep(wait);
      } catch (e) {
        updates.push([p.row, '失敗', nowStr(), String(e.message || e).slice(0, 300)]);
        log(issue, email, '失敗', e.message || e);
        ng++;
      }

      if (updates.length >= FLUSH_EVERY) { flushQueue(qsh, map, updates); updates.length = 0; }
    }
    if (updates.length) flushQueue(qsh, map, updates);

    const doneNow = Number(draft['送信済'] || 0) + ok;
    const failNow = Number(draft['失敗'] || 0) + ng;
    setCells(SHEETS.drafts, draft._row, { '送信済': doneNow, '失敗': failNow });

    const rest = pending.length - ok - ng - skip;
    log(issue, '', '進捗', '送信 ' + ok + ' / 失敗 ' + ng + ' / スキップ ' + skip + ' / 残り ' + rest);

    if (rest <= 0) { finish(issue, '完了'); return issue + ' の送信が完了しました（成功 ' + doneNow + '件、失敗 ' + failNow + '件）。'; }
    return '送信 ' + ok + '件。残り ' + rest + '件は5分後に自動で続きます。';

  } finally {
    lock.releaseLock();
  }
}

/** 号を終える。トリガーを外して、状態を書き戻す。 */
function finish(issue, reason) {
  removeTrigger();
  PropertiesService.getScriptProperties().deleteProperty(PROP_ISSUE);
  const d = draftByIssue(issue);
  if (d) setCells(SHEETS.drafts, d._row, { '状態': '送信済', '送信完了': nowStr() });
  log(issue, '', '完了', reason);
}

/** キューの状態列をまとめて書き戻す。1行ずつ書くと遅いのでバッチにする。 */
function flushQueue(qsh, map, updates) {
  // 状態・処理日時・詳細 は隣り合わせで並べてある前提（Sheets.gs の定義）
  const first = map['状態'] + 1;
  updates.forEach(function (u) {
    qsh.getRange(u[0], first, 1, 3).setValues([[u[1], u[2], u[3]]]);
  });
  SpreadsheetApp.flush();
}

/**
 * 送信中の号があるのに枠が尽きた翌日、自動で続きを流すための入口。
 * ensureTrigger() のトリガーがそのまま processQueue を呼ぶので、
 * 実際にはこの関数は「手で押して続きを送る」ためのもの。
 */
function resumeSending() {
  ensureTrigger();
  return processQueue();
}
