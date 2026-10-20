"""Item 3.02, filing-level reader (added 2026-10-20).

Replaces the per-sentence "sale + type" guess with ONE reading of the whole filing: a RoBERTa-large LoRA model that outputs 13
independent yes/no scores - seven security types (common, preferred, convertible notes, warrants, units, equity award, other) and six
exemptions (4(a)(2), Regulation D, Regulation S, 3(a)(9), 3(a)(10), other). It reads the company name, the start of Item 3.02 and the
start of Item 1.01 (where about a quarter of 3.02 sections just point to), with the filer's own name replaced by FILER (same recipe as
training: ml/items/f5_common/build_dataset.py `doc302_text`).

Why it replaced the old pipeline: on 57 filings whose labels were decided by hand from the raw text (not by any model), security type
F1 0.66 -> 0.82 and exemption F1 0.72 -> 0.83 (0.81 / 0.81 on the two final months that were never used for tuning). The 0.5 cut-offs
are the untuned defaults.

The model does not read amounts: proceeds and price still come from the regex extractors, and the evidence sentence from the old
sentence reader. If the adapter is not mounted, or no security type clears the cut-off, EquityV2 behaves exactly like the old Equity
detector.
"""
import json
import os
import time
from typing import Dict, List, Optional

import torch
from peft import PeftModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from ..devices import place
from . import rules302
from .deal_text import deal_sentences, strip_caption
from .families2 import MAX_SECTION, Equity, _money, _softmax_probs
from .items import find_item_section, normalize_filing_text
from .labelers201 import mark_self, self_aliases

TYPES = ["COMMON", "PREFERRED", "CONVERTIBLE_DEBT", "WARRANT", "UNITS", "EQUITY_AWARD", "OTHER"]
EXEMPTS = ["4A2", "REG_D", "REG_S", "3A9", "3A10", "OTHER"]
LABELS = ["T_" + t for t in TYPES] + ["X_" + x for x in EXEMPTS]
EXEMPT_NAMES = {"4A2": "4(a)(2)", "REG_D": "Regulation D", "REG_S": "Regulation S", "3A9": "3(a)(9)", "3A10": "3(a)(10)", "OTHER": "other"}
TYPE_NAMES = {"COMMON": "common stock", "PREFERRED": "preferred stock", "CONVERTIBLE_DEBT": "convertible notes", "WARRANT": "warrants",
              "UNITS": "units", "EQUITY_AWARD": "equity award", "OTHER": "other securities"}
SEED_DIRS = ("equity_doc_s42",)
THRESH_TYPE, THRESH_EXEMPT = 0.5, 0.5
MAX_LENGTH = 512


def adapters_dir() -> Optional[str]:
    d = os.environ.get("EQUITY_DIR")
    if d and all(os.path.exists(os.path.join(d, s, "adapter_config.json")) for s in SEED_DIRS):
        return d
    return None


def load_readers(d: str) -> list:
    out = []
    for s in SEED_DIRS:
        p = os.path.join(d, s)
        with open(os.path.join(p, "adapter_config.json")) as f:
            base = json.load(f)["base_model_name_or_path"]
        tok = AutoTokenizer.from_pretrained(p)
        model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=len(LABELS), problem_type="multi_label_classification",
                                                                   torch_dtype=torch.float32)
        out.append((tok, place(PeftModel.from_pretrained(model, p).merge_and_unload().float().eval())))
    return out


def doc_text(sections: Dict[str, Optional[str]], company: str) -> str:
    """The exact model input used in training (doc302_text)."""
    parts = ["Item 3.02: " + " ".join(strip_caption(sections["3.02"], "3.02").split())[:1000]]
    if sections.get("1.01"):
        parts.append("Item 1.01: " + " ".join(strip_caption(sections["1.01"], "1.01").split())[:1100])
    blob = " ".join(v for v in sections.values() if v)
    return "Filer: " + company + " || " + mark_self(" || ".join(parts), self_aliases(company, blob))


def predict(readers: list, text: str) -> List[float]:
    """Mean sigmoid probability over the seed readers for the 13 outputs."""
    rows = []
    for tok, model in readers:
        enc = tok([text], truncation=True, max_length=MAX_LENGTH, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            rows.append(torch.sigmoid(model(**enc).logits.float())[0].tolist())
    return [sum(r[i] for r in rows) / len(rows) for i in range(len(LABELS))]


def decide(probs: List[float]) -> Dict[str, list]:
    """Every security type / exemption whose probability clears the cut-off, most likely first."""
    types = sorted([(TYPES[i], probs[i]) for i in range(len(TYPES)) if probs[i] >= THRESH_TYPE], key=lambda x: -x[1])
    ex = sorted([(EXEMPTS[i], probs[len(TYPES) + i]) for i in range(len(EXEMPTS)) if probs[len(TYPES) + i] >= THRESH_EXEMPT], key=lambda x: -x[1])
    return {"types": types, "exemptions": ex}


class EquityV2(Equity):
    models = ["equity_events", "equity_types", "equity_doc_s42"]
    experimental = ("Names the security type and the exemption fairly well (F1 about 0.82 and 0.83 on 57 filings checked by hand); "
                    "the amount raised still comes from text patterns and is right about 4 times in 5.")

    def _load_models(self) -> None:
        super()._load_models()
        d = adapters_dir()
        self._docr = load_readers(d) if d else None

    def test_models(self) -> list:
        base = super().test_models()
        if getattr(self, "_docr", None):
            base += [(f"Filing reader · RoBERTa-large", tok, model, len(LABELS)) for tok, model in self._docr]
        return base

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        secs = {it: find_item_section(text, it) for it in ("3.02", "1.01")}
        if not secs["3.02"]:
            return self.not_applicable()
        self.ensure_loaded()
        if not self._docr:                                   # adapter not mounted: behave like the old detector
            return super().run(plain, tables, filing_date, **ctx)
        sections = {it: (s[:MAX_SECTION] if s else None) for it, s in secs.items()}
        probs = predict(self._docr, doc_text(sections, ctx.get("company", "")))
        picked = decide(probs)
        if not picked["types"]:                              # the filing reader sees no security: let the sentence readers decide
            return super().run(plain, tables, filing_date, **ctx)
        sec = sections["3.02"]
        # evidence sentence: the most confident sale sentence from the old sentence reader
        sents = deal_sentences(sec, "3.02")
        etok, emodel, _ = self._ev
        sp = _softmax_probs(sents, etok, emodel, 256) if sents else []
        scored = [(p[1], s) for s, p in zip(sents, sp)]
        sent = max(scored)[1] if scored else (sents[0] if sents else "")
        nums = rules302.extract_numbers(sec)
        top_type, top_p = picked["types"][0]
        bits = ["Security: " + ", ".join(TYPE_NAMES[t] for t, _ in picked["types"])]
        if nums.get("gross_proceeds_usd"):
            bits.append(f"Proceeds: {_money(nums['gross_proceeds_usd'])}")
        if nums.get("price_per_share_usd"):
            bits.append(f"Price per share: ${nums['price_per_share_usd']:g}")
        if picked["exemptions"]:
            bits.append("Exemption: " + ", ".join(EXEMPT_NAMES[x] for x, _ in picked["exemptions"]))
        events = [{
            "label": "SALE", "title": "Unregistered equity securities sold", "confidence": round(top_p, 4), "evidence": sent, "detail": " · ".join(bits),
            "types": [{"type": t, "probability": round(p, 4)} for t, p in picked["types"]],
            "exemptions": [{"exemption": x, "probability": round(p, 4)} for x, p in picked["exemptions"]],
            "readers": [{"reader": f"Filing reader · RoBERTa-large ({TYPE_NAMES[top_type]})", "probability": round(top_p, 4)}],
        }]
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": True, "events": events, "readerNames": ["RoBERTa-large filing reader", "RoBERTa-base sentence reader (evidence)"],
                "probabilities": {l: round(p, 4) for l, p in zip(LABELS, probs)}, "seconds": round(time.time() - t0, 2)}
