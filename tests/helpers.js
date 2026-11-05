// テスト共通: ページのURL、Anthropic API の模擬、ページ内エラーの収集
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = process.env.PAGE_URL || pathToFileURL(path.resolve(__dirname, '..', 'topic-generator.html')).href;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' };

// プロンプトの冒頭から呼び出しの種類を判定する
const kindOf = prompt => prompt.includes('書記') ? 'summary' : prompt.includes('相談役') ? 'topics' : 'notes';

// handler(kind, prompt, body, headers) が返す値:
//   文字列 → 200 の text 応答 / { status, message } → エラー応答 / 'abort' → 通信失敗
async function mockAnthropic(page, handler) {
  const calls = [];
  await page.route('https://api.anthropic.com/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData());
    const prompt = body.messages[0].content;
    const kind = kindOf(prompt);
    const headers = req.headers();
    calls.push({ kind, prompt, model: body.model, key: headers['x-api-key'], direct: headers['anthropic-dangerous-direct-browser-access'] });
    const r = await handler(kind, prompt, body, headers);
    if (r === 'abort') return route.abort();
    if (r && typeof r === 'object') {
      return route.fulfill({ status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: r.message || '' } }) });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: r }] }) });
  });
  return calls;
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  return errors;
}

// 条件を満たした時点の値を返す(後から上書きされる表示も取りこぼさない)
async function waitText(page, selector, pred, timeout = 20000) {
  const h = await page.waitForFunction(([sel, src]) => {
    const el = document.querySelector(sel);
    const t = 'value' in el ? el.value : el.textContent;
    return new Function('t', 'return (' + src + ')(t)')(t) ? t : false;
  }, [selector, pred.toString()], { timeout });
  return h.jsonValue();
}

// 左の設定欄(折りたたみ)をすべて開く
const openAll = page => page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
// 右の列のタブを切り替える(memo / recap / nb / prep / past)
const pane = (page, name) => page.click(`.sidetabs [data-pane="${name}"]`);
// 機能のオン・オフを、ページを開く前に決める(指定しないものは既定のまま)
const setFeatures = (page, f) => page.addInitScript(v => { if (!sessionStorage.getItem('featSet')) { localStorage.setItem('features', JSON.stringify(v)); sessionStorage.setItem('featSet', '1'); } }, f);

module.exports = { PAGE, mockAnthropic, collectErrors, waitText, openAll, pane, setFeatures };
