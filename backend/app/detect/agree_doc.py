"""Items 1.01 / 1.02, filing-level reader (added 2026-10-19).

Replaces the per-sentence "event + type" guess with ONE reading of the whole filing: a RoBERTa-large LoRA model, averaged over two
seeds, that outputs 12 independent yes/no scores - for each of six agreement types (MNA, DEBT, EQUITY, COMMERCIAL, GOVERNANCE,
OTHER) whether such an agreement was ENTERED and whether one was TERMINATED. It reads the company name plus the start of Item 1.01 and
Item 1.02 with the filer's own name replaced by FILER (same recipe as in training: ml/items/f5_common/build_dataset.py `agr_text`).

Why it replaced the old pipeline: on 98 filings whose labels were decided by hand from the raw text (not by any model), against the old
two-reader sentence pipeline - entered any F1 0.926 -> 0.988, entered types 0.775 -> 0.85-0.89, terminated any 0.800 -> 0.919,
terminated types 0.659 -> 0.868 (see src/data/notes.ts). Thresholds (0.6 entered, 0.8 terminated) were picked on other months.

The old sentence readers stay loaded: they still supply the evidence sentence, counterparty and amount. If the adapters are not
mounted (older Kaggle dataset), AgreementsV2 behaves exactly like the old Agreements detector.
"""
import json
import os
import time
from typing import Dict, List, Optional

import torch
from peft import PeftModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from ..devices import place
from . import agreements
from .deal_text import deal_sentences, extract_amounts, strip_caption
from .families2 import MAX_SECTION, Agreements, _money, _softmax_probs
from .items import find_item_section, normalize_filing_text
from .labelers201 import mark_self, self_aliases

TYPES = ["MNA", "DEBT", "EQUITY", "COMMERCIAL", "GOVERNANCE", "OTHER"]
LABELS = ["E_" + t for t in TYPES] + ["T_" + t for t in TYPES]
SEED_DIRS = ("agree_doc_s42", "agree_doc_s7")
THRESH = {"ENTERED": 0.6, "TERMINATED": 0.8}
MAX_LENGTH = 512
TYPE_NAMES = {"MNA": "merger or acquisition", "DEBT": "debt or credit", "EQUITY": "equity or securities", "COMMERCIAL": "commercial or supply",
              "GOVERNANCE": "governance or employment", "OTHER": "other"}


def adapters_dir() -> Optional[str]:
    d = os.environ.get("AGREE_DIR")
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
    """The exact model input used in training (agr_text)."""
    parts = []
    if sections.get("1.01"):
        parts.append("Item 1.01: " + " ".join(strip_caption(sections["1.01"], "1.01").split())[:1000])
    if sections.get("1.02"):
        parts.append("Item 1.02: " + " ".join(strip_caption(sections["1.02"], "1.02").split())[:900])
    blob = " ".join(v for v in sections.values() if v)
    return "Filer: " + company + " || " + mark_self(" || ".join(parts), self_aliases(company, blob))


def predict(readers: list, text: str) -> List[float]:
    """Mean sigmoid probability over the seed readers for the 12 outputs."""
    rows = []
    for tok, model in readers:
        enc = tok([text], truncation=True, max_length=MAX_LENGTH, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            rows.append(torch.sigmoid(model(**enc).logits.float())[0].tolist())
    return [sum(r[i] for r in rows) / len(rows) for i in range(len(LABELS))]


def decide(probs: List[float]) -> Dict[str, list]:
    """{'ENTERED': [(type, p)...], 'TERMINATED': [...]} - every type whose probability clears that event's threshold, most likely first."""
    out = {}
    for ev, off in (("ENTERED", 0), ("TERMINATED", 6)):
        hits = [(TYPES[i], probs[off + i]) for i in range(6) if probs[off + i] >= THRESH[ev]]
        out[ev] = sorted(hits, key=lambda x: -x[1])
    return out


class AgreementsV2(Agreements):
    models = ["agree_events", "agree_types", "agree_doc_s42", "agree_doc_s7"]
    experimental = ("Finds agreements entered and ended well (F1 0.99 / 0.92 on 98 filings checked by hand); naming the agreement types is "
                    "good but not perfect (F1 about 0.85-0.89 entered, 0.87 ended).")

    def _load_models(self) -> None:
        super()._load_models()
        d = adapters_dir()
        self._docr = load_readers(d) if d else None

    def test_models(self) -> list:
        base = super().test_models()
        if getattr(self, "_docr", None):
            base += [(f"Filing reader seed {i} · RoBERTa-large", tok, model, len(LABELS)) for i, (tok, model) in enumerate(self._docr)]
        return base

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        secs = {it: find_item_section(text, it) for it in ("1.01", "1.02")}
        if not any(secs.values()):
            return self.not_applicable()
        self.ensure_loaded()
        if not self._docr:                                   # adapters not mounted: behave like the old detector
            return super().run(plain, tables, filing_date, **ctx)
        company = ctx.get("company", "")
        sections = {it: (s[:MAX_SECTION] if s else None) for it, s in secs.items()}
        probs = predict(self._docr, doc_text(sections, company))
        picked = decide(probs)
        # evidence sentence / counterparty / amount still come from the sentence readers (most confident sentence per event)
        rows = [(it, s) for it, sec in sections.items() if sec for s in deal_sentences(sec, it)]
        etok, emodel, _ = self._ev
        sp = _softmax_probs([s for _, s in rows], etok, emodel, 256) if rows else []
        best: Dict[str, tuple] = {}
        for (it, s), p in zip(rows, sp):
            for k, name in ((1, "ENTERED"), (2, "TERMINATED")):
                if p[k] >= 0.5 and (name not in best or p[k] > best[name][0]):
                    best[name] = (p[k], s, it)
        events = []
        for ev, title in (("ENTERED", "Material agreement entered"), ("TERMINATED", "Material agreement terminated")):
            if not picked[ev]:
                continue
            fallback_item = "1.02" if ev == "TERMINATED" and sections.get("1.02") else ("1.01" if sections.get("1.01") else "1.02")
            if ev in best:
                _, sent, it = best[ev]
            else:                                            # the filing reader is sure but no single sentence stood out: show the opening sentence
                first = deal_sentences(sections[fallback_item], fallback_item) if sections.get(fallback_item) else []
                sent, it = (first[0] if first else ""), fallback_item
            top_type, top_p = picked[ev][0]
            bits = ["Type: " + ", ".join(TYPE_NAMES[t] for t, _ in picked[ev])]
            party = agreements.extract_counterparty(sent) if sent else None
            amounts = extract_amounts(sent) if sent else []
            if party:
                bits.append(f"Counterparty: {party}")
            if amounts:
                bits.append(f"Amount: {_money(max(amounts))}")
            events.append({
                "label": ev, "title": f"{title} (Item {it})", "confidence": round(top_p, 4), "evidence": sent, "detail": " · ".join(bits),
                "types": [{"type": t, "probability": round(p, 4)} for t, p in picked[ev]],
                "readers": [{"reader": f"Filing reader · RoBERTa-large ×{len(self._docr)} ({TYPE_NAMES[top_type]})", "probability": round(top_p, 4)}],
            })
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": bool(events), "events": events, "readerNames": [f"RoBERTa-large filing reader ×{len(self._docr)}", "RoBERTa-base sentence reader (evidence)"],
                "probabilities": {l: round(p, 4) for l, p in zip(LABELS, probs)}, "seconds": round(time.time() - t0, 2)}
