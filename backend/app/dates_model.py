"""The trained date tagger: reads a CEO/CFO change in its passage and marks the words that give the date it takes effect and the date
it was decided. LoRA adapter on roberta-base (`other/dates502/` in the model dataset); trained on LLM span labels, scored on held-out
months (see ml/items/dates502/LOG.md). If the adapter is not there the callers fall back to the rule reader in dates.py.
"""
import json
import os
import re
import threading
from typing import Dict, Optional

_lock = threading.Lock()
_state: Dict[str, object] = {"tagger": None, "tried": False, "error": None}

_MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
_MON = rf"(?:{_MONTHS})\.?"
_DATE = re.compile(rf"(?:{_MON}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}|\d{{1,2}}(?:st|nd|rd|th)?\s+{_MON},?\s+\d{{4}}|\d{{1,2}}/\d{{1,2}}/\d{{2,4}})", re.I)


def _adapter_dir() -> Optional[str]:
    for d in (os.getenv("DATES_DIR"), os.path.join(os.getenv("MODEL_DIR", ""), "other", "dates502") if os.getenv("MODEL_DIR") else None):
        if d and os.path.exists(os.path.join(d, "adapter_config.json")):
            return d
    return None


def _snap(text: str, s: int, e: int) -> tuple:
    """Widens a predicted span to whole words (and the whole date it touches); drops dangling punctuation."""
    for m in _DATE.finditer(text):
        if m.start() < e and m.end() > s:
            return m.start(), m.end()
    while s > 0 and text[s - 1].isalnum() and text[s].isalnum():
        s -= 1
    while e < len(text) and text[e - 1].isalnum() and text[e].isalnum():
        e += 1
    while e > s and text[e - 1] in " ,.;:)(\"“”":
        e -= 1
    while s < e and text[s] in " ,.;:)(\"“”":
        s += 1
    return s, e


class DateTagger:
    def __init__(self, directory: str) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForTokenClassification, AutoTokenizer

        from .devices import place

        with open(os.path.join(directory, "adapter_config.json")) as f:
            base = json.load(f)["base_model_name_or_path"]
        meta_path = os.path.join(directory, "labels.json")
        meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
        self.threshold = float(meta.get("threshold", 0.5))
        self.max_len = int(meta.get("max_len", 384))
        self.tok = AutoTokenizer.from_pretrained(directory)
        model = AutoModelForTokenClassification.from_pretrained(base, num_labels=2, torch_dtype=torch.float32)
        self.model = place(PeftModel.from_pretrained(model, directory).merge_and_unload().float().eval())
        self.torch = torch

    def tag(self, header: str, passage: str) -> Dict[str, Optional[dict]]:
        """{'eff': {'text','start','end','conf'} or None, 'dec': ...}, spans measured in `passage`."""
        enc = self.tok(header, passage, truncation="only_second", max_length=self.max_len, return_offsets_mapping=True, return_tensors="pt")
        offsets = enc.pop("offset_mapping")[0].tolist()
        seq = enc.sequence_ids(0)
        with self.torch.inference_mode():
            logits = self.model(**{k: v.to(self.model.device) for k, v in enc.items()}).logits[0].float().cpu()
        probs = self.torch.sigmoid(logits).numpy()
        out: Dict[str, Optional[dict]] = {}
        for ch, key in ((0, "eff"), (1, "dec")):
            runs, cur = [], []
            for t, (sid, (s, e)) in enumerate(zip(seq, offsets)):
                if sid == 1 and probs[t, ch] >= self.threshold:
                    cur.append((s, e, float(probs[t, ch])))
                elif cur:
                    runs.append(cur)
                    cur = []
            if cur:
                runs.append(cur)
            if not runs:
                out[key] = None
                continue
            best = max(runs, key=lambda r: sum(x[2] for x in r) / len(r))
            s, e = _snap(passage, best[0][0], best[-1][1])
            out[key] = {"text": passage[s:e], "start": s, "end": e, "conf": round(sum(x[2] for x in best) / len(best), 4)} if e > s else None
        return out


def tagger() -> Optional[DateTagger]:
    """The loaded tagger, or None when the adapter is not available. Loaded once, on first use."""
    if _state["tagger"] is not None or _state["tried"]:
        return _state["tagger"]  # type: ignore[return-value]
    with _lock:
        if _state["tried"]:
            return _state["tagger"]  # type: ignore[return-value]
        d = _adapter_dir()
        try:
            if d:
                _state["tagger"] = DateTagger(d)
        except Exception as exc:  # the rule reader still works; the status panel can show why
            _state["error"] = f"{type(exc).__name__}: {exc}"
        _state["tried"] = True
        return _state["tagger"]  # type: ignore[return-value]


def status() -> dict:
    t = _state["tagger"]
    return {"state": "ready" if t else ("error" if _state["error"] else ("off" if not _state["tried"] else "missing")), "error": _state["error"], "dir": _adapter_dir()}
