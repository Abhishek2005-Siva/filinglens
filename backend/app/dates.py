"""Finds the date an appointment or departure takes effect, and the date it was decided, when the filing gives one.

The CEO / CFO readers say *that* something happened and in which sentence. Dates are written out in plain words
("effective March 3, 2025", "effective immediately", "on February 28, 2025, the Board elected ..."), so they are read
with patterns from that sentence (and, if needed, nearby sentences about the same person), not with a trained model.
"""
import datetime as dt
import re
from typing import Dict, List, Optional, Sequence

_M = "January|February|March|April|May|June|July|August|September|October|November|December"
_MABBR = "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
_MON = rf"(?:{_M}|{_MABBR})\.?"
_DATE = rf"(?:{_MON}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}|\d{{1,2}}(?:st|nd|rd|th)?\s+{_MON},?\s+\d{{4}}|\d{{1,2}}/\d{{1,2}}/\d{{2,4}})"
_NAMES = {m.lower(): i + 1 for i, m in enumerate(_M.split("|"))}
_NAMES.update({"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12})

_EFFECTIVE = re.compile(
    rf"(?i)\b(?:effective(?:\s+(?:as\s+of|on|from|date\s+of))?(?:\s+on\s+or\s+about)?|with\s+effect\s+from|beginning(?:\s+on)?|commencing(?:\s+on)?|starting(?:\s+on)?|"
    rf"will\s+(?:assume|begin|start|become|serve)[^.]{{0,70}}?\bon|to\s+(?:be\s+)?(?:effective|become\s+effective)\s+(?:on|as\s+of))\s*[:,]?\s*({_DATE})")
_EFFECTIVE_EOB = re.compile(rf"(?i)\beffective\s+(?:at\s+|upon\s+)?(?:the\s+)?(?:close|end)\s+of\s+(?:business|day|the\s+day)\s+on\s+({_DATE})")
_ENDING = re.compile(rf"(?i)\b(?:through|until|up\s+to\s+and\s+including|will\s+(?:continue\s+to\s+)?serve\s+(?:as|until)[^.]{{0,60}}?(?:through|until))\s+({_DATE})")
_IMMEDIATE = re.compile(r"(?i)\beffective\s+(?:immediately|as\s+of\s+(?:the\s+date\s+hereof|today)|upon\s+(?:his|her|their)\s+(?:appointment|election|resignation))\b|\bimmediate(?:ly)?\s+effect\b|\bwith\s+immediate\s+effect\b")
_CONDITION = re.compile(r"(?i)\beffective\s+(?:upon|following|after|at\s+the\s+(?:close|time|end)|as\s+of\s+the\s+(?:closing|completion|end)|when)\b([^.;,]{0,70})")
_DECIDED = re.compile(rf"(?i)\bon\s+({_DATE})\s*,")
_DECIDED_ANY = re.compile(rf"(?i)\b(?:on|dated|as\s+of)\s+({_DATE})")


def parse_date(text: str) -> Optional[str]:
    """'March 3, 2025' / '3 March 2025' / '3/3/2025' -> '2025-03-03', or None if it is not a real date."""
    t = text.strip().rstrip(",.")
    m = re.match(rf"(?i)({_MON})\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})$", t)
    if m:
        mo, d, y = m.group(1), m.group(2), m.group(3)
    else:
        m = re.match(rf"(?i)(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MON}),?\s+(\d{{4}})$", t)
        if m:
            d, mo, y = m.group(1), m.group(2), m.group(3)
        else:
            m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})$", t)
            if not m:
                return None
            mo, d, y = m.group(1), m.group(2), m.group(3)
            y = y if len(y) == 4 else "20" + y
    month = int(mo) if mo.isdigit() else _NAMES.get(mo.lower().rstrip("."))
    try:
        return dt.date(int(y), month, int(d)).isoformat() if month else None
    except ValueError:
        return None


def _about_person(sentence: str, name: Optional[str]) -> bool:
    if not name:
        return True
    parts = [p for p in re.split(r"\s+", name.replace(",", " ")) if len(p) > 2 and p.lower() not in ("mr.", "ms.", "mrs.", "dr.", "jr.", "sr.")]
    return any(re.search(rf"\b{re.escape(p)}\b", sentence) for p in parts[-2:])


def _closest(sentence: str, matches: list, name: Optional[str]):
    """When a sentence has several 'effective ...' dates (one per person), the one nearest this person's name."""
    if len(matches) < 2 or not name:
        return matches[0]
    pos = [m.start() for p in re.split(r"\s+", name.replace(",", " ")) if len(p) > 2 for m in re.finditer(rf"\b{re.escape(p)}\b", sentence)]
    if not pos:
        return matches[0]
    return min(matches, key=lambda m: min(abs(m.start() - q) for q in pos))


def _find(sentence: str, name: Optional[str] = None) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {"effective": None, "effectiveNote": None, "decided": None}
    found = list(_EFFECTIVE.finditer(sentence)) + list(_EFFECTIVE_EOB.finditer(sentence))
    found.sort(key=lambda m: m.start())
    m = _closest(sentence, found, name) if found else None
    if m:
        out["effective"] = parse_date(m.group(1))
    if out["effective"] is None:
        if _IMMEDIATE.search(sentence):
            out["effectiveNote"] = "immediately"
        else:
            c = _CONDITION.search(sentence)
            if c and not _EFFECTIVE_EOB.search(sentence):
                out["effectiveNote"] = ("upon" + c.group(1)).strip().rstrip(",")
    taken = {m.group(1)} if m else set()
    d = _DECIDED.search(sentence)
    if d and d.group(1) not in taken:
        out["decided"] = parse_date(d.group(1))
    return out


def window(sentences: Sequence[str], index: Optional[int], span: int = 2) -> str:
    """The passage the trained date tagger reads: the evidence sentence and `span` sentences each side, as it was trained."""
    if index is None or not (0 <= index < len(sentences)):
        return ""
    return re.sub(r"\s+", " ", " ".join(sentences[max(0, index - span): index + span + 1])).strip()


def _from_model(res: Dict[str, Optional[dict]]) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {"effective": None, "effectiveNote": None, "decided": None, "name": None}
    eff, dec = res.get("eff"), res.get("dec")
    if res.get("name"):
        out["name"] = res["name"]["text"].strip() or None
    if eff:
        iso = parse_date(eff["text"])
        if iso is None:
            m = re.search(_DATE, eff["text"], re.I)
            iso = parse_date(m.group(0)) if m else None
        if iso:
            out["effective"] = iso
        elif re.search(r"(?i)immediate", eff["text"]):
            out["effectiveNote"] = "immediately"
        else:
            t = eff["text"].strip()
            out["effectiveNote"] = t if re.match(r"(?i)(upon|following|after|as of|at|when|once)\b", t) else f"upon {t}"
    if dec:
        out["decided"] = parse_date(dec["text"]) or (parse_date(re.search(_DATE, dec["text"], re.I).group(0)) if re.search(_DATE, dec["text"], re.I) else None)
    return out


def extract(sentence: Optional[str], name: Optional[str] = None, neighbours: Sequence[str] = (), role: Optional[str] = None,
            kind: Optional[str] = None, context: Optional[str] = None) -> Dict[str, Optional[str]]:
    """{'effective': ISO date or None, 'effectiveNote': 'immediately' / 'upon ...' or None, 'decided': ISO date or None}.

    With role ('CEO' / 'CFO'), kind ('appointed' / 'resigned') and context (dates.window(...)) the trained date tagger is used when
    its adapter is available. Otherwise the evidence sentence is read with patterns; if it gives no effective date, the sentences
    around it that are about the same person are tried (the date often sits in the next sentence)."""
    if role and kind and context:
        from . import dates_model

        t = dates_model.tagger()
        if t is not None:
            try:
                return _from_model(t.tag(f"{role} {kind}" + (f": {name}" if name and not t.has_name else ""), context))
            except Exception:
                pass  # fall through to the rules
    out = _find(sentence or "", name)
    if out["effective"] is None and out["effectiveNote"] is None:
        for s in neighbours:
            if s == sentence or not _about_person(s, name):
                continue
            found = _find(s, name)
            if found["effective"] or found["effectiveNote"]:
                out["effective"], out["effectiveNote"] = found["effective"], found["effectiveNote"]
                break
    if out["decided"] is None and sentence:
        # "On February 28, 2025, ..." is when it was decided; for a departure "on <date>" next to the verb is also the date it happened
        d = _DECIDED_ANY.search(sentence)
        if d:
            iso = parse_date(d.group(1))
            if iso and iso != out["effective"]:
                out["decided"] = iso
    return out


def around(sentences: Sequence[str], index: Optional[int], span: int = 2) -> List[str]:
    if index is None or not (0 <= index < len(sentences)):
        return list(sentences[:6])
    return [sentences[i] for i in range(max(0, index - span), min(len(sentences), index + span + 1)) if i != index]


def best_name(model_name: Optional[str], fallback: Optional[str], section: str = "") -> Optional[str]:
    """The person's name: the trained tagger's when it found one (97% on held-out events vs 84% for the patterns), else the patterns'.
    A bare surname is completed from the rest of the section when the full name appears there."""
    if not model_name:
        return fallback
    words = re.findall(r"[A-Za-z][A-Za-z'’\-]+", re.sub(r"(?i)\b(?:mr|ms|mrs|dr|jr|sr)\b\.?", " ", model_name))
    if not words:  # a lone initial ("W") is a cut-off name, not a name
        return fallback
    if len(words) == 1 and section:
        from .people import resolve_surname

        full = resolve_surname(words[0], section)
        if full:
            return full
    return model_name
