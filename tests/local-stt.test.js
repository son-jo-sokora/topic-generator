// 手元の文字起こしサーバー方式(サーバーは模擬)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PAGE, mockAnthropic, collectErrors, waitText, openAll } = require('./helpers');

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

async function setup(browser, { serverUp = true } = {}) {
  const page = await (await browser.newContext()).newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    window.__starts = 0;
    window.SpeechRecognition = window.webkitSpeechRecognition = class { constructor() { window.__sr = this; } start() { window.__starts++; } stop() {} };
  });
  await mockAnthropic(page, k => k === 'summary' ? '・手元で要約' : k === 'topics' ? '[{"title":"t","angle":"a","opener":"o","from":null}]' : '[]');
  const sent = [];
  await page.route('http://127.0.0.1:8790/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (!serverUp) return route.abort();
    if (req.url().endsWith('/health')) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"ok":true}' });
    const buf = req.postDataBuffer();
    sent.push({ riff: buf.slice(0, 4).toString(), rate: buf.readUInt32LE(24), bytes: buf.length, hot: decodeURIComponent(req.headers()['x-hotwords'] || '') });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ text: '手元の発言' + sent.length }) });
  });
  await page.goto(PAGE); await page.waitForTimeout(400);
  await page.fill('#apiKey', 'sk-ant-test');
  await openAll(page);
  return { page, errors, sent };
}

// 実際のマイクの音は数えるだけにして、区切りの判定には決まった音を流す
const hookFrames = page => page.evaluate(() => {
  window.__frames = 0; window.__orig = localFrame;
  window.localFrame = () => { window.__frames++; };
});
const feed = (page, pattern) => page.evaluate(p => {
  for (const [amp, n] of p) for (let i = 0; i < n; i++) {
    const x = new Float32Array(1600);
    for (let j = 0; j < x.length; j++) x[j] = amp * Math.sin(j / 3);
    window.__orig(x);
  }
}, pattern);

test('手元方式: 話の切れ目で区切ってWAVを送り、返った文字を記録する', async () => {
  const browser = await chromium.launch({ args: ARGS });
  try {
    const { page, errors, sent } = await setup(browser);
    await page.selectOption('#sttMode', 'local');
    assert.equal(await page.isVisible('#sttLocalBox'), true);
    await page.fill('#sttWords', '北海道, ハンバーグ');
    await hookFrames(page);
    await page.click('#go');
    await waitText(page, '#status', t => t.includes('手元のWhisper'), 10000);
    await page.waitForFunction(() => window.__frames > 5, null, { timeout: 5000 });

    await feed(page, [[0.001, 20], [0.2, 10], [0.001, 8]]); // 静か → 1秒話す → 0.8秒黙る
    await feed(page, [[0.2, 1], [0.001, 8]]);                // 0.1秒の物音は送らない
    await feed(page, [[0.2, 12], [0.001, 8]]);               // もう一度話す
    await page.click('#tabRaw');
    await waitText(page, '#memo', t => t.includes('手元の発言2'), 10000);
    const raw = await page.inputValue('#memo');
    assert.ok(raw.includes('手元の発言1') && raw.indexOf('手元の発言1') < raw.indexOf('手元の発言2'), '順番どおり');
    assert.equal(sent.length, 2, '物音は送らない');
    assert.equal(sent[0].riff, 'RIFF');
    assert.equal(sent[0].rate, 16000);
    assert.ok(sent[0].bytes > 16000 * 2 * 1, '前後の音も含めて1秒以上');
    assert.equal(sent[0].hot, '北海道, ハンバーグ');

    // 話している途中で止めても、その分は送る
    await feed(page, [[0.2, 6]]);
    await page.click('#go');
    await waitText(page, '#memo', t => t.includes('手元の発言3'), 10000);
    assert.equal(await page.evaluate(() => lc), null);
    assert.equal(await page.evaluate(() => window.__starts), 0, 'ブラウザの音声認識は使っていない');

    // 方式の選択は保存される
    await page.reload(); await page.waitForTimeout(300); await openAll(page);
    assert.equal(await page.inputValue('#sttMode'), 'local');
    assert.equal(await page.inputValue('#sttWords'), '北海道, ハンバーグ');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('手元方式: サーバーにつながらなければ、ブラウザの音声認識に切り替える', async () => {
  const browser = await chromium.launch({ args: ARGS });
  try {
    const { page, errors } = await setup(browser, { serverUp: false });
    await page.selectOption('#sttMode', 'local');
    await page.click('#go');
    const s = await waitText(page, '#status', t => t.includes('つながりません'), 10000);
    assert.match(s, /ブラウザの音声認識で続けます/);
    assert.equal(await page.evaluate(() => window.__starts), 1);
    assert.equal(await page.textContent('#go'), '停止');
    assert.deepEqual(errors.filter(e => !/8790/.test(e)), []);
  } finally { await browser.close(); }
});
