"""Every detector in one list, and the runner that applies all of them to a filing."""
from typing import Callable, List, Optional

from .families import Auditor, Bankruptcy, Delisting, Family, Votes
from .agree_doc import AgreementsV2
from .families2 import CFO, Acquisition, Equity, Guidance, Restructuring
from .item105 import CyberIncident

REGISTRY: List[Family] = [
    # AgreementsV2 reads the whole filing with two RoBERTa-large readers when the `filinglens-agree` adapters are mounted
    # (AGREE_DIR); without them it behaves exactly like the old sentence-based Agreements detector.
    Bankruptcy(), Delisting(), Auditor(), Votes(), CFO(), Acquisition(), AgreementsV2(), Equity(), Guidance(), Restructuring(),
    CyberIncident(),
]


def run_all(plain: str, tables: str, filing_date: str, company: str = "", exhibit: Optional[str] = None,
            on_status: Optional[Callable[[str, bool], None]] = None) -> List[dict]:
    """Runs every detector; one whose Item is absent from the filing reports applicable=False cheaply."""
    out = []
    for fam in REGISTRY:
        present = fam.present(plain, tables)
        if present and on_status:
            on_status(fam.title, not fam.loaded)
        try:
            out.append(fam.run(plain, tables, filing_date, company=company, exhibit=exhibit))
            if present:
                fam.last_error = None
        except Exception as exc:  # one failing detector must not hide the others
            fam.last_error = f"{type(exc).__name__}: {exc}"
            out.append({**fam.not_applicable(), "applicable": present, "error": fam.last_error})
    return out


def selftest_family(fam: Family) -> dict:
    """Loads the family if needed and runs each of its models once on a short sentence. Checks the output has the
    right number of labels and is finite, which catches a missing, mismatched or corrupted model."""
    import time

    import torch

    t0 = time.time()
    res = {"key": fam.key, "ok": True, "models": []}
    try:
        fam.ensure_loaded()
        for name, tok, model, n in fam.test_models():
            t = time.time()
            try:
                enc = tok(["The Company announced a change on March 3, 2025."], truncation=True, max_length=64, return_tensors="pt").to(model.device)
                with torch.inference_mode():
                    logits = model(**enc).logits
                good = logits.shape[-1] == n and bool(torch.isfinite(logits).all())
                res["models"].append({"name": name, "ok": good, "ms": round((time.time() - t) * 1000), "error": None if good else f"expected {n} outputs, got {tuple(logits.shape)} or non-finite values"})
                res["ok"] = res["ok"] and good
            except Exception as exc:
                res["models"].append({"name": name, "ok": False, "ms": 0, "error": f"{type(exc).__name__}: {exc}"})
                res["ok"] = False
    except Exception as exc:
        res.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    res["ms"] = round((time.time() - t0) * 1000)
    return res
