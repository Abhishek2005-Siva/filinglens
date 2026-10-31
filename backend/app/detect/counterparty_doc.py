"""Counterparties named in Items 1.01 / 1.02 / 2.01 / 3.02 (added 2026-10-31, owner training-sec-c8).

A token tagger (BIO, one entity type) that reads the first ~7,000 characters of each of those Item sections and returns every distinct
company or person that is the OTHER party to an agreement or transaction described there: lenders and agents, trustees, underwriters and
placement agents, buyers and sellers, merger partners, investors, licensors, landlords, executives in employment agreements.
It does not return the filer or its subsidiaries, role words ("the Purchaser"), regulators or exchanges, or unnamed groups.

How it reads: the section is cut into 256-token windows (64 tokens of overlap) and each window is prefixed with "Filer: <company>" so the model
knows whose name is NOT a counterparty. Several independently trained models vote; a name is kept when at least VOTE_MIN models predict it.
Predicted spans are repaired to whole words and keep the final period of "Inc." / "N.A." (same code as in training, ml/items/counterparty/cp_common.py).

Why it exists: the earlier regex extractor (one name per sentence) scored F1 0.44 on 84 sections labeled by hand; the tagger ensemble is
reported in src/data/notes.ts. Training text and metrics: ml/items/counterparty/LOG.md.
"""
import os
import re
import shutil
import time
from typing import Dict, List, Optional, Tuple

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

from ..devices import place
from .deal_text import strip_caption
from .families import Family
from .families2 import MAX_SECTION
from .items import find_item_section, normalize_filing_text

ITEMS = ["1.01", "1.02", "2.01", "3.02"]
MAXC = 7000
WIN, STRIDE = 256, 64
VOTE_MIN = int(os.environ.get("CP_VOTE_MIN", "2"))

# ---------------------------------------------------------------- text helpers (copied from ml/items/counterparty/cp_common.py)
SUFFIX = {"inc", "incorporated", "llc", "l", "ltd", "limited", "corp", "corporation", "co", "company", "na", "lp", "llp", "plc", "sa", "nv", "bv", "ag", "the", "gmbh", "ab", "as", "pty", "se",
          "sarl", "kg", "pc", "lllp", "us", "usa", "dba", "dc", "pllc", "ulc", "holdings", "holding", "group", "trust", "bank", "fund"}
ROLE_STOP = {"company", "the company", "purchaser", "purchasers", "buyer", "seller", "sellers", "lender", "lenders", "investor", "investors", "holder", "holders", "parent", "merger sub",
             "agent", "administrative agent", "trustee", "underwriter", "underwriters", "sponsor", "borrower", "issuer", "registrant", "none", "n/a", "we", "us", "our", "filer",
             "sec", "nasdaq", "nyse", "finra", "securities and exchange commission", "the commission", "commission"}
ABBREV_END = {"inc", "ltd", "corp", "co", "cos", "n.a", "na", "s.a", "l.p", "l.l.c", "llc", "l.l.p", "u.s", "jr", "sr", "bros", "plc", "g.p", "n.v", "b.v", "s.a.s", "ph.d", "d/b/a", "f/k/a",
              "pte", "pty", "ag", "a.s", "e.v"}


def norm(name: str) -> str:
    s = name.lower().replace("’", "'")
    s = re.sub(r"(?<=\w)\.(?=\w)", "", s)
    s = re.sub(r"\bnational association\b", "", s)
    s = re.sub(r"[^\w\s&/-]", " ", s)
    toks = re.sub(r"\s+", " ", s).strip().split()
    while len(toks) > 1 and toks[-1] in SUFFIX:
        toks.pop()
    while len(toks) > 1 and toks[0] == "the":
        toks.pop(0)
    return " ".join(toks)


def lenient(a: str, b: str) -> bool:
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 4 and re.search(r"(?<!\w)" + re.escape(short) + r"(?!\w)", long_) is not None


def fix_span(text: str, name: str) -> str:
    i = text.find(name)
    if i < 0:
        return name
    j = i + len(name)
    while i > 0 and (text[i - 1].isalnum() or text[i - 1] in "&'’-"):
        i -= 1
    while j < len(text) and (text[j].isalnum() or text[j] in "&'’-"):
        j += 1
    words = text[i:j].split()
    last = words[-1].lower().strip(",") if words else ""
    if j < len(text) and text[j] == "." and (last in ABBREV_END or re.fullmatch(r"(?:[a-z]\.)+[a-z]", last)):
        j += 1
    return text[i:j].strip(" ,;:()\"'“”")


def postprocess(text: str, names: List[str]) -> List[str]:
    out: List[str] = []
    for n in names:
        f = fix_span(text, n)
        if len(f) >= 3 and f not in out:
            out.append(f)
    return out


# ---------------------------------------------------------------- model
def section_text(section: str, item: str) -> str:
    """The exact model input used in training."""
    return " ".join(strip_caption(section, item).split())[:MAXC]


def _stage_locally(path: str) -> str:
    """Copy a model folder from the (network-backed) dataset mount to local disk with one sequential read. Loading the 700 MB weights straight
    from the mount memory-maps them and takes ~10 minutes per model (measured on Kaggle, 2026-10-31); the copy takes ~10 seconds."""
    local = os.path.join(os.environ.get("CP_LOCAL_DIR", "/tmp/cp_models"), os.path.basename(path))
    if not os.path.exists(os.path.join(local, "model.safetensors")):
        tmp = local + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(path, tmp)
        shutil.rmtree(local, ignore_errors=True)
        os.replace(tmp, local)
    return local


class _Tagger:
    def __init__(self, path: str) -> None:
        self.name = os.path.basename(path)
        path = _stage_locally(path)
        self.roberta = "roberta" in open(os.path.join(path, "config.json")).read().lower()
        self.tok = AutoTokenizer.from_pretrained(path, add_prefix_space=True) if self.roberta else AutoTokenizer.from_pretrained(path)
        self.model = place(AutoModelForTokenClassification.from_pretrained(path, torch_dtype=torch.float32).float().eval())

    def _pair(self, a: List[int], b: List[int]) -> List[int]:
        t = self.tok
        mid = [t.sep_token_id, t.sep_token_id] if self.roberta else [t.sep_token_id]
        return [t.cls_token_id] + a + mid + b + [t.sep_token_id]

    @torch.inference_mode()
    def names(self, company: str, text: str) -> Tuple[List[str], float]:
        enc = self.tok(text, add_special_tokens=False, return_offsets_mapping=True)
        ids, offs = enc["input_ids"], enc["offset_mapping"]
        prefix = self.tok("Filer: " + company, add_special_tokens=False)["input_ids"][:24]
        wins = []
        step = max(1, WIN - STRIDE)
        for st in range(0, max(1, len(ids)), step):
            ch = ids[st:st + WIN]
            if not ch:
                continue
            inp = self._pair(prefix, ch)
            wins.append({"ids": inp, "offs": offs[st:st + WIN], "cs": len(inp) - len(ch) - 1})
            if st + WIN >= len(ids):
                break
        spans: List[Tuple[int, int]] = []
        probs: List[float] = []
        for k in range(0, len(wins), 32):
            batch = wins[k:k + 32]
            m = max(len(w["ids"]) for w in batch)
            x = torch.tensor([w["ids"] + [self.tok.pad_token_id] * (m - len(w["ids"])) for w in batch])
            att = torch.tensor([[1] * len(w["ids"]) + [0] * (m - len(w["ids"])) for w in batch])
            logits = self.model(input_ids=x.to(self.model.device), attention_mask=att.to(self.model.device)).logits.float()
            pr = logits.softmax(-1).cpu()
            lab = pr.argmax(-1).tolist()
            for w, p, lb in zip(batch, pr, lab):
                cur = None
                for i, (s, e) in enumerate(w["offs"]):
                    c = lb[w["cs"] + i]
                    if c == 1 or (c == 2 and cur is None):
                        if cur:
                            spans.append(tuple(cur))
                        cur = [s, e]
                        probs.append(float(1 - p[w["cs"] + i][0]))
                    elif c == 2 and cur is not None:
                        cur[1] = e
                        probs.append(float(1 - p[w["cs"] + i][0]))
                    elif cur:
                        spans.append(tuple(cur))
                        cur = None
                if cur:
                    spans.append(tuple(cur))
        spans.sort()
        merged: List[List[int]] = []
        for a, b in spans:
            if merged and a <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        out: List[str] = []
        for a, b in merged:
            n = text[a:b].strip(" ,;:.()\"'“”")
            if n.lower().startswith("the "):
                n = n[4:]
            if len(n) >= 3 and n.lower() not in ROLE_STOP and n not in out:
                out.append(n)
        return postprocess(text, out), (sum(probs) / len(probs) if probs else 0.0)


def vote(per_model: List[List[str]], need: int) -> List[str]:
    """names predicted (same normalised name, or one contains the other as whole words) by at least `need` models; first model's spelling kept"""
    pool: List[Tuple[str, str]] = []
    for names in per_model:
        pool += [(n, norm(n)) for n in names]
    kept: List[str] = []
    seen: List[str] = []
    for n, nn in pool:
        if any(lenient(nn, s) for s in seen):
            continue
        support = sum(any(lenient(nn, norm(x)) for x in names) for names in per_model)
        if support >= need:
            seen.append(nn)
            kept.append(max([x for names in per_model for x in names if lenient(nn, norm(x))], key=len))
    return kept


def adapters_dir() -> Optional[str]:
    d = os.environ.get("CP_DIR")
    if d and os.path.isdir(d) and any(os.path.exists(os.path.join(d, s, "config.json")) for s in sorted(os.listdir(d))):
        return d
    return None


class Counterparties(Family):
    key, item, title = "counterparties", "1.01 / 1.02 / 2.01 / 3.02", "Counterparties"
    items = ITEMS
    models = ["cp_ner"]
    experimental = ("Names the other parties to agreements and deals (lenders, agents, trustees, buyers, sellers, merger partners, investors). Checked on 124 sections "
                    "labeled by hand; still misses parties that are only named by a short defined term and sometimes lists a filer's own subsidiary.")

    def _load_models(self) -> None:
        d = adapters_dir()
        # without the `filinglens-counterparty` dataset the detector loads as inactive (no taggers) instead of showing an error on that account
        self._taggers = [_Tagger(os.path.join(d, s)) for s in sorted(os.listdir(d)) if os.path.exists(os.path.join(d, s, "config.json"))] if d else []

    def test_models(self) -> list:
        return [(f"Counterparty tagger · {t.name}", t.tok, t.model, 3) for t in getattr(self, "_taggers", [])]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        secs = {it: find_item_section(text, it) for it in ITEMS}
        if not any(secs.values()) or (not self._loaded and not adapters_dir()):
            return self.not_applicable()          # no Item to read, or the `filinglens-counterparty` dataset is not mounted on this account
        self.ensure_loaded()
        if not self._taggers:
            return self.not_applicable()
        company = ctx.get("company", "") or ""
        events, all_names, seen_global = [], [], []
        confs = []
        for it, sec in secs.items():
            if not sec:
                continue
            txt = section_text(sec[:MAX_SECTION], it)
            if len(txt) < 100:
                continue
            res = [t.names(company, txt) for t in self._taggers]
            need = min(VOTE_MIN, len(self._taggers))
            names = vote([r[0] for r in res], need)
            conf = sum(r[1] for r in res) / len(res)
            if not names:
                continue
            confs.append(conf)
            for n in names:
                if not any(lenient(norm(n), g) for g in seen_global):
                    seen_global.append(norm(n))
                    all_names.append(n)
            first = names[0]
            m = re.search(re.escape(first), txt)
            evidence = txt[max(0, m.start() - 120):m.end() + 160] if m else txt[:280]
            events.append({"label": "COUNTERPARTIES", "title": f"Counterparties named in Item {it}", "confidence": round(conf, 4), "evidence": evidence,
                           "detail": "Counterparties: " + " · ".join(names), "names": names,
                           "readers": [{"reader": f"Counterparty tagger · {len(self._taggers)} models, ≥{need} agree", "probability": round(conf, 4)}]})
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": bool(events), "events": events, "counterparties": all_names,
                "readerNames": [f"{len(self._taggers)}-model token tagger (vote ≥{min(VOTE_MIN, len(self._taggers))})"], "seconds": round(time.time() - t0, 2)}
