// 2026-11-05 に追加した機能と、機能のオン・オフ
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');
const { PAGE, mockAnthropic, collectErrors, waitText, openAll, pane, setFeatures } = require('./helpers');

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (route, obj, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(obj) });

// AIの模擬: 指示文の中身で返す内容を変える
const reply = (kind, p) =>
  p.includes('構成作家') ? JSON.stringify({ outline: [{ name: 'オープニング', min: 5 }, { name: '本題', min: 40 }], opening: 'こんばんは', topics: [{ title: '準備の話題A', note: '広げ方' }], closing: 'またね' })
  : p.includes('誤変換だけを直して') ? p.split('文字起こし:\n')[1].replace(/機会学習/g, '機械学習')
  : kind === 'summary' ? '・要約です'
  : kind === 'topics' ? '[{"title":"提案された話題","angle":"a","opener":"o","from":null}]'
  : '[]';

async function open(browser, { features, ctxOpts = {}, handler } = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  if (features) await setFeatures(page, features);
  await page.addInitScript(() => {
    window.__starts = 0;
    window.SpeechRecognition = window.webkitSpeechRecognition = class { constructor() { window.__sr = this; } start() { window.__starts++; } stop() {} };
  });
  const calls = await mockAnthropic(page, handler || reply);
  await page.goto(PAGE); await page.waitForTimeout(400);
  await openAll(page);
  await page.fill('#apiKey', 'sk-ant-test');
  return { ctx, page, errors, calls };
}
const lastTopicsPrompt = calls => (calls.filter(c => c.kind === 'topics').pop() || {}).prompt || '';
const say = async (page, t) => { await page.fill('#manual', t); await page.press('#manual', 'Enter'); };

test('オン・オフ: 既定ではコメントとOBSが切れていて、切り替えると表示と保存に反映される', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser);
    assert.equal(await page.isVisible('#chatSrc'), false, 'コメントは既定でオフ');
    assert.equal(await page.isVisible('#g-overlay'), false, 'OBSは既定でオフ');
    assert.equal(await page.isVisible('#out'), true);
    assert.equal(await page.locator('#featList input').count(), 15);
    await page.check('[data-feat="chat"]');
    await page.check('[data-feat="overlay"]');
    assert.equal(await page.isVisible('#chatSrc'), true);
    assert.equal(await page.isVisible('#g-overlay'), true);
    await page.uncheck('[data-feat="topics"]');
    assert.equal(await page.isVisible('#out'), false, '話題を切ると消える');
    assert.equal(await page.isVisible('#now'), false);
    await page.reload(); await page.waitForTimeout(300); await openAll(page);
    assert.equal(await page.isVisible('#chatSrc'), true, '再読み込み後も覚えている');
    assert.equal(await page.isVisible('#out'), false);
    assert.equal(await page.isChecked('[data-feat="topics"]'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('オン・オフ: 切った機能はAIを呼ばず、指示文にも入らない', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser, { features: { summary: false, notebook: false, news: false } });
    assert.equal(await page.isVisible('#tabSum'), false, '要約タブが消える');
    assert.equal(await page.isVisible('.sidetabs [data-pane="nb"]'), false, 'ネタ帳タブが消える');
    assert.equal(await page.isVisible('#g-news'), false);
    assert.equal(await page.getAttribute('#tabRaw', 'aria-pressed'), 'true', '文字起こしを表示');
    await page.evaluate(() => { notes = [newNote({ title: 'ネタ帳のネタ' })]; document.querySelector('#news').value = '・ニュースの見出し'; });
    await say(page, 'こんにちは、今日は雑談です');
    await page.waitForSelector('#out .card', { timeout: 10000 });
    await page.waitForTimeout(4000);
    assert.equal(calls.filter(c => c.kind === 'summary').length, 0, '要約を呼ばない');
    const p = lastTopicsPrompt(calls);
    assert.ok(!p.includes('ネタ帳のネタ') && !p.includes('ニュースの見出し'), 'ネタ帳と時事ネタを使わない');

    // 話題を切ると、話しても呼ばない
    await page.uncheck('[data-feat="topics"]');
    const n = calls.length;
    await say(page, 'もう一度話します'); await page.waitForTimeout(3500);
    assert.equal(calls.length, n, '話題も要約も呼ばない');
    assert.match(await page.inputValue('#memo'), /もう一度話します/, '文字起こしは続く');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('オン・オフ: タブ・音声認識・進行表の連動', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser);
    // 準備タブは、進行表と準備の両方を切ったときだけ消える
    await page.uncheck('[data-feat="prep"]');
    assert.equal(await page.isVisible('.sidetabs [data-pane="prep"]'), true);
    await page.uncheck('[data-feat="plan"]');
    assert.equal(await page.isVisible('.sidetabs [data-pane="prep"]'), false);
    // 検索とバックアップを両方切ると、過去タブに案内が出る
    await pane(page, 'past');
    await page.uncheck('[data-feat="search"]'); await page.uncheck('[data-feat="backup"]');
    assert.match(await page.textContent('#pane-past'), /切られています/);
    // 表示中のタブを切ると、メモに戻る
    await page.check('[data-feat="prep"]'); await pane(page, 'prep');
    await page.uncheck('[data-feat="prep"]');
    assert.equal(await page.isVisible('#pane-memo'), true);
    // 手元のWhisperを切ると、ブラウザの音声認識に戻る
    await page.selectOption('#sttMode', 'local');
    await page.uncheck('[data-feat="localStt"]');
    assert.equal(await page.inputValue('#sttMode'), 'browser');
    // 右の列のタブは矢印キーでも移れる
    await page.focus('.sidetabs [data-pane="memo"]'); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('.sidetabs [data-pane="recap"]', 'aria-selected'), 'true');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('配信スタイル・進行表・タイマー', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser);
    await page.selectOption('#style', 'game');
    await pane(page, 'prep');
    await page.fill('#planText', 'オープニング 5\n本題 30分\nフリー');
    await page.click('#planStart');
    assert.equal(await page.isVisible('#runBar'), true);
    assert.match(await page.textContent('#runSeg'), /1\/3 オープニング/);
    assert.match(await page.textContent('#runTime'), /残り [45]:\d\d/);
    assert.match(await page.textContent('#runNext'), /次:本題/);
    await page.click('#now'); await page.waitForTimeout(600);
    const p = lastTopicsPrompt(calls);
    assert.ok(p.includes('ゲーム実況'), 'スタイルが入る');
    assert.ok(p.includes('今のコーナーは「オープニング」') && p.includes('次は「本題」'), '進行が入る');
    // 超過の表示
    await page.evaluate(() => { segStart = Date.now() - 6 * 60 * 1000; renderPlan(); });
    assert.match(await page.textContent('#runTime'), /^\+1:0\d 超過$/);
    assert.equal(await page.getAttribute('#runTime', 'class'), 'over');
    await page.click('#planNext'); await page.click('#planNext');
    assert.match(await page.textContent('#runSeg'), /3\/3 フリー/);
    assert.equal(await page.textContent('#runTime'), '', '分のないコーナーは残り時間を出さない');
    await page.click('#planNext');
    assert.equal(await page.isVisible('#runBar'), false, '最後のあとは消える');
    await page.click('#planStart'); await page.click('#planReset');
    assert.equal(await page.isVisible('#runBar'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('沈黙の知らせ', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser);
    await page.selectOption('#silence', '15');
    await page.click('#go');
    await page.evaluate(() => { lastSpeechAt = Date.now() - 16000; });
    await waitText(page, '#silenceBar', t => t.includes('15秒'), 3000);
    await page.waitForTimeout(500);
    assert.ok(calls.some(c => c.kind === 'topics'), '新しい話題を頼む');
    await page.evaluate(() => window.__sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: '話しはじめました' }], { isFinal: true })] }));
    assert.equal(await page.isVisible('#silenceBar'), false, '話すと消える');
    // 「使わない」なら出ない
    await page.selectOption('#silence', '0');
    await page.evaluate(() => { lastSpeechAt = Date.now() - 600000; });
    await page.waitForTimeout(1500);
    assert.equal(await page.isVisible('#silenceBar'), false);
    // マイクを止めていれば出ない
    await page.selectOption('#silence', '15'); await page.click('#go');
    await page.evaluate(() => { lastSpeechAt = Date.now() - 600000; });
    await page.waitForTimeout(1500);
    assert.equal(await page.isVisible('#silenceBar'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('視聴者のコメント: Twitch(模擬)と、話題の提案への反映', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser, { features: { chat: true } });
    const sent = [];
    await page.routeWebSocket(/irc-ws\.chat\.twitch\.tv/, ws => {
      ws.onMessage(m => {
        sent.push(String(m));
        if (String(m).startsWith('JOIN')) {
          ws.send('@badge-info=;display-name=見る人;color= :viewer1!viewer1@viewer1.tmi.twitch.tv PRIVMSG #testch :おすすめのゲームは何ですか?\r\n');
          ws.send('PING :tmi.twitch.tv\r\n');
          ws.send(':viewer2!viewer2@viewer2.tmi.twitch.tv PRIVMSG #testch :こんばんは\r\n');
        }
      });
    });
    await page.selectOption('#chatSrc', 'twitch'); await page.fill('#chatId', 'https://www.twitch.tv/TestCh');
    await page.click('#chatConnect');
    await page.waitForFunction(() => chat.length === 2, null, { timeout: 5000 });
    assert.ok(sent.includes('JOIN #testch'), 'チャンネル名を整えて入る');
    assert.ok(sent.some(s => s.startsWith('PONG')), 'PINGに答える');
    assert.equal(await page.textContent('#chatList li:last-child .by'), '見る人', '表示名を使う');
    assert.match(await page.getAttribute('#chatList li:last-child', 'class'), /q/, '質問に色が付く');
    await page.click('#now'); await page.waitForTimeout(600);
    let p = lastTopicsPrompt(calls);
    assert.ok(p.includes('見る人: おすすめのゲームは何ですか?') && p.includes('viewer2: こんばんは'));
    // クリックで「答えた」→ 提案に使わない
    await page.click('#chatList li:last-child');
    assert.match(await page.getAttribute('#chatList li:last-child', 'class'), /done/);
    await page.waitForTimeout(10500); await page.click('#now'); await page.waitForTimeout(600);
    p = lastTopicsPrompt(calls);
    assert.ok(!p.includes('おすすめのゲーム') && p.includes('viewer2'));
    // 「提案に使う」を外すと入らない
    await page.uncheck('#chatUse');
    assert.equal(await page.evaluate(() => chatForPrompt()), '');
    await page.click('#chatConnect');
    assert.equal(await page.textContent('#chatConnect'), '接続');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('視聴者のコメント: YouTube Live(模擬)', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { features: { chat: true } });
    const reqs = [];
    await page.route('https://www.googleapis.com/**', route => {
      const r = route.request();
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      reqs.push({ url: r.url(), key: r.headers()['x-goog-api-key'] });
      if (r.url().includes('/videos')) return json(route, { items: [{ liveStreamingDetails: { activeLiveChatId: 'CHAT1' } }] });
      return json(route, { items: [{ authorDetails: { displayName: 'yt太郎' }, snippet: { displayMessage: '初見です' } }], nextPageToken: 'P2', pollingIntervalMillis: 3000 });
    });
    await page.selectOption('#chatSrc', 'youtube');
    assert.equal(await page.isVisible('#ytKey'), true);
    await page.fill('#chatId', 'https://www.youtube.com/live/abcdefghijk?si=x');
    await page.click('#chatConnect');
    assert.match(await page.textContent('#chatStat'), /キー/, 'キーがないと始めない');
    await page.fill('#ytKey', 'AIza-yt-test');
    await page.click('#chatConnect');
    await page.waitForFunction(() => chat.length >= 1, null, { timeout: 5000 });
    assert.ok(reqs[0].url.includes('id=abcdefghijk'), 'URLから動画IDを取り出す');
    assert.ok(reqs.every(r => r.key === 'AIza-yt-test' && !r.url.includes('AIza')), 'キーはヘッダーで送り、URLに入れない');
    assert.ok(reqs[1].url.includes('liveChatId=CHAT1'));
    assert.equal(await page.textContent('#chatList li .by'), 'yt太郎');
    assert.equal(await page.evaluate(() => ytVideoId('abcdefghijk')), 'abcdefghijk');
    assert.equal(await page.evaluate(() => ytVideoId('https://youtu.be/abcdefghijk')), 'abcdefghijk');
    await page.click('#chatConnect');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('OBSに表示: お題・進行・コメントを手元のサーバーに送る', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { features: { overlay: true, chat: true } });
    const posts = [];
    let up = true;
    await page.route('http://127.0.0.1:8790/overlay/state', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (!up) return route.abort();
      posts.push(JSON.parse(route.request().postData()));
      return json(route, { ok: true });
    });
    await page.check('#ovOn');
    await page.fill('#ovTopic', '今日のお題');
    await page.waitForTimeout(300);
    assert.equal(posts.pop().topic, '今日のお題');
    // 進行表のコーナーと残り時間
    await pane(page, 'prep'); await page.fill('#planText', 'オープニング 5'); await page.click('#planStart');
    await page.waitForTimeout(1300);
    const s = posts.pop();
    assert.equal(s.segment, 'オープニング'); assert.match(s.timer, /^残り [45]:\d\d$/);
    // 話題カードのダブルクリックでお題に
    await page.click('#now'); await page.waitForSelector('#out .card');
    await page.dblclick('#out .card');
    await page.waitForTimeout(300);
    assert.equal(posts.pop().topic, '提案された話題');
    // コメントの Shift+クリック
    await page.evaluate(() => addChat('viewer1', 'こんにちは'));
    await page.click('#chatList li', { modifiers: ['Shift'] });
    await page.waitForTimeout(300);
    const c = posts.pop(); assert.equal(c.comment, 'こんにちは'); assert.equal(c.commentBy, 'viewer1');
    // 消す
    await page.click('#ovClear'); await page.waitForTimeout(300);
    const cl = posts.pop(); assert.equal(cl.topic, ''); assert.equal(cl.comment, '');
    // サーバーがないと知らせる
    up = false; await page.fill('#ovTopic', '別のお題');
    await waitText(page, '#ovStat', t => t.includes('送れません'), 3000);
    // 機能を切ると送らない
    up = true; await page.uncheck('[data-feat="overlay"]'); const n = posts.length;
    await page.evaluate(() => { document.querySelector('#ovTopic').value = 'さらに別'; ovPush(true); });
    await page.waitForTimeout(1300);
    assert.equal(posts.length, n);
    assert.deepEqual(errors.filter(e => !/8790/.test(e)), []);
  } finally { await browser.close(); }
});

test('配信前の準備', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser);
    await pane(page, 'prep');
    await page.click('#prepGo');
    assert.match(await page.textContent('#prepStat'), /テーマ/);
    await page.selectOption('#style', 'radio');
    await page.fill('#prepTheme', '週末のキャンプ'); await page.fill('#prepMin', '45');
    await page.click('#prepGo');
    await waitText(page, '#prepStat', t => t.includes('作りました'), 10000);
    const p = calls.pop().prompt;
    assert.ok(p.includes('週末のキャンプ') && p.includes('45分') && p.includes('ラジオ'));
    assert.match(await page.textContent('#prepText'), /オープニング 5分[\s\S]*こんばんは[\s\S]*準備の話題A/);
    await page.click('#prepToPlan');
    assert.equal(await page.inputValue('#planText'), 'オープニング 5\n本題 40');
    await page.click('#prepToNb');
    assert.match(await page.textContent('#prepStat'), /1件/);
    await page.click('#prepToNb');
    assert.match(await page.textContent('#prepStat'), /0件/, '同じ題は重ねて入れない');
    await pane(page, 'nb');
    assert.match(await page.textContent('#nbList'), /準備の話題A/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('時事ネタの取得(手元のサーバーは模擬)', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser);
    let lastUrl = '', up = true;
    await page.route('http://127.0.0.1:8790/news**', route => {
      lastUrl = route.request().url();
      if (!up) return route.abort();
      return json(route, { items: [{ title: '見出しA', date: 'Wed, 04 Nov 2026 20:32:13 +0900' }, { title: '見出しB', date: '' }, { title: '', error: 'x' }] });
    });
    // 既定の取得元は持たない: 空なら取りに行かず、入れるよう知らせる
    await page.click('#newsFetch');
    assert.match(await page.textContent('#newsStat'), /RSSのURLを入れて/);
    assert.equal(lastUrl, '', '取得元が空なら呼ばない');
    await page.fill('#newsFeeds', 'https://example.com/a.xml\nnot-a-url\nhttps://example.com/b.xml');
    await page.click('#newsFetch');
    await waitText(page, '#newsStat', t => t.includes('2件'), 5000);
    const v = await page.inputValue('#news');
    assert.match(v, /^\(\d+\/\d+ \d\d:\d\d 取得/);
    assert.ok(v.includes('・見出しA(11/4)') && v.includes('・見出しB'));
    assert.ok(lastUrl.includes('url=https%3A%2F%2Fexample.com%2Fa.xml&url=https%3A%2F%2Fexample.com%2Fb.xml'), 'http(s)のURLだけ渡す');
    // 取った見出しが話題の指示文に入る
    await page.click('#now'); await page.waitForTimeout(600);
    assert.ok(lastTopicsPrompt(calls).includes('見出しA'));
    up = false; await page.click('#newsFetch');
    await waitText(page, '#newsStat', t => t.includes('起動している'), 5000);
    await page.reload(); await page.waitForTimeout(300); await openAll(page);
    assert.match(await page.inputValue('#news'), /見出しA/, '取った見出しも保存される');
    assert.deepEqual(errors.filter(e => !/8790/.test(e)), []);
  } finally { await browser.close(); }
});

test('誤変換の補正と、補正前に戻す', async () => {
  const browser = await chromium.launch();
  try {
    const { page, calls, errors } = await open(browser);
    // 「認識させたい語」は手元のWhisperを選んだときに出る欄だが、補正の用語集にも使う
    await page.selectOption('#sttMode', 'local'); await page.fill('#sttWords', '機械学習'); await page.selectOption('#sttMode', 'browser');
    await say(page, 'AIの機会学習について話します');
    await say(page, '二行目も機会学習の話');
    await page.click('#fixBtn');
    await waitText(page, '#fixStat', t => t.includes('2行を直しました'), 10000);
    const p = calls.filter(c => c.prompt.includes('誤変換だけを直して')).pop().prompt;
    assert.ok(p.includes('機械学習') && /\[0:0\d\] AIの機会学習/.test(p), '用語集と時刻つきの行を渡す');
    let raw = await page.evaluate(() => rawLog);
    assert.match(raw, /^\[0:0\d\] AIの機械学習について話します\n\[0:0\d\] 二行目も機械学習の話\n$/);
    // 補正のあとに話した分は、戻しても残る
    await say(page, '補正のあとに話した');
    await page.click('#fixUndo');
    raw = await page.evaluate(() => rawLog);
    assert.ok(raw.includes('機会学習について') && raw.includes('補正のあとに話した') && !raw.includes('機械学習'));
    assert.equal(await page.isVisible('#fixUndo'), false);
    // AIが行を崩して返したら、その行は元のまま
    await page.evaluate(() => { window.__badFix = true; });
    await page.route('https://api.anthropic.com/**', route => json(route, { content: [{ type: 'text', text: 'まったく違う一行' }] }));
    await page.click('#fixBtn');
    await waitText(page, '#fixStat', t => t.includes('0行を直しました'), 10000);
    assert.equal(await page.evaluate(() => rawLog), raw);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('利用料の表示', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser);
    await page.route('https://api.anthropic.com/**', route => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS })
      : json(route, { content: [{ type: 'text', text: '[{"title":"t","angle":"a","opener":"o","from":null}]' }], usage: { input_tokens: 1500, output_tokens: 300 } }));
    assert.equal(await page.textContent('#usage'), '');
    await page.click('#now'); await page.waitForTimeout(600);
    assert.equal(await page.textContent('#usage'), 'このセッションのAI利用:1回 / 入力 1,500・出力 300 トークン');
    await page.fill('#priceIn', '1'); await page.fill('#priceOut', '5');
    assert.match(await page.textContent('#usage'), /約 \$0\.003/);
    await page.reload(); await page.waitForTimeout(300); await openAll(page);
    assert.equal(await page.inputValue('#priceIn'), '1', '料金は覚えている');
    await page.uncheck('[data-feat="usage"]');
    assert.equal(await page.isVisible('#usage'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('過去の配信を探す・バックアップと移行', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { features: { chat: true } });
    await say(page, '週末にキャンプへ行きました');
    await page.evaluate(() => addChat('viewer1', 'いいね'));
    await page.evaluate(() => { dirty = true; return save(); });
    await page.click('#newSess'); await page.waitForTimeout(800);
    await say(page, '今日はゲームの話');
    await page.evaluate(() => { dirty = true; return save(); });
    await pane(page, 'past');
    await page.fill('#searchQ', 'キャンプ'); await page.press('#searchQ', 'Enter');
    const found = await waitText(page, '#searchStat', t => /件|見つかりません|できません/.test(t), 5000);
    assert.match(found, /^1件/, found);
    await page.click('#hits li');
    assert.equal(await page.isVisible('#pane-past'), false);
    await pane(page, 'memo');
    assert.match(await page.inputValue('#memo'), /キャンプへ行きました/, 'その回を開く');
    await pane(page, 'past');
    await page.fill('#searchQ', '存在しない言葉'); await page.click('#searchGo');
    await waitText(page, '#searchStat', t => t.includes('見つかりません'), 5000);

    // 書き出し(APIキーは含めない)
    await page.check('#keyRemember');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#bkExport')]);
    assert.match(d.suggestedFilename(), /^topic-generator-backup-\d{4}-\d\d-\d\d\.json$/);
    const text = fs.readFileSync(await d.path(), 'utf8');
    const bk = JSON.parse(text);
    assert.equal(bk.app, 'topic-generator');
    assert.equal(bk.sessions.length, 2);
    assert.ok(!text.includes('sk-ant-test'), 'APIキーは入らない');
    assert.ok(bk.sessions.some(s => (s.data.chat || []).some(c => c.text === 'いいね')), 'コメントも入る');
    const file = d.path ? await d.path() : null;

    // 別のブラウザで読み込む
    const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
    const e2 = collectErrors(p2);
    await p2.goto(PAGE); await p2.waitForTimeout(300);
    p2.on('dialog', dlg => dlg.accept());
    await p2.click('.sidetabs [data-pane="past"]');
    await p2.setInputFiles('#bkImport', file);
    await waitText(p2, '#bkStat', t => t.includes('読み込みました'), 5000);
    assert.equal(await p2.locator('#past option').count(), 3, '2件のセッションが入る');
    await p2.reload(); await p2.waitForTimeout(300);
    assert.ok(await p2.evaluate(() => localStorage.getItem('features')), '機能のオン・オフも移る');
    // 形式の違うファイルは読まない
    fs.writeFileSync(file + '.bad.json', '{"app":"other"}');
    await p2.click('.sidetabs [data-pane="past"]');
    await p2.setInputFiles('#bkImport', file + '.bad.json');
    await waitText(p2, '#bkStat', t => t.includes('読み込めませんでした'), 5000);
    assert.deepEqual(errors, []); assert.deepEqual(e2, []);
  } finally { await browser.close(); }
});

test('AIの提供元: OpenAI・Gemini・OpenAI互換', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser);
    const got = {};
    const ok = (route, body) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : json(route, body);
    const topics = '[{"title":"t","angle":"a","opener":"o","from":null}]';
    await page.route('https://api.openai.com/**', route => { if (route.request().method() === 'POST') got.openai = { url: route.request().url(), h: route.request().headers(), b: JSON.parse(route.request().postData()) }; return ok(route, { choices: [{ message: { content: topics } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); });
    await page.route('https://generativelanguage.googleapis.com/**', route => { if (route.request().method() === 'POST') got.gemini = { url: route.request().url(), h: route.request().headers(), b: JSON.parse(route.request().postData()) }; return ok(route, { candidates: [{ content: { parts: [{ text: topics }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }); });
    await page.route('http://127.0.0.1:11434/**', route => { if (route.request().method() === 'POST') got.compat = { url: route.request().url(), h: route.request().headers(), b: JSON.parse(route.request().postData()) }; return ok(route, { choices: [{ message: { content: topics } }] }); });
    const ask = async () => { await page.evaluate(() => { last = 0; }); await page.click('#now'); await page.waitForTimeout(500); };

    await page.check('#keyRemember'); // Anthropic のキーを覚えさせる
    await page.selectOption('#aiProvider', 'openai');
    assert.equal(await page.inputValue('#apiKey'), '', '提供元ごとにキーは別');
    await page.fill('#apiKey', 'sk-openai'); await ask();
    assert.match(await page.textContent('#status'), /モデル名が未設定/, 'モデル名がないと呼ばない');
    await page.fill('#modelName', 'oa-model'); await page.dispatchEvent('#modelName', 'change'); await ask();
    assert.equal(got.openai.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(got.openai.h.authorization, 'Bearer sk-openai');
    assert.equal(got.openai.b.model, 'oa-model'); assert.equal(got.openai.b.max_completion_tokens, 2000);
    assert.equal(await page.locator('#out .card').count() > 0, true);

    await page.selectOption('#aiProvider', 'gemini');
    await page.fill('#apiKey', 'AIza-gem'); await page.fill('#modelName', 'gem-model'); await ask();
    assert.equal(got.gemini.url, 'https://generativelanguage.googleapis.com/v1beta/models/gem-model:generateContent');
    assert.equal(got.gemini.h['x-goog-api-key'], 'AIza-gem');
    assert.equal(got.gemini.b.generationConfig.maxOutputTokens, 2000);

    await page.selectOption('#aiProvider', 'compat');
    assert.equal(await page.isVisible('#aiBase'), true);
    await page.fill('#apiKey', ''); await page.fill('#modelName', 'llama-local'); await ask();
    assert.equal(got.compat.url, 'http://127.0.0.1:11434/v1/chat/completions', 'キーなしでも呼べる');
    assert.equal(got.compat.h.authorization, undefined);
    assert.equal(got.compat.b.max_tokens, 2000);
    assert.match(await page.textContent('#usage'), /3回 \/ 入力 17・出力 8/, '提供元ごとの使用量を数える');

    await page.selectOption('#aiProvider', 'anthropic');
    assert.equal(await page.inputValue('#apiKey'), 'sk-ant-test', 'Anthropic のキーに戻る');
    assert.equal(await page.inputValue('#modelName'), 'claude-haiku-5-5');
    await page.reload(); await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#aiProvider'), 'anthropic');
    assert.deepEqual(errors.filter(e => !/11434/.test(e)), []);
  } finally { await browser.close(); }
});
