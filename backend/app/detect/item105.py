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
import re
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


_NOT_MATERIAL = re.compile(
    r"(?i)\b(?:has|have|had|did|does|do)\s+not\s+(?:had\s+|have\s+|yet\s+had\s+)?(?:a\s+|any\s+)?material|not\s+reasonably\s+likely\s+to\s+(?:have\s+|materially\s+)|"
    r"\bno\s+material\s+(?:impact|effect|adverse)|\bnot\s+(?:been\s+)?(?:determined\s+to\s+be\s+)?material\b|does\s+not\s+believe[^.]{0,80}material")
_MATERIAL = re.compile(
    r"(?i)(?<!not\s)(?<!not\s{2})\b(?:is|are|was|were|be)\s+(?:reasonably\s+)?likely\s+to\s+(?:have\s+|materially\s+)|"
    r"\bdetermined\s+that\s+(?:the\s+|this\s+)?(?:incident|event)[^.]{0,80}\b(?:is|was)\s+(?:a\s+)?material|"
    r"\b(?:has|have)\s+had\s+(?:a\s+)?material\s+(?:impact|effect)")
_UNDER = re.compile(r"(?i)(?:not\s+(?:yet\s+)?(?:determined|concluded|able\s+to\s+determine)|unable\s+to\s+determine|has\s+not\s+yet\s+determined|still\s+(?:assessing|evaluating|determining))[^.]{0,80}(?:material(?:ity|ly)?|reasonably\s+likely)")


_HEDGED = re.compile(r"(?i)\b(?:could|may|might)\s+(?:potentially\s+)?(?:have|result\s+in|become)\b[^.]{0,80}\bmaterial|potential\s+to\s+(?:have\s+)?(?:a\s+)?material")


def stated_materiality(text: str):
    """(label, sentence) when the Item itself says whether the incident is material; None when it is silent. A 'not' decides first."""
    sents = re.split(r"(?<=[.;])\s+", re.sub(r"\s+", " ", text))
    found = {}
    for sent in sents:
        if re.search(r"(?i)forward-looking|could\s+cause\s+actual\s+results", sent):
            continue
        if _UNDER.search(sent):
            found.setdefault("UNDER_ASSESSMENT", sent)
        elif _NOT_MATERIAL.search(sent):
            found.setdefault("NOT_MATERIAL", sent)
        elif _MATERIAL.search(sent):
            found.setdefault("MATERIAL", sent)
    for label in ("UNDER_ASSESSMENT", "NOT_MATERIAL", "MATERIAL"):
        if label in found:
            return label, found[label][:400]
    for sent in sents:  # 'the incident could have the potential to have a material impact' is a company that has not decided yet
        if _HEDGED.search(sent) and not re.search(r"(?i)forward-looking|could\s+cause\s+actual", sent):
            return "UNDER_ASSESSMENT", sent[:400]
    return None


class CyberIncident(Family):
    key, item, title = "cyber_incident", "1.05", "Material cybersecurity incident"
    models = ["item105"]
    experimental = (
        "Experimental: trained on only 55 filings (the full population of this disclosure "
        "since it became mandatory in Dec 2023). Reliable for MATERIAL vs. NOT_MATERIAL "
        "(macro F1 ~0.58 each on 5-fold cross-validation); the UNDER_ASSESSMENT category is "
        "close to a coin flip (11 examples total) and should not be trusted. When the Item states its "
        "own conclusion in words (\"has not had a material impact\", \"is likely to have a material impact\", "
        "\"could have the potential to\" = still assessing), those words decide."
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
        said = stated_materiality(text)
        evidence = None
        if said and said[0] != pred:
            # the Item states its own conclusion ("has not had a material impact and is not reasonably likely to ..."): the model, trained on 55
            # filings and nearly undecided on most of them, does not overrule the text
            pred, evidence = said[0], said[1]
            pred_idx = LABELS.index(pred)
        elif said:
            evidence = said[1]
        titles = {"MATERIAL": "Determined material", "NOT_MATERIAL": "Determined not material",
                  "UNDER_ASSESSMENT": "Materiality assessment ongoing"}
        return {
            "key": self.key, "item": self.item, "title": self.title, "applicable": True,
            "experimental": self.experimental, "found": True,
            "events": [{"label": pred, "title": titles[pred], "confidence": round(probs[pred_idx], 4), **({"evidence": evidence} if evidence else {}),
                        **({"source": "the filing's own words"} if said and said[0] == pred and evidence else {})}],
            "probabilities": {l: round(p, 4) for l, p in zip(LABELS, probs)},
            "readerNames": ["RoBERTa-large (single model -- too little data for an ensemble)"],
            "inputText": text[:1500],
            "seconds": round(time.time() - t0, 2),
        }
