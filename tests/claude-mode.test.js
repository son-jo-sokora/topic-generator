// Claude内モード(window.claude を模擬)の一巡
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PAGE, collectErrors, waitText, pane } = require('./helpers');

test('Claude内モード: sample / db / downloads を使う', async () => {
  const browser = await chromium.launch();
  try {
    // 日本時間の朝9時前(UTCでは前日)にして、ファイル名の日付を確かめる
    const ctx = await browser.newContext({ acceptDownloads: true, timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date('2026-11-04T08:30:00+09:00'));
    const errors = collectErrors(page);
    await page.addInitScript(() => {
      window.__log = { sample: [], put: [], dl: [] }; const mem = {};
      const reply = p => p.includes('書記') ? '・要約テスト' : p.includes('相談役') ? [{ title: 'Claude内の話題', angle: 'a', opener: 'o', from: null }] : [{ title: 'ネタA', note: 'n', tags: ['t'] }];
      const sample = async p => { window.__log.sample.push('text'); return { text: reply(p) }; };
      sample.json = async p => { window.__log.sample.push('json'); return reply(p); };
      const col = {
        doc: id => ({ set: async d => { mem[id] = d; window.__log.put.push(id); }, get: async () => ({ exists: id in mem, data: () => mem[id] }) }),
        orderBy: () => ({ limit: n => ({ get: async () => { window.__log.limit = n; return { docs: Object.entries(mem).map(([id, d]) => ({ id, data: () => d })) }; } }) })
      };
      window.claude = { use: async n => ({ sample, user: { id: async () => 'u1' }, db: { collection: path => { window.__log.path = path; return col; } }, downloads: { save: async f => { window.__log.dl.push(f.filename); } } }[n] || null) };
    });
    await page.goto(PAGE);
    await page.waitForTimeout(600);

    assert.equal(await page.isVisible('#keyBox'), false, 'APIキー欄は出ない');
    assert.match(await page.textContent('#saveNote'), /5秒ごとに保存/);

    await page.fill('#manual', 'テスト発言です'); await page.press('#manual', 'Enter');
    await page.waitForSelector('#out .card', { timeout: 20000 });
    assert.equal(await page.locator('#out .card h3').first().textContent(), 'Claude内の話題');
    await waitText(page, '#memo', t => t.includes('要約テスト'), 30000);
    await page.waitForFunction(() => window.__log.put.some(id => id.startsWith('s')), null, { timeout: 15000 });

    await pane(page, 'nb');
    await page.fill('#nbTitle', 'x'); await page.press('#nbTitle', 'Enter');
    await page.waitForFunction(() => window.__log.put.includes('notebook'), null, { timeout: 5000 });
    await page.click('#nbExport'); await pane(page, 'memo'); await page.click('#dl');
    await page.waitForTimeout(300);

    const log = await page.evaluate(() => window.__log);
    assert.equal(log.path, 'data/users/u1');
    assert.ok(log.sample.includes('json') && log.sample.includes('text'));
    assert.ok(log.put.includes('s20261104-083000'), 'セッションIDは端末の時刻: ' + log.put);
    assert.deepEqual(log.dl.sort(), ['notebook.md', 'stream-log-2026-11-04.md']);
    assert.equal(log.limit, 22, 'notebook の分を1件多く取る');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
