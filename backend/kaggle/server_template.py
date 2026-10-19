"""Kaggle GPU kernel that runs the FilingLens model service and exposes it through an ngrok tunnel.

Built by build.sh (which fills the __PLACEHOLDERS__). Private kernel: it holds the API key and ngrok token.
Adapters come from the private Kaggle dataset `filinglens-adapters`; base models download from the public hub.
It stops by itself after RUN_HOURS, or earlier after IDLE_MINUTES (default 7) without requests, so the session ends cleanly and saves GPU quota.
"""
import base64
import glob
import io
import os
import subprocess
import sys
import threading
import time
import zipfile

T0 = time.time()


def stamp(msg):
    print(f"[{time.time() - T0:5.0f}s] {msg}", flush=True)


APP_B64 = "__APP_B64__"
os.environ["API_KEY"] = "__API_KEY__"
os.environ["SEC_USER_AGENT"] = "__SEC_UA__"
NGROK_TOKEN = "__NGROK_TOKEN__"
NGROK_DOMAIN = "__NGROK_DOMAIN__"
RUN_HOURS = float("__RUN_HOURS__")
IDLE_MINUTES = float("__IDLE_MINUTES__")  # stop early when nobody has used the server for this long (saves GPU quota)

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "peft", "torchao", "transformers", "fastapi", "uvicorn",
                "pydantic", "beautifulsoup4", "lxml", "pyngrok", "sentencepiece"], check=False)

stamp("packages installed")
zipfile.ZipFile(io.BytesIO(base64.b64decode(APP_B64))).extractall("/kaggle/working/svc")
sys.path.insert(0, "/kaggle/working/svc")

hit = glob.glob("/kaggle/input/**/other/ceo_filing/adapter_config.json", recursive=True)
if not hit:
    raise SystemExit("adapter dataset not found under /kaggle/input (expected other/ceo_filing/)")
os.environ["MODEL_DIR"] = os.path.dirname(os.path.dirname(os.path.dirname(hit[0])))
# optional: the trained CEO/CFO date tagger. Kaggle mounts the small `filinglens-dates` dataset with the adapter files at its root.
dates_hit = glob.glob("/kaggle/input/**/filinglens-dates/adapter_config.json", recursive=True) or glob.glob("/kaggle/input/**/dates502/adapter_config.json", recursive=True)
if dates_hit:
    os.environ["DATES_DIR"] = os.path.dirname(dates_hit[0])
print("date tagger:", os.environ.get("DATES_DIR", "not found (rules only)"), flush=True)
os.environ["USE_GPU"] = "1"
os.environ["TORCH_THREADS"] = str(os.cpu_count() or 4)
os.environ["HF_HUB_DISABLE_XET"] = "1"
print("models:", os.environ["MODEL_DIR"], flush=True)

import torch  # noqa: E402
import uvicorn  # noqa: E402
from pyngrok import conf, ngrok  # noqa: E402

stamp(f"torch imported; CUDA: {torch.cuda.is_available()} x{torch.cuda.device_count()}")

from app.main import app, start_prewarm  # noqa: E402  (importing starts loading the CEO ensemble in the background)

conf.get_default().auth_token = NGROK_TOKEN

# If an older instance still holds the static domain, ask it to stop (servers from this version on understand /shutdown),
# then keep retrying for a while in case it is slow to release the address.
try:
    import urllib.request

    req = urllib.request.Request(f"https://{NGROK_DOMAIN}/shutdown", data=b"{}", method="POST",
                                 headers={"Authorization": f"Bearer {os.environ['API_KEY']}", "Content-Type": "application/json", "ngrok-skip-browser-warning": "1"})
    urllib.request.urlopen(req, timeout=10).read()
    print("asked the previous server to shut down", flush=True)
    time.sleep(8)
except Exception as exc:  # no previous server, or an older one without /shutdown
    print(f"no previous server stopped ({type(exc).__name__})", flush=True)

tunnel, t_wait = None, time.time()
while tunnel is None:
    try:
        tunnel = ngrok.connect(7860, bind_tls=True, domain=NGROK_DOMAIN)
    except Exception as exc:
        if time.time() - t_wait > 20 * 60:
            raise SystemExit(f"the ngrok address stayed busy for 20 minutes: {exc}")
        stamp(f"ngrok address busy (another server may still be running); retrying in 30 s: {str(exc)[:200]}")
        time.sleep(30)
stamp("PUBLIC_URL " + tunnel.public_url)

start_prewarm()
server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=7860, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()

import app.main as _main  # noqa: E402

t0 = time.time()
reason = "time limit reached"
last_log = 0.0
while time.time() - t0 < RUN_HOURS * 3600:
    time.sleep(5)
    if _main._activity.get("shutdown"):
        reason = "stopped from the website"
        time.sleep(3)  # let the HTTP reply reach the browser
        break
    busy = _main._batches.active() > 0  # an analysis is running: never stop under it, whether the idle timer or a turn-off asks
    if _main._activity.get("shutdown_queued") and not busy:
        reason = "turned off from the website once the analysis finished"
        time.sleep(3)
        break
    idle = (time.time() - _main._activity["t"]) / 60
    if idle > IDLE_MINUTES and time.time() - t0 > 300 and not busy:
        reason = f"idle for {int(idle)} min"
        break
    if time.time() - last_log > 1800:
        last_log = time.time()
        print(f"alive {int((time.time() - t0) / 60)} min, idle {int(idle)} min", flush=True)
if _main._batches.active():  # hand over whatever an analysis has finished so far, so it can be resumed later
    print("saving unfinished analyses before stopping", flush=True)
    _main._batches.stop_all(f"The model server stopped ({reason}) before this analysis finished. Turn it on again and press Resume.")
print(f"DONE_SERVER ({reason}; start the kernel again to continue)", flush=True)
