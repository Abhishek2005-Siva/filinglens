"""Background batch analysis.

The website hands over a search (or a list of filings). This module collects every matching filing, analyzes them a few
at a time, and hands the answers to the website's `/api/batch` endpoint in small parts, so the results are stored there
and the user can close the page and come back later. Nothing here depends on a browser being open.
"""
import datetime as dt
import threading
import time
from queue import Empty, Queue
from typing import Callable, Dict, List, Optional

import requests

PART_SIZE = 50  # filings per stored part
HEARTBEAT = 90  # seconds between progress notes while nothing else is being saved
EFTS_LIMIT = 10000  # the SEC search cannot page past this many hits for one query
_session = requests.Session()


class Stopped(Exception):
    """Raised inside collection when the batch was stopped or the server is going away."""


def slim(result: dict) -> dict:
    """Keeps only what the spreadsheet needs (drops the filing text and per-sentence scores)."""
    f = result.get("filing", {})

    def ext(e: dict) -> dict:
        out = {k: e[k] for k in ("found", "name", "confidence", "effective", "effectiveNote", "decided") if e.get(k) is not None or k in ("found",)}
        if e.get("sentence"):
            out["sentence"] = str(e["sentence"])[:600]
        c = e.get("check")
        if c:
            out["check"] = {k: c[k] for k in ("score", "state", "reason", "repointed") if c.get(k) is not None}
        return out

    dets = []
    for d in result.get("detectors", []):
        if not d.get("applicable"):
            continue
        events = []
        for ev in d.get("events", []):
            item = {k: ev[k] for k in ("title", "detail", "confidence", "kind", "name", "interim", "effective", "effectiveNote", "decided") if ev.get(k) is not None}
            if ev.get("evidence"):
                item["evidence"] = str(ev["evidence"])[:600]
            events.append(item)
        dets.append({"key": d["key"], "applicable": True, "found": bool(d.get("found")), "events": events})
    return {
        "filing": {"items": f.get("items", [])},
        "item502Found": bool(result.get("item502Found")),
        "appointed": ext(result.get("appointed", {})),
        "resigned": ext(result.get("resigned", {})),
        "detectors": dets,
    }


class Batch:
    def __init__(self, runner: "BatchRunner", id: str, base: str, search: Optional[dict], filings: Optional[List[dict]], skip: List[str], part: int):
        self.runner = runner
        self.id = id
        self.base = base.rstrip("/")
        self.search = search
        self.explicit = filings
        self.skip = set(skip)
        self.part = part
        self.stored = part  # parts the website has accepted so far
        self.status = "queued"
        self.total = 0
        self.done = len(self.skip)
        self.errors = 0
        self.message = ""
        self.started_at = time.time()
        self.updated_at = time.time()
        self.stop = False
        self.reason = ""  # set when the server itself is going away
        self.buf: List[dict] = []
        self.lock = threading.Lock()
        self.save_lock = threading.Lock()
        self.pending_parts: List[tuple] = []  # (n, items) not yet accepted by the website
        self.last_save = 0.0
        self.finished = False  # true once the final note has been handed to the website

    # ---- talking to the website ----
    def _post(self, payload: dict) -> Optional[dict]:
        for attempt in range(4):
            try:
                r = _session.post(f"{self.base}/api/batch", json={"action": "save", "id": self.id, **payload},
                                  headers={"Authorization": f"Bearer {self.runner.api_key}"}, timeout=60)
                if r.status_code == 200:
                    body = r.json()
                    if body.get("stop"):
                        self.stop = True
                    return body
                if r.status_code in (400, 401, 403, 404):
                    self.message = f"The website refused the save ({r.status_code})."
                    return None
            except (requests.RequestException, ValueError):
                pass
            time.sleep(2 ** attempt)
        return None

    def view(self) -> dict:
        return {"id": self.id, "status": self.status, "total": self.total, "done": self.done, "errors": self.errors,
                "message": self.message, "updatedAt": int(self.updated_at * 1000), "startedAt": int(self.started_at * 1000), "parts": self.stored}

    def tail(self) -> List[dict]:
        """Finished filings the website has not stored yet, so a page can show them right away."""
        with self.lock:
            items = list(self.buf)
        for _, p in list(self.pending_parts):
            items += p
        return items

    def save(self, **patch) -> bool:
        """Sends any waiting parts, then the progress note. Returns False if the website could not be reached."""
        with self.save_lock:
            ok = True
            while self.pending_parts:
                n, items = self.pending_parts[0]
                if self._post({"part": {"n": n, "items": items}, "patch": {"parts": n + 1, **self._counts()}}) is None:
                    ok = False
                    break
                self.pending_parts.pop(0)
                self.stored = n + 1
            if ok:
                ok = self._post({"patch": {**self._counts(), "status": self.status, "message": self.message, **patch}}) is not None
            self.last_save = time.time()
            return ok

    def _counts(self) -> dict:
        return {"total": self.total, "done": self.done, "errors": self.errors}

    def _flush(self, force: bool = False) -> None:
        with self.lock:
            if self.buf and (force or len(self.buf) >= PART_SIZE):
                self.pending_parts.append((self.part, self.buf))
                self.part += 1
                self.buf = []
        if self.pending_parts:
            self.save()

    # ---- the work ----
    def run(self) -> None:
        try:
            self.status = "collecting"
            self.save()
            filings = self.explicit if self.explicit is not None else self._collect()
            if self.stop or self.reason:
                return self._finish()
            seen, todo = set(), []
            for f in filings:
                acc = f["accession"]
                if acc in seen:
                    continue
                seen.add(acc)
                if acc not in self.skip:
                    todo.append(f)
            self.total = len(self.skip) + len(todo)
            self.status = "running"
            self.save()
            q: Queue = Queue()
            for f in todo:
                q.put(f)

            def worker() -> None:
                while not self.stop and not self.reason:
                    try:
                        f = q.get_nowait()
                    except Empty:
                        return
                    entry: dict = {"filing": f}
                    try:
                        entry["result"] = slim(self.runner.analyze(f["cik"], f["accession"]))
                    except Exception as exc:  # recorded as an error row; the batch carries on
                        entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
                    with self.lock:
                        self.buf.append(entry)
                        self.done += 1
                        self.errors += 1 if "error" in entry else 0
                        self.updated_at = time.time()
                    self.runner.touch()
                    self._flush()

            threads = [threading.Thread(target=worker, daemon=True) for _ in range(self.runner.workers)]
            for t in threads:
                t.start()
            while any(t.is_alive() for t in threads):
                time.sleep(2)
                self.runner.touch()  # the GPU is busy, so the idle shutdown clock stays at zero
                if time.time() - self.last_save > HEARTBEAT:
                    self.save()
            self._finish()
        except Stopped:
            self._finish()
        except Exception as exc:
            self.status = "error"
            self.message = f"{type(exc).__name__}: {exc}"[:300]
            self._flush(force=True)
            self.save(finishedAt=int(time.time() * 1000))
        finally:
            self.finished = True

    def _finish(self) -> None:
        if self.reason:
            final, self.message = "interrupted", self.reason
        elif self.stop:
            final = "stopped"
        else:
            final = "done"
        self.updated_at = time.time()
        self._flush(force=True)
        for _ in range(10):  # the final note matters most: keep trying for a while
            if self.save(status=final, finishedAt=int(time.time() * 1000)):
                break
            time.sleep(6)
        self.status = final  # shown to pages only now, when everything they need is stored

    # ---- finding the filings ----
    def _get(self, path: str, params: dict) -> dict:
        for attempt in range(5):
            if self.stop or self.reason:
                raise Stopped()
            try:
                r = _session.get(f"{self.base}{path}", params=params, timeout=60)
                if r.status_code == 200:
                    return r.json()
                if r.status_code == 404:
                    raise RuntimeError(r.json().get("error", "Not found"))
            except (requests.RequestException, ValueError):
                pass
            time.sleep(2 * (attempt + 1))
        raise RuntimeError("The website's SEC search did not answer.")

    def _collect(self) -> List[dict]:
        s = self.search or {}
        base = {"forms": s.get("forms") or "8-K", "item": s.get("item") or "", "cik": s.get("cik") or "", "q": s.get("q") or ""}
        start, end = s.get("start") or "", s.get("end") or ""
        if base["cik"] and not base["q"].strip():  # one company with no keywords: its full filing list in one call
            return self._get("/api/filings", {**base, "start": start, "end": end, "all": "1"}).get("filings", [])
        out: List[dict] = []
        seen = set()

        def window(a: str, b: str) -> None:
            dates = {"start": a, "end": b} if a and b else {}
            first = self._get("/api/search", {**base, **dates, "from": 0})
            total = int(first.get("total", 0))
            if total > EFTS_LIMIT and not (a and b):  # no dates given but too many hits: cover all of EDGAR's history in date windows
                window("2001-01-01", dt.date.today().isoformat())
                return
            if total > EFTS_LIMIT and a and b and a < b:  # the SEC will not page past 10,000 hits: split the dates in two
                d1, d2 = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
                mid = (d1 + (d2 - d1) / 2).isoformat()
                window(a, mid)
                window((dt.date.fromisoformat(mid) + dt.timedelta(days=1)).isoformat(), b)
                return
            page, pos = first, 0
            while True:
                for f in page.get("filings", []):
                    if f["accession"] not in seen:
                        seen.add(f["accession"])
                        out.append(f)
                step = int(page.get("pageSize", 0))
                pos += step
                self.total = max(self.total, len(out))
                if step <= 0 or pos >= min(total, EFTS_LIMIT):
                    return
                time.sleep(0.15)
                page = self._get("/api/search", {**base, **dates, "from": pos})

        if s.get("start") or s.get("end"):
            start = start or "2001-01-01"
            end = end or dt.date.today().isoformat()
        window(start, end)
        return out


class BatchRunner:
    def __init__(self, analyze: Callable[[str, str], dict], touch: Callable[[], None], api_key: str, workers: int = 4):
        self.analyze = analyze
        self.touch = touch
        self.api_key = api_key
        self.workers = workers
        self.batches: Dict[str, Batch] = {}

    def start(self, id: str, base: str, search: Optional[dict], filings: Optional[List[dict]], skip: List[str], part: int) -> Batch:
        old = self.batches.get(id)
        if old and not old.finished:
            return old
        b = Batch(self, id, base, search, filings, skip, part)
        self.batches[id] = b
        threading.Thread(target=b.run, daemon=True).start()
        return b

    def active(self) -> int:
        return sum(1 for b in self.batches.values() if not b.finished)

    def stop_all(self, reason: str, wait: float = 30.0) -> None:
        """Called when the server is about to go away: stop taking new filings and hand over what is done."""
        for b in self.batches.values():
            if not b.finished:
                b.reason = reason
        end = time.time() + wait
        while self.active() and time.time() < end:
            time.sleep(1)
