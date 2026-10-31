"""Kaggle GPU kernel that runs the FilingLens model service and exposes it through an ngrok tunnel.

Built by build.sh (which fills the __PLACEHOLDERS__). Private kernel: it holds the API key and ngrok token.
Adapters come from the private Kaggle dataset `filinglens-adapters`; base models download from the public hub.
It stops by itself after RUN_HOURS, or earlier after IDLE_MINUTES (default 7) without requests, so the session ends cleanly and saves GPU quota.
"""
import base64
import glob
import io
import json
import os
import re
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
SITE_URL = "__SITE_URL__"  # the website; the server tells it which public address it got
RUN_HOURS = float("__RUN_HOURS__")
IDLE_MINUTES = float("__IDLE_MINUTES__")  # stop early when nobody has used the server for this long (saves GPU quota)

# Upgrade only what the models need; the rest is installed only if the image lacks it (a blanket -U costs time and risks surprises).
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "peft", "torchao", "transformers"], check=False)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "fastapi", "uvicorn", "pydantic", "beautifulsoup4", "lxml", "sentencepiece"], check=False)

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
# optional: the filing-level 1.01/1.02 reader (two seeds in folders agree_doc_s42/ and agree_doc_s7/ of the small `filinglens-agree` dataset)
agree_hit = glob.glob("/kaggle/input/**/agree_doc_s42/adapter_config.json", recursive=True)
if agree_hit:
    os.environ["AGREE_DIR"] = os.path.dirname(os.path.dirname(agree_hit[0]))
print("agreements filing reader:", os.environ.get("AGREE_DIR", "not found (sentence readers only)"), flush=True)
# optional: the filing-level Item 3.02 reader (folder equity_doc_s42/ of the small `filinglens-equity` dataset)
equity_hit = glob.glob("/kaggle/input/**/equity_doc_s42/adapter_config.json", recursive=True)
if equity_hit:
    os.environ["EQUITY_DIR"] = os.path.dirname(os.path.dirname(equity_hit[0]))
print("equity (3.02) filing reader:", os.environ.get("EQUITY_DIR", "not found (sentence readers only)"), flush=True)
# optional: the three counterparty taggers (folders cp_ner_a/, cp_ner_b/, cp_ner_c/ of the `filinglens-counterparty` dataset)
cp_hit = glob.glob("/kaggle/input/**/cp_ner_a/config.json", recursive=True)
if cp_hit:
    os.environ["CP_DIR"] = os.path.dirname(os.path.dirname(cp_hit[0]))
print("counterparty taggers:", os.environ.get("CP_DIR", "not found (detector stays off)"), flush=True)
# optional: the Item 1.05 (cybersecurity incident) materiality classifier. Kaggle mounts the small
# `filinglens-item105` dataset with the adapter files at its root, same shape as filinglens-dates.
item105_hit = glob.glob("/kaggle/input/**/filinglens-item105/adapter_config.json", recursive=True)
if item105_hit:
    os.environ["ITEM105_DIR"] = os.path.dirname(item105_hit[0])
print("item105 materiality reader:", os.environ.get("ITEM105_DIR", "not found (detector will error if present)"), flush=True)
# optional: the result checker (second reader that scores each CEO answer); the `filinglens-verifier` dataset has the adapter files at its root.
verifier_hit = glob.glob("/kaggle/input/**/filinglens-verifier/adapter_config.json", recursive=True)
if verifier_hit:
    os.environ["VERIFIER_DIR"] = os.path.dirname(verifier_hit[0])
print("result checker:", os.environ.get("VERIFIER_DIR", "not found (answers carry no score)"), flush=True)
# optional: the retrained main CEO model (two seeds, cleaned labels + hard negatives); the `filinglens-ceo2` dataset holds the folders cl_hn_s42/ and cl_hn_s7/.
ceo2_hit = glob.glob("/kaggle/input/**/cl_hn_s42/adapter_config.json", recursive=True)
if ceo2_hit and glob.glob("/kaggle/input/**/cl_hn_s7/adapter_config.json", recursive=True):
    os.environ["CEO2_DIR"] = os.path.dirname(os.path.dirname(ceo2_hit[0]))
print("main CEO model v2:", os.environ.get("CEO2_DIR", "not found (using the original single model)"), flush=True)
# optional: the "stays with the company?" reader (two seeds); the `filinglens-stays` dataset holds the folders st_s1/ and st_s2/.
stays_hit = glob.glob("/kaggle/input/**/st_s1/adapter_config.json", recursive=True)
if stays_hit and glob.glob("/kaggle/input/**/st_s2/adapter_config.json", recursive=True):
    os.environ["STAYS_DIR"] = os.path.dirname(os.path.dirname(stays_hit[0]))
print("stays-with-the-company reader:", os.environ.get("STAYS_DIR", "not found (rules only)"), flush=True)
os.environ["USE_GPU"] = "1"
os.environ["TORCH_THREADS"] = str(os.cpu_count() or 4)
os.environ["HF_HUB_DISABLE_XET"] = "1"
print("models:", os.environ["MODEL_DIR"], flush=True)

import torch  # noqa: E402
import uvicorn  # noqa: E402

stamp(f"torch imported; CUDA: {torch.cuda.is_available()} x{torch.cuda.device_count()}")

from app.main import app, start_prewarm  # noqa: E402  (importing starts loading the CEO ensemble in the background)

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

# ---- public address: run the ngrok agent binary directly. (pyngrok talks to the agent through an API whose fields change between
# agent versions; on 2026-10-20 that mismatch made every connect fail with "invalid endpoint configuration" for 20 minutes.)
NGROK_BIN = "/kaggle/working/ngrok"


def fetch_ngrok() -> None:
    import tarfile
    import urllib.request

    if os.path.exists(NGROK_BIN):
        return
    last = None
    for url in ("https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz",
                "https://ngrok-agent.s3.amazonaws.com/ngrok-v3-stable-linux-amd64.tgz"):
        try:
            data = urllib.request.urlopen(url, timeout=120).read()
            tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").extractall("/kaggle/working")
            os.chmod(NGROK_BIN, 0o755)
            return
        except Exception as exc:
            last = exc
    raise SystemExit(f"could not download the ngrok agent: {last}")


def open_tunnel(port: int, domain: str, token: str, wait: float = 60.0):
    """Starts the agent and waits until the public address answers. Returns (process, public_url) or (process, None) with its output printed."""
    import urllib.request

    proc = subprocess.Popen([NGROK_BIN, "http", str(port), f"--url=https://{domain}", "--log=stdout", "--log-format=logfmt"],
                            env={**os.environ, "NGROK_AUTHTOKEN": token}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines: list = []

    def drain() -> None:
        for line in proc.stdout:  # keeps the pipe from filling up and records what the agent says
            lines.append(line.rstrip())
            del lines[:-40]

    threading.Thread(target=drain, daemon=True).start()
    end = time.time() + wait
    while time.time() < end and proc.poll() is None:
        time.sleep(1.0)
        try:
            tunnels = json.loads(urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=3).read()).get("tunnels", [])
            if tunnels:
                return proc, tunnels[0]["public_url"]
        except Exception:
            pass
    if proc.poll() is None:
        proc.kill()
    for line in lines[-12:]:
        stamp("ngrok: " + re.sub(r"authtoken=\S+", "authtoken=…", line)[:260])
    return proc, None


# ---- public address, first choice: a free Cloudflare quick tunnel (no monthly request cap, unlike ngrok's free plan). Its address is new
# every time, so the server registers it with the website. ngrok below is the fallback.
CF_BIN = "/kaggle/working/cloudflared"


def open_cloudflare(port: int, wait: float = 90.0):
    import urllib.request

    if not os.path.exists(CF_BIN):
        data = urllib.request.urlopen("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", timeout=120).read()
        open(CF_BIN, "wb").write(data)
        os.chmod(CF_BIN, 0o755)
    proc = subprocess.Popen([CF_BIN, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    found: list = []
    tail: list = []

    def drain() -> None:
        for line in proc.stdout:
            tail.append(line.rstrip())
            del tail[:-30]
            # cloudflared also prints its own control address (https://api.trycloudflare.com) in startup/error lines: never use that one
            for m in re.finditer(r"https://([a-z0-9-]+)\.trycloudflare\.com", line):
                if m.group(1) != "api" and not found:
                    found.append(m.group(0))

    threading.Thread(target=drain, daemon=True).start()
    end = time.time() + wait
    while time.time() < end and proc.poll() is None and not found:
        time.sleep(1.0)
    if found:
        return proc, found[0]
    if proc.poll() is None:
        proc.kill()
    for line in tail[-8:]:
        stamp("cloudflared: " + line[:200])
    return proc, None


def register(url: str) -> bool:
    import urllib.request

    for attempt in range(6):
        try:
            req = urllib.request.Request(f"{SITE_URL}/api/host", data=json.dumps({"action": "register", "url": url}).encode(), method="POST",
                                         # Cloudflare turns away Python's default user agent with a 403 (error 1010)
                                         headers={"Authorization": f"Bearer {os.environ['API_KEY']}", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (FilingLens model server)"})
            urllib.request.urlopen(req, timeout=20).read()
            return True
        except Exception as exc:
            stamp(f"could not register the address with the website ({type(exc).__name__}: {exc}); retrying")
            time.sleep(5)
    return False


tunnel_proc, public_url, t_wait = None, None, time.time()
try:
    for attempt in range(3):
        tunnel_proc, public_url = open_cloudflare(7860)
        if public_url:
            if register(public_url):
                stamp("registered the Cloudflare address with the website")
            else:
                stamp("the website did not accept the address; falling back to ngrok")
                tunnel_proc.kill()
                public_url = None
            break
        stamp("cloudflare tunnel did not open; retrying")
except Exception as exc:
    stamp(f"cloudflare tunnel failed ({type(exc).__name__}: {exc}); falling back to ngrok")
    public_url = None

if public_url is None:
    fetch_ngrok()
    stamp("ngrok agent ready")
while public_url is None:
    tunnel_proc, public_url = open_tunnel(7860, NGROK_DOMAIN, NGROK_TOKEN)
    if public_url is None:
        if time.time() - t_wait > 20 * 60:
            raise SystemExit("the ngrok address could not be opened for 20 minutes (see the ngrok lines above)")
        stamp("could not open the public address (another server may still hold it); retrying in 20 s")
        time.sleep(20)
stamp("PUBLIC_URL " + public_url)

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
