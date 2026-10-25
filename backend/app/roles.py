"""When a CEO gives up the CEO role but stays with the company (Executive Chairman, CEO of a division, board member, advisor ...), say so.

The CEO detector counts "gives up the CEO role" as a departure, which is how its training labels were made. For a reader that can sound like
"left the company", so this finds the role the person keeps, when the filing names one in the same sentence or the next two.
Rules only (about 3 in 4 right on a hand-read sample before this version); a trained reader is the planned next step.
"""
import re
from typing import Optional, Sequence

_CUE = re.compile(
    r"(?i)\b(?:assum(?:ed|es|ing)|will\s+assume|will\s+become|became|becomes|transition(?:s|ed|ing)?\s+(?:to|into)|(?:will\s+)?continue(?:s)?\s+(?:to\s+serve\s+)?(?:as|in)|"
    r"(?:will\s+)?remain(?:s)?\s+(?:as|with|on)|will\s+serve\s+as|has\s+been\s+appointed\s+as|appointed\s+(?:him|her)\s+(?:as|to)|"
    r"(?:will\s+)?stay(?:s)?\s+(?:on\s+)?as|move(?:s|d)?\s+(?:in)?to)\s+(?:the\s+)?(?:position\s+of\s+|role\s+of\s+|office\s+of\s+|a\s+|an\s+)?(?:new\s+)?(?P<role>[^.;]{3,100})")
_CEO_AGAIN = re.compile(r"(?i)^(?:the\s+)?(?:company.s\s+)?(?:sole\s+|interim\s+|acting\s+|new\s+)?(?:chief\s+executive|ceo\b|principal\s+executive)")
_BAD_ROLE = re.compile(r"(?i)^(?:the\s+)?(?:board|company|closing|merger|effective|additional\s+dut|options?|shares?|his\s+capacity|her\s+capacity|\d)")
_HONORIFIC = re.compile(r"\b(?:Mr|Ms|Mrs|Dr)\.\s+([A-Z][A-Za-z'\-]+)")
# the roles worth showing: a short list keeps the wrong captures out (about 3 in 4 right before, this is the precision filter)
_ROLE_START = re.compile(
    r"(?i)^(?:(?:an?|the)\s+)?(?:(?:full-time|non-?officer|non-?executive|senior|special|strategic|executive|vice|independent|interim)\s+)*"
    r"(?:chair(?:man|woman|person)?\b|director\b|member\b|advis|consult|employee\b|president\b|chief\s+(?:operating|financial|strategy|scientific|medical|technology|product|investment)|"
    r"(?:ceo|chief\s+executive\s+officer)\s+of\s+(?!the\s+company\b)|board\b)")
_NOT_ROLE = re.compile(r"(?i)\b(?:resign|cease|retire|step(?:s|ped)?\s+down|was\s+appointed|were\s+appointed|terminat)")


def _surname(name: str) -> str:
    toks = [t for t in re.sub(r"[^A-Za-z' \-]", " ", name or "").split() if len(t) > 1 and t.lower() not in ("mr", "ms", "mrs", "dr", "jr", "sr", "phd", "ii", "iii", "md")]
    return toks[-1] if toks else ""


def stays_as(sentences: Sequence[str], idx: Optional[int], name: str) -> Optional[str]:
    """The role the leaving CEO keeps (short text), or None when the filing does not say they stay."""
    if idx is None or not name:
        return None
    sur = _surname(name)
    if not sur:
        return None
    own = re.compile(rf"\b{re.escape(sur)}\b")
    for j in range(idx, min(len(sentences), idx + 3)):
        s = sentences[j]
        marks = [(m.start(), True) for m in own.finditer(s)] + [(m.start(), False) for m in _HONORIFIC.finditer(s) if m.group(1).lower() != sur.lower()]
        pronoun_start = j > idx and bool(re.match(r"(?i)\s*(?:he|she)\b", s)) and not any(not mine for _, mine in marks)
        if not marks and not pronoun_start:
            continue
        for m in _CUE.finditer(s):
            before = [(p, mine) for p, mine in marks if p < m.start()]
            if before:
                if not max(before)[1]:  # the nearest named person before the cue is somebody else (a successor, a colleague): not this person's new role
                    continue
            elif not pronoun_start:
                continue
            role = re.split(r"(?i),?\s+(?:effective|reporting|who|which|until|through|beginning|commencing|on\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))\b|,\s|\s+and\s+(?:will|is|has)\b|\s+and\s+(?:be\s+|will\s+be\s+)?(?:appointed|named)\b", m.group("role"))[0].strip(" ,")
            role = re.sub(r"\s+[A-Z]$", "", role)  # "...Partners L" (an abbreviation cut at its full stop)
            if len(role) < 4 or _BAD_ROLE.match(role) or not _ROLE_START.match(role) or _NOT_ROLE.search(role):
                continue
            if re.search(r"(?i)chief\s+executive\s+officer|\bceo\b", role) and not re.match(r"(?i)^(?:ceo|chief\s+executive\s+officer)\s+of\s+(?!the\s+company\b)|^(?:\w+\s+)?advis", role):
                continue  # a CEO role again is the role being left (or a colleague's), not one that is kept
            return role[:80]
    return None
