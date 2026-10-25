"""Heading-aware slicing of an arbitrary Form 8-K Item out of plain filing text.

item502.find_item_502_section() takes the *first* "Item 5.02" mention in the
document. That works tolerably for 5.02 but breaks badly for other Items
because 8-Ks constantly cross-reference one another from inside a different
Item's prose ("...as described in Item 5.07 below", "Item 5.07 is
incorporated herein by reference"). Found on real filings: for Volcon, Inc.
the "Item 5.07 section" returned by a first-mention slicer was actually the
entire preceding Item 5.02 text, because the first mention of "5.07" sits
inside the 5.02 prose.

A real section heading differs from a cross-reference in two ways this module
relies on: it starts a line, and what follows it is a capitalized caption
("Submission of Matters to a Vote of Security Holders") rather than a lowercase
continuation word ("below", "of", "is incorporated"). SEC's Form 8-K
instructions prescribe the exact caption per Item, so when one is known it is
used as a tiebreaker.
"""
import re
from typing import List, Optional, Tuple

from bs4 import BeautifulSoup

from ..item502 import _ABBREVIATION_RE, _ENTITY_SUFFIX_RE, _SENTENCE_SPLIT_RE
from ..sec_fetch import _DISPLAY_NONE_RE, _fetch_raw
from ..sec_fetch import _primary_document as _extract_primary_document

# Canonical captions prescribed by Form 8-K, lowercase-matched. Only items we
# build detectors for need an entry; everything else falls back to the generic
# line-start + capitalized-caption shape check.
ITEM_CAPTIONS = {
    "4.01": r"changes?\s+in\s+registrant['’]?s?\s+certifying\s+accountants?",
    "5.02": r"departure\s+of\s+directors",
    "5.07": r"submission\s+of\s+matters(?:\s+to\s+a\s+vote\s+of\s+security\s+holders)?",
}

_INVISIBLE_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
# "Item 5.07", "ITEM 5.07", and the "Item\n4.01" form that HTML table cells
# produce when the number sits in its own cell. Anchored to line start.
#
# "|" is allowed because html_to_text_with_tables() joins layout-table cells
# with " | ", so a heading laid out as a table row reads "Item 5.07. | Submission
# of Matters..." or "Item | 5.07 | Submission...".
_HEADING_RE = re.compile(r"^[ \t]*item[\s|]*(\d{1,2}\.\d{2})\b", re.IGNORECASE | re.MULTILINE)
_SIGNATURE_LINE_RE = re.compile(r"^[ \t]*SIGNATURES?\b", re.MULTILINE)
_AFTER_NUMBER_RE = re.compile(r"[ \t.:|\-–—]*\s*(\S[^\n]{0,80})?")


def normalize_filing_text(text: str) -> str:
    return _INVISIBLE_RE.sub("", text).replace("\xa0", " ")


def _is_real_heading(text: str, m: "re.Match") -> bool:
    """True if what follows the item number looks like a caption (capitalized
    word / paren enumerator) or nothing at all, not a lowercase continuation."""
    tail = _AFTER_NUMBER_RE.match(text, m.end())
    nxt = (tail.group(1) or "").strip() if tail else ""
    if not nxt:
        return True  # "Item 5.07." alone on its line, caption on the next one
    first = nxt[0]
    return first.isupper() or first.isdigit() or first in "(“\"'"


def list_headings(text: str) -> List[Tuple[int, str]]:
    """(offset, item number) of every real Item heading in document order."""
    return [(m.start(), m.group(1)) for m in _HEADING_RE.finditer(text) if _is_real_heading(text, m)]


def find_item_section(text: str, item: str) -> Optional[str]:
    """Slice the body of `item` (e.g. "4.01") out of the filing text, heading
    included. None if no genuine heading for that item exists."""
    text = normalize_filing_text(text)
    headings = list_headings(text)
    starts = [i for i, (_, num) in enumerate(headings) if num == item]
    if not starts:
        return None

    pick = starts[0]
    caption_re = ITEM_CAPTIONS.get(item)
    if caption_re and len(starts) > 1:
        cap = re.compile(caption_re, re.IGNORECASE)
        for i in starts:
            off = headings[i][0]
            if cap.search(text[off:off + 200]):
                pick = i
                break

    start = headings[pick][0]
    end = len(text)
    for off, num in headings[pick + 1:]:
        if num != item:
            end = off
            break
    sig = _SIGNATURE_LINE_RE.search(text, start)
    if sig and sig.start() < end:
        end = sig.start()
    section = text[start:end].strip()
    if item == "5.02" and section:
        # a short Item 5.02 that only points to another Item ("Item 8.01 under the caption ... is incorporated herein by reference"): add that text
        from ..appointees import referenced_items

        for ref in referenced_items(section):
            extra = find_item_section(text, ref)
            if extra:
                section = section + "\n" + extra[:6000]
    return section or None


# "...filing with the U.S." | "Securities and Exchange Commission..." — a "U.S."
# almost never ends a real sentence in these filings, so always re-join it.
_US_ABBREV_RE = re.compile(r"(?:^|\s)(?:U\.S|U\.K|(?:[A-Z]\.){1,3}[A-Z])\.$")  # also initials: "L.J.", "M.S."
# "...Frank, Rimerman + Co." | "LLP as the Company's..." — a firm-suffix token starting the next
# fragment means the period belonged to the name.
_NEXT_FIRM_SUFFIX_RE = re.compile(r"^(?:LLP|LLC|PLLC|P\.C\.?|PC|PA|P\.A\.?|CPAs?|Inc\b|Corp\b|Ltd\b|Associates|Partners|&)")
# Accounting-firm suffixes item502's entity-suffix list doesn't know about:
# "...Company engaged CBIZ CPAs P.C." | "(“CBIZ”) as its independent...".
_FIRM_SUFFIX_RE = re.compile(r"(?:^|\s)(?:P\.C|P\.A|PLLC|L\.L\.P|LLP|CPAs?)\.$")


def split_item_sentences(section: str, caption_re: Optional[str] = None) -> List[str]:
    """Sentence-split an item section the same way item502.split_sentences
    does (middle initials, Mr./Dr., "Corp." + "(the Company)" merges), but drop
    the item's own boilerplate heading instead of 5.02's.

    The heading is dropped for the same reason documented in item502.py: it is
    near-identical text in every filing of this item, so leaving it in as a
    classifiable sentence invites a spurious "heading => positive" shortcut."""
    normalized = re.sub(r"\s+", " ", section).strip()
    if not normalized:
        return []
    heading_re = re.compile(r"^item\s*\d{1,2}\.\d{2}\b", re.IGNORECASE)
    cap_re = re.compile(caption_re, re.IGNORECASE) if caption_re else None
    merged: List[str] = []
    for part in _SENTENCE_SPLIT_RE.split(normalized):
        if merged and (_ABBREVIATION_RE.search(merged[-1]) or _US_ABBREV_RE.search(merged[-1])
                       or (re.search(r"\bCo\.$", merged[-1]) and _NEXT_FIRM_SUFFIX_RE.match(part))):
            merged[-1] = merged[-1] + " " + part
        elif merged and part.startswith(("(", "“(", "(“")) and (
                _ENTITY_SUFFIX_RE.search(merged[-1]) or _FIRM_SUFFIX_RE.search(merged[-1])):
            merged[-1] = merged[-1] + " " + part
        else:
            merged.append(part)
    out = []
    for p in merged:
        p = _strip_heading(p.strip(), heading_re, cap_re)
        if len(p) > 15:
            out.append(p)
    return out


def _strip_heading(p: str, heading_re: "re.Pattern", cap_re: Optional["re.Pattern"]) -> str:
    """Remove the Item's own heading ("Item 4.01 Changes in Registrant's
    Certifying Accountant") from the FRONT of a sentence rather than dropping
    the whole sentence: headings carry no terminal period, so they arrive glued
    to the first real sentence ("Item 4.01 ... (a) Dismissal ... On March 3,
    the Audit Committee dismissed KPMG LLP..."), and dropping the chunk threw
    away the filing's key dismissal/engagement sentence."""
    m = heading_re.match(p)
    if m:
        p = p[m.end():].lstrip(" .:|-\u2013\u2014")
    if cap_re:
        c = cap_re.match(p)
        if c:
            p = p[c.end():].lstrip(" .:|-\u2013\u2014")
    return p


# --- table-preserving HTML -> text -------------------------------------------------
# fetch_filing_plaintext() (sec_fetch.py) emits one cell per line, which turns a
# vote table into "FOR / AGAINST / 174,826,399 / 3,584,552 ..." and destroys the
# row/column structure Item 5.07 vote counts depend on. This variant is only
# used by the new Item detectors, so the existing 5.02 text path is untouched.

def html_to_text_with_tables(html: str) -> str:
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    for tag in soup.find_all(["ix:header", "ix:hidden", "ix:references", "ix:resources"]):
        tag.decompose()
    for tag in soup.find_all(style=True):
        if _DISPLAY_NONE_RE.search((getattr(tag, "attrs", None) or {}).get("style", "")):
            tag.decompose()
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [re.sub(r"\s+", " ", c.get_text(" ")).strip() for c in tr.find_all(["td", "th"])]
            # Drop empty cells and lone "$" / ")" / "%" spacer cells that SEC
            # filing software emits around every number.
            cells = [c for c in cells if c and c not in {"$", ")", "%", "(", "—"} or c == "—"]
            if cells:
                rows.append(" | ".join(cells))
        table.replace_with(soup.new_string("\n" + "\n".join(rows) + "\n"))
    text = soup.get_text(separator="\n")
    lines = [_INVISIBLE_RE.sub("", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def fetch_filing_text_with_tables(url: str) -> Optional[str]:
    raw = _fetch_raw(url)
    if raw is None:
        return None
    return html_to_text_with_tables(_extract_primary_document(raw.decode("utf-8", errors="replace")))
