"""Item 4.01 (Changes in Registrant's Certifying Accountant) — regex fast path.

Item 4.01 text is highly formulaic: a dismissal / resignation statement, an
engagement statement, then Reg S-K Item 304 boilerplate ("no disagreements",
"no reportable events", "audit reports did not contain an adverse opinion").
Because a single sentence can carry several facts ("approved (1) the dismissal
of EY and (2) the engagement of KPMG"), this is a MULTI-LABEL problem, unlike
the single-label CEO detector:

    DISMISSED          company ended the auditor's engagement
    RESIGNED           auditor resigned / declined to stand for re-election
    ENGAGED            a (new) auditor was engaged / appointed
    DISAGREEMENT       AFFIRMATIVE statement that there was a disagreement
    REPORTABLE_EVENT   AFFIRMATIVE statement of a reportable event / material weakness
    OPINION_MODIFIED   prior audit report was adverse / disclaimed / going-concern

The hard part is negation, not vocabulary. "There were no disagreements" is in
virtually every filing and is NOT a positive; "no reportable events, other than
the material weaknesses" IS one. The regexes below encode that logic, and the
same functions provide (a) the first-tier production fast path and (b) the weak
labels the LoRA classifier is trained on — see ml/items/item401/LOG.md.
"""
import re
from typing import Dict, List, Optional, Sequence, Set

LABELS = ["DISMISSED", "RESIGNED", "ENGAGED", "DISAGREEMENT", "REPORTABLE_EVENT", "OPINION_MODIFIED"]
LABEL2ID = {l: i for i, l in enumerate(LABELS)}

# --- sentence cleaning ---------------------------------------------------------------
# Sub-headings ("(a) Dismissal of Independent Registered Public Accounting Firm")
# have no terminal period, so they arrive glued to the front of the first real
# sentence. Strip them so a heading alone never looks like an event statement.
_ENUMERATOR_RE = re.compile(r"^\s*(?:\((?:[a-zA-Z]|\d{1,2}|[ivxIVX]{1,4})\)|\d{1,2}\.)\s+")
_SUBHEADING_RE = re.compile(
    r"^(?i:(?:(?:dismissal|termination|resignation|change|changes|appointment|engagement|retention|selection)\s+"
    r"of\s+(?:the\s+)?(?:new\s+|previous\s+|former\s+|prior\s+|current\s+)?"
    r"(?:independent\s+)?(?:registered\s+)?(?:public\s+)?(?:certifying\s+)?"
    r"(?:accounting\s+firm|accountants?|auditors?)|"
    r"(?:new|previous|former|prior)\s+independent\s+(?:registered\s+public\s+)?(?:accounting\s+firm|accountants?|auditors?))\.?)\s*"
)


def clean_sentence(s: str) -> str:
    prev = None
    while prev != s:
        prev = s
        s = _ENUMERATOR_RE.sub("", s, count=1)
        s = _SUBHEADING_RE.sub("", s, count=1)
    return s.strip()


# --- shared vocabulary ----------------------------------------------------------------
_FIRM_SUFFIX = (
    r"(?:LLP|L\.L\.P\.?|PLLC|LLC|P\.C\.|PC|CPAs?(?:\s+(?:LLC|PLLC|P\.C\.|PC))?|"
    r"Partners|Associates|Ltd\.?|&\s+(?:Co\.?|Company|Partners|Associates))"
)
_WORD = r"[A-Z][A-Za-z0-9&'’.+\-]*"
# Capitalised words ("Ernst & Young", "Baker Tilly US,", "Withum Smith+Brown,") then
# a firm suffix. Commas only join a name to its suffix, so "Board of Directors,
# CBIZ CPAs P.C." can't swallow the committee words; a bare "Co." isn't a suffix,
# so "Coffee Holding Co." (the registrant) isn't mistaken for an auditor.
FIRM_RE = re.compile(rf"(?:{_WORD}\s+(?:&\s+)?){{0,5}}{_WORD}(?:\s*,\s*|\s+){_FIRM_SUFFIX}(?![A-Za-z])")
_KNOWN_SHORT = (
    r"KPMG|Deloitte|PwC|PricewaterhouseCoopers|Ernst\s*(?:&|and)\s*Young|E&Y|\bEY\b|BDO|RSM|Grant\s+Thornton|"
    r"Marcum|CBIZ|Crowe|Baker\s+Tilly|Moss\s+Adams|Withum\w*|Forvis|Mazars|CohnReznick|Plante\s*&?\s*Moran|"
    r"Cherry\s+Bekaert|Armanino|Citrin\s+Cooperman|Haskell|MaloneBailey|Borgers|Friedman|Squar\s+Milner|Turner,?\s+Stone"
)
KNOWN_FIRM_RE = re.compile(rf"(?:{_KNOWN_SHORT})")
_AUDITOR_CTX = re.compile(
    r"(?i:independent\s+(?:registered\s+)?(?:public\s+)?(?:accounting\s+firm|accountants?|auditors?)|"
    r"registered\s+public\s+accounting\s+firm|accounting\s+firm|certifying\s+accountant|\bauditors?\b|\baccountants?\b)"
)


def _has_auditor_ctx(s: str) -> bool:
    return bool(_AUDITOR_CTX.search(s) or FIRM_RE.search(s) or KNOWN_FIRM_RE.search(s))


_DISAGREE = re.compile(r"(?i:disagree)")
_REPORTABLE = re.compile(r"(?i:reportable\s+events?)")
_MATWEAK = re.compile(r"(?i:material\s+weakness\w*|significant\s+deficienc\w+)")
_CONSULT = re.compile(r"(?i:consult)")
_NEG_CUE = re.compile(r"(?i:\bno\b|\bnot\b|\bnone\b|\bnever\b|\bneither\b|\bnor\b|\bwithout\b|n't\b)")
_EXCEPT_CUE = re.compile(r"(?i:other\s+than|\bexcept\b|save\s+for|with\s+the\s+exception|apart\s+from|aside\s+from)")
# "(ii) a reportable event" — a positive determiner right before the mention
# overrides an earlier "no" that scoped only over the first enumerated item.
_POS_DET_BEFORE = re.compile(r"(?i:\)\s*(?:a|an|one|two|three|the\s+following|certain|several)\s+[“\"']?$)")

_DISMISS = re.compile(
    r"(?i:\bdismiss(?:ed|al|ing|es)?\b|\bterminat(?:e|ed|ion|ing|es)\b|\bdischarg(?:ed|ing)\b|"
    r"\bend(?:ed|ing|s)?\s+(?:the|its|our)\s+(?:engagement|relationship)|\bdecision\s+to\s+(?:change|replace)\b|"
    r"\bchange\s+(?:its|our|the\s+Company['’]s)\s+(?:independent\s+)?(?:registered\s+)?(?:public\s+)?"
    r"(?:accounting\s+firm|auditors?|accountants?)|"
    r"\b(?:not|no\s+longer)\s+(?:to\s+)?(?:re-?engage|re-?appoint|renew)\w*|\breplaced\b|"
    r"\bwill\s+not\s+continue\s+as\b|\bretention\s+of\b[^.]{0,160}?\bended\b|\bregistration\b[\s\S]{0,200}?\b(?:revoked|withdrawn)\b)"
)
# "the Board requested that PwC resign" / "In light of the appointment of X, EY will cease
# serving" are company-initiated changes even though they use resignation vocabulary.
_REQUESTED_RESIGN = re.compile(r"(?i:request\w*\s+(?:that\s+)?[^.]{0,40}?\bresign)")
_CEASE_AFTER_APPOINTMENT = re.compile(
    r"(?i:(?:in\s+light\s+of|following|upon|as\s+a\s+result\s+of)\s+the\s+(?:appointment|engagement)\s+of[^.]{0,120}?\bcease)")
_CLIENT_AUDITOR_END = re.compile(r"(?i:client[\s-]auditor\s+relationship)")
_RESIGN = re.compile(
    r"(?i:\bresign(?:ed|ation|ing|s)?\b|"
    r"\bdeclin(?:e|ed|ing|es)\s+to\s+(?:stand\s+for\s+)?(?:re-?election|re-?appointment|re-?engag\w+|continue|serve)|"
    r"\b(?:will|would|did|does|do|has|have|is|was)\s+not\s+(?:be\s+)?(?:stand(?:ing)?\s+for|seek\s+(?:to\s+be\s+)?)\s*(?:re-?election|re-?appointment|re-?engag\w+|retain\w*|re-?hire\w*)|"
    r"\b(?:will|would)\s+not\s+seek\s+to\s+be\s+(?:re-?)?(?:retained|engaged|appointed)|"
    r"\bnot\s+(?:to\s+)?stand\s+for\s+re-?(?:election|appointment)|\bto\s+not\s+stand\s+for\s+re-?(?:election|appointment)|"
    r"\belected\s+not\s+to\s+stand|\bwithdr(?:ew|awn|aw|awing|awal)\b[^.]{0,30}\b(?:from|as)\b(?:\s+its)?(?:\s+engagement)?|"
    r"\bceas(?:e|ed|ing|es)\s+(?:to\s+)?(?:be|serv)\w*|\bno\s+longer\s+(?:serve|provide|act)\w*)"
)
_ENGAGE = re.compile(
    r"(?i:\bengag(?:ed|es|ing|ement)\b|\bappoint(?:ed|ment|ing|s)\b|\bretain(?:ed|ing|s)\b|"
    r"\bselect(?:ed|ing)\b|\bselection\s+of\b)"
)
# "ended the engagement of X" / "terminated its relationship with X" mention an
# engagement without making one; mask before looking for engagement language.
_END_ENGAGEMENT = re.compile(
    r"(?i:(?:end(?:ed|ing|s)?|terminat\w+|discontinu\w+|(?:not\s+(?:to\s+)?)?renew\w*)\s+(?:the\s+|its\s+|our\s+)?(?:\w+\s+)?"
    r"(?:engagement|relationship)(?:\s+(?:of|with))?)"
)
# "Deloitte’s appointment will be for the fiscal year ending..." describes an
# already-announced engagement's scope, not the act of engaging.
_POSSESSIVE_SCOPE = re.compile(r"^\W*[A-Z][\w&.\-]*['’]s\s+(?:appointment|engagement)\s+(?:will|is|was|shall)\b")
# Future intent ("anticipates engaging a new accounting firm") and re-words used inside a
# resignation ("stand for reappointment") are not an engagement being made.
_FUTURE_ENGAGE = re.compile(
    r"(?i:(?:anticipat\w+|expect\w*|plans?|intends?|undertake|seeking|search(?:ing)?\s+for|will\s+evaluate)\s+[^.]{0,40}?"
    r"(?:engag|retain|appoint|replacement)\w*)"
)
_FUTURE_ENGAGE2 = re.compile(
    r"(?i:will\s+disclose[^.]{0,60}|(?:is|are)\s+(?:currently\s+)?in\s+(?:the\s+)?process\s+of\s+(?:engag|appoint|retain)\w*|"
    r"has\s+not\s+(?:yet\s+)?completed\s+the\s+engagement|previously\s+been\s+(?:appointed|engaged)|"
    r"engagement\s+of\s+[^.]{0,100}?\bended\b|has\s+agreed\s+to\s+perform|remain(?:s|ed)?\s+engaged)"
)
_RE_WORDS = re.compile(r"(?i:\bre-?(?:appointment|engagement|election|engage\w*|appoint\w*)\b)")
_SELECTION_PROCESS = re.compile(r"(?i:selection\s+process|competitive\s+process|request[\s-]for[\s-]proposal|\bRFP\b)")


_PARENS_RE = re.compile(r"\((?=[^()]{4,}\))[^()]*\)")  # enumerators like (ii) stay
# "...which, if not resolved to the satisfaction of X, would have caused X to
# make reference to the subject matter of the disagreement in connection with
# its report" — a long relative clause that pushes the governing "no" out of
# any fixed negation window, and itself contains "not". Remove it.
_DEFINITION_CLAUSE_RE = re.compile(
    r"(?i:,?\s*(?:which|any),?\s+(?:such\s+)?(?:disagreements?,?\s+)?if\s+not\s+resolved.*?\breports?\b"
    r"(?:\s+on\s+[^,;]*?(?:statements|years|period)s?)?(?:\s+for\s+(?:such|those|the\s+\w+)\s+(?:fiscal\s+)?years?)?)"
)
_MATTER_LIST_RE = re.compile(
    r"(?i:on\s+any\s+matters?\s+of\s+accounting\s+principles?\s+or\s+practices?,?[^,;.]*?(?:,[^,;.]*?)?\bprocedures?)"
)


_SUBJECT_OF_DISAGREEMENT = re.compile(r"(?i:(?:either\s+)?the\s+subject\s+of\s+(?:a|any)\s+[“\"']?disagreements?[”\"']?)")
_LETTER_AGREE = re.compile(r"(?i:agree(?:ing|s)?\s+or\s+disagree\w*|whether\s+(?:or\s+not\s+)?(?:it|they)\s+agrees?)")
_THERE_NO = re.compile(r"(?i:there\s+(?:were|was|have\s+been|has\s+been|had\s+been)\s+no\b|did\s+not\s+(?:have|experience))")
_LATER_ITEM = re.compile(r"(?i:\((?:ii|2|b)\)|;\s*(?:and|or)\b|\bevents?\b)")


def normalize_304(s: str) -> str:
    """Strip parentheticals and the Item 304 definition boilerplate so that
    "there were no: (1) disagreements (as defined...) ... or (2) reportable
    events" reads as "there were no: disagreements, or reportable events"."""
    for _ in range(3):
        s = _PARENS_RE.sub(" ", s)
    s = _SUBJECT_OF_DISAGREEMENT.sub(" ", s)
    s = _LETTER_AGREE.sub(" ", s)
    s = _DEFINITION_CLAUSE_RE.sub(" ", s)
    s = _MATTER_LIST_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s)


def _mentions_affirmatively(s: str, topic: "re.Pattern", exception_blocker: Optional["re.Pattern"] = None) -> bool:
    """True if some mention of `topic` is NOT scoped by a negation, or is a
    negated mention followed by an exception ("no X, other than ...")."""
    for m in topic.finditer(s):
        before = s[max(0, m.start() - 160):m.start()]
        if _POS_DET_BEFORE.search(before[-25:]):
            return True
        if not _NEG_CUE.search(before) and not _THERE_NO.search(s[:m.start()]):
            return True
        after = s[m.end():]
        cue = _EXCEPT_CUE.search(after)
        if cue:
            between = after[:cue.start()]
            if exception_blocker is None or not exception_blocker.search(between):
                return True
    return False


def is_disagreement(s: str) -> bool:
    if not _DISAGREE.search(s) or _CONSULT.search(s):
        return False  # consult sentences say "...the subject of a disagreement or a reportable event" generically
    return _mentions_affirmatively(normalize_304(s), _DISAGREE, exception_blocker=_LATER_ITEM)


def is_reportable_event(s: str) -> bool:
    if _CONSULT.search(s):
        return False
    n = normalize_304(s)
    if _MATWEAK.search(n) and _mentions_affirmatively(n, _MATWEAK):
        return True
    if _REPORTABLE.search(n):
        return _mentions_affirmatively(n, _REPORTABLE)
    return False


_REPORT_CTX = re.compile(r"(?i:\b(?:audit|auditor['’]?s?)\s+reports?\b|\breports?\s+(?:of|on|from)\b|\bopinions?\b)")
_MODIFIERS = re.compile(r"(?i:going\s+concern|substantial\s+doubt|explanatory\s+paragraph)")
_ADVERSE = re.compile(
    r"(?i:adverse\s+opinion|disclaimer\s+of\s+opinion|qualified\s+opinion|did\s+not\s+maintain\s+effective\s+internal\s+control)"
)
_BOILER_UNQUALIFIED = re.compile(r"(?i:not\s+qualified\s+or\s+modified)")


_EMPHASIS_EXCEPTION = re.compile(r"(?i:,?\s*(?:except|other\s+than)\s+for\s+the\s+inclusion\s+of\s+an?\s+emphasis[\s-]of[\s-]matter[^.]*)")


def is_opinion_modified(s: str) -> bool:
    s = _EMPHASIS_EXCEPTION.sub(" ", normalize_304(s))
    if not _REPORT_CTX.search(s):
        return False
    if _MODIFIERS.search(s) and _mentions_affirmatively(s, _MODIFIERS):
        return True
    if _ADVERSE.search(s) and _mentions_affirmatively(s, _ADVERSE):
        return True
    m = _BOILER_UNQUALIFIED.search(s)
    if m and _EXCEPT_CUE.search(s[m.end():]):
        # "...except for the inclusion of an emphasis of matter paragraph with respect to
        # investments in digital assets" is not a qualification (ground truth agrees)
        tail = s[m.end():]
        return not (re.search(r"(?i:emphasis[\s-]of[\s-]matter)", tail) and not _MODIFIERS.search(tail))  # "...were not qualified or modified ..., except to indicate that..."
    return False


def _event_labels(s: str) -> Set[str]:
    """DISMISSED / RESIGNED / ENGAGED. Item 304 boilerplate sentences are
    excluded wholesale: "through the date of dismissal, there were no
    disagreements" mentions dismissal without stating one."""
    if _DISAGREE.search(s) or _REPORTABLE.search(s) or _CONSULT.search(s) or not _has_auditor_ctx(s):
        return set()
    out: Set[str] = set()
    client_auditor_end = bool(_CLIENT_AUDITOR_END.search(s))
    requested_resign = bool(_REQUESTED_RESIGN.search(s))
    replaced_by_appointment = bool(_CEASE_AFTER_APPOINTMENT.search(s))
    if (_RESIGN.search(s) and not requested_resign and not replaced_by_appointment) or client_auditor_end:
        out.add("RESIGNED")
    if (_DISMISS.search(s) and not client_auditor_end) or requested_resign or replaced_by_appointment:
        out.add("DISMISSED")
    eng_text = _RE_WORDS.sub(" ", _FUTURE_ENGAGE2.sub(" ", _FUTURE_ENGAGE.sub(" ", _RESIGN.sub(" ", _SELECTION_PROCESS.sub(" ", _END_ENGAGEMENT.sub(" ", s))))))
    if _ENGAGE.search(eng_text) and not _POSSESSIVE_SCOPE.search(s):
        out.add("ENGAGED")
    return out


def label_sentence(sentence: str) -> List[str]:
    """Regex labels for ONE sentence (already cleaned). Multi-label; [] = NONE."""
    s = sentence
    labels = _event_labels(s)
    if is_disagreement(s):
        labels.add("DISAGREEMENT")
    if is_reportable_event(s):
        labels.add("REPORTABLE_EVENT")
    if is_opinion_modified(s):
        labels.add("OPINION_MODIFIED")
    return [l for l in LABELS if l in labels]


# --- section -> cleaned sentences ----------------------------------------------------------
# Inline sub-headings sometimes survive sentence splitting glued to the end of
# the previous sentence ("...Exhibit 16.1 to this Form 8-K. 1 (b) Appointment of
# New Independent Registered Public Accounting Firm On March 4, ..."), because
# the page number / enumerator after the period isn't a capital letter.
_INLINE_HEADING_SPLIT = re.compile(
    r"\s+(?:\d{1,2}\s+)?(?=\((?:[a-b]|i{1,3})\)\s+(?:Dismissal|Appointment|Engagement|Resignation|Change|Previous|New|Former)\b)"
)


def sentences_from_section(section: str) -> List[str]:
    from .items import ITEM_CAPTIONS, split_item_sentences

    out: List[str] = []
    for sent in split_item_sentences(section, ITEM_CAPTIONS["4.01"]):
        for part in _INLINE_HEADING_SPLIT.split(sent):
            part = clean_sentence(part)
            if len(part) > 15:
                out.append(part)
    return out


# --- auditor name extraction ------------------------------------------------------------
_OLD_CUE = re.compile(r"(?i:dismiss\w*|terminat\w*|discharg\w*|notified|informed|replac\w*|resign\w*|declin\w*|ceas\w*|"
                      r"end(?:ed|ing|s)?\s+(?:the|its|our)\s+(?:engagement|relationship)(?:\s+of)?|"
                      r"stand\s+for\s+re-?election|decision\s+to\s+change)")
_NEW_CUE = re.compile(r"(?i:engag\w+|appoint\w*|retain\w*|select\w*)")
_NAME_STOP = {"new", "independent", "registered", "public", "accounting", "firm", "company", "audit", "committee",
              "board", "directors", "the", "and", "of"}


_OBJ_NAME = r"(?P<n>[A-Za-z][A-Za-z0-9&'’.+\-]*(?:\s+(?:&\s+)?[A-Za-z][A-Za-z0-9&'’.+\-]*){0,4}?)(?=\s*(?:,|;|\(|\s+(?:as|of|that|effective|from|and|to)\b|$))"
_OLD_OBJECT = re.compile(r"(?i:dismiss(?:ed|al\s+of)|discharg(?:ed)|terminat(?:ed|ion\s+of(?:\s+the\s+engagement\s+of)?))\s+(?:the\s+Company['’]s\s+)?" + _OBJ_NAME)
_NEW_OBJECT = re.compile(r"(?i:engag(?:ed|ement\s+of)|appoint(?:ed|ment\s+of)|retain(?:ed)|select(?:ed|ion\s+of))\s+" + _OBJ_NAME)


_SELF_DEFINITION = re.compile(r"\s*\(\s*(?:the\s+|“\s*the\s+)?[“\"']?\s*(?:Company|Registrant|Partnership|Fund|Trust|we|our|us|Issuer|Corporation)\b", re.I)


_NEW_OBJECT_AFTER_FIRM = re.compile(
    r"(?i:engag(?:e|ed|ing|ement\s+of)|appoint(?:ed|ing|ment\s+of)?|retain(?:ed|ing)?|select(?:ed|ing)?)\s+(?:the\s+|as\s+its\s+)?(?:new\s+)?(?:independent\s+)?(?:registered\s+)?(?:public\s+)?"
    r"(?:accounting\s+firm|accountants?|auditors?),?\s+" + _OBJ_NAME)


def extract_firms(sentence: str) -> List[str]:
    """Auditor names in a sentence, in order of appearance. Parenthetical aliases
    ("Ernst & Young LLP (“EY”)") are ignored so each firm is listed once."""
    out: List[str] = []
    for f, _ in _firm_spans(sentence):
        if f not in out:
            out.append(f)
    return out


def _firm_spans(sentence: str):
    """(name, (start, end)) for every firm mention, in order — duplicates kept,
    since the same firm can appear in two roles ("notified by Marcum that Marcum
    will resign") and each mention sits near a different action cue."""
    masked = _PARENS_RE.sub(lambda m: " " * len(m.group(0)), sentence)  # keep offsets stable
    spans = []
    for m in FIRM_RE.finditer(masked):
        name = re.sub(r"^(?:On|The|Company|Board|Audit|Committee|And)\s+", "", m.group(0)).strip(" ,")
        if all(w.lower().strip(".,") in _NAME_STOP for w in name.split()):
            continue
        if _SELF_DEFINITION.match(sentence, m.end()):
            continue  # 'Bloom HoldCo LLC (the “Company”) engaged ...': the registrant, not an auditor
        spans.append((name, (m.start(), m.end())))
    for m in KNOWN_FIRM_RE.finditer(masked):
        if not any(a <= m.start() < b for _, (a, b) in spans):
            spans.append((m.group(0).strip(), (m.start(), m.end())))
    spans.sort(key=lambda t: t[1][0])
    return spans


def role_firms(sentence: str) -> Dict[str, List[str]]:
    """Split a sentence's firms into 'old' (dismissed / resigned) and 'new'
    (engaged) by the nearest action cue. "...selected Deloitte & Touche LLP ...
    and notified BDO USA, P.C. of its dismissal" -> new=[Deloitte...], old=[BDO...]."""
    masked = _PARENS_RE.sub(lambda m: " " * len(m.group(0)), sentence)
    # offset-preserving: "terminated our engagement with" -> "terminated" + padding
    masked = _END_ENGAGEMENT.sub(lambda m: ("terminated" + " " * len(m.group(0)))[:len(m.group(0))] if len(m.group(0)) >= 10 else m.group(0), masked)
    out: Dict[str, List[str]] = {"old": [], "new": []}
    for name, (a, b) in _firm_spans(sentence):
        best = None  # (distance, role)
        for role, cue in (("old", _OLD_CUE), ("new", _NEW_CUE)):
            for m in cue.finditer(masked):
                if m.end() <= a and a - m.end() <= 90:
                    d = a - m.end()
                elif m.start() >= b and m.start() - b <= 110:
                    d = (m.start() - b) + 6  # prefer a preceding cue on near ties
                else:
                    continue
                if best is None or d < best[0]:
                    best = (d, role)
        if best and name not in out[best[1]]:
            out[best[1]].append(name)
    for role, pat in (("old", _OLD_OBJECT), ("new", _NEW_OBJECT_AFTER_FIRM), ("new", _NEW_OBJECT)):
        if not out[role]:
            m = pat.search(masked)
            if m:
                name = m.group("n").strip(" ,")
                if name and not all(w.lower().strip(".,") in _NAME_STOP for w in name.split()):
                    out[role].append(name)
    return out


# --- filing-level aggregation -------------------------------------------------------------
# Item 304 boilerplate always names the FORMER auditor ("reports of X", "disagreements with X",
# "provided X with a copy", "X's letter") and the "consulted with Y" sentence always names the
# NEW one — used when the key dismissal / engagement sentence names nobody
# ("approved the decision to change independent accountants").
_FORMER_CTX = re.compile(r"(?i:\breports?\s+(?:of|from|by)\b|disagree|\bletter\b|copy\s+of\s+(?:this|the)|provided\s+\S+\s+with)")


def _first_word_name(sent: str) -> str:
    m = re.match(r"\W*([A-Z][A-Za-z0-9&'’.+\-]*(?:\s+(?:&\s+)?[A-Z][A-Za-z0-9&'’.+\-]*){0,3})(?=\s*(?:,|;|\(|\s+(?:regarding|with\s+respect|concerning|on|as|of)\b))", sent)
    return m.group(1).strip(" ,") if m else ""


def _boilerplate_firm(sentences, ctx) -> str:
    counts: Dict[str, int] = {}
    for sent in sentences:
        if ctx is _FORMER_CTX and _CONSULT.search(sent):
            continue
        if ctx.search(sent):
            if ctx is _CONSULT:
                m = re.search(r"(?i:consult\w*\s+(?:with\s+)?)", sent)
                sent = sent[m.end():] if m else sent  # "...preceding the engagement of OLD, the Company has not consulted with NEW": only NEW follows
                for nm in extract_firms(sent)[:1] or ([_first_word_name(sent)] if _first_word_name(sent) else []):
                    counts[nm] = counts.get(nm, 0) + 1
                continue
            for name in extract_firms(sent):
                counts[name] = counts.get(name, 0) + 1
    return max(counts, key=counts.get) if counts else ""


def aggregate(sentences: Sequence[str], per_sentence: Sequence[Dict[str, float]], threshold=0.5,
              section: Optional[str] = None) -> dict:
    """Combine per-sentence label scores (regex: 1.0/0.0; model: sigmoid probs)
    into one filing-level record. Shared by the regex path and the model path
    so both are scored identically against ground truth. `threshold` is a float
    or a {label: float} dict (tuned per label on the validation split)."""
    thr = (lambda l: threshold[l]) if isinstance(threshold, dict) else (lambda l: threshold)
    best: Dict[str, tuple] = {}
    for sent, scores in zip(sentences, per_sentence):
        for label in LABELS:
            p = scores.get(label, 0.0)
            if p >= thr(label) and (label not in best or p > best[label][1]):
                best[label] = (sent, p)
    rec = {
        "dismissed": "DISMISSED" in best,
        "resigned": "RESIGNED" in best,
        "engaged": "ENGAGED" in best,
        "disagreement": "DISAGREEMENT" in best,
        "reportable_event": "REPORTABLE_EVENT" in best,
        "opinion_modified": "OPINION_MODIFIED" in best,
        "evidence": {l: best[l][0] for l in best},
        "confidence": {l: round(best[l][1], 4) for l in best},
    }
    def first_firm(labels, role):
        for sent, scores in zip(sentences, per_sentence):
            if role == "new" and re.search(r"(?i)remain(?:s|ed)?\s+engaged", sent):
                continue  # 'Baker Tilly remains engaged to complete its audit' is the outgoing firm
            if any(scores.get(l, 0.0) >= thr(l) for l in labels):
                found = role_firms(sent)[role]
                if found:
                    return found[0]
        return ""

    rec["former_auditor"] = first_firm(("DISMISSED", "RESIGNED"), "old") or _boilerplate_firm(sentences, _FORMER_CTX)
    rec["new_auditor"] = first_firm(("ENGAGED",), "new") or _boilerplate_firm(sentences, _CONSULT)
    return rec


def regex_analyze(sentences: Sequence[str], section: Optional[str] = None) -> dict:
    """The fast path: regex-only filing-level analysis of cleaned sentences."""
    per = [{l: 1.0 for l in label_sentence(s)} for s in sentences]
    return aggregate(sentences, per, section=section)


# --- evaluation interface (used by ml/items/eval_template.py) ---------------------------
# filing-level record key -> key in the LLM ground-truth labels (nvidia_label.py)
FLAG_MAP = {
    "dismissed": "dismissed", "resigned": "resigned", "engaged": "engaged",
    "disagreement": "disagreements", "reportable_event": "reportable_events",
    "opinion_modified": "opinion_modified",
}
NAME_FIELDS = [("former_auditor", "former_auditor"), ("new_auditor", "new_auditor")]

_FIRM_DROP = {"llp", "llc", "pc", "pllc", "cpa", "cpas", "us", "usa", "the", "company", "co", "partners",
              "associates", "ltd", "inc", "lpp", "and", "of"}
_FIRM_ALIAS = {"ey": "ernst young", "e y": "ernst young", "ernst young": "ernst young",
               "pwc": "pricewaterhousecoopers", "dt": "deloitte", "d t": "deloitte", "deloitte touche": "deloitte",
               "gt": "grant thornton"}


def canon_firm(name: str) -> str:
    """Normalise an auditor name so "E&Y", "Ernst & Young LLP" and "EY" compare equal."""
    n = re.sub(r"[^a-z0-9& ]", " ", (name or "").lower().replace("&", " "))
    toks = [t for t in n.split() if t not in _FIRM_DROP]
    key = " ".join(toks)
    return _FIRM_ALIAS.get(key, key)


def firm_match(a: str, b: str) -> bool:
    """Lenient name agreement: equal after canonicalisation, or one's tokens
    contained in the other's ("Marcum" vs "Marcum LLP", "CBIZ" vs "CBIZ CPAs P.C.")."""
    ca, cb = canon_firm(a), canon_firm(b)
    if not ca or not cb:
        return ca == cb
    return ca == cb or set(ca.split()) <= set(cb.split()) or set(cb.split()) <= set(ca.split())


# Broad trigger vocabulary: any cleaned sentence containing these is worth reading when
# the regex missed an event. Used by the regex-dev kernel to print false-negative evidence.
TRIGGER_RE = re.compile(r"(?i:resign|declin|dismiss|terminat|engag|appoint|re-?election|re-?appoint|ceas|replac|"
                        r"disagree|reportable|material weakness|going concern|adverse|disclaimer|substantial doubt)")
