"""The "stays with the company?" reader: when a CEO gives up the CEO role, does the person leave the company (A), keep another role (B: executive chair,
division head, advisor, employee ...) or stay only on the board (C)? Two RoBERTa-large LoRA adapters (seeds) whose probabilities are averaged.
Trained on 1,006 passages labelled by Qwen2.5-14B, scored on 245 live answers from the four kept-back months (89 labelled by hand): "stays" precision 87%,
recall 99%, F1 .93 (the rule finder in roles.py alone: precision 100%, recall 15%). Without the adapters nothing changes.
"""
import json
import os
import threading
from typing import Dict, List, Optional

_lock = threading.Lock()
_state: Dict[str, object] = {"models": None, "tried": False, "error": None}
SHOW_AT = 0.85  # show "stays with the company" only when P(B)+P(C) is at least this (precision .91, recall .90 on the test slice)


def _dirs() -> List[str]:
    root = os.getenv("STAYS_DIR")
    if not root:
        return []
    ds = [os.path.join(root, f) for f in ("st_s1", "st_s2")]
    return ds if all(os.path.exists(os.path.join(d, "adapter_config.json")) for d in ds) else []


class Stays:
    def __init__(self, dirs: List[str]) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        from .devices import place

        self.torch = torch
        self.parts = []
        for d in dirs:
            with open(os.path.join(d, "adapter_config.json")) as f:
                base = json.load(f)["base_model_name_or_path"]
            tok = AutoTokenizer.from_pretrained(d)
            model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=3, torch_dtype=torch.float32)
            self.parts.append((tok, place(PeftModel.from_pretrained(model, d).merge_and_unload().float().eval())))

    def probs(self, company: str, name: str, text: str) -> List[float]:
        """[P(leaves), P(stays in another role), P(stays only on the board)], averaged over the two adapters."""
        out = []
        for tok, model in self.parts:
            enc = tok([f"CEO resigned | {company} | {name or 'unknown'}"], [text[:1800]], truncation="only_second", max_length=448, return_tensors="pt")
            with self.torch.inference_mode():
                out.append(self.torch.softmax(model(**{k: v.to(model.device) for k, v in enc.items()}).logits.float(), -1)[0].cpu().tolist())
        return [sum(p[k] for p in out) / len(out) for k in range(3)]


def reader() -> Optional[Stays]:
    if _state["models"] is not None or _state["tried"]:
        return _state["models"]  # type: ignore[return-value]
    with _lock:
        if _state["tried"]:
            return _state["models"]  # type: ignore[return-value]
        d = _dirs()
        try:
            if d:
                _state["models"] = Stays(d)
        except Exception as exc:
            _state["error"] = f"{type(exc).__name__}: {exc}"
        _state["tried"] = True
        return _state["models"]  # type: ignore[return-value]


def status() -> dict:
    m = _state["models"]
    return {"state": "ready" if m else ("error" if _state["error"] else ("off" if not _state["tried"] else "missing")), "error": _state["error"]}
