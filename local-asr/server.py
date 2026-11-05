"""手元の文字起こしサーバー(faster-whisper + kotoba-whisper)

話題ジェネレーターのページから、話の切れ目ごとの音声(16kHz モノラル WAV)を受け取り、文字にして返す。
127.0.0.1 でだけ待ち受け、許可したページ(--allow-origin)からの呼び出しだけを受け付ける。

  POST /transcribe     本文: audio/wav。ヘッダ X-Hotwords: 認識させたい語(URLエンコード、任意)
                       → {"text": "...", "audioSec": 3.2, "sec": 0.4}
  GET  /health         → {"ok": true, "asr": true, "model": "...", "device": "cuda"}
  GET  /overlay        OBS のブラウザソース用ページ(背景透明)
  GET/POST /overlay/state  OBS に出す内容 {topic, segment, timer, comment, commentBy}
  GET  /news?url=...   RSS/Atom の見出し(url は必須。既定の取得元は持たない)
"""
import argparse
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

DEFAULT_ORIGINS = [
    "https://son-jo-sokora.github.io",
    "http://127.0.0.1:8000", "http://localhost:8000",
    "http://127.0.0.1:8010", "http://localhost:8010",
]
MAX_BYTES = 16000 * 2 * 60  # 60秒分まで

# 無音や雑音で Whisper が出しがちな定型文(これだけの結果は捨てる)
HALLUCINATIONS = re.compile(
    r"^(ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録(をお願いします|よろしくお願いします)?|"
    r"おやすみなさい|ありがとうございました|字幕.*|最後までご視聴.*)[。!！\s]*$"
)


def add_cuda_dll_dirs():
    """pip の nvidia-* パッケージに入っている CUDA の DLL を Windows で見つけられるようにする"""
    if os.name != "nt":
        return
    import site
    for sp in site.getsitepackages():
        for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            d = os.path.join(sp, "nvidia", sub, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def read_wav(data: bytes):
    import numpy as np
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("16bit モノラルの WAV を送ってください")
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        # 単純な線形補間で 16kHz に揃える
        n = int(len(pcm) * 16000 / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


class Engine:
    def __init__(self, model, device, compute_type, beam_size):
        add_cuda_dll_dirs()
        from faster_whisper import WhisperModel
        self.name, self.device, self.beam_size = model, device, beam_size
        t = time.time()
        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.lock = threading.Lock()  # GPU は一度に1件ずつ
        print(f"モデルを読み込みました: {model} ({device}, {compute_type}) {time.time() - t:.1f}秒", flush=True)

    def transcribe(self, audio, hotwords=None):
        with self.lock:
            segments, _ = self.model.transcribe(
                audio,
                language="ja",
                beam_size=self.beam_size,
                vad_filter=True,
                condition_on_previous_text=False,
                hotwords=hotwords or None,
            )
            text = "".join(s.text for s in segments).strip()
        return "" if HALLUCINATIONS.match(text) else text


# ===== OBS への表示: ページが状態を送り、OBS のブラウザソース(/overlay)が1秒ごとに読みに来る =====
OVERLAY_KEYS = {"topic", "segment", "timer", "comment", "commentBy"}
overlay_state = {}
overlay_lock = threading.Lock()
OVERLAY_HTML = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>overlay</title>
<style>
html,body{margin:0;background:transparent;font-family:"Yu Gothic UI","Hiragino Sans",sans-serif;color:#fff}
.box{margin:16px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.c{background:rgba(20,22,40,.78);border-radius:12px;padding:10px 16px;font-size:28px;line-height:1.4;max-width:90vw;text-shadow:0 1px 2px #000}
.s{font-size:20px;opacity:.85}.by{font-size:18px;opacity:.75;margin-right:8px}
[hidden]{display:none}
</style></head><body><div class="box">
<div class="c s" id="seg" hidden></div><div class="c" id="topic" hidden></div><div class="c" id="cm" hidden><span class="by" id="by"></span><span id="ct"></span></div>
</div><script>
const $=i=>document.getElementById(i);
async function tick(){
  try{
    const s=await (await fetch('/overlay/state',{cache:'no-store'})).json();
    const seg=[s.segment,s.timer].filter(Boolean).join('  ');
    $('seg').textContent=seg;$('seg').hidden=!seg;
    $('topic').textContent=s.topic||'';$('topic').hidden=!s.topic;
    $('by').textContent=s.commentBy||'';$('ct').textContent=s.comment||'';$('cm').hidden=!s.comment;
  }catch(e){}
  setTimeout(tick,1000);
}
tick();
</script></body></html>"""

# ===== 時事ネタ: RSS/Atom の見出しを取る(ブラウザからは CORS で取れないため、ここで中継する) =====
# 取得元は利用者が選ぶ(取得元ごとの利用条件に従うため、既定の取得元は持たない)


def fetch_news(urls, per_feed=15):
    import urllib.request
    import xml.etree.ElementTree as ET
    items = []
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "topic-generator-news/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                root = ET.fromstring(r.read(2_000_000))
        except Exception as e:  # noqa: BLE001
            items.append({"title": "", "error": f"{u}: {e}"})
            continue
        n = 0
        for el in root.iter():
            tag = el.tag.split("}")[-1]
            if tag not in ("item", "entry"):
                continue
            title = date = ""
            for ch in el:
                t = ch.tag.split("}")[-1]
                if t == "title":
                    title = (ch.text or "").strip()
                elif t in ("pubDate", "updated", "published", "date") and not date:
                    date = (ch.text or "").strip()
            if title:
                items.append({"title": title, "date": date, "feed": u})
                n += 1
                if n >= per_feed:
                    break
    return items


def make_handler(engine, origins):
    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            o = self.headers.get("Origin")
            if o and ("*" in origins or o in origins):
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Hotwords")
                # 公開ページから手元のサーバーを呼ぶとき(Chrome のローカルネットワークの確認)用
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self):
            o = self.headers.get("Origin")
            return o is None or "*" in origins or o in origins

        def do_OPTIONS(self):
            self.send_response(204 if self._allowed() else 403)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if path == "/overlay":
                # OBS のブラウザソースで開くページ(Origin なしで来るので許可の確認は不要)
                body = OVERLAY_HTML.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if not self._allowed():
                return self._json(403, {"error": "このページからの呼び出しは許可されていません"})
            if path == "/health":
                return self._json(200, {"ok": True, "asr": engine is not None,
                                        "model": engine.name if engine else None,
                                        "device": engine.device if engine else None})
            if path == "/overlay/state":
                with overlay_lock:
                    return self._json(200, overlay_state)
            if path == "/news":
                urls = [u for u in parse_qs(query).get("url", []) if u.startswith(("http://", "https://"))][:10]
                if not urls:
                    return self._json(400, {"error": "取得元(url)を指定してください"})
                return self._json(200, {"items": fetch_news(urls)})
            return self._json(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?")[0]
            if not self._allowed():
                return self._json(403, {"error": "このページからの呼び出しは許可されていません"})
            n = int(self.headers.get("Content-Length") or 0)
            if path == "/overlay/state":
                if n <= 0 or n > 20000:
                    return self._json(413, {"error": "too large"})
                try:
                    data = json.loads(self.rfile.read(n))
                except ValueError:
                    return self._json(400, {"error": "JSONではありません"})
                with overlay_lock:
                    overlay_state.clear()
                    overlay_state.update({k: str(v)[:500] for k, v in data.items() if k in OVERLAY_KEYS})
                    overlay_state["updatedAt"] = time.time()
                return self._json(200, {"ok": True})
            if path != "/transcribe":
                return self._json(404, {"error": "not found"})
            if engine is None:
                return self._json(503, {"error": "文字起こしは無効です(--no-asr で起動しています)"})
            if n <= 0 or n > MAX_BYTES:
                return self._json(413, {"error": "音声が空か、長すぎます(60秒まで)"})
            data = self.rfile.read(n)
            try:
                audio = read_wav(data)
            except Exception as e:  # noqa: BLE001
                return self._json(400, {"error": str(e)})
            hot = unquote(self.headers.get("X-Hotwords") or "")[:500]
            t = time.time()
            text = engine.transcribe(audio, hot)
            sec = time.time() - t
            print(f"[{time.strftime('%H:%M:%S')}] {len(audio) / 16000:.1f}秒 → {sec:.2f}秒: {text}", flush=True)
            self._json(200, {"text": text, "audioSec": round(len(audio) / 16000, 2), "sec": round(sec, 2)})

        def log_message(self, *args):
            pass

    return Handler


def main():
    p = argparse.ArgumentParser(description="話題ジェネレーター用の手元の文字起こしサーバー")
    p.add_argument("--port", type=int, default=8790)
    p.add_argument("--model", default="kotoba-tech/kotoba-whisper-v2.0-faster")
    p.add_argument("--device", default="cuda", help="cuda または cpu")
    p.add_argument("--compute-type", default=None, help="既定: cuda は float16、cpu は int8")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--allow-origin", action="append", help="呼び出しを許可するページの origin(複数可、* で全許可)")
    p.add_argument("--no-asr", action="store_true", help="文字起こしを使わず、OBS表示と時事ネタ取得だけで起動する(モデルを読み込まない)")
    a = p.parse_args()
    ct = a.compute_type or ("float16" if a.device == "cuda" else "int8")
    origins = a.allow_origin or DEFAULT_ORIGINS
    # Windows では既定の設定だと使用中のポートにも重ねて入れてしまうので、使用中なら先に止める
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.port), None)
    except OSError:
        print(f"ポート {a.port} は別のプログラムが使っています。--port で別の番号を指定してください", flush=True)
        return 1
    engine = None if a.no_asr else Engine(a.model, a.device, ct, a.beam_size)
    srv.RequestHandlerClass = make_handler(engine, origins)
    print(f"準備できました: http://127.0.0.1:{a.port}  (止めるときは Ctrl+C)", flush=True)
    print(f"OBS に表示するときは、ブラウザソースに http://127.0.0.1:{a.port}/overlay を指定します", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
