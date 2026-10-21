"""The result checker: a second trained reader that looks at the passage behind a CEO answer and says how likely it is a real change of
that company's chief executive announced in this filing (score 0-1). RoBERTa-large + LoRA, trained on about 7k event passages with the
subsidiary / contract-terms / recap / other-officer false alarms labelled "not real" (see ml/items/errana/NOTES.md).

It never removes an answer. A low score first makes the service look for a better sentence in the same section; if none scores well the
answer is kept and marked "needs review". Without the adapter nothing changes.
"""
import json
import os
import threading
from typing import Dict, List, Optional

_lock = threading.Lock()
_state: Dict[str, object] = {"checker": None, "tried": False, "error": None}

THRESHOLD = 0.5


def _adapter_dir() -> Optional[str]:
    for d in (os.getenv("VERIFIER_DIR"), os.path.join(os.getenv("MODEL_DIR", ""), "other", "verifier") if os.getenv("MODEL_DIR") else None):
        if d and os.path.exists(os.path.join(d, "adapter_config.json")):
            return d
    return None


class Checker:
    def __init__(self, directory: str) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        from .devices import place

        with open(os.path.join(directory, "adapter_config.json")) as f:
            base = json.load(f)["base_model_name_or_path"]
        self.tok = AutoTokenizer.from_pretrained(directory)
        model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=1, torch_dtype=torch.float32)
        self.model = place(PeftModel.from_pretrained(model, directory).merge_and_unload().float().eval())
        self.torch = torch

    def score(self, rows: List[dict], batch: int = 8) -> List[float]:
        """rows: {role, kind, company, name, text}. The input is built exactly as in training."""
        out: List[float] = []
        for i in range(0, len(rows), batch):
            part = rows[i:i + batch]
            enc = self.tok([f"{r['role']} {r['kind']} | {r['company']} | {r.get('name') or 'unknown'}" for r in part], [r["text"][:1800] for r in part],
                           truncation="only_second", max_length=448, padding=True, return_tensors="pt")
            with self.torch.inference_mode():
                logits = self.model(**{k: v.to(self.model.device) for k, v in enc.items()}).logits.float().squeeze(-1)
            out += self.torch.sigmoid(logits).reshape(-1).cpu().tolist()
        return out


def checker() -> Optional[Checker]:
    """The loaded checker, or None when the adapter is not available. Loaded once, on first use."""
    if _state["checker"] is not None or _state["tried"]:
        return _state["checker"]  # type: ignore[return-value]
    with _lock:
        if _state["tried"]:
            return _state["checker"]  # type: ignore[return-value]
        d = _adapter_dir()
        try:
            if d:
                _state["checker"] = Checker(d)
        except Exception as exc:  # answers still work, just without a score; the status panel shows why
            _state["error"] = f"{type(exc).__name__}: {exc}"
        _state["tried"] = True
        return _state["checker"]  # type: ignore[return-value]


def status() -> dict:
    c = _state["checker"]
    return {"state": "ready" if c else ("error" if _state["error"] else ("off" if not _state["tried"] else "missing")), "error": _state["error"], "dir": _adapter_dir()}
