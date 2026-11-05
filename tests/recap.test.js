// 配信のまとめ(タイトル案・概要欄・チャプター・切り抜き候補・振り返り投稿)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');
const { PAGE, mockAnthropic, collectErrors, waitText, pane } = require('./helpers');

const RECAP = {
  titles: ['週末キャンプの話', '焚き火の失敗談'],
  description: '週末に行ったキャンプの話をしました。',
  chapters: [{ t: '0:05', title: 'オープニング' }, { t: '1:01:40', title: '焚き火の話' }, { t: '9:59:59', title: '範囲外' }],
  highlights: [{ start: '0:05', end: '1:01:45', title: '焚き火の失敗', reason: '笑える' }, { start: 'x', end: '1:00', title: '不正な時刻', reason: '' }],
  posts: ['今日はキャンプの話をしました。']
};

test('まとめ: 時刻つきの文字起こしから作り、時刻をずらせて、保存・書き出しされる', async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    let recapReq = null, recapReply = JSON.stringify(RECAP);
    await mockAnthropic(page, (kind, prompt, body) => {
      if (prompt.includes('編集担当')) { recapReq = { prompt, maxTokens: body.max_tokens }; return recapReply; }
      return kind === 'summary' ? '・キャンプの話' : kind === 'topics' ? '[{"title":"t","angle":"a","opener":"o","from":null}]' : '[]';
    });
    await page.goto(PAGE); await page.waitForTimeout(400);
    await page.fill('#apiKey', 'sk-ant-test');

    // 文字起こしの各行に経過時間が付く
    await page.fill('#manual', '週末にキャンプに行ってきました'); await page.press('#manual', 'Enter');
    await page.evaluate(() => { sessStart = new Date(Date.now() - 3700 * 1000).toISOString(); }); // 1時間1分40秒たったことにする
    await page.fill('#manual', '焚き火で失敗した話をします'); await page.press('#manual', 'Enter');
    await page.click('#tabRaw');
    const raw = await page.inputValue('#memo');
    assert.match(raw, /^\[0:0\d\] 週末にキャンプに行ってきました$/m);
    assert.match(raw, /^\[1:01:4\d\] 焚き火で失敗した話をします$/m);

    // まとめを作る
    await pane(page, 'recap');
    assert.equal(await page.isVisible('#recapOut'), false);
    await page.click('#recapBtn');
    await waitText(page, '#recapStat', t => t.includes('まとめを作りました'), 10000);
    assert.ok(recapReq.prompt.includes('[0:0') && recapReq.prompt.includes('焚き火で失敗'), '時刻つきの文字起こしを渡す');
    assert.equal(recapReq.maxTokens, 4000);
    assert.equal(await page.textContent('#r_titles'), '週末キャンプの話\n焚き火の失敗談');
    assert.equal(await page.textContent('#r_chapters'), '0:00 オープニング\n1:01:40 焚き火の話', '最初は0:00、範囲外は除く');
    assert.equal(await page.textContent('#r_highlights'), '0:05〜1:01:45 焚き火の失敗(笑える)', '時刻が不正なものは除く');

    // 時刻をずらす(最初の0:00はそのまま)
    await page.fill('#recapOffset', '1:30');
    assert.equal(await page.textContent('#r_chapters'), '0:00 オープニング\n1:03:10 焚き火の話');
    assert.match(await page.textContent('#r_highlights'), /^1:35〜1:03:15 /);

    // コピー
    await page.click('[data-copy="chapters"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip.replace(/\r\n/g, '\n'), '0:00 オープニング\n1:03:10 焚き火の話'); // Windows は改行を CRLF にする

    // 書き出しに含まれる
    await pane(page, 'memo');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    const md = fs.readFileSync(await d.path(), 'utf8');
    assert.ok(md.includes('## 配信のまとめ') && md.includes('### チャプター') && md.includes('焚き火の話'));

    // 保存され、再読み込み後に過去のセッションとして見られる
    await waitText(page, '#saveNote', t => t.includes('保存済み'), 10000);
    await page.waitForTimeout(5500);
    await page.reload(); await page.waitForTimeout(800);
    await pane(page, 'memo');
    await page.selectOption('#past', { index: 1 });
    await pane(page, 'recap');
    assert.equal(await page.isVisible('#recapOut'), true);
    assert.equal(await page.textContent('#r_chapters'), '0:00 オープニング\n1:01:40 焚き火の話');

    // 過去のセッションでも作り直せる。失敗したら理由を出す
    await page.fill('#apiKey', 'sk-ant-test');
    recapReply = 'すみません';
    await page.click('#recapBtn');
    await waitText(page, '#recapStat', t => t.includes('作れませんでした'), 10000);
    recapReply = JSON.stringify({ ...RECAP, titles: ['作り直したタイトル'] });
    await page.click('#recapBtn');
    await waitText(page, '#recapStat', t => t.includes('まとめを作りました'), 10000);
    assert.equal(await page.textContent('#r_titles'), '作り直したタイトル');
    await page.reload(); await page.waitForTimeout(800);
    await pane(page, 'memo');
    await page.selectOption('#past', { index: 1 });
    assert.equal(await page.textContent('#r_titles'), '作り直したタイトル', '過去のセッションに保存される');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('まとめ: 文字起こしがなければ作らない', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const calls = await mockAnthropic(page, () => '{}');
    await page.goto(PAGE); await page.waitForTimeout(300);
    await page.fill('#apiKey', 'sk-ant-test');
    await pane(page, 'recap');
    await page.click('#recapBtn');
    assert.equal(await page.textContent('#recapStat'), '文字起こしがまだありません');
    assert.equal(calls.length, 0);
  } finally { await browser.close(); }
});
