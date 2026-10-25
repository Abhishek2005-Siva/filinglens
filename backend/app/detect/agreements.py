"""Weak-supervision labelers for Items 1.01 (Entry into a Material Definitive
Agreement) and 1.02 (Termination of a Material Definitive Agreement).
Owner: training-sec-f5.

Two small sentence-level tasks, trained as two models:

  EVENT model   NONE / ENTERED / TERMINATED     (does this sentence announce an
                                                  agreement being entered or ended?)
  TYPE  model   MNA / DEBT / EQUITY / COMMERCIAL / GOVERNANCE
                                                (what kind of agreement? trained only on
                                                 event sentences whose keywords place it)

Why split: ENTERED is nearly guaranteed in any 1.01 filing, so the useful signal is
the agreement type and (best-effort, regex) counterparty/amount. Also 1.02 sections
routinely announce the *replacement* agreement too (Canopy Growth, iRhythm), so one
event vocabulary has to cover both items.

The dominant false-positive trap in 1.01/1.02 text is contract *provisions*: "either
party may terminate the Agreement", "the Company has the right to terminate",
"agreed to enter into a registration rights agreement". Those read like events and
are mined deliberately as hard negatives. Event-like sentences no rule can place go
to a SKIP bucket (label None) instead of being called NONE.
"""
import re
from typing import Optional, Tuple

EVENT_LABELS = ["NONE", "ENTERED", "TERMINATED"]
TYPE_LABELS = ["MNA", "DEBT", "EQUITY", "COMMERCIAL", "GOVERNANCE"]

_AGREEMENT_NOUN = re.compile(
    r"\b(?:agreements?|contracts?|indenture|notes?|debentures?|facility|facilities|lease|sublease|commitment|"
    r"letter\s+of\s+intent|term\s+sheet|plan\s+of\s+(?:merger|reorganization)|amendments?|waiver|forbearance|"
    r"guarant(?:y|ee)|arrangements?|warrants?|understanding)\b", re.IGNORECASE)

# What can precede an event verb and turn it into a promise / provision / condition.
_FUTURE_BEFORE = re.compile(
    r"\b(?:will|shall|would|may|might|can|could|expects?|intends?|plans?|propos\w+|agreed\s+to|agrees?\s+to|"
    r"to|right\s+to|option\s+to|entitled\s+to|obligat\w+\s+to|required\s+to|permitted\s+to|unless|if|until|"
    r"in\s+order\s+to|ability\s+to|prior\s+to|either\s+party|any\s+party)\s+(?:\w+\s+){0,3}$", re.IGNORECASE)
_PROVISION_BEFORE = re.compile(
    r"\b(?:may|can|could|will|shall|would|right|option|entitled|able|permitted|expects?|intends?|"
    r"event\s+of|upon|if|unless|until|in\s+the\s+event|provides?|grants?|subject\s+to|automatically|"
    r"either\s+party|at\s+any\s+time|unilateral\w*)\b", re.IGNORECASE)
_PRESENT_PASSIVE_BEFORE = re.compile(r"\b(?:is|are|be|being)\s+(?:\w+\s+)?$", re.IGNORECASE)
_PAST_AUX_BEFORE = re.compile(r"\b(?:was|were|been|hereby|has|have|had)\s+(?:\w+\s+)?$", re.IGNORECASE)
_TERMS_RE = re.compile(
    r"\b(?:pursuant\s+to|provides?\s+(?:that|for)|qualified\s+in\s+its\s+entirety|incorporated\s+(?:herein\s+)?by\s+reference|"
    r"filed\s+as\s+Exhibit|attached\s+as\s+Exhibit|full\s+text|representations?|warrant(?:y|ies)|covenants?|"
    r"events?\s+of\s+default|interest\s+rate|matur(?:e|es|ity)|conversion\s+price)\b", re.IGNORECASE)

_ENTER_RE = re.compile(r"\b(?:entered|enter|entering)\s+into\b|\bmade\s+and\s+entered\s+into\b|\b(?:executed|signed)\b", re.IGNORECASE)
_ISSUED_NOTE_RE = re.compile(
    r"^(?:On|As\s+of|Effective|Dated)\b.{0,40}?\b(?:20\d\d|19\d\d)\b.{0,80}?\bissued\b.{0,100}?"
    r"\b(?:promissory\s+note|convertible\s+note|note|notes|debenture|warrant)", re.IGNORECASE)
# lowercase verb only: "Third Amended and Restated Loan Agreement" is a contract's name, not an amendment event
_AMEND_RE = re.compile(r"(?i:\b(?:the\s+Company|we|the\s+parties|the\s+[“\"]?Company[”\"]?)\b).{0,60}?\bamended\b(?!\s+and\s+restated)")
_TERMINATE_RE = re.compile(r"\b(terminated|terminating|terminate|terminates|termination)\b", re.IGNORECASE)
_AGREED_TERMINATE = re.compile(r"(?:exercised\s+(?:its|their|the)\s+(?:right|option)\s+to|agreed\s+to|mutual\w*\s+(?:agreed\s+to\s+)?|elected\s+to|decided\s+to|determined\s+to|voted\s+to)\s*$", re.IGNORECASE)
_NOTICE_OF_TERMINATION = re.compile(r"\b(?:notice\s+of|notified\s+\w+(?:\s+\w+)?\s+of\s+(?:its|the)?)\s*termination\b", re.IGNORECASE)
_EVENTLIKE = re.compile(r"\b(?:entered|executed|signed|terminated|amended|restated|rescinded|cancell?ed|expired)\b", re.IGNORECASE)


# v2 (from error analysis of 97 missed terminations on the dev months): terminations that never say "terminated"
_TERM_AGREEMENT_NAME_RE = re.compile(
    r"\b(?:lease\s+|mutual\s+|settlement\s+)?termination(?:\s+and\s+(?:release|settlement))?\s+(?:agreement|letter|notice)\b", re.IGNORECASE)
_ENTERED_TO_TERMINATE_RE = re.compile(r"\bentered\s+into\b.{0,200}?\bto\s+terminate\b|\bagreed\s+to\s+terminate\b", re.IGNORECASE)
# "to terminate" inside a provision ("has the right to terminate", "may elect to terminate") is not an event
_PROVISION_TERMINATE_BEFORE = re.compile(
    r"\b(?:right|option|elect|able|ability|may|entitled|permitted|required|obligat\w*|intend\w*|plan\w*|propos\w*|wish\w*|desire\w*|"
    r"either\s+party|any\s+party)\b[^.]{0,30}$", re.IGNORECASE)


class _TermAgreement:
    """regex-like wrapper so call sites read `_TERMINATION_AGREEMENT_RE.search(sentence)`"""

    @staticmethod
    def search(sentence: str):
        m = _TERM_AGREEMENT_NAME_RE.search(sentence)
        if m:
            return m
        for m in _ENTERED_TO_TERMINATE_RE.finditer(sentence):
            if m.group(0).lower().startswith("agreed"):
                return m
            tt = sentence.lower().rfind("to terminate", m.start(), m.end())
            if not _PROVISION_TERMINATE_BEFORE.search(sentence[max(0, tt - 45):tt]):
                return m
        return None


_TERMINATION_AGREEMENT_RE = _TermAgreement()
_PAYOFF_RE = re.compile(
    r"\b(?:satisfied\s+and\s+discharged|satisfaction\s+and\s+discharge|(?:is|are|were|was|being)\s+no\s+longer\s+(?:outstanding|in\s+effect)|"
    r"(?:redeemed|repaid|paid\s+off|retired|prepaid)\s+(?:all|in\s+full|the\s+entire|its\s+outstanding)|hereby\s+terminates?|"
    r"(?:released|discharged)\s+(?:all\s+)?(?:liens|security|obligations)|obligations\s+(?:thereunder\s+)?(?:have\s+been|were)\s+(?:satisfied|discharged)|"
    r"termination\s+of\s+(?:the|that|its)\b.{0,80}?\b(?:was|is|became)\s+effective)", re.IGNORECASE)


def _entered(sentence: str) -> Optional[str]:
    """'positive' | 'hard_negative' | None for the ENTERED side."""
    if not _AGREEMENT_NOUN.search(sentence):
        return None
    for m in _ENTER_RE.finditer(sentence):
        if _FUTURE_BEFORE.search(sentence[max(0, m.start() - 45):m.start()]):
            return "hard_negative"
        return "positive"
    if _ISSUED_NOTE_RE.search(sentence):
        return "positive"
    m = _AMEND_RE.search(sentence)
    if m and not _FUTURE_BEFORE.search(sentence[max(0, m.start() - 45):m.end()]):
        return "positive"
    return None


def _terminated(sentence: str) -> Optional[str]:
    if not _AGREEMENT_NOUN.search(sentence):
        return None
    for rx in (_TERMINATION_AGREEMENT_RE, _PAYOFF_RE):
        m = rx.search(sentence)
        if m and not _FUTURE_BEFORE.search(sentence[max(0, m.start() - 45):m.start()]):
            return "positive"
    result = None
    for m in _TERMINATE_RE.finditer(sentence):
        word = m.group(1).lower()
        prefix = sentence[:m.start()]
        if word == "terminated":
            if re.search(r"\bhereby\s+$", prefix[-15:], re.IGNORECASE) or _PAST_AUX_BEFORE.search(prefix[-30:]):
                return "positive"
            if _PRESENT_PASSIVE_BEFORE.search(prefix[-15:]) or _PROVISION_BEFORE.search(prefix[-100:]):
                result = "hard_negative"  # "is terminated automatically", "may be terminated", "upon ... terminated"
                continue
            return "positive"
        if word in ("terminate", "terminates", "terminating"):
            if _AGREED_TERMINATE.search(prefix[-30:]):
                return "positive"
            result = "hard_negative"
            continue
        # "termination": only a notice of termination is a clear event on its own
        if _NOTICE_OF_TERMINATION.search(sentence):
            return "positive"
        if _PROVISION_BEFORE.search(prefix[-100:]):
            result = result or "hard_negative"
    return result


def classify_event(sentence: str) -> Tuple[Optional[str], str]:
    """-> (label, bucket); label None = SKIP.
    bucket: positive | hard_negative | generic_negative | skip."""
    ent, ter = _entered(sentence), _terminated(sentence)
    if ent == "positive" and ter == "positive":
        if _TERMINATION_AGREEMENT_RE.search(sentence):
            return "TERMINATED", "positive"  # "entered into a Termination Agreement ..." is a termination
        return None, "skip"  # "entered into X and terminated Y" -- ambiguous, keep out of training
    if ent == "positive":
        return "ENTERED", "positive"
    if ter == "positive":
        return "TERMINATED", "positive"
    if ent == "hard_negative" or ter == "hard_negative":
        return "NONE", "hard_negative"
    if _AGREEMENT_NOUN.search(sentence) and _TERMS_RE.search(sentence):
        return "NONE", "hard_negative"
    if _EVENTLIKE.search(sentence):
        return None, "skip"
    return "NONE", "generic_negative"


# ---- agreement type -----------------------------------------------------------------
_TYPE_PATTERNS = {
    "MNA": r"merger|plan\s+of\s+(?:merger|reorganization|exchange|arrangement)|business\s+combination|"
           r"(?:asset|stock|share|equity|membership\s+interest|unit|real\s+estate)\s+purchase|acquisition\s+agreement|"
           r"sale\s+and\s+purchase|purchase\s+and\s+sale|tender\s+(?:and\s+)?support|support\s+agreement|"
           r"contribution\s+agreement|exchange\s+agreement|transaction\s+agreement|asset\s+sale|share\s+exchange|arrangement\s+agreement",
    "EQUITY": r"securities\s+purchase|subscription|underwriting|placement\s+agen|equity\s+line|"
              r"equity\s+distribution|at[-\s]the[-\s]market|sales\s+agreement|private\s+placement|public\s+offering|"
              r"registered\s+direct|warrants?|(?:preferred|common)\s+stock\s+purchase|registration\s+rights|lock-?up",
    "DEBT": r"credit\s+(?:agreement|facility)|loan\s+(?:agreement|and\s+security)|(?:term|revolving|bridge|delayed\s+draw)\s+(?:loan|credit|facility)|"
            r"financing\s+agreement|indenture|promissory\s+note|convertible\s+(?:promissory\s+)?note|"
            r"(?:senior|secured|subordinated|unsecured)\s+(?:\w+\s+)?notes?\b|note\s+purchase|debenture|line\s+of\s+credit|"
            r"forbearance|guarant(?:y|ee)|security\s+agreement|mortgage|factoring|receivables|merchant\s+cash|notes\s+due|\bnotes?\b",
    "GOVERNANCE": r"employment|consulting|separation|severance|retention|indemnification|cooperation\s+agreement|settlement|"
                  r"standstill|voting\s+agreement|stockholders?['’]?\s+agreement|shareholders?['’]?\s+agreement|"
                  r"investor\s+rights|nominat\w+|board\s+observer|\brelease\b",
    "COMMERCIAL": r"licen[sc]|collaborat|supply|distribut|development\s+agreement|manufactur|services?\s+agreement|"
                  r"master\s+services|off-?take|joint\s+venture|reseller|royalt|sponsorship|lease|sublease|co-?promotion|"
                  r"marketing\s+agreement|purchase\s+order|research|agency\s+agreement|franchise|partnership\s+agreement|"
                  r"customer|charter|construction|engineering",
}
_TYPE_RX = {k: re.compile(v, re.IGNORECASE) for k, v in _TYPE_PATTERNS.items()}
_TYPE_PRIORITY = ["MNA", "EQUITY", "DEBT", "GOVERNANCE", "COMMERCIAL"]


def agreement_type(sentence: str) -> Optional[str]:
    """Type of the agreement named after the event verb ('entered into a credit
    agreement', 'terminated the merger agreement'); earliest keyword wins, ties by
    _TYPE_PRIORITY. None if no keyword places it (excluded from type training)."""
    anchor = _ENTER_RE.search(sentence) or _TERMINATE_RE.search(sentence) or _ISSUED_NOTE_RE.search(sentence)
    window = sentence[anchor.end():anchor.end() + 220] if anchor else sentence
    for text in (window, sentence):
        best = None
        for rank, name in enumerate(_TYPE_PRIORITY):
            m = _TYPE_RX[name].search(text)
            if m and (best is None or (m.start(), rank) < (best[1], best[2])):
                best = (name, m.start(), rank)
        if best:
            return best[0]
    return None


# ---- best-effort counterparty (regex only; flagged as such in any output) -----------
_COUNTERPARTY_RE = re.compile(
    r"\b(?:with|among|between|and)\s+((?:[A-Z][\w&.'’\-]*)(?:[ ,]+(?:[A-Z][\w&.'’\-]*|of|and|the|&)){0,6}?)"
    r"(?=,\s+(?:a|an|the|as)\b|\s+\(|\s+pursuant|\s+providing|\s+for\s|\s+relating|\s+dated|\s+to\s|\.$|;)")
_NOT_COUNTERPARTY = {"the company", "the registrant", "the partnership", "the parties", "company"}


_NOT_A_PARTY = re.compile(
    r"(?i)\b(?:agreement|amendment|note|notes|merger|plan|commission|contract|facility|indenture|warrants?|offering|prospectus|act|code|"
    r"supplement|exhibit|schedule|credit\s+facility|letter|guarant\w+|reimbursement|lease|purchase|sale|restated|revised|following|parties|securities\s+and)\b")
_ENTITY = re.compile(
    r"\b((?:[A-Z][\w&.'’\-]*[ ,]+(?:&\s+|of\s+|and\s+)?){0,5}?[A-Z][\w&.'’\-]*?),?\s+"
    r"(N\.A\.|Inc\.?|LLC|L\.L\.C\.|L\.P\.|LP|Corp(?:oration)?\.?|Ltd\.?|LLP|PLC|plc|S\.A\.|AG|Bank|Company|Trust|Capital|Partners|Securities|Group|Holdings|Limited)\b")


def _bad_party(name: str, company: str = "") -> bool:
    n = name.strip(" ,.").lower()
    if n in _NOT_COUNTERPARTY or len(n) < 3 or _NOT_A_PARTY.search(name):
        return True
    drop = {"inc", "corp", "llc", "ltd", "company", "corporation", "holdings", "group", "the", "plc", "limited"}
    toks = {t for t in re.findall(r"[a-z0-9]+", company.lower()) if len(t) > 2 and t not in drop}
    nt = {t for t in re.findall(r"[a-z0-9]+", n) if len(t) > 2 and t not in drop}
    return bool(toks and nt and nt <= toks)  # the registrant itself


def extract_counterparty(sentence: str, company: str = "") -> Optional[str]:
    rejected = False
    for m in _COUNTERPARTY_RE.finditer(sentence):
        name = m.group(1).strip(" ,")
        if not _bad_party(name, company):
            return name
        rejected = True
    if not rejected:
        return None
    # the only 'with X' phrases named a document, not a party ('amendment to the Restated Credit Agreement among ...'): take the first
    # company-looking name, preferring one followed by its role ('Bank of America, N.A., as administrative agent')
    text = re.sub(r"\([^)]{0,60}\)", " ", sentence)
    found = []
    for m in _ENTITY.finditer(text):
        name = (m.group(1) + (" " if m.group(2) in ("Bank", "Company", "Trust", "Capital", "Partners", "Securities", "Group", "Holdings", "Limited") else ", ") + m.group(2)).strip()
        name = re.sub(r"^(?:On|The|In|Under|Pursuant|And|With|Among|Between|As|By|Date|Effective|Company)[\s,]+", "", name)
        if len(name.split()) >= 2 and not _bad_party(name, company):
            found.append((name, bool(re.match(r"\s*,?\s*as\s+(?:the\s+)?[a-z]", text[m.end():m.end() + 20]))))
    for name, has_role in found:
        if has_role:
            return name
    return found[0][0] if found else None
