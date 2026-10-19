"""The deployed CEO reader: ONE RoBERTa-large (LoRA) model that reads the whole Item 5.02 section of a filing.

It replaces the old three-reader per-sentence ensemble (kept in ensemble.py for reference). Trained on 8,019 real
filings (labels = two language models + rules agreeing, 347 disagreements in the test months hand-adjudicated) and
scored on 1,070 filings from four months it never saw: appointed F1 0.920, resigned F1 0.868 at a fixed 0.5 cut-off,
against 0.873 / 0.794 for the old ensemble on the same filings.

Input is the same one used in training: only the sentences that mention a CEO title, with every date annotated by
its day offset from the filing date ("[D-3]"). The model returns one probability per label for the whole filing;
the sentence shown as evidence and the person's name come from the rule layer and the name finder.

The class keeps the interface of the old Ensemble (reader_names, readers, analyze) so the service and the website
need no other change.
"""
import os
import re
from typing import Callable, Dict, List, Optional

import torch

from .detect import context as ctxmod
from .detect import rules
from .detect.families import BODY_KW_CAP, SECTION_CAP, _keyword_sentences, _load, _sigmoid_probs
from .dates import around, extract as extract_dates, window as date_window
from .detect.items import find_item_section
from .item502 import regex_extract_ceo_event
from .people import _APPOINT, _LEAVE, pick_name

ITEM = "5.02ceo"
FOLDER = "ceo_filing"       # other/ceo_filing in the adapter repo
LABELS = ["CEO_APPOINTED", "CEO_RESIGNED"]
THRESHOLD = 0.5
MAX_LENGTH = 448
READER = "RoBERTa-large · reads the whole section"
_HONORIFIC_SURNAME = re.compile(r"\b(?:Mr|Ms|Mrs|Dr)\.\s+([A-Z][A-Za-z'\-]+)")


class Reader:
    def __init__(self, name: str, tok, model, n_labels: int) -> None:
        self.name, self.tok, self.model, self.n_labels = name, tok, model, n_labels


class Ensemble:
    """Single-model CEO detector with the old ensemble's interface."""

    def __init__(self) -> None:
        torch.set_num_threads(int(os.getenv("TORCH_THREADS", str(os.cpu_count() or 4))))
        tok, model, _ = _load(FOLDER, len(LABELS))
        self.readers: List[Reader] = [Reader(READER, tok, model, len(LABELS))]

    @property
    def reader_names(self) -> List[str]:
        return [r.name for r in self.readers]

    def analyze(self, sentences: List[str], on_progress: Optional[Callable[[int, int, int], None]] = None,
                plain: str = "", filing_date: str = "") -> Dict:
        """sentences: the split Item 5.02 section (for display); plain: the whole filing text the model reads."""
        section = find_item_section(plain, "5.02") if plain else None
        if section is None:
            section = " ".join(sentences)
        section = section[:SECTION_CAP]
        body_kw = _keyword_sentences(ITEM, plain.replace(section, " "), BODY_KW_CAP) if plain else ""
        text = ctxmod.build_context(ITEM, section, body_kw, filing_date=filing_date or None)
        probs = [0.0, 0.0]
        if text.strip():
            r = self.readers[0]
            probs = _sigmoid_probs([text], r.tok, r.model, MAX_LENGTH)[0]
        if on_progress:
            on_progress(1, 1, 0)
        a = rules.analyze(ITEM, section, body_kw, filing_date)
        return self._decide(sentences, section, probs, a)

    def _decide(self, sentences: List[str], section: str, probs: List[float], a: Dict) -> Dict:
        ceo_sents = [s for s in sentences if re.search(ctxmod.CEO_TITLE_PATTERN, s, re.I)]
        shown: Dict[int, Dict] = {}
        result: Dict = {}
        for k, (label, key, verb) in enumerate((("CEO_APPOINTED", "appointed", _APPOINT), ("CEO_RESIGNED", "resigned", _LEAVE))):
            p = float(probs[k])
            found = p >= THRESHOLD
            evidence, name = None, ""
            if found:
                # 1) a sentence whose wording names the person (same patterns the old pipeline used first)
                for s in ceo_sents:
                    ev = regex_extract_ceo_event(s)
                    if ev and ev[1] == key:
                        evidence, name = s, ev[0]
                        break
                # 2) the rule layer's sentence, 3) the CEO sentence that talks about this kind of change
                if not evidence:
                    evidence = a["evidence"].get(label) or next((s for s in ceo_sents if verb.search(s)), ceo_sents[0] if ceo_sents else None)
                if evidence and not name:
                    # the name must come from the evidence sentence itself (a wrong name is worse than "not named")
                    name = pick_name(evidence, key, section) or (a["fields"].get(f"{key}_name") if evidence == a["evidence"].get(label) else "") or ""
                if evidence and not name:
                    m = _HONORIFIC_SURNAME.search(evidence)
                    name = m.group(0) if m else ""
            idx = None
            if evidence:
                idx = next((i for i, s in enumerate(sentences) if s == evidence or evidence in s or s in evidence), None)
            when = extract_dates(evidence, name or None, around(sentences, idx), role="CEO", kind=key, context=date_window(sentences, idx)) if found and evidence else {"effective": None, "effectiveNote": None, "decided": None}
            if found and idx is not None:
                shown[idx] = {"reader": READER, "label": key.upper(), "confidence": round(p, 4), "counts": True}
            result[key] = {
                "found": found,
                "name": name,
                "sentence": evidence if found and evidence else "",
                "sentenceIndex": idx if found else None,
                "confidence": round(p, 4) if found else None,
                "votesFor": 1 if found else 0,
                "interim": bool(found and evidence and re.search(r"(?i)\b(?:interim|acting)\b", evidence)),
                "effective": when["effective"],  # ISO date the change takes effect, when the filing says
                "effectiveNote": when["effectiveNote"],  # "immediately" or "upon ..." when there is no calendar date
                "decided": when["decided"],  # the date the board acted or the person gave notice, when stated
                "readers": [{"reader": READER, "voted": found, "confidence": round(p, 4) if found else None}],
            }
        rows = [{"text": s, "readers": [shown[i]] if i in shown else []} for i, s in enumerate(sentences)]
        return {"sentences": rows, **result, "probabilities": {l: round(float(p), 4) for l, p in zip(LABELS, probs)}}
