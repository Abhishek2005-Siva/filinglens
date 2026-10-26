"""Item 5.07 (Submission of Matters to a Vote of Security Holders) — regex fast path.

Two layers, mirroring the CEO detector's "regex fast path -> LoRA classifier":

1. A deterministic VOTE-TABLE PARSER (`parse_votes`). 5.07 filings are mostly
   tables of For / Against / Abstain / Broker Non-Votes, and arithmetic beats a
   classifier at reading them: it yields per-proposal counts, pass/fail by vote
   math, and the say-on-pay approval percentage. Works on the table-preserving
   text from src/items.fetch_filing_text_with_tables ("a | b | c" rows).

2. A multi-label SEGMENT CLASSIFIER over the narrative / proposal-description
   text (what was voted on, and whether anything failed). The regexes here are
   its first tier and the weak labels it trains on:

    ELECT_DIRECTORS, RATIFY_AUDITOR, SAY_ON_PAY, SAY_ON_FREQUENCY, EQUITY_PLAN,
    CHARTER_BYLAW, MERGER_TRANSACTION, SHARE_ISSUANCE_SPLIT, SHAREHOLDER_PROPOSAL,
    ADJOURNMENT, PROPOSAL_FAILED, MEETING_SPECIAL

PROPOSAL_FAILED is the high-value, rare-ish signal ("an insufficient number of
affirmative votes was received to approve Proposal 2"): a defeated proposal.
"""
import re
from typing import Dict, List, Optional, Sequence

LABELS = [
    "ELECT_DIRECTORS", "RATIFY_AUDITOR", "SAY_ON_PAY", "SAY_ON_FREQUENCY", "EQUITY_PLAN", "CHARTER_BYLAW",
    "MERGER_TRANSACTION", "SHARE_ISSUANCE_SPLIT", "SHAREHOLDER_PROPOSAL", "ADJOURNMENT", "PROPOSAL_FAILED",
    "MEETING_SPECIAL",
]
LABEL2ID = {l: i for i, l in enumerate(LABELS)}

# --- numbers / table vocabulary -----------------------------------------------------------
_DASHES = {"—", "–", "-", "--", "nil", "none", "n/a"}
_COLS = {  # normalised header text -> canonical column
    "for": "for", "votes for": "for", "vote for": "for", "in favor": "for", "affirmative": "for",
    "against": "against", "votes against": "against", "vote against": "against", "opposed": "against",
    "abstain": "abstain", "abstains": "abstain", "abstention": "abstain", "abstentions": "abstain",
    "abstained": "abstain", "votes abstained": "abstain", "votes abstaining": "abstain",
    "withheld": "withheld", "withhold": "withheld", "votes withheld": "withheld", "vote withheld": "withheld",
    "broker": "broker", "broker non votes": "broker", "broker nonvotes": "broker", "broker non vote": "broker",
    "broker nonvote": "broker", "non votes": "broker", "nonvotes": "broker",
    "votes for approval": "for", "for approval": "for", "affirmative votes": "for", "votes in favor": "for", "votes cast for": "for", "shares voted for": "for",
    "yes": "for", "votes against approval": "against", "against approval": "against", "negative votes": "against", "negative": "against",
    "votes cast against": "against", "no": "against", "votes in opposition": "against",
    "1 year": "y1", "one year": "y1", "1 yr": "y1", "2 years": "y2", "two years": "y2", "2 yrs": "y2",
    "3 years": "y3", "three years": "y3", "3 yrs": "y3",
}
_NAME_HEADS = {"nominee", "nominees", "name", "names", "director", "directors", "director nominee",
               "nominee name", "proposal", "matter", ""}


def _norm_head(cell: str) -> str:
    c = re.sub(r"[^a-z0-9 ]", " ", cell.lower().replace("-", " "))
    c = re.sub(r"^(?:shares\s+)?voted\s+", "", c)   # "Voted For", "Voted One Year", "Shares Voted For"
    c = re.sub(r"\b(?:number of|shares|total)\b", " ", c)
    return re.sub(r"\s+", " ", c).strip()


def _to_int(cell: str) -> Optional[int]:
    c = cell.strip().strip("()").replace(",", "").replace("$", "").strip()
    if c.lower() in _DASHES:
        return 0
    if re.fullmatch(r"\d+(?:\.\d+)?", c):
        return int(float(c))
    return None


def _is_numeric_row(cells: List[str]) -> bool:
    nums = sum(_to_int(c) is not None for c in cells)
    return nums >= max(1, len(cells) - 1) and nums >= 1


def _header_cols(cells: List[str]) -> Optional[List[Optional[str]]]:
    """Canonical column list if `cells` is a vote-table header (>=2 known vote columns), with None for a leading name column and '_' for a column
    we do not use (a percentage, 'Witheld', ...) so that data cells stay aligned; else None. A header cell split in two ("Broker" | "Non-Votes") counts once."""
    cols: List[Optional[str]] = []
    prev = None
    for i, c in enumerate(cells):
        canon = _COLS.get(_norm_head(c))
        if canon and canon == prev:
            continue  # the second half of a split header cell
        if canon is None and (i > 0 and _norm_head(c) not in _NAME_HEADS):
            if (len(c) > 60 and not re.search(r"(?i)percent|%|of shares", c)) or re.search(r"\d{3}", c):
                return None  # a long text cell or a number: not a header
            if prev == "_":
                continue
            canon = "_"
        cols.append(canon)
        prev = canon
    known = [c for c in cols if c and c != "_"]
    if len(known) >= 2 and (cols[0] is None or cols[0] in _COLS.values()):
        while cols and cols[-1] == "_":
            cols.pop()
        return cols
    return None


def _split_cells(line: str) -> List[str]:
    cells = [c.strip() for c in line.split(" | ")]
    first, rest = cells[0], [c for c in cells[1:] if c]
    # a share of the vote written next to the count ("92.30 | %", "99.7%") is not a count
    if len(rest) >= 3 and sum(bool(re.fullmatch(r"[\d,]{3,}", c)) for c in rest) >= 2:
        rest = [c for c in rest if c != "%" and not re.fullmatch(r"\d{1,3}\.\d+\s*%?|\d{1,3}\s*%", c)]
    return [first] + rest


# --- vote-table parser -----------------------------------------------------------------------
_PROPOSALISH = re.compile(r"(?i:^\s*(?:proposal|item|\d{1,2}[.)])|approv|ratif|amend|advisory|adjourn|compensation|plan\b|split|merger)")


def parse_votes(section: str) -> dict:
    """Tables of votes -> [{desc, kind, rows:[{name, for, against, ...}]}] plus
    derived pass/fail and say-on-pay numbers. Pure arithmetic; no model."""
    lines = [ln.rstrip() for ln in section.splitlines()]
    tables: List[dict] = []
    desc_lines: List[str] = []
    cur: Optional[dict] = None
    last_header: Optional[List[Optional[str]]] = None

    def close():
        nonlocal cur
        if cur and cur["rows"]:
            tables.append(cur)
            # The next table's description is only the text AFTER this one;
            # carrying older lines over made every table look like it belonged
            # to the first proposal ("...election of directors...").
            desc_lines.clear()
        cur = None

    for ln in lines:
        if " | " not in ln:
            # plain text line: ends any open table, becomes part of the next table's description
            close()
            if ln.strip():
                desc_lines.append(ln.strip())
                desc_lines = desc_lines[-6:]
                if len(ln.strip()) > 80:
                    last_header = None  # a new paragraph: a table that follows brings its own header
            continue
        cells = _split_cells(ln)
        header = _header_cols(cells)
        if header:  # horizontal table header row
            close()
            cur = {"desc": " ".join(desc_lines[-3:]), "last": desc_lines[-1] if desc_lines else "", "header": header, "rows": [], "orient": "h"}
            last_header = header
            continue
        if last_header and len(cells) >= 2 and re.fullmatch(r"\(?\d{1,2}[.)]?", cells[0]) and _to_int(cells[1]) is None:
            # one shared header, then '2. | To approve the compensation ... | 413,337,605 | 98.1 | ...' or '1. | To appoint the following directors:': a new proposal
            text, nums = cells[1], cells[2:]
            if len(nums) >= 2 and _is_numeric_row(nums):
                close()
                cols = [c for c in last_header if c is not None]
                row = {"name": text}
                for c, v in zip(cols, nums):
                    if c != "_":
                        row[c] = _to_int(v)
                cur = {"desc": text, "last": text, "header": last_header, "rows": [row], "orient": "h"}
            else:
                close()
                cur = {"desc": text, "last": text, "header": last_header, "rows": [], "orient": "h"}
            continue
        if cur and cur["orient"] == "h" and len(cells) >= 3 - (_to_int(cells[0]) is None) and _is_numeric_row(cells[1:] if len(cells) > len(cur["header"]) - 0 and
                                                           _to_int(cells[0]) is None else cells):
            nums_cells = cells[1:] if _to_int(cells[0]) is None else cells
            name = cells[0] if _to_int(cells[0]) is None else ""
            cols = [c for c in cur["header"] if c is not None]
            row = {"name": name}
            for c, v in zip(cols, nums_cells):
                if c != "_":
                    row[c] = _to_int(v)
            cur["rows"].append(row)
            continue
        # vertical key|value rows: "For | 5,819,219"
        if len(cells) == 2 and _COLS.get(_norm_head(cells[0])) and _to_int(cells[1]) is not None:
            if not cur or cur["orient"] != "v":
                close()
                cur = {"desc": " ".join(desc_lines[-3:]), "last": desc_lines[-1] if desc_lines else "", "header": None, "rows": [{"name": ""}], "orient": "v"}
            cur["rows"][0][_COLS[_norm_head(cells[0])]] = _to_int(cells[1])
            continue
        # a text-bearing table row ("1. | The following nominees ...") is description, not data
        close()
        text = " ".join(c for c in cells if c)
        if text.strip():
            desc_lines.append(text.strip())
            desc_lines = desc_lines[-6:]
    close()

    proposals, say_on_pay = [], None
    expanded = []
    for t in tables:
        t["rows"] = [r for r in t["rows"] if not re.match(r"(?i)\s*(?:percent|percentage|%)", r.get("name", ""))] or t["rows"]  # 'Percentage of outstanding shares: 58.60 | 3.02'
    for t in tables:
        if len(t["rows"]) >= 2 and all(_PROPOSALISH.search(r.get("name", "")) for r in t["rows"]):
            for r in t["rows"]:  # each row is its own proposal
                expanded.append({**t, "rows": [r], "desc": r.get("name", ""), "last": r.get("name", "")})
        else:
            expanded.append(t)
    for t in expanded:
        rows = t["rows"]
        cols = set().union(*[set(r) for r in rows]) - {"name"}
        desc = t["desc"]
        if {"y1", "y2", "y3"} & cols:
            kind = "frequency"
        elif len(rows) >= 2 or ("withheld" in cols and "against" not in cols) or (_DIRECTOR_DESC.search(t.get("last", "")) and not _NOT_ELECTION.search(t.get("last", ""))):
            kind = "directors"
        else:
            kind = "proposal"
        rec = {"kind": kind, "desc": desc[-200:], "n_rows": len(rows)}
        if kind == "proposal":
            r = rows[0]
            f, a = r.get("for"), r.get("against")
            if f is not None and a is not None:
                rec.update({k: r.get(k) for k in ("for", "against", "abstain", "broker")})
                rec["passed_by_math"] = f > a
                rec["pct_for"] = round(100.0 * f / (f + a), 2) if f + a else None
                if _SAY_ON_PAY_DESC.search(desc) and not _FREQ_DESC.search(desc) and say_on_pay is None:
                    say_on_pay = {"for": f, "against": a, "pct_for": rec["pct_for"], "passed": f > a}
        elif kind == "directors":
            rec["nominees_below_majority"] = sum(
                1 for r in rows if r.get("for") is not None and r.get("against") is not None and r["for"] < r["against"])
        proposals.append(rec)

    nondir = [p for p in proposals if p["kind"] == "proposal"]
    return {
        "tables": proposals,
        "n_proposals": len(nondir) + (1 if any(p["kind"] == "directors" for p in proposals) else 0)
                       + sum(1 for p in proposals if p["kind"] == "frequency"),
        "any_failed_by_math": any(not p["passed_by_math"] for p in nondir if "passed_by_math" in p),
        "say_on_pay": say_on_pay,
    }


# --- segment extraction -----------------------------------------------------------------------
_NOT_ELECTION = re.compile(r"(?i)\b(?:guideline|policy|proposal|amend\w*|resignation|majority\s+voting|declassif\w*|bylaws?|plan|compensation|ratif\w*)\b")
_DIRECTOR_DESC = re.compile(r"(?i:\belect(?:ed|ion|s)?\b[^.]{0,60}\bdirectors?\b|\bdirectors?\b[^.]{0,40}\belect(?:ed|ion|s)?\b|\bnominees?\b)")  # not 'selection of the firm ... Board of Directors' 
_SAY_ON_PAY_DESC = re.compile(r"(?i:(?:compensation|pay)\s+of\s+(?:[\w’'.&-]+\s+){0,4}named\s+executive|"
                              r"executive\s+compensation|say[\s-]on[\s-]pay|named\s+executive\s+officer\s+compensation)")
_FREQ_DESC = re.compile(r"(?i:frequency|every\s+(?:one|1|two|2|three|3)\s+year)")
_MARKER_RE = re.compile(r"^\(?(?:proposal\b|\d{1,2}[.)]\s|\(\d{1,2}\)|[ivx]{1,4}\.\s|item\s+\d)", re.IGNORECASE)
_NOISE_LINE_RE = re.compile(r"(?i:^number of votes$|^page \d+$|^\d{1,3}$|^votes?:?$)")


def sentences_from_section(section: str) -> List[str]:
    """Narrative / proposal-description segments of a 5.07 section: vote-count
    table rows are dropped (the parser reads those), text lines belonging to one
    paragraph are re-joined, and 'Proposal N' / '(N)' lines start a new block."""
    from .items import ITEM_CAPTIONS, split_item_sentences

    blocks: List[str] = []
    cur: List[str] = []

    def flush():
        if cur:
            blocks.append(" ".join(cur))
            cur.clear()

    for raw in section.splitlines():
        ln = raw.strip()
        if not ln or _NOISE_LINE_RE.match(ln):
            continue
        if " | " in ln:
            cells = _split_cells(ln)
            if _header_cols(cells) or _is_numeric_row(cells[1:] if _to_int(cells[0]) is None else cells) \
                    or (len(cells) == 2 and _COLS.get(_norm_head(cells[0]))):
                flush()  # vote header / data / key-value row: parser territory
                continue
            ln = " ".join(c for c in cells if c)  # "1. | The following nominees..." text row
        if _MARKER_RE.match(ln):
            flush()
        cur.append(ln)
    flush()

    out: List[str] = []
    for b in blocks:
        for s in split_item_sentences(b, ITEM_CAPTIONS["5.07"]):
            s = s.strip()
            if len(s) > 15:
                out.append(s)
    return out


# --- regex weak labels --------------------------------------------------------------------------
_R = lambda p: re.compile(p, re.IGNORECASE)  # noqa: E731
_PAT = {
    "ELECT_DIRECTORS": _R(
        r"elect\w*\s+(?:of\s+)?(?:the\s+)?(?:following\s+)?(?:\w+\s+){0,4}(?:directors?|nominees?|trustees?|governors?|managers?)|"
        r"elect\w*\b.{0,60}\b(?:persons?|individuals?|members\s+of\s+(?:the\s+)?board)\s+to\s+serve|"
        r"(?:stock|share)?holders\s+elected\b|(?:members|owners|unitholders)\s+elected\b|"
        r"class\s+[ivx]+\s+(?:directors|members)|"
        r"(?:directors?|nominees?|trustees?).{0,80}\b(?:were|was|have\s+been)\s+(?:duly\s+)?(?:re-?)?elected|"
        r"re-?elect\w*.{0,60}(?:directors?|trustees?)|nominees?\s+(?:for\s+director\s+)?(?:were|was)\s+elected"),
    "RATIFY_AUDITOR": _R(
        r"(?:ratif\w+|appointment|selection|engagement|retention).{0,140}"
        r"(?:independent\s+)?(?:registered\s+)?(?:public\s+)?(?:accounting\s+firm|auditors?|accountants?)"),
    "SAY_ON_PAY": _R(
        r"(?:advisory|non-?binding).{0,100}(?:compensation|named\s+executive)|"
        r"(?:compensation|pay)\s+of\s+(?:[\w’'.&-]+\s+){0,4}named\s+executive|say[\s-]on[\s-]pay|"
        r"approve.{0,40}executive\s+compensation"),
    "SAY_ON_FREQUENCY": _R(
        r"frequency\s+(?:of|with\s+which).{0,120}(?:advisory|executive\s+compensation|say|vote)|"
        r"(?:advisory|say[\s-]on[\s-]pay).{0,120}\bevery\s+(?:one|1|two|2|three|3)\s+years?|"
        r"(?:one|1)\s+year,?\s+(?:two|2)\s+years?,?\s+(?:or\s+)?(?:three|3)\s+years?"),
    "EQUITY_PLAN": _R(
        r"(?:equity|stock|share|option|incentive|omnibus|compensation)[\w\s,&-]{0,40}\bplan\b|"
        r"employee\s+stock\s+purchase|\bESPP\b|long[\s-]term\s+incentive"),
    "CHARTER_BYLAW": _R(
        r"extension\s+(?:amendment|proposal)|trust\s+(?:agreement\s+)?amendment|\bNTA\s+amendment|"
        r"amend\w*.{0,80}(?:certificate\s+of\s+(?:incorporation|formation)|articles\s+of\s+(?:incorporation|association)|"
        r"charter|by-?laws|declaration\s+of\s+trust|operating\s+agreement|memorandum)|declassif\w+|"
        r"(?:eliminat\w+|reduc\w+).{0,40}supermajority"),
    "MERGER_TRANSACTION": _R(
        r"\bmerger\b|business\s+combination\s+(?:proposal|agreement)|approv\w+\s+(?:of\s+)?(?:the\s+)?business\s+combination|plan\s+of\s+(?:merger|reorganization|liquidation|dissolution)|"
        r"sale\s+of\s+(?:all\s+or\s+)?substantially\s+all|asset\s+(?:sale|purchase)|\bdissol\w+|"
        r"(?:acquisition|acquire)\s+of\b|agreement\s+and\s+plan"),
    "SHARE_ISSUANCE_SPLIT": _R(
        r"reverse\s+(?:stock\s+|share\s+)?split|forward\s+(?:stock\s+)?split|"
        r"increas\w*.{0,60}authorized\s+(?:number\s+of\s+)?(?:shares|common|capital)|authorized\s+(?:shares|capital).{0,50}increas\w*|"
        r"(?:share|stock)\s+issuance|issuance\b.{0,160}(?:shares|common\s+stock|ordinary\s+shares|preferred\s+stock|warrants|conversion)|"
        r"\b(?:allot|allotment)\b|pre-?emption|nasdaq.{0,30}rule\s+5635|rule\s+5635|private\s+placement|"
        r"conversion\s+of.{0,60}(?:preferred|notes|warrants)|below.{0,30}net\s+asset\s+value"),
    "SHAREHOLDER_PROPOSAL": _R(
        r"(?:share|stock)holder\s+proposals?|proposal\s+(?:submitted|presented|made)\s+by\s+(?:a\s+)?(?:share|stock)holder|"
        r"(?:share|stock)holder\s+(?:advisory\s+)?(?:proposal|resolution)|\bproponent\b|"
        r"(?:requesting|requests|requiring)\s+(?:that\s+)?the\s+(?:board|company)"),
    "ADJOURNMENT": _R(r"adjourn\w*|postpone\w*|no\s+vote\s+was\s+taken|(?:proposal|matter).{0,30}\bwithdrawn\b"),
    "PROPOSAL_FAILED": _R(
        r"(?:was|were|has|have|had)\s+not\s+(?:been\s+)?(?:approved|adopted|ratified|passed|elected|carried)|"
        r"\bfail(?:ed|s)?\s+to\s+(?:receive|pass|obtain|be\s+approved|achieve|gain)|"
        r"(?:did|does|do)\s+not\s+(?:receive|obtain|achieve|pass|gain)\b.{0,40}(?:requisite|required|sufficient|necessary|affirmative|majority|vote)|"
        r"insufficient\s+(?:number\s+of\s+)?(?:affirmative\s+)?votes\s+(?:was|were)\s+(?:received|cast|obtained)|"
        r"(?:was|were)\s+not\s+(?:approved|adopted)\s+by|\b(?:was|were)\s+(?:defeated|rejected|voted\s+down)|"
        r"did\s+not\s+(?:approve|adopt|ratify|pass|elect)\b|not\s+approved|failed\s+to\s+(?:be\s+)?(?:approved|elected|adopted)|received\s+(?:less|fewer)\s+than"),
    "MEETING_SPECIAL": _R(r"special\s+(?:general\s+)?meeting|extraordinary\s+(?:general\s+)?meeting|(?<!annual )(?<!annual and )general\s+meeting"),
}
# Generic phrases that mention a "plan"/"approve" in boilerplate but are not a vote item.
_NOT_A_VOTE = re.compile(r"(?i:employment\s+agreement|offer\s+letter|severance|retention\s+bonus)")
_ALL_APPROVED = re.compile(r"(?i:all\s+(?:matters|proposals|of\s+the\s+proposals)\b[^.]{0,60}\bwere\s+approved|each\s+of\s+the\s+proposals\s+(?:was|were|received)|"
                           r"(?:no|none\s+of\s+the)\s+proposals?\s+(?:failed|was\s+rejected))")


# Conditional adjournment text ("if the Company does not receive sufficient votes"), the cover
# legend ("not been approved or disapproved by the SEC") and similar are not outcomes.
_FAIL_BOILERPLATE = re.compile(
    r"(?i:approved\s+or\s+disapproved|if\s+(?:necessary|there\s+are|the\s+company|[a-z]+\s+does)|in\s+the\s+event\s+(?:that\s+)?(?:there|the|[a-z]+\s+does)|"
    r"additional\s+proxies|further\s+solicitation|to\s+solicit)")
_DIRECTOR_BOILERPLATE = re.compile(r"(?i:shall\s+hold\s+office|entitled\s+to\s+vote\s+(?:generally\s+)?in\s+the\s+election|"
                                   r"affirmative\s+vote\s+of)")
_NOT_PRESENTED = re.compile(r"(?i:not\s+necessary|originally\s+convened\s+and\s+adjourned|had\s+been\s+adjourned|not\s+applicable|rendered\s+moot|\bmoot\b|was\s+not\s+(?:presented|submitted|put|voted)|not\s+presented)")


def label_sentence(sentence: str) -> List[str]:
    s = sentence
    labs = {l for l, p in _PAT.items() if p.search(s)}
    if _NOT_A_VOTE.search(s) and not re.search(r"(?i:vot|proposal|stockholders?\s+approved|shareholders?\s+approved)", s):
        labs.discard("EQUITY_PLAN")
    if "ADJOURNMENT" in labs and _NOT_PRESENTED.search(s):
        labs.discard("ADJOURNMENT")
    if "MERGER_TRANSACTION" in labs and re.search(r"(?i:extend|extension)", s):
        labs.discard("MERGER_TRANSACTION")  # SPAC "extend the date to consummate a business combination"
    # frequency vs pay: a frequency vote line also says "advisory ... compensation"
    if "SAY_ON_FREQUENCY" in labs:
        labs.discard("SAY_ON_PAY")
    # "all proposals were approved" is the opposite of a failure
    if "PROPOSAL_FAILED" in labs and (_ALL_APPROVED.search(s) or _FAIL_BOILERPLATE.search(s)):
        labs.discard("PROPOSAL_FAILED")
    if "ELECT_DIRECTORS" in labs and _DIRECTOR_BOILERPLATE.search(s):
        labs.discard("ELECT_DIRECTORS")
    return [l for l in LABELS if l in labs]


# --- aggregation / evaluation interface -----------------------------------------------------------
_TYPE_KEYS = {
    "ELECT_DIRECTORS": "has_directors", "RATIFY_AUDITOR": "has_auditor", "SAY_ON_PAY": "has_say_on_pay",
    "SAY_ON_FREQUENCY": "has_say_on_frequency", "EQUITY_PLAN": "has_equity_plan", "CHARTER_BYLAW": "has_charter",
    "MERGER_TRANSACTION": "has_merger", "SHARE_ISSUANCE_SPLIT": "has_share_issuance",
    "SHAREHOLDER_PROPOSAL": "has_shareholder_proposal", "ADJOURNMENT": "has_adjournment",
}
FLAG_MAP = {**{v: v for v in _TYPE_KEYS.values()}, "special_meeting": "special_meeting", "any_failed": "any_failed"}
NAME_FIELDS: list = []


def aggregate(sentences: Sequence[str], per_sentence: Sequence[Dict[str, float]], threshold=0.5,
              section: Optional[str] = None) -> dict:
    thr = (lambda l: threshold[l]) if isinstance(threshold, dict) else (lambda l: threshold)
    best: Dict[str, tuple] = {}
    for sent, scores in zip(sentences, per_sentence):
        for label in LABELS:
            p = scores.get(label, 0.0)
            if p >= thr(label) and (label not in best or p > best[label][1]):
                best[label] = (sent, p)
    votes = parse_votes(section) if section else {"tables": [], "n_proposals": 0, "any_failed_by_math": False,
                                                   "say_on_pay": None}
    rec = {key: label in best for label, key in _TYPE_KEYS.items()}
    # table structure is authoritative for presence of director / say-on-pay / frequency votes
    kinds = {t["kind"] for t in votes["tables"]}
    rec["has_directors"] = rec["has_directors"] or "directors" in kinds
    rec["has_say_on_frequency"] = rec["has_say_on_frequency"] or "frequency" in kinds
    rec["has_say_on_pay"] = rec["has_say_on_pay"] or votes["say_on_pay"] is not None
    rec["special_meeting"] = "MEETING_SPECIAL" in best
    rec["failed_by_text"] = "PROPOSAL_FAILED" in best
    rec["failed_by_math"] = bool(votes["any_failed_by_math"])
    rec["any_failed"] = rec["failed_by_text"] or rec["failed_by_math"]
    sop = votes["say_on_pay"]
    rec["say_on_pay_pct_for"] = sop["pct_for"] if sop else None
    rec["say_on_pay_failed"] = bool(sop and not sop["passed"])
    rec["n_proposals"] = votes["n_proposals"]
    rec["evidence"] = {l: best[l][0] for l in best}
    rec["confidence"] = {l: round(best[l][1], 4) for l in best}
    return rec


def regex_analyze(sentences: Sequence[str], section: Optional[str] = None) -> dict:
    per = [{l: 1.0 for l in label_sentence(s)} for s in sentences]
    return aggregate(sentences, per, section=section)


# Broad trigger vocabulary for false-negative digests in the regex-dev kernel.
TRIGGER_RE = re.compile(r"(?i:elect|ratif|approv|advisory|compensation|plan|amend|merger|split|issuance|adjourn|"
                        r"withdr|defeat|reject|fail|insufficient|not\s+approved|special\s+meeting|shareholder\s+proposal|"
                        r"stockholder\s+proposal|frequency)")
