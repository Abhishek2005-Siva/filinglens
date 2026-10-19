"""Item 1.05 (material cybersecurity incidents) — MATERIALITY classifier.

A single roberta-large + LoRA model, loaded from its own small Kaggle
dataset (not folded into the main 540MB `filinglens-adapters` dataset —
see backend/kaggle/server_template.py's ITEM105_DIR glob), the same
pattern dates_model.py uses for the date tagger.

Deliberately a single model, not an ensemble like Bankruptcy/Delisting:
only 55 labeled filings exist in the full available history of this
disclosure (effective Dec 2023), so there's no spare data to justify
training multiple seeds. Trained with standard single-label softmax/
cross-entropy (MATERIALITY is mutually exclusive), not the sigmoid/
multi-label setup families.py's _load() assumes for Bankruptcy/Delisting
— reusing that helper on this model would silently miscalibrate every
probability, so this file has its own loader. See ml/items/item105/
LOG.md and TRAIN_LOG.md for the full build and the 5-fold
cross-validation result this component's `experimental` string quotes.
"""
import json
import os
import threading
import time
from typing import List, Optional

from .families import Family
from .items import find_item_section

LABELS = ["MATERIAL", "NOT_MATERIAL", "UNDER_ASSESSMENT"]
SECTION_CAP = 4000  # matches ml/items/item105/train_final_template.py

_load_lock = threading.Lock()
_state = {"tok": None, "model": None, "tried": False}


def _adapter_dir() -> Optional[str]:
    for d in (os.getenv("ITEM105_DIR"),
              os.path.join(os.getenv("MODEL_DIR", ""), "other", "item105") if os.getenv("MODEL_DIR") else None):
        if d and os.path.exists(os.path.join(d, "adapter_config.json")):
            return d
    return None


def _load():
    with _load_lock:
        if _state["tried"]:
            return _state["tok"], _state["model"]
        _state["tried"] = True
        directory = _adapter_dir()
        if directory is None:
            return None, None
        import torch
        from peft import PeftModel
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        from ..devices import place

        with open(os.path.join(directory, "adapter_config.json")) as f:
            base = json.load(f)["base_model_name_or_path"]
        tok = AutoTokenizer.from_pretrained(directory)
        # Default problem_type (single_label_classification) -- this model
        # was trained with softmax/cross-entropy, NOT the sigmoid/
        # multi-label setup families.py's _load() uses for Bankruptcy/
        # Delisting. Loading it that way would be silently wrong.
        model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=len(LABELS), torch_dtype=torch.float32)
        model = place(PeftModel.from_pretrained(model, directory).merge_and_unload().float().eval())
        _state["tok"], _state["model"] = tok, model
        return tok, model


def _softmax_probs(texts: List[str], tok, model, max_length: int = 512) -> List[List[float]]:
    import torch

    enc = tok(texts, truncation=True, max_length=max_length, padding=True, return_tensors="pt").to(model.device)
    with torch.inference_mode():
        return torch.softmax(model(**enc).logits.float(), dim=-1).tolist()


class CyberIncident(Family):
    key, item, title = "cyber_incident", "1.05", "Material cybersecurity incident"
    models = ["item105"]
    experimental = (
        "Experimental: trained on only 55 filings (the full population of this disclosure "
        "since it became mandatory in Dec 2023). Reliable for MATERIAL vs. NOT_MATERIAL "
        "(macro F1 ~0.58 each on 5-fold cross-validation); the UNDER_ASSESSMENT category is "
        "close to a coin flip (11 examples total) and should not be trusted."
    )

    def _load_models(self) -> None:
        tok, model = _load()
        if model is None:
            raise RuntimeError("item105 adapter not found (set ITEM105_DIR or bundle under MODEL_DIR/other/item105)")
        self._tok, self._model = tok, model

    def test_models(self) -> list:
        return [(self.models[0], self._tok, self._model, len(LABELS))]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        section = find_item_section(plain, self.item)
        if section is None:
            return self.not_applicable()
        self.ensure_loaded()
        text = section[:SECTION_CAP]
        probs = _softmax_probs([text], self._tok, self._model)[0]
        pred_idx = max(range(len(LABELS)), key=lambda i: probs[i])
        pred = LABELS[pred_idx]
        titles = {"MATERIAL": "Determined material", "NOT_MATERIAL": "Determined not material",
                  "UNDER_ASSESSMENT": "Materiality assessment ongoing"}
        return {
            "key": self.key, "item": self.item, "title": self.title, "applicable": True,
            "experimental": self.experimental, "found": True,
            "events": [{"label": pred, "title": titles[pred], "confidence": round(probs[pred_idx], 4)}],
            "probabilities": {l: round(p, 4) for l, p in zip(LABELS, probs)},
            "readerNames": ["RoBERTa-large (single model -- too little data for an ensemble)"],
            "inputText": text[:1500],
            "seconds": round(time.time() - t0, 2),
        }
