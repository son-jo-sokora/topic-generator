// 単体モード(自分のAPIキー + IndexedDB + Blob)の一巡
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PAGE, mockAnthropic, collectErrors, waitText, openAll, pane } = require('./helpers');

const TOPICS = '```json\n[{"title":"休日の過ごし方","angle":"のんびり派か予定派か","opener":"休みの日って何してる?","from":null},{"title":"最近のおすすめ","angle":"最近気に入っているもの","opener":"最近ハマってるものある?","from":null}]\n```';
const reply = kind => kind === 'summary' ? '・週末のキャンプについて話した'
  : kind === 'topics' ? TOPICS
  : '[{"title":"取り込みテスト","note":"貼り付け文から","tags":["テスト"]}]';

test('単体モード: 話題・要約・ネタ帳・保存・復元・書き出し', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    const errors = collectErrors(page);
    const calls = await mockAnthropic(page, reply);
    await page.goto(PAGE);
    await page.waitForTimeout(800);

    assert.equal(await page.isVisible('#keyBox'), true, 'APIキー欄が表示される');
    assert.match(await page.textContent('#saveNote'), /このブラウザ内に保存/);

    await page.fill('#apiKey', 'sk-ant-test');
    await page.fill('#profile', '・料理が好き');
    await page.fill('#manual', '今日は週末のキャンプについて話したい');
    await page.press('#manual', 'Enter');
    await page.waitForSelector('#out .card', { timeout: 20000 });
    assert.equal(await page.locator('#out .card').count(), 2);
    assert.equal(await page.locator('#out .card h3').first().textContent(), '休日の過ごし方');

    await waitText(page, '#memo', t => t.includes('キャンプ'), 30000);
    await waitText(page, '#saveNote', t => t.includes('保存済み'), 15000);

    // 要約の入力は発言だけ(提案した話題や関心欄を混ぜない)
    const sum = calls.find(c => c.kind === 'summary');
    assert.ok(sum, '要約の呼び出しがある');
    assert.ok(sum.prompt.includes('週末のキャンプ'), '発言が渡る');
    assert.ok(!sum.prompt.includes('休日の過ごし方'), '提案した話題が混ざらない');
    assert.ok(!sum.prompt.includes('料理が好き'), '関心欄が混ざらない');

    // ネタ帳: 手入力 → 取り込み → 書き出し
    await pane(page, 'nb'); await openAll(page);
    await page.fill('#nbTitle', '手入力のネタ'); await page.press('#nbTitle', 'Enter');
    assert.equal(await page.locator('#nbList li').count(), 1);
    await page.fill('#nbPaste', 'テスト用の長めの文章です。'); await page.click('#nbImport');
    await waitText(page, '#nbStat', t => t.includes('追加しました'), 15000);
    assert.equal(await page.locator('#nbList li').count(), 2);
    await waitText(page, '#nbStat', t => t.includes('保存しました'), 8000);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#nbExport')]);
    assert.equal(dl.suggestedFilename(), 'notebook.md');

    // 再読み込み後の復元
    await page.reload(); await page.waitForTimeout(1200);
    await pane(page, 'memo');
    assert.ok(await page.locator('#past option').count() >= 2, '過去セッションが一覧に出る');
    assert.equal(await page.locator('#nbList li').count(), 2, 'ネタ帳が復元される');
    await page.selectOption('#past', { index: 1 });
    assert.match(await page.inputValue('#memo'), /キャンプ/);

    // リクエストの形
    for (const c of calls) {
      assert.equal(c.key, 'sk-ant-test');
      assert.equal(c.direct, 'true');
      assert.equal(c.model, 'claude-haiku-5-5');
    }
    assert.deepEqual([...new Set(calls.map(c => c.kind))].sort(), ['notes', 'summary', 'topics']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('単体モード: 関心・時事ネタ欄は空で始まり、書くと保存されて指示文に入る', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = collectErrors(page);
    const calls = await mockAnthropic(page, reply);
    await page.goto(PAGE);
    await page.waitForTimeout(500);
    await openAll(page); // 時事ネタの欄は折りたたまれている
    assert.equal(await page.inputValue('#profile'), '', '関心欄は空');
    assert.equal(await page.inputValue('#news'), '', '時事ネタ欄は空');
    await page.fill('#apiKey', 'sk-ant-test');

    // 空のとき: 関心と時事ネタの段落を入れない
    await page.click('#now');
    await page.waitForSelector('#out .card', { timeout: 10000 });
    const p0 = calls.find(c => c.kind === 'topics').prompt;
    assert.ok(!p0.includes('配信者の関心・背景'), '関心の段落がない');
    assert.ok(!p0.includes('関心との接点'), '関心のルールがない');
    assert.ok(!p0.includes('時事ネタの材料'), '時事ネタの段落がない');
    assert.ok(p0.includes('誰でも話しやすい身近な話題'));

    // 書いたら保存され、再読み込み後も残り、指示文に入る
    await page.fill('#profile', '・ゲーム実況が好き');
    await page.fill('#news', '・テスト用の見出し');
    await page.reload(); await page.waitForTimeout(500);
    assert.equal(await page.inputValue('#profile'), '・ゲーム実況が好き');
    assert.equal(await page.inputValue('#news'), '・テスト用の見出し');
    await page.fill('#apiKey', 'sk-ant-test');
    const before = calls.length;
    await page.click('#now');
    for (let i = 0; i < 50 && !calls.slice(before).some(c => c.kind === 'topics'); i++) await page.waitForTimeout(200);
    const p1 = calls.slice(before).find(c => c.kind === 'topics').prompt;
    assert.ok(p1.includes('・ゲーム実況が好き') && p1.includes('関心との接点'));
    assert.ok(p1.includes('時事ネタの材料') && p1.includes('・テスト用の見出し'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('単体モード: キー未入力で話しても、キーを入れると要約が再開する', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = collectErrors(page);
    await mockAnthropic(page, reply);
    await page.goto(PAGE);
    await page.waitForTimeout(500);
    await page.fill('#manual', 'キーを入れる前の発言です'); await page.press('#manual', 'Enter');
    await waitText(page, '#status', t => t.includes('APIキー'), 10000);
    await page.waitForTimeout(3500); // 要約も一度失敗させる
    assert.ok(!(await page.inputValue('#memo')).includes('キャンプ'));
    await page.fill('#apiKey', 'sk-ant-test');
    await waitText(page, '#memo', t => t.includes('キャンプ'), 20000);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
