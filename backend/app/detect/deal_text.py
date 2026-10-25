"""Section text -> sentences for Items 2.01 / 1.01 / 1.02 (owner: training-sec-f5).

Thin wrapper over src.items.split_item_sentences that first strips the item's
own caption. The shared splitter drops any "sentence" that *starts with* the
caption, which is fine when the caption ends in a period but swallows the whole
first paragraph when the heading has no terminal punctuation (seen on iRhythm's
Item 1.02: "Item 1.02 Termination of a Material Definitive Agreement\nTermination
of SVB Loan ... was terminated ..." came back as zero sentences).
"""
import re
from typing import List, Optional

CAPTIONS = {
    "1.01": r"Entry\s+into\s+a\s+Material\s+Definitive\s+Agreement",
    "1.02": r"Termination\s+of\s+a\s+Material\s+Definitive\s+Agreement",
    "3.02": r"Unregistered\s+Sales\s+of\s+Equity\s+Securities",
    "2.01": r"Completion\s+of\s+Acquisition\s+or\s+Disposition\s+of\s+Assets",
}
_HEAD_PREFIX = r"^\s*item[\s|]*\d{1,2}\.\d{2}[\s.:|\-–—]*"


def strip_caption(section: str, item: str) -> str:
    cap = CAPTIONS[item]
    out = re.sub(_HEAD_PREFIX + r"(?:" + cap + r")?[\s.:|\-–—]*", "", section, count=1, flags=re.IGNORECASE)
    return out.strip()


def deal_sentences(section: str, item: str) -> List[str]:
    from .items import split_item_sentences
    return split_item_sentences(strip_caption(section, item), None)


_AMOUNT_RE = re.compile(r"(?:US\s?)?\$\s?(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|[MBK]\b)?", re.IGNORECASE)
_MULT = {"billion": 1e9, "b": 1e9, "million": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}


_UNIT_AFTER = re.compile(r"(?i)^[^.;]{0,30}?\b(?:per|a|each)\s+(?:common\s+|ordinary\s+|class\s+\w\s+)?(?:share|unit|warrant|ads|ordinary|note|security|bond|right)\b|^\s*/\s*(?:share|unit)")
_UNIT_BEFORE = re.compile(r"(?i)(?:par\s+value|stated\s+value|exercise\s+price|conversion\s+price|price)\s+(?:of\s+|per\s+\w+\s+(?:of\s+)?|is\s+|was\s+)?(?:approximately\s+|up\s+to\s+)?(?:US\s?)?$")


def extract_amounts(text: str, per_unit: bool = False) -> List[float]:
    """Dollar amounts in `text`, in dollars (regex only; not model-derived). A price per share/unit/warrant, a par value or an exercise price is not
    the size of the deal and is left out unless per_unit=True."""
    out = []
    for m in _AMOUNT_RE.finditer(text):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if not per_unit and (_UNIT_AFTER.search(text[m.end():m.end() + 45]) or _UNIT_BEFORE.search(text[max(0, m.start() - 40):m.start()])):
            continue
        out.append(v * _MULT.get((m.group(2) or "").lower(), 1.0))
    return out


_SIZE_CUE = re.compile(r"(?i)\b(?:gross\s+proceeds|aggregate\s+(?:principal|purchase\s+price|offering\s+price|gross|cash|consideration|commitment)|principal\s+amount|total\s+(?:consideration|commitments?)|aggregate\s+commitments?|revolving\s+(?:credit\s+)?(?:facility|commitments?)|term\s+loan)\b")


def deal_amount(sentence: str, section: str = "") -> Optional[float]:
    """The size of the deal: the largest amount in the evidence sentence, else the first amount in a sentence of the section that talks about
    proceeds, principal, commitments or a purchase price."""
    a = extract_amounts(sentence or "")
    if a:
        return max(a)
    for sent in split_sentences_simple(section):
        if _SIZE_CUE.search(sent):
            b = [x for x in extract_amounts(sent) if x >= 1e6]  # a fee or a deposit in the same paragraph is not the size of the deal
            if b:
                return max(b)
    return None


def split_sentences_simple(text: str) -> List[str]:
    return [t for t in re.split(r"(?<=[.;])\s+(?=[A-Z(])", re.sub(r"\s+", " ", text or "")) if t]


_CHARGE_CUE = re.compile(r"(?i)\b(?:charges?|impairments?|write-?(?:down|off)s?|charge-?offs?|severance|restructuring\s+(?:costs?|expenses?)|exit\s+costs?|termination\s+benefits?)\b")
_NOT_CHARGE = re.compile(r"(?i)\b(?:savings|annualized|revenues?|volume|improve\w*|operating\s+income|total\s+assets|net\s+sales|outstanding|balance)\b")


def charge_amount(text: str) -> Optional[float]:
    """The size of a restructuring or impairment charge: the largest amount in the sentences that talk about charges, impairments or severance
    (and not about savings, volumes or revenue); else None (a bare figure elsewhere in the text is more likely a volume, a balance or a saving)."""
    best = []
    for sent in split_sentences_simple(text):
        if _CHARGE_CUE.search(sent) and not _NOT_CHARGE.search(sent):
            best += extract_amounts(sent)
    return max(best) if best else None
