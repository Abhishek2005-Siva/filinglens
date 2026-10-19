"""The deployed best model: a mixed ensemble of three LoRA-tuned readers
(RoBERTa-large x2 + DeBERTa-v3-base x1). A reader's vote only counts when its own
confidence is >= THRESHOLD, and a class is flagged when >= 2 of 3 readers agree.
Same decision logic as the evaluation run that scored 0.8673 overall F1.

Speed-ups that keep the model's predictions unchanged:
  * LoRA adapters are merged into the base weights (same maths, no adapter overhead)
  * sentences are batched by length so padding is not wasted
Tested and rejected: int8 dynamic quantisation. It was ~3x faster but flipped real decisions
(e.g. a 99.9% CEO-resignation was missed), so the full-precision model is used.
"""
import json
import os
import re
from typing import Callable, Dict, List, Optional

import torch
from huggingface_hub import snapshot_download
from peft import PeftModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from .devices import place
from .dates import around, extract as extract_dates, window as date_window
from .people import pick_name, pick_name_from_sentences
from .item502 import regex_extract_ceo_event

LABELS = ["NONE", "APPOINTED", "RESIGNED"]
ID2LABEL = {i: l for i, l in enumerate(LABELS)}
LABEL2ID = {l: i for i, l in ID2LABEL.items()}
THRESHOLD = 0.7
MAX_LENGTH = 320
BATCH = 16

_HONORIFIC_SURNAME = re.compile(r"\b(?:Mr|Ms|Mrs|Dr)\.\s+([A-Z][A-Za-z'\-]+)")

READER_NAMES = {
    "robertalarge_seed7": "Reader A · RoBERTa-large",
    "robertalarge_seed123": "Reader B · RoBERTa-large",
    "deberta_seed42": "Reader C · DeBERTa-v3",
}


class Reader:
    def __init__(self, name: str, tok, model) -> None:
        self.name, self.tok, self.model = name, tok, model


class Ensemble:
    def __init__(self) -> None:
        torch.set_num_threads(int(os.getenv("TORCH_THREADS", str(os.cpu_count() or 4))))
        repo = os.environ.get("MODEL_REPO", "")
        local = os.environ.get("MODEL_DIR") or snapshot_download(repo_id=repo, token=os.getenv("HF_TOKEN"))
        order = list(READER_NAMES)
        dirs = sorted(
            (
                os.path.join(local, d)
                for d in os.listdir(local)
                if os.path.exists(os.path.join(local, d, "adapter_config.json"))
            ),
            key=lambda p: order.index(os.path.basename(p)) if os.path.basename(p) in order else 99,
        )
        if len(dirs) != 3:
            raise RuntimeError(f"Expected 3 reader folders in the model repo, found {len(dirs)}")
        self.readers: List[Reader] = []
        for d in dirs:
            with open(os.path.join(d, "adapter_config.json")) as f:
                base = json.load(f)["base_model_name_or_path"]
            tok = AutoTokenizer.from_pretrained(d)
            model = AutoModelForSequenceClassification.from_pretrained(
                base, num_labels=len(LABELS), id2label=ID2LABEL, label2id=LABEL2ID
            )
            model = PeftModel.from_pretrained(model, d).merge_and_unload().float()  # saved head weights are fp16; fp32 -> exact
            model.eval()
            model = place(model)
            self.readers.append(Reader(READER_NAMES.get(os.path.basename(d), os.path.basename(d)), tok, model))

    @property
    def reader_names(self) -> List[str]:
        return [r.name for r in self.readers]

    @staticmethod
    def _probs(sentences: List[str], tok, model, on_batch: Optional[Callable[[int], None]] = None) -> List[List[float]]:
        out: List[Optional[List[float]]] = [None] * len(sentences)
        # similar-length sentences together => far less padding
        order = sorted(range(len(sentences)), key=lambda i: len(sentences[i]))
        for i in range(0, len(order), BATCH):
            idx = order[i : i + BATCH]
            enc = tok([sentences[j] for j in idx], truncation=True, max_length=MAX_LENGTH, padding=True, return_tensors="pt").to(model.device)
            with torch.inference_mode():
                probs = torch.softmax(model(**enc).logits, dim=-1).tolist()
            for j, p in zip(idx, probs):
                out[j] = p
            if on_batch:
                on_batch(len(idx))
        return out  # type: ignore[return-value]

    def analyze(
        self,
        sentences: List[str],
        on_progress: Optional[Callable[[int, int, int], None]] = None,
    ) -> Dict:
        """on_progress(units_done, units_total, reader_index) fires after every batch; one unit = one sentence read by one reader."""
        per_reader = []
        total = len(sentences) * len(self.readers)
        done = 0
        for idx, r in enumerate(self.readers):

            def on_batch(n: int, idx: int = idx) -> None:
                nonlocal done
                done += n
                if on_progress:
                    on_progress(done, total, idx)

            per_reader.append(self._probs(sentences, r.tok, r.model, on_batch))
        return self.decide(sentences, per_reader)

    def decide(self, sentences: List[str], per_reader: List[List[List[float]]]) -> Dict:
        names = self.reader_names
        sent_rows = []
        for s_i, sentence in enumerate(sentences):
            readers = []
            for r_i, name in enumerate(names):
                p = per_reader[r_i][s_i]
                top = max(range(3), key=lambda k: p[k])
                readers.append({
                    "reader": name,
                    "label": LABELS[top],
                    "confidence": round(p[top], 4),
                    "counts": top != 0 and p[top] >= THRESHOLD,
                })
            sent_rows.append({"text": sentence, "readers": readers})

        def best_for(label: str, r_i: int):
            best = None
            for s_i in range(len(sentences)):
                p = per_reader[r_i][s_i]
                top = max(range(3), key=lambda k: p[k])
                if LABELS[top] == label and p[top] >= THRESHOLD and (best is None or p[top] > best[1]):
                    best = (s_i, p[top])
            return best

        result = {}
        for label, key in (("APPOINTED", "appointed"), ("RESIGNED", "resigned")):
            votes = [best_for(label, r) for r in range(len(names))]
            agreeing = [v for v in votes if v is not None]
            flagged = len(agreeing) >= len(names) // 2 + 1
            best = max(agreeing, key=lambda v: v[1]) if flagged else None
            sentence = sentences[best[0]] if best else ""
            name = ""
            if best:
                ev = regex_extract_ceo_event(sentence)
                if ev and ev[1] == key:
                    name = ev[0]
                else:
                    for s in sentences:
                        ev = regex_extract_ceo_event(s)
                        if ev and ev[1] == key:
                            name = ev[0]
                            break
            if best and not name:
                context = " ".join(sentences)
                name = pick_name(sentence, key, context) or ""
                if not name:
                    counted = [sentences[i] for i in range(len(sentences)) if any(sent_rows[i]["readers"][r]["counts"] for r in range(len(names)))]
                    name = pick_name_from_sentences(counted, key, context) or ""
            if best and not name:
                m = _HONORIFIC_SURNAME.search(sentence)
                if m:
                    name = m.group(0)  # e.g. "Mr. Janik": the filing only gives the surname here
            when = extract_dates(sentence, name or None, around(sentences, best[0] if best else None), role="CEO", kind=key, context=date_window(sentences, best[0])) if best else {"effective": None, "effectiveNote": None, "decided": None}
            result[key] = {
                "found": flagged,
                "name": name,
                "effective": when["effective"],  # ISO date the change takes effect, when the filing says
                "effectiveNote": when["effectiveNote"],  # "immediately" or "upon ..." when there is no calendar date
                "decided": when["decided"],  # the date the board acted or the person gave notice, when stated
                "sentence": sentence,
                "sentenceIndex": best[0] if best else None,
                "confidence": round(best[1], 4) if best else None,
                "votesFor": len(agreeing),
                "readers": [
                    {
                        "reader": names[r],
                        "voted": votes[r] is not None,
                        "confidence": round(votes[r][1], 4) if votes[r] else None,
                    }
                    for r in range(len(names))
                ],
            }
        return {"sentences": sent_rows, **result}
