// マイク模擬、エラー処理、tweets.js、分割、新しいセッション、話し続けたときの動き
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { PAGE, mockAnthropic, collectErrors, waitText, openAll, pane } = require('./helpers');

// SpeechRecognition の模擬(Chromium はネイティブで持つので両方上書きする)
const fakeMic = () => {
  window.__starts = 0;
  window.SpeechRecognition = window.webkitSpeechRecognition = class { constructor() { window.__sr = this; } start() { window.__starts++; } stop() {} };
  window.__say = (t, final = true) => window.__sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: final })] });
};

async function openPage(browser, handler) {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const errors = collectErrors(page);
  await page.addInitScript(fakeMic);
  const calls = await mockAnthropic(page, handler);
  await page.goto(PAGE); await page.waitForTimeout(500);
  await page.fill('#apiKey', 'sk-ant-test');
  return { page, errors, calls };
}

test('マイク・エラー処理・tweets.js・分割・新しいセッション', async () => {
  const browser = await chromium.launch();
  try {
    let mode = 'ok', n = 0;
    const { page, errors } = await openPage(browser, kind => {
      n++;
      if (mode === 'abort') return 'abort';
      if (mode === '401') return { status: 401, message: 'invalid x-api-key' };
      if (mode === '429') return { status: 429, message: 'rate limited' };
      if (mode === '400') return { status: 400, message: 'model: claude-nope not found' };
      if (mode === 'badjson' && kind === 'topics') return 'すみません、JSONは出せません';
      if (kind === 'summary') return '・要約' + n;
      if (kind === 'topics') return '[{"title":"話題' + n + '","angle":"a","opener":"o","from":null}]';
      return '[{"title":"ネタ' + n + '","note":"n","tags":["t"]}]';
    });
    const status = () => page.textContent('#status');
    const clearStatus = () => page.evaluate(() => { document.querySelector('#status').textContent = ''; });

    // 1 マイク開始 / 認識途中 / 確定 / 自動再開
    await page.click('#go');
    assert.equal(await status(), '聞いています…');
    assert.equal(await page.textContent('#go'), '停止');
    assert.equal(await page.evaluate(() => window.__starts), 1);
    await page.evaluate(() => window.__say('途中の言葉', false));
    assert.equal(await page.textContent('#interim'), '認識中:途中の言葉');
    await page.evaluate(() => window.__say('マイクからの発言です'));
    await page.waitForSelector('#out .card', { timeout: 20000 });
    assert.match(await page.locator('#out .card h3').first().textContent(), /^話題\d+$/);
    await page.evaluate(() => window.__sr.onend());
    assert.equal(await page.evaluate(() => window.__starts), 2, '途切れたら再開する');
    await waitText(page, '#memo', t => t.includes('要約'), 30000);

    // 2 停止 → 最後の要約 + 保存
    await page.evaluate(() => window.__say('停止前の最後の発言です'));
    await page.click('#go');
    assert.equal(await page.textContent('#go'), 'マイクを開始');
    await waitText(page, '#saveNote', t => t.includes('保存済み'), 15000);
    await page.click('#tabRaw');
    const raw = await page.inputValue('#memo');
    await page.click('#tabSum');
    assert.ok(raw.includes('マイクからの発言です') && raw.includes('停止前の最後の発言です'));

    // 3 エラー処理(話題の間隔10秒・要約の間隔15秒を空けながら)
    await page.waitForTimeout(16000);
    mode = '401'; await clearStatus(); await page.click('#go'); await page.evaluate(() => window.__say('401を起こす発言'));
    let s = await waitText(page, '#status', t => t.includes('APIキー'));
    assert.match(s, /HTTP 401: invalid x-api-key/, 'APIのエラー文が出る');
    assert.equal(await page.textContent('#go'), '停止', '認可エラーでもマイクは止めない');
    assert.match(s, /文字起こしは続けています/);

    await page.waitForTimeout(11000);
    mode = '429'; await clearStatus(); await page.fill('#apiKey', 'sk-ant-test2'); await page.evaluate(() => window.__say('429を起こす発言'));
    s = await waitText(page, '#status', t => t.includes('利用上限'));
    assert.match(s, /HTTP 429/);
    await page.waitForTimeout(1000);
    assert.match(await status(), /利用上限/, '要約側のエラーで上書きしない');
    assert.equal(await page.textContent('#go'), '停止');

    await page.waitForTimeout(11000);
    mode = '400'; await clearStatus(); await page.fill('#apiKey', 'sk-ant-test3'); await page.evaluate(() => window.__say('400を起こす発言'));
    s = await waitText(page, '#status', t => t.includes('話題の生成に失敗'));
    assert.match(s, /HTTP 400: model: claude-nope not found/, 'モデル名の誤りが画面でわかる');
    assert.equal(await page.textContent('#go'), '停止', 'その他のエラーではマイクを止めない');

    await page.waitForTimeout(11000);
    mode = 'abort'; await clearStatus(); await page.evaluate(() => window.__say('通信失敗の発言'));
    s = await waitText(page, '#status', t => t.includes('話題の生成に失敗'));
    assert.match(s, /通信できませんでした/);

    await page.waitForTimeout(11000);
    mode = 'badjson'; await clearStatus(); await page.evaluate(() => window.__say('JSON不正の発言'));
    s = await waitText(page, '#status', t => t.includes('話題の生成に失敗'));
    assert.match(s, /読み取れませんでした/);
    await page.click('#go'); mode = 'ok';

    // 4 tweets.js の解析(RT・返信・短文を除き、いいね順、URL除去)
    const tw = [
      { tweet: { full_text: 'これは本人の長めの投稿で、いいねが一番多いものです。テスト用', favorite_count: '50' } },
      { tweet: { full_text: 'RT @someone: リツイートは除外されるべき投稿です。これはテスト用の長い文', favorite_count: '999' } },
      { tweet: { full_text: '@friend 返信は除外されるべき投稿です。これはテスト用の長い文章です', in_reply_to_status_id_str: '1', favorite_count: '500' } },
      { tweet: { full_text: '短い', favorite_count: '5' } },
      { tweet: { full_text: 'こちらはいいねが少ない本人の投稿です。URLも含む https://t.co/abc テスト用', favorite_count: '3' } }
    ];
    const twPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'tweets.js');
    fs.writeFileSync(twPath, 'window.YTD.tweet.part0 = ' + JSON.stringify(tw));
    await pane(page, 'nb'); await openAll(page); await page.setInputFiles('#nbFile', twPath); await page.waitForTimeout(500);
    const lines = (await page.inputValue('#nbPaste')).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /いいねが一番多い/);
    assert.ok(!lines[1].includes('https://'));

    await pane(page, 'memo');
    // 5 60,000字での分割 → 新しいセッション
    const sidBefore = await page.evaluate(() => sid);
    await page.evaluate(() => { rawPart = 'x'.repeat(60000); onSpeech('分割を起こす発言です'); });
    assert.equal(await page.evaluate(() => sid), sidBefore + '-2');
    await page.evaluate(() => { dirty = true; return save(); });
    await page.click('#newSess');
    await page.waitForFunction(() => !document.querySelector('#newSess').disabled && document.querySelector('#status').textContent.includes('新しいセッション'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    assert.match(await page.inputValue('#memo'), /話すと、ここに要約メモ/);
    assert.ok(await page.locator('#past option').count() >= 3, '分割した2パートが一覧に出る');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('要約の処理中に「新しいセッション」を押しても、前の要約が混ざらない', async () => {
  const browser = await chromium.launch();
  try {
    let release; const gate = new Promise(r => { release = r; });
    const { page, errors, calls } = await openPage(browser, async kind => {
      if (kind === 'summary') { await gate; return '・前のセッションの要約'; }
      if (kind === 'topics') return '[{"title":"t","angle":"a","opener":"o","from":null}]';
      return '[]';
    });
    await page.fill('#manual', '前のセッションの発言です'); await page.press('#manual', 'Enter');
    for (let i = 0; i < 50 && !calls.some(c => c.kind === 'summary'); i++) await page.waitForTimeout(200);
    assert.ok(calls.some(c => c.kind === 'summary'), '要約の呼び出しが始まっている');
    await page.click('#newSess');
    await page.waitForTimeout(300);
    release();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('新しいセッション'), null, { timeout: 10000 });
    await page.fill('#manual', '新しいセッションの発言です'); await page.press('#manual', 'Enter');
    await page.waitForTimeout(500);
    assert.ok(!(await page.inputValue('#memo')).includes('前のセッションの要約'), '新しいセッションに前の要約が入らない');
    await page.click('#tabRaw');
    assert.match((await page.inputValue('#memo')).trim(), /^\[0:0\d\] 新しいセッションの発言です$/, '新しい発言が欠けない');
    await page.click('#tabSum');
    await page.selectOption('#past', { index: 1 });
    assert.match(await page.inputValue('#memo'), /前のセッションの要約/, '前の要約は前のセッションに保存される');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('話し続けても、要約は数秒で、話題は20秒以内に出る', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors, calls } = await openPage(browser, kind =>
      kind === 'summary' ? '・続けて話した' : kind === 'topics' ? '[{"title":"続き","angle":"a","opener":"o","from":null}]' : '[]');
    await page.click('#go');
    const t0 = Date.now();
    let sumAt = 0, topicAt = 0;
    while (Date.now() - t0 < 24000 && !(sumAt && topicAt)) {
      await page.evaluate(i => window.__say('途切れずに話している発言その' + i), Date.now());
      await page.waitForTimeout(1000);
      if (!sumAt && calls.some(c => c.kind === 'summary')) sumAt = Date.now() - t0;
      if (!topicAt && calls.some(c => c.kind === 'topics')) topicAt = Date.now() - t0;
    }
    assert.ok(sumAt && sumAt < 6000, '要約の呼び出し: ' + sumAt + 'ms');
    assert.ok(topicAt && topicAt < 23000, '話題の呼び出し: ' + topicAt + 'ms');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('キー未入力でマイクを開始しても文字起こしは続き、キーを入れると話題と要約が始まる', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = collectErrors(page);
    await page.addInitScript(fakeMic);
    const calls = await mockAnthropic(page, k => k === 'summary' ? '・あとから要約' : k === 'topics' ? '[{"title":"キー後の話題","angle":"a","opener":"o","from":null}]' : '[]');
    await page.goto(PAGE); await page.waitForTimeout(500);
    await page.click('#go');
    assert.match(await page.textContent('#status'), /APIキーが未入力です.*文字起こしは続けています/);
    await page.evaluate(() => window.__say('キーなしで話した発言です'));
    await page.waitForTimeout(4000);
    assert.equal(await page.textContent('#go'), '停止', 'マイクは止まらない');
    assert.equal(calls.length, 0, 'AIは呼ばない');
    await page.click('#tabRaw');
    assert.match(await page.inputValue('#memo'), /キーなしで話した発言です/, '文字起こしは残る');
    await page.click('#tabSum');
    await page.fill('#apiKey', 'sk-ant-test');
    await waitText(page, '#memo', t => t.includes('あとから要約'), 10000);
    await page.evaluate(() => window.__say('キーを入れたあとの発言です'));
    await page.waitForSelector('#out .card', { timeout: 10000 });
    assert.equal(await page.textContent('#status'), '聞いています…');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('一度動いたあとに再開を拒否されたら、止めずに待ち、タブに戻ったら再開する', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openPage(browser, () => '[]');
    await page.click('#go');
    await page.evaluate(() => { window.__sr.onstart(); window.__sr.onerror({ error: 'not-allowed' }); window.__sr.onend(); });
    assert.equal(await page.textContent('#go'), '停止', 'マイクは止めない');
    assert.match(await page.textContent('#status'), /このタブを表示すると再開/);
    const before = await page.evaluate(() => window.__starts);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.evaluate(() => window.__starts), before + 1, 'タブに戻ると再開を試す');
    await page.evaluate(() => window.__sr.onstart());
    assert.equal(await page.textContent('#status'), '聞いています…');
    const log = await page.evaluate(() => window.__srLog.map(x => x.type + (x.detail ? ':' + x.detail : '')));
    assert.ok(log.includes('error:not-allowed') && log.includes('end'), '記録が残る: ' + log);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('最初の開始でマイクを拒否されたら止め、その理由を後から上書きしない', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openPage(browser, k => k === 'topics' ? '[{"title":"t","angle":"a","opener":"o","from":null}]' : '・s');
    await page.click('#go');
    await page.evaluate(() => window.__sr.onerror({ error: 'not-allowed' }));
    assert.equal(await page.textContent('#go'), 'マイクを開始');
    await page.click('#now'); // 話題の生成が終わっても理由が残る
    await page.waitForSelector('#out .card', { timeout: 10000 });
    assert.equal(await page.textContent('#status'), 'マイクの使用が許可されていません');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('音声認識のエラーが続いたら、再開をやめて知らせる', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openPage(browser, () => '[]');
    await page.click('#go');
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__sr.onerror({ error: 'network' }); window.__sr.onend(); });
    assert.match(await page.textContent('#status'), /音声認識が続けて失敗/);
    assert.equal(await page.textContent('#go'), 'マイクを開始');
    assert.equal(await page.evaluate(() => window.__starts), 1, '再開しない');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
