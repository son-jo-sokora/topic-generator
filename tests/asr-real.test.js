// 本物の文字起こし(GPU と kotoba-whisper のモデルが必要)。重いので既定では飛ばす
// 実行: PowerShell で  $env:LOCAL_ASR_FULL='1'; node --test tests/asr-real.test.js
// 音声は Windows の読み上げ(日本語の音声 Haruka)で作る
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', 'local-asr');
const PY = process.env.LOCAL_ASR_PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const RUN = process.env.LOCAL_ASR_FULL === '1' && process.platform === 'win32' && fs.existsSync(PY);
const PORT = 8796;

test('本物の文字起こし: 日本語の音声を文字にする', { skip: RUN ? false : 'LOCAL_ASR_FULL=1 のときだけ実行', timeout: 600000 }, async () => {
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-asr-')), 'ja.wav');
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Haruka Desktop'); $f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wav}',$f); $s.Speak('今日は週末のキャンプについて話したいと思います。焚き火がとても楽しかったです。'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
  const p = spawn(PY, ['-u', path.join(ROOT, 'server.py'), '--port', String(PORT)], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' } });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  try {
    await new Promise((res, rej) => { const t = setInterval(() => { if (out.includes('準備できました')) { clearInterval(t); res(); } if (p.exitCode !== null) { clearInterval(t); rej(new Error(out)); } }, 300); });
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    assert.equal(h.asr, true);
    const r = await fetch(`http://127.0.0.1:${PORT}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Origin: 'http://127.0.0.1:8010' }, body: fs.readFileSync(wav) });
    const j = await r.json();
    console.log('文字起こし:', j.text, `(${j.audioSec}秒の音声を${j.sec}秒)`);
    assert.ok(j.text.includes('キャンプ') && j.text.includes('焚き火'), j.text);
    const bad = await fetch(`http://127.0.0.1:${PORT}/transcribe`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8010' }, body: Buffer.from('not a wav') });
    assert.equal(bad.status, 400, 'WAVでなければ断る');
  } finally { p.kill(); }
});
