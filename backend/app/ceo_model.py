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

from . import checker as checkmod
from .detect import context as ctxmod
from .detect import rules
from .detect.families import BODY_KW_CAP, SECTION_CAP, _keyword_sentences, _load, _sigmoid_probs
from .dates import around, best_name, extract as extract_dates, window as date_window
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


def _same_person(a: str, b: str) -> bool:
    skip = {"mr", "ms", "mrs", "dr", "jr", "sr", "ii", "iii"}
    ta = {w for w in re.sub(r"[^a-z ]", "", a.lower()).split() if len(w) > 1 and w not in skip}
    tb = {w for w in re.sub(r"[^a-z ]", "", b.lower()).split() if len(w) > 1 and w not in skip}
    return bool(ta and tb and (ta <= tb or tb <= ta))


def _load_dir(d: str, num_labels: int):
    """Like detect.families._load, but from an explicit adapter folder."""
    import json

    from peft import PeftModel
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    from .devices import place

    with open(os.path.join(d, "adapter_config.json")) as f:
        base = json.load(f)["base_model_name_or_path"]
    tok = AutoTokenizer.from_pretrained(d)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=num_labels, problem_type="multi_label_classification", torch_dtype=torch.float32)
    return tok, place(PeftModel.from_pretrained(model, d).merge_and_unload().float().eval())


class Reader:
    def __init__(self, name: str, tok, model, n_labels: int) -> None:
        self.name, self.tok, self.model, self.n_labels = name, tok, model, n_labels


class Ensemble:
    """Single-model CEO detector with the old ensemble's interface."""

    def __init__(self) -> None:
        torch.set_num_threads(int(os.getenv("TORCH_THREADS", str(os.cpu_count() or 4))))
        v2 = os.getenv("CEO2_DIR")
        seeds = [os.path.join(v2, f) for f in ("cl_hn_s42", "cl_hn_s7")] if v2 else []
        if seeds and all(os.path.exists(os.path.join(d, "adapter_config.json")) for d in seeds):
            # v2: two seeds trained on cleaned labels plus hard negatives (false alarms with no CEO sentence); their probabilities are averaged.
            # held-out months: appointed F1 .934, resigned F1 .872 (v1: .920 / .868) and 10 of 93 hard negatives flagged (v1: 93 of 93).
            self.readers = [Reader(f"{READER} · v2 seed {name}", *_load_dir(d, len(LABELS)), len(LABELS)) for d, name in zip(seeds, ("42", "7"))]
        else:
            tok, model, _ = _load(FOLDER, len(LABELS))
            self.readers: List[Reader] = [Reader(READER, tok, model, len(LABELS))]

    @property
    def reader_names(self) -> List[str]:
        return [r.name for r in self.readers]

    def analyze(self, sentences: List[str], on_progress: Optional[Callable[[int, int, int], None]] = None,
                plain: str = "", filing_date: str = "", company: str = "") -> Dict:
        """sentences: the split Item 5.02 section (for display); plain: the whole filing text the model reads."""
        section = find_item_section(plain, "5.02") if plain else None
        if section is None:
            section = " ".join(sentences)
        section = section[:SECTION_CAP]
        body_kw = _keyword_sentences(ITEM, plain.replace(section, " "), BODY_KW_CAP) if plain else ""
        text = ctxmod.build_context(ITEM, section, body_kw, filing_date=filing_date or None)
        probs = [0.0, 0.0]
        if text.strip():
            each = [_sigmoid_probs([text], r.tok, r.model, MAX_LENGTH)[0] for r in self.readers]
            probs = [sum(p[k] for p in each) / len(each) for k in range(len(LABELS))]
        if on_progress:
            on_progress(1, 1, 0)
        a = rules.analyze(ITEM, section, body_kw, filing_date)
        return self._decide(sentences, section, probs, a, company)

    def _decide(self, sentences: List[str], section: str, probs: List[float], a: Dict, company: str = "") -> Dict:
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
            def read_when(ev, nm, ix):
                """Dates and the final name for one candidate sentence (the trained tagger's name beats the patterns: 97% vs 84% held-out)."""
                w = extract_dates(ev, nm or None, around(sentences, ix), role="CEO", kind=key, context=date_window(sentences, ix)) if ev else {"effective": None, "effectiveNote": None, "decided": None}
                if w.get("name"):
                    nm = best_name(w["name"], nm, section) or nm
                return w, nm

            when = {"effective": None, "effectiveNote": None, "decided": None}
            check = None
            if found and evidence:
                when, name = read_when(evidence, name, idx)
                ck = checkmod.checker()  # when the evidence sentence cannot be placed in the section (idx is None) it is scored on its own
                if ck is not None:
                    # the checker sees the final name, so a succession announcement is not judged with the outgoing CEO's name
                    new_ev, new_name, new_idx, check = self._check(ck, key, verb, company, sentences, idx, evidence, name, section, read_when)
                    if check.get("repointed"):
                        evidence, idx = new_ev, new_idx
                        when, name = read_when(evidence, new_name, idx)
            no_evidence = found and not evidence
            if no_evidence:
                # the model says there is a CEO change but no sentence of the section is about one: on unseen filings these are almost always false alarms
                check = {"score": None, "state": "likely_wrong", "reason": "No sentence in this section is about a change of CEO.", "repointed": False}
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
                "check": check,  # the result checker's score, whether a better sentence was found, and "review" when it is not sure
            }
        a_, r_ = result["appointed"], result["resigned"]
        if a_["found"] and r_["found"] and a_["name"] and r_["name"] and _same_person(a_["name"], r_["name"]):
            for e in (a_, r_):  # one person both gaining and losing the CEO role is sometimes real (CEO to Executive Chairman), so only flag it
                if e["check"] is None:
                    e["check"] = {"score": None, "state": "review", "reason": "The same person is named as joining and leaving.", "repointed": False}
                elif e["check"]["state"] == "ok":
                    e["check"] = {**e["check"], "state": "review", "reason": "The same person is named as joining and leaving."}
        rows = [{"text": s, "readers": [shown[i]] if i in shown else []} for i, s in enumerate(sentences)]
        needs_review = any(result[k]["found"] and (result[k]["check"] or {}).get("state") in ("review", "likely_wrong") for k in ("appointed", "resigned"))
        return {"sentences": rows, **result, "needsReview": needs_review, "probabilities": {l: round(float(p), 4) for l, p in zip(LABELS, probs)}}

    def _check(self, ck, key: str, verb, company: str, sentences: List[str], idx: int, evidence: str, name: str, section: str, read_when=None):
        """Scores the passage behind the answer. If it looks wrong, tries the other CEO sentences of the section and moves to the best one that
        scores well; if none does the answer stays and is marked for review."""
        base = {"role": "CEO", "kind": key, "company": company}
        cands = [j for j, s in enumerate(sentences) if j != idx and re.search(ctxmod.CEO_TITLE_PATTERN, s, re.I)]
        cands.sort(key=lambda j: (not verb.search(sentences[j]), abs(j - (idx or 0))))
        cands = cands[:6]
        names = []
        for j in cands:
            ev = regex_extract_ceo_event(sentences[j])
            nm = ev[0] if ev and ev[1] == key else (pick_name(sentences[j], key, section) or "")
            names.append(read_when(sentences[j], nm, j)[1] if read_when else nm)
        first = ck.score([{**base, "name": name, "text": date_window(sentences, idx) if idx is not None else re.sub(r"\s+", " ", evidence).strip()}])[0]
        check = {"score": round(first, 4), "state": "ok", "reason": None, "repointed": False}
        if first >= checkmod.THRESHOLD:
            return evidence, name, idx, check
        if cands:
            scores = ck.score([{**base, "name": n, "text": date_window(sentences, j)} for j, n in zip(cands, names)])
            best = max(range(len(cands)), key=lambda i: scores[i])
            if scores[best] >= checkmod.THRESHOLD:
                j = cands[best]
                return sentences[j], names[best], j, {"score": round(scores[best], 4), "state": "ok", "reason": None, "repointed": True, "firstScore": round(first, 4)}
        if first < 0.1:
            check.update(state="likely_wrong", reason="The checker thinks this is probably not a change of this company's CEO.")
        else:
            check.update(state="review", reason="The checker is not sure this is a real change of this company's CEO.")
        return evidence, name, idx, check
