// 手元のサーバー(local-asr/server.py)。--no-asr で起動するので GPU やモデルは要らない
// Python は local-asr/.venv を使う(なければ飛ばす)。別の Python は環境変数 LOCAL_ASR_PYTHON で指定
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', 'local-asr');
const PY = process.env.LOCAL_ASR_PYTHON || path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HAS_PY = fs.existsSync(PY);
const PORT = 8795, BASE = `http://127.0.0.1:${PORT}`;
const OK_ORIGIN = 'http://127.0.0.1:8010';

function startServer(args) {
  const p = spawn(PY, ['-u', path.join(ROOT, 'server.py'), ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('起動しない: ' + out)), 20000);
    p.stdout.on('data', () => { if (out.includes('準備できました')) { clearTimeout(t); res(); } });
    p.on('exit', () => { clearTimeout(t); res(); });
  });
  return { p, ready, out: () => out };
}

let srv, rss;
before(async () => {
  if (!HAS_PY) return;
  // ニュース用の RSS と Atom を配る小さなサーバー
  rss = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    if (req.url === '/rss') return res.end('<?xml version="1.0"?><rss><channel><title>t</title><item><title>RSSの見出し1</title><pubDate>Wed, 04 Nov 2026 20:00:00 +0900</pubDate></item><item><title>RSSの見出し2</title></item></channel></rss>');
    if (req.url === '/atom') return res.end('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atomの見出し</title><updated>2026-11-05T01:00:00Z</updated></entry></feed>');
    res.statusCode = 404; res.end('no');
  }).listen(0, '127.0.0.1');
  await new Promise(r => rss.on('listening', r));
  srv = startServer(['--no-asr', '--port', String(PORT)]);
  await srv.ready;
});
after(() => { if (srv) srv.p.kill(); if (rss) rss.close(); });

const opts = { skip: HAS_PY ? false : 'local-asr/.venv がないため飛ばします' };

test('サーバー: 起動と、呼び出し元の確認', opts, async () => {
  assert.match(srv.out(), /\/overlay を指定/);
  const h = await (await fetch(BASE + '/health')).json();
  assert.deepEqual([h.ok, h.asr], [true, false], '--no-asr では文字起こしなし');
  const bad = await fetch(BASE + '/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403, '許可していないページからは断る');
  const pre = await fetch(BASE + '/overlay/state', { method: 'OPTIONS', headers: { Origin: OK_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), OK_ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  const tr = await fetch(BASE + '/transcribe', { method: 'POST', headers: { Origin: OK_ORIGIN }, body: 'x' });
  assert.equal(tr.status, 503, '文字起こしは無効と返す');
});

test('サーバー: OBS表示の状態とページ', opts, async () => {
  const r = await fetch(BASE + '/overlay/state', { method: 'POST', headers: { Origin: OK_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'お題です', segment: '本題', timer: '残り 3:00', comment: 'こんにちは', commentBy: 'v1', evil: '<script>' }) });
  assert.equal(r.status, 200);
  const s = await (await fetch(BASE + '/overlay/state')).json();
  assert.equal(s.topic, 'お題です'); assert.equal(s.commentBy, 'v1');
  assert.equal(s.evil, undefined, '決まった項目だけ受け取る');
  const bad = await fetch(BASE + '/overlay/state', { method: 'POST', headers: { Origin: OK_ORIGIN }, body: '{not json' });
  assert.equal(bad.status, 400);
  const page = await fetch(BASE + '/overlay');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/overlay/state') && html.includes('background:transparent'), 'OBS用の透明なページ');
  assert.ok(html.includes('textContent') && !html.includes('innerHTML'), '受け取った文は文字として表示する');
});

test('サーバー: ニュースの見出し(RSS / Atom)', opts, async () => {
  const port = rss.address().port;
  const q = ['/rss', '/atom', '/missing'].map(p => 'url=' + encodeURIComponent(`http://127.0.0.1:${port}${p}`)).join('&') + '&url=' + encodeURIComponent('file:///etc/passwd');
  const j = await (await fetch(BASE + '/news?' + q)).json();
  const titles = j.items.filter(x => x.title).map(x => x.title);
  assert.deepEqual(titles, ['RSSの見出し1', 'RSSの見出し2', 'Atomの見出し']);
  assert.equal(j.items.find(x => x.title === 'RSSの見出し1').date, 'Wed, 04 Nov 2026 20:00:00 +0900');
  assert.ok(j.items.some(x => x.error && x.error.includes('/missing')), '取れなかった取得元は error で返す');
  assert.ok(!JSON.stringify(j).includes('passwd'), 'http(s) 以外のURLは使わない');
  const none = await fetch(BASE + '/news');
  assert.equal(none.status, 400, '既定の取得元は持たない');
});

test('サーバー: ポートが使用中なら、はっきり知らせて止まる', opts, async () => {
  const s2 = startServer(['--no-asr', '--port', String(PORT)]);
  const code = await new Promise(r => s2.p.on('exit', r));
  assert.notEqual(code, 0);
  assert.match(s2.out(), /ポート 8795 は別のプログラムが使っています/);
});
