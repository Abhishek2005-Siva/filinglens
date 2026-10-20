"""Model service: given an SEC filing, find Item 5.02, run the CEO reader and the other detectors, return the extraction.

Runs as a Hugging Face Docker Space. Jobs are async (CPU inference takes a while), so the
front-end starts a job and polls it. Only one filing is processed at a time.
"""
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

import re

from .item502 import ITEM_HEADING_RE, find_item_502_section, split_sentences
from .detect.fetch import fetch_all
from .detect.registry import REGISTRY, run_all, selftest_family
from .sec_fetch import filing_txt_url

API_KEY = os.getenv("API_KEY", "")
# A filing whose Item 5.02 text never mentions a CEO-type title cannot contain a CEO appointment or resignation.
CEO_HINT = re.compile(r"chief\s+executive|\bCEO\b|principal\s+executive|president", re.IGNORECASE)


def _auth(request: Request, authorization: str = Header(default="")) -> None:
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(401, "Unauthorized")
    # Only real use keeps the server awake. Status checks (/health) must not, or an open status panel would stop it from ever sleeping.
    if request.url.path != "/health":
        _activity["t"] = time.time()


app = FastAPI(title="Leadership Change Detector model service", dependencies=[Depends(_auth)])
_activity = {"t": time.time()}  # last authenticated request; the Kaggle host shuts down when this gets old
_pool = ThreadPoolExecutor(max_workers=int(os.getenv("WORKERS", "3")))  # a few filings at a time (batch analysis)
_jobs: Dict[str, dict] = {}
_cache: Dict[str, dict] = {}
_lock = threading.Lock()
_model = {"ensemble": None, "error": None, "loading": True, "load_seconds": None, "last_error": None}


def _load() -> None:
    t0 = time.time()
    try:
        from .ceo_model import Ensemble

        _model["ensemble"] = Ensemble()
        _model["load_seconds"] = round(time.time() - t0, 1)
    except Exception as exc:  # surfaced via /health so the UI can explain it
        _model["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        _model["loading"] = False
        _activity["t"] = time.time()  # the idle clock starts when the server is usable, not when it booted


# Normally load in the background at startup. The Modal memory-snapshot path loads synchronously instead (MODEL_AUTOLOAD=0).
if os.getenv("MODEL_AUTOLOAD", "1") == "1":
    threading.Thread(target=_load, daemon=True).start()


class JobRequest(BaseModel):
    cik: str = Field(pattern=r"^\d{1,10}$")
    accession: str = Field(pattern=r"^\d{10}-\d{2}-\d{6}$")


EST_PER_UNIT = 0.06  # seconds per (sentence x reader) on the 8-core container; refined live from real timings


def _view(job: dict) -> dict:
    """Job state for the browser, with live elapsed time and a remaining-time estimate."""
    with _lock:
        d = dict(job)
    now = time.time()
    end = d.get("t_end")
    d["elapsed"] = round((end or now) - d["t0"], 1)
    stage = d["stage"]
    if stage in ("done", "error"):
        eta = 0.0
    elif stage == "reading" and d.get("unitsTotal"):
        done, total = d.get("unitsDone", 0), d["unitsTotal"]
        spent = now - d["readStart"]
        rate = spent / done if done > 0 and spent > 1.5 else EST_PER_UNIT
        eta = max(0.0, (total - done) * rate)
    elif stage == "detectors":
        eta = 14.0 if d.get("loadingModels") else 2.0
    elif stage == "splitting" and d.get("unitsTotal"):
        eta = d["unitsTotal"] * EST_PER_UNIT
    elif stage == "locating":
        eta = 4.0
    else:
        eta = 6.0
    d["etaSeconds"] = round(eta, 1)
    for k in ("t0", "t_end", "readStart"):
        d.pop(k, None)
    return d


def _set(job: dict, **kw) -> None:
    with _lock:
        job.update(kw)


def _run(job: dict, cik: str, accession: str, cache: bool = True) -> None:
    t0 = time.time()
    try:
        _set(job, stage="fetching", progress=0.05)
        text, tables_text, meta, exhibit = fetch_all(cik, accession)
        if text is None:
            _set(job, stage="error", t_end=time.time(), error="The SEC did not return this filing (not found or temporarily unavailable).")
            return
        filing = {
            "cik": cik,
            "accession": accession,
            "company": meta.company,
            "form": meta.form,
            "filed": meta.filed,
            "items": sorted({m.group(1) for m in ITEM_HEADING_RE.finditer(text)}),
            "url": filing_txt_url(cik, accession),
            "characters": len(text),
        }
        _set(job, stage="locating", progress=0.2, filing=filing)
        ens = _model["ensemble"]
        result: dict = {
            "filing": filing, "item502Found": False, "section": "", "sentences": [], "readers": ens.reader_names,
            "appointed": {"found": False}, "resigned": {"found": False}, "detectors": [],
        }

        # ---- CEO appointed / resigned (Item 5.02), unchanged ----
        section = find_item_502_section(text)
        if section is not None:
            _set(job, stage="splitting", progress=0.3)
            sentences = split_sentences(section)
            gate_skips = CEO_HINT.search(section) is None and os.getenv("CEO_GATE", "1") == "1"
            total_units = 1  # the CEO model reads the whole section in one pass
            _set(job, stage="splitting", progress=0.3, sentenceCount=len(sentences), unitsTotal=0 if gate_skips else total_units, unitsDone=0)
            result["item502Found"] = True
            result["section"] = section[:8000]
            if gate_skips:
                result["skippedModel"] = "This leadership section never mentions a CEO or president, so no CEO change is possible."
            else:
                _set(job, stage="reading", progress=0.35, readStart=time.time(), readersDone=0)

                def on_progress(done: int, total: int, reader_idx: int) -> None:
                    _set(job, unitsDone=done, readersDone=reader_idx, progress=0.35 + 0.5 * done / total)

                result.update(ens.analyze(sentences, on_progress, plain=text, filing_date=meta.filed))

        # ---- every other detector whose Item is present in this filing ----
        def on_status(title: str, cold: bool) -> None:
            _set(job, stage="detectors", progress=0.88, detail=f"Checking: {title}" + (" (loading its AI readers first)" if cold else ""), loadingModels=cold)

        _set(job, stage="detectors", progress=0.86, detail="Checking for other events…")
        result["detectors"] = run_all(text, tables_text, meta.filed, meta.company, exhibit, on_status)
        result["seconds"] = round(time.time() - t0, 1)
        if cache:
            _cache[f"{cik}/{accession}"] = result
        _set(job, stage="done", progress=1.0, result=result, t_end=time.time())
    except Exception as exc:
        _model["last_error"] = f"{type(exc).__name__}: {exc}"
        _set(job, stage="error", t_end=time.time(), error=f"{type(exc).__name__}: {exc}")


def _models_status() -> list:
    """One entry per detector: ready / loading / off (not loaded yet) / error, so the website can show a status sign."""
    ens = _model["ensemble"]
    ceo_state = "ready" if ens is not None else "error" if _model["error"] else "loading"
    out = [{
        "key": "ceo", "item": "5.02", "title": "CEO appointed or leaving", "state": ceo_state, "error": _model["error"],
        "lastError": _model["last_error"], "adapters": len(ens.readers) if ens else 1, "loadSeconds": _model["load_seconds"],
        "readers": ens.reader_names if ens else [],
    }]
    for f in REGISTRY:
        out.append({
            "key": f.key, "item": f.item, "title": f.title, "state": f.state, "error": f.error, "lastError": f.last_error,
            "adapters": len(f.models), "loadSeconds": f.load_seconds, "readers": [],
        })
    from . import dates_model

    d = dates_model.status()
    if d["state"] != "missing":  # without its adapter the plain pattern reader is used and nothing needs to be shown
        out.append({
            "key": "dates", "item": "5.02", "title": "CEO / CFO date reader", "state": d["state"], "error": d["error"],
            "lastError": None, "adapters": 1, "loadSeconds": None, "readers": [],
        })
    return out


class ShutdownRequest(BaseModel):
    queue: bool = False  # true: wait for any running analysis to finish first


@app.post("/shutdown")
def shutdown(req: Optional[ShutdownRequest] = None) -> dict:
    """Asks the host to stop. The Kaggle kernel watches these flags, exits, and so releases the GPU.

    With queue=true and an analysis running, the stop is queued and happens as soon as the analysis is over."""
    running = _batches.active()
    if req is not None and req.queue and running > 0:
        _activity["shutdown_queued"] = True
        return {"ok": True, "queued": True, "batches": running, "message": "An analysis is running, so the server will turn off as soon as it finishes."}
    _activity.pop("shutdown_queued", None)
    _activity["shutdown"] = True
    return {"ok": True, "queued": False, "batches": running, "message": "Shutting down. The server will stop within a few seconds."}


@app.post("/shutdown/cancel")
def cancel_shutdown() -> dict:
    """Takes back a queued turn-off."""
    _activity.pop("shutdown_queued", None)
    return {"ok": True}


@app.get("/health")
def health() -> dict:
    return {
        "ok": _model["ensemble"] is not None,
        "loading": _model["loading"],
        "error": _model["error"],
        "readers": _model["ensemble"].reader_names if _model["ensemble"] else [],
        "detectors": [{"key": f.key, "item": f.item, "title": f.title, "loaded": f.loaded} for f in REGISTRY],
        "models": _models_status(),
        "batches": _batches.active(),
        "shutdownQueued": bool(_activity.get("shutdown_queued")),
    }


@app.post("/selftest")
def selftest() -> dict:
    """Runs every model once and reports which work. Loads any detector that has not loaded yet."""
    results = []
    ens = _model["ensemble"]
    if ens is None:
        results.append({"key": "ceo", "ok": False, "error": _model["error"] or "still loading", "models": []})
    else:
        import torch

        models = []
        for r in ens.readers:
            try:
                t = time.time()
                enc = r.tok(["The Company announced a change on March 3, 2025."], truncation=True, max_length=64, return_tensors="pt").to(r.model.device)
                with torch.inference_mode():
                    logits = r.model(**enc).logits
                good = logits.shape[-1] == r.n_labels and bool(torch.isfinite(logits).all())
                models.append({"name": r.name, "ok": good, "ms": round((time.time() - t) * 1000), "error": None if good else "unexpected output"})
            except Exception as exc:
                models.append({"name": r.name, "ok": False, "ms": 0, "error": f"{type(exc).__name__}: {exc}"})
        results.append({"key": "ceo", "ok": all(m["ok"] for m in models), "models": models})
    for fam in REGISTRY:
        results.append(selftest_family(fam))
    return {"ok": all(r["ok"] for r in results), "results": results, "models": _models_status()}


def start_prewarm() -> None:
    """Loads every detector in the background so the first filing is not slowed. Several are loaded at once: each load is mostly
    reading weights and merging an adapter, so running a few side by side cuts the start-up time (PREWARM_WORKERS, default 3)."""

    def load_one(fam) -> None:
        try:
            fam.ensure_loaded()
        except Exception:
            pass  # recorded on the family (state "error") and shown in the status panel

    def load_dates() -> None:
        try:
            from . import dates_model

            dates_model.tagger()  # the date reader for CEO / CFO changes loads with the others
        except Exception:
            pass

    def go() -> None:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=int(os.getenv("PREWARM_WORKERS", "3"))) as pool:
            futures = [pool.submit(load_one, fam) for fam in REGISTRY] + [pool.submit(load_dates)]
            for f in futures:
                f.result()
        _activity["t"] = time.time()  # all detectors are ready: the idle clock starts now

    threading.Thread(target=go, daemon=True).start()


@app.post("/jobs")
def create_job(req: JobRequest) -> dict:
    if _model["ensemble"] is None:
        raise HTTPException(503, "The model is still loading" if _model["loading"] else f"Model failed to load: {_model['error']}")
    key = f"{req.cik}/{req.accession}"
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "stage": "queued", "progress": 0.0, "t0": time.time()}
    _jobs[job_id] = job
    if key in _cache:
        _set(job, stage="done", progress=1.0, result=_cache[key], t_end=time.time())
    else:
        _pool.submit(_run, job, req.cik, req.accession)
    if len(_jobs) > 200:
        for old in list(_jobs)[:100]:
            _jobs.pop(old, None)
    return {"id": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job: Optional[dict] = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    return _view(job)


# ---------------------------------------------------------------- background batches
from .batch import BatchRunner  # noqa: E402


def _analyze_sync(cik: str, accession: str) -> dict:
    """Analyzes one filing and returns the full result (used by batches; blocks until done)."""
    cached = _cache.get(f"{cik}/{accession}")
    if cached is not None:
        return cached
    job = {"id": "batch", "stage": "queued", "progress": 0.0, "t0": time.time()}
    _run(job, cik, accession, cache=False)  # not cached: a big batch would otherwise hold every filing's text in memory
    if job.get("stage") == "done":
        return job["result"]
    raise RuntimeError(job.get("error") or "The analysis failed.")


_batches = BatchRunner(_analyze_sync, lambda: _activity.__setitem__("t", time.time()), API_KEY, workers=int(os.getenv("BATCH_WORKERS", "4")))


class BatchRequest(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{16}$")
    base: str = Field(pattern=r"^https://[A-Za-z0-9.\-]+$")  # the website that stores the results
    search: Optional[dict] = None
    filings: Optional[list] = None
    skip: list = []
    part: int = 0


@app.post("/batches")
def start_batch(req: BatchRequest) -> dict:
    if _model["ensemble"] is None:
        raise HTTPException(503, "The model is still loading" if _model["loading"] else f"Model failed to load: {_model['error']}")
    if req.search is None and req.filings is None:
        raise HTTPException(400, "Give either a search or a list of filings.")
    return _batches.start(req.id, req.base, req.search, req.filings, [str(a) for a in req.skip], req.part).view()


@app.get("/batches/{batch_id}")
def get_batch(batch_id: str) -> dict:
    b = _batches.batches.get(batch_id)
    if b is None:
        raise HTTPException(404, "Unknown batch")
    return b.view()


@app.get("/batches/{batch_id}/tail")
def batch_tail(batch_id: str) -> dict:
    b = _batches.batches.get(batch_id)
    if b is None:
        raise HTTPException(404, "Unknown batch")
    return {**b.view(), "items": b.tail()}


@app.post("/batches/{batch_id}/stop")
def stop_batch(batch_id: str) -> dict:
    b = _batches.batches.get(batch_id)
    if b is None:
        raise HTTPException(404, "Unknown batch")
    b.stop = True
    return b.view()
