"""Detectors for 8-K events other than CEO changes. Each family reuses the exact pipeline it was
trained and evaluated with (section slicer, model-input builder, ensemble averaging, thresholds).

  bankruptcy  Item 1.03  RoBERTa-large + DeBERTa-v3-base, mean probability, threshold 0.5
  delisting   Item 3.01  RoBERTa-large x2 + DeBERTa-v3-base, mean probability, threshold 0.5
  auditor     Item 4.01  RoBERTa-base (per-sentence) OR regex fast path
  votes       Item 5.07  RoBERTa-base (per-sentence) OR regex fast path, plus vote-table parsing

Families load their models lazily on first use and keep them in memory.
"""
import json
import os
import re
import threading
import time
from typing import Callable, Dict, List, Optional

import torch
from huggingface_hub import snapshot_download
from peft import PeftModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from ..devices import place
from . import context as ctxmod
from . import item401, item507, rules
from . import items as items_mod
from .items import find_item_section, split_item_sentences

items_mod.ITEM_CAPTIONS.update({"1.03": r"bankruptcy\s+or\s+receivership", "3.01": r"notice\s+of\s+delisting"})

SECTION_CAP, BODY_KW_CAP = 30000, 6000
_load_lock = threading.Lock()
_root: Dict[str, str] = {}


def _repo_root() -> str:
    with _load_lock:
        if "p" not in _root:
            _root["p"] = os.environ.get("MODEL_DIR") or snapshot_download(repo_id=os.environ["MODEL_REPO"], token=os.getenv("HF_TOKEN"), allow_patterns=["other/*"])
        return _root["p"]


def _load(name: str, num_labels: int):
    d = os.path.join(_repo_root(), "other", name)
    with open(os.path.join(d, "adapter_config.json")) as f:
        base = json.load(f)["base_model_name_or_path"]
    tok = AutoTokenizer.from_pretrained(d)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=num_labels, problem_type="multi_label_classification", torch_dtype=torch.float32)
    model = place(PeftModel.from_pretrained(model, d).merge_and_unload().float().eval())
    labels_path = os.path.join(d, "labels.json")
    meta = json.load(open(labels_path)) if os.path.exists(labels_path) else {}
    return tok, model, meta


def _sigmoid_probs(texts: List[str], tok, model, max_length: int, batch: int = 16) -> List[List[float]]:
    out: List[Optional[List[float]]] = [None] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for i in range(0, len(order), batch):
        idx = order[i : i + batch]
        enc = tok([texts[j] for j in idx], truncation=True, max_length=max_length, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            p = torch.sigmoid(model(**enc).logits.float()).tolist()
        for j, row in zip(idx, p):
            out[j] = row
    return out  # type: ignore[return-value]


def _keyword_sentences(item: str, text: str, cap: int) -> str:
    kw = ctxmod.ITEM_CFG[item]["kw"]
    kept, size, seen = [], 0, set()
    for s in split_item_sentences(text):
        if kw.search(s) and s not in seen:
            seen.add(s)
            s = s[:700]
            if size + len(s) > cap:
                break
            kept.append(s)
            size += len(s) + 1
    return " ".join(kept)


class Family:
    key = ""
    item = ""
    title = ""
    models: List[str] = []
    items: List[str] = []   # every 8-K Item this detector reads (defaults to [item])
    source = "plain"        # which text variant the Item section is cut from: "plain" or "tables"
    experimental = ""       # honest caveat shown next to the detector, if any

    def item_list(self) -> List[str]:
        return self.items or [self.item]

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self.state = "off"          # off (not loaded yet) | loading | ready | error
        self.error: Optional[str] = None       # why loading failed
        self.last_error: Optional[str] = None  # last failure while analysing a filing
        self.load_seconds: Optional[float] = None

    @property
    def loaded(self) -> bool:
        return self._loaded

    def ensure_loaded(self) -> None:
        with self._lock:
            if self._loaded:
                return
            self.state, t0 = "loading", time.time()
            try:
                self._load_models()
            except Exception as exc:
                self.state, self.error = "error", f"{type(exc).__name__}: {exc}"
                raise
            self._loaded, self.state, self.error = True, "ready", None
            self.load_seconds = round(time.time() - t0, 1)

    def test_models(self) -> list:
        """[(display name, tokenizer, model, expected number of labels)] for the self-test; override per family."""
        return []

    def _load_models(self) -> None:
        raise NotImplementedError

    def present(self, plain: str, tables: str) -> bool:
        text = tables if self.source == "tables" else plain
        return any(find_item_section(text, it) is not None for it in self.item_list())

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        raise NotImplementedError

    def not_applicable(self) -> dict:
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": False, "found": False, "events": [],
                "experimental": self.experimental}


# --------------------------------------------------------------------------------- 1.03 / 3.01
class DistressFamily(Family):
    """Section-level multi-label classifier ensemble (probabilities averaged)."""

    spec: List[tuple] = []  # (folder, max_len, display name)
    rescue_at: Optional[float] = None   # report the likeliest label of a long, declared Item when nothing reaches 0.5 but this one reaches this value
    event_titles: Dict[str, str] = {}

    def _load_models(self) -> None:
        self._m = []
        for folder, max_len, name in self.spec:
            tok, model, _ = _load(folder, len(ctxmod.ITEM_CFG[self.item]["labels"]))
            self._m.append((tok, model, max_len, name))

    def test_models(self) -> list:
        n = len(ctxmod.ITEM_CFG[self.item]["labels"])
        return [(name, tok, model, n) for tok, model, _, name in self._m]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        labels = ctxmod.ITEM_CFG[self.item]["labels"]
        section = find_item_section(plain, self.item)
        if section is None:
            return self.not_applicable()
        self.ensure_loaded()
        section = section[:SECTION_CAP]
        body_kw = _keyword_sentences(self.item, plain.replace(section, " "), BODY_KW_CAP)
        text = ctxmod.build_context(self.item, section, body_kw, filing_date=filing_date)
        if not text.strip():
            res = self.not_applicable()
            res.update({"applicable": True, "note": "The section had no readable text."})
            return res
        per_model = []
        for tok, model, max_len, name in self._m:
            per_model.append((name, _sigmoid_probs([text], tok, model, max_len)[0]))
        mean = [sum(p[k] for _, p in per_model) / len(per_model) for k in range(len(labels))]
        pred = [l for l, v in zip(labels, mean) if v >= 0.5]
        a = rules.analyze(self.item, section, body_kw, filing_date)
        rescued = False
        if not pred and self.rescue_at is not None and len(section) >= 600:
            # the readers split (one at 0.01, one at 0.5) on a filing that declares the Item and says plenty: report the likeliest label, marked as unsure
            k = max(range(len(labels)), key=mean.__getitem__)
            if mean[k] >= self.rescue_at or a["evidence"].get(labels[k]):
                pred, rescued = [labels[k]], True
        events = []
        for l in sorted(pred, key=lambda l: -mean[labels.index(l)]):
            events.append({
                "label": l,
                "title": self.event_titles.get(l, l.replace("_", " ").title()),
                "confidence": round(mean[labels.index(l)], 4),
                "evidence": a["evidence"].get(l),
                "readers": [{"reader": n, "probability": round(p[labels.index(l)], 4)} for n, p in per_model],
                **({"unsure": True} if rescued else {}),
            })
        return {
            "key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
            "found": bool(events), "events": events, "fields": a["fields"],
            "probabilities": {l: round(v, 4) for l, v in zip(labels, mean)},
            "readerProbabilities": {n: {l: round(v, 4) for l, v in zip(labels, p)} for n, p in per_model},
            "readerNames": [n for n, _ in per_model],
            "inputText": text[:1500],
            "seconds": round(time.time() - t0, 2),
        }


class Bankruptcy(DistressFamily):
    key, item, title = "bankruptcy", "1.03", "Bankruptcy or receivership"
    rescue_at = 0.25
    spec = [("bankruptcy_rl42", 448, "Reader A · RoBERTa-large"), ("bankruptcy_db42", 384, "Reader B · DeBERTa-v3")]
    models = [s[0] for s in spec]
    event_titles = {
        "PETITION_FILED": "Bankruptcy petition filed",
        "RECEIVERSHIP": "Receivership or assignment for creditors",
        "PLAN_CONFIRMED": "Reorganization plan confirmed",
        "CONVERTED_DISMISSED": "Bankruptcy case converted or dismissed",
    }


class Delisting(DistressFamily):
    key, item, title = "delisting", "3.01", "Delisting or listing notice"
    spec = [
        ("delisting_rl42", 448, "Reader A · RoBERTa-large"),
        ("delisting_rl7", 448, "Reader B · RoBERTa-large"),
        ("delisting_db42", 384, "Reader C · DeBERTa-v3"),
    ]
    models = [s[0] for s in spec]
    event_titles = {
        "DEFICIENCY_NOTICE": "Listing deficiency notice received",
        "DELISTING_EXCHANGE": "Delisting by the exchange",
        "DELISTING_VOLUNTARY": "Voluntary delisting",
        "TRANSFER": "Transfer to another exchange or tier",
        "COMPLIANCE_REGAINED": "Listing compliance regained",
    }


# --------------------------------------------------------------------------------- 4.01 / 5.07
class SentenceFamily(Family):
    """Per-sentence multi-label model (per-label thresholds) combined with the regex fast path (union)."""

    mod = None
    folder = ""

    def _load_models(self) -> None:
        self._tok, self._model, meta = _load(self.folder, len(self.mod.LABELS))
        self._thr = meta.get("thresholds", 0.5)

    def test_models(self) -> list:
        return [(self.folder, self._tok, self._model, len(self.mod.LABELS))]

    def _analyze(self, plain: str, tables: str):
        section = find_item_section(tables, self.item)
        if section is None:
            return None
        self.ensure_loaded()
        sents = self.mod.sentences_from_section(section)
        probs = _sigmoid_probs(sents, self._tok, self._model, 320, batch=32) if sents else []
        scores = [{l: float(p[j]) for j, l in enumerate(self.mod.LABELS)} for p in probs]
        rec_model = self.mod.aggregate(sents, scores, self._thr, section=section)
        rec_regex = self.mod.regex_analyze(sents, section=section)
        return section, sents, rec_model, rec_regex


class Auditor(SentenceFamily):
    key, item, title = "auditor", "4.01", "Change of auditor"
    source = "tables"
    mod, folder = item401, "auditor_rb"
    models = ["auditor_rb"]
    flags = [
        ("DISMISSED", "dismissed", "Auditor dismissed"),
        ("RESIGNED", "resigned", "Auditor resigned"),
        ("ENGAGED", "engaged", "New auditor engaged"),
        ("DISAGREEMENT", "disagreement", "Disagreement with the auditor reported"),
        ("REPORTABLE_EVENT", "reportable_event", "Reportable event or material weakness"),
        ("OPINION_MODIFIED", "opinion_modified", "Prior audit opinion was adverse or qualified"),
    ]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        got = self._analyze(plain, tables)
        if got is None:
            return self.not_applicable()
        _section, _sents, m, r = got
        events = []
        for label, key, title in self.flags:
            if m[key] or r[key]:
                src = "model and rules" if m[key] and r[key] else "model" if m[key] else "rules"
                detail = ""
                if key in ("dismissed", "resigned") and (m["former_auditor"] or r["former_auditor"]):
                    detail = m["former_auditor"] or r["former_auditor"]
                if key == "engaged" and (m["new_auditor"] or r["new_auditor"]):
                    detail = m["new_auditor"] or r["new_auditor"]
                events.append({
                    "label": label, "title": title, "detail": detail, "source": src,
                    "confidence": m["confidence"].get(label), "evidence": m["evidence"].get(label) or r["evidence"].get(label),
                })
        return {
            "key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental, "found": bool(events), "events": events,
            "fields": {"former_auditor": m["former_auditor"] or r["former_auditor"], "new_auditor": m["new_auditor"] or r["new_auditor"]},
            "readerNames": ["RoBERTa-base + rule engine"], "seconds": round(time.time() - t0, 2),
        }


_VOTE_TAIL = re.compile(r"(?i)[\s,;:.\-–]*(?:(?:was|were|is)\s+(?:approved|ratified|elected|adopted)\s*)?(?:,?\s*(?:by|with|based on|as|on)\s+(?:a\s+vote\s+of\s+(?:the\s+)?\w+\s+)?(?:the\s+)?(?:following\s+)?(?:votes?|results?|tabulation|table)[^.]*?|"
                        r"received\s+the\s+following\s+votes|(?:as\s+)?follows|(?:is|are)\s+(?:as\s+)?(?:follows|set\s+forth\s+below)|The\s+(?:final\s+)?(?:voting\s+)?results?\b[^.]*?(?:follows|below))\s*:?\s*$")


def _vote_title(desc: str) -> str:
    """The proposal's own words: the last sentence before its table, without 'by the following vote:' and the like."""
    d = re.sub(r"\s+", " ", desc).strip()
    parts = [x.strip() for x in re.split(r"(?<=[.:])\s+(?=[A-Z0-9“\"(])|\s+\|\s+", d) if x.strip()]
    for part in reversed(parts):
        if not re.search(r"[A-Za-z]{3}", part) or re.match(r"(?i)(?:this\s+proposal|the\s+proposal\s+was|the\s+stockholders|the\s+shareholders|a\s+majority|the\s+results|there\s+were\s+no)", part):
            continue  # '153,828,391 |' and 'This proposal was approved by the requisite vote'; the proposal's own wording comes earlier
        cleaned = _VOTE_TAIL.sub("", part).strip(" ,;:.")
        if len(cleaned) >= 20 and not re.fullmatch(r"(?i)(?:proposal\s*(?:no\.?)?\s*\d+|for|against|abstain|\d+)[.:]?", cleaned):
            d = cleaned
            break
    if d[:1].islower() and " " in d:  # the stored description is cut at 200 characters, often mid-word
        d = "…" + d[d.find(" ") + 1:]
    if len(d) > 130:
        d = d[:127].rsplit(" ", 1)[0] + "…"
    return d


class Votes(SentenceFamily):
    key, item, title = "votes", "5.07", "Shareholder vote results"
    source = "tables"
    mod, folder = item507, "votes_rb"
    models = ["votes_rb"]
    flags = [
        ("has_directors", "Directors elected"),
        ("has_auditor", "Auditor ratified"),
        ("has_say_on_pay", "Say-on-pay vote"),
        ("has_say_on_frequency", "Pay-vote frequency vote"),
        ("has_equity_plan", "Equity plan vote"),
        ("has_charter", "Charter or bylaw amendment"),
        ("has_merger", "Merger or transaction vote"),
        ("has_share_issuance", "Share issuance or reverse split vote"),
        ("has_shareholder_proposal", "Shareholder proposal"),
        ("has_adjournment", "Meeting adjournment"),
        ("special_meeting", "Special meeting"),
        ("any_failed", "A proposal did not pass"),
    ]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        got = self._analyze(plain, tables)
        if got is None:
            return self.not_applicable()
        section, _sents, m, r = got
        events = []
        for key, title in self.flags:
            if m[key] or r[key]:
                ev = {"label": key.upper(), "title": title, "source": "model and rules" if m[key] and r[key] else "model" if m[key] else "rules"}
                if key == "has_say_on_pay" and m.get("say_on_pay_pct_for") is not None:
                    ev["detail"] = f"{m['say_on_pay_pct_for']:.1f}% voted for" if isinstance(m["say_on_pay_pct_for"], (int, float)) else str(m["say_on_pay_pct_for"])
                events.append(ev)
        votes = item507.parse_votes(section)
        rows_out = []
        for t in votes.get("tables", [])[:15]:
            desc = _vote_title(t.get("desc") or "")
            row = {"Proposal": desc if desc else ("Election of directors" if t.get("kind") == "directors" else "Pay-vote frequency" if t.get("kind") == "frequency" else "Proposal")}
            if t.get("kind") == "proposal":
                row.update({"For": t.get("for"), "Against": t.get("against"), "Abstain": t.get("abstain"), "% for": t.get("pct_for"),
                            "Result": "Passed" if t.get("passed_by_math") else "Did not pass"})
            elif t.get("kind") == "directors":
                row.update({"Nominees": t.get("n_rows"), "Below majority": t.get("nominees_below_majority")})
            rows_out.append({k: v for k, v in row.items() if v is not None})
        return {
            "key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental, "found": bool(events), "events": events,
            "fields": {
                "Proposals voted on": m.get("n_proposals") or None,
                "Say-on-pay support": (f"{m['say_on_pay_pct_for']:.1f}% for, " + ("did not pass" if m.get("say_on_pay_failed") else "passed")) if isinstance(m.get("say_on_pay_pct_for"), (int, float)) else None,
            },
            "voteRows": rows_out,
            "readerNames": ["RoBERTa-base + rule engine"], "seconds": round(time.time() - t0, 2),
        }
