"""Small rule helpers that fix the edge cases found by cross-checking against a hand-made list of CEO / CFO appointments (Jan-Feb 2025):

- interim_of_new_role: "interim" counts only when it describes the NEW role. Not "Ciaran Long, the Interim CEO ... appointed to the position of CEO"
  (his old title), not "Ms. Abate will relinquish her role as interim principal financial officer" (someone else's old role).
- co_names: several people appointed together ("A, B and C as Co-Chief Executive Officers", "each of A and B", "Messrs. A and B"): all of them, not just the first.
- expand_reference: an Item 5.02 that only says "see Item 8.01, caption X" gets that text added.
"""
import re
from typing import List, Optional

_INTERIM_ROLE = re.compile(
    r"(?i)\b(?:interim|acting)\s+(?:principal\s+(?:executive|financial|accounting)\s+officer|chief\s+(?:executive|financial)\s+officer|ceo|cfo|president)\b|"
    r"\bon\s+an\s+interim\s+basis\b")
_OLD_ROLE = re.compile(r"(?i)relinquish|resign\w*|step\w*\s+down|ceas\w+|former(?:ly)?|previously|prior\s+to|has\s+served|had\s+served|served\s+as|removed|replac\w+|succe\w+|until\s+the\s+appointment")


def interim_of_new_role(sentence: str, name: str = "") -> bool:
    """True when 'interim' / 'acting' describes the role being given, not a role the person or someone else held before."""
    for m in _INTERIM_ROLE.finditer(sentence or ""):
        left = sentence[max(0, m.start() - 120): m.start()]
        # "appointed X, the Company's EVP and former CFO, as the Company's interim CFO": the 'as ...' right before the word is the new role even though 'former' appears earlier
        wide = sentence[max(0, m.start() - 230): m.start()]
        imm = sentence[max(0, m.start() - 40): m.start()]
        if not re.search(r"(?i)\b(?:serv(?:ed|ing|es)|was|were|had\s+been|formerly|previously)\s+as\s+(?:the\s+)?(?:Company(?:'|’)s\s+)?$", imm) and re.search(r"(?is)\b(?:appointed|named|designated|elected|promoted|selected)\b.{0,200}?\bas\s+(?:the\s+)?(?:Company(?:'|’)s\s+|our\s+)?$", wide) and not re.search(r"(?i)relinquish|resign\w*\s+(?:her|his)\s+role|step\w*\s+down\s+from", wide[-60:]):
            return True
        if _OLD_ROLE.search(left):
            continue
        # "appointed Damon Rich, the Interim CFO of the Company, as the CFO": the interim word is the old title, the new role has none
        if re.search(r"(?i),\s*(?:who\s+(?:is|was)\s+)?(?:currently\s+)?(?:serving\s+as\s+)?(?:the\s+)?(?:Company(?:'|’)s\s+)?$", left) and re.match(r"(?is)[^.]{0,80}?,\s*as\s+(?:the\s+)?(?:Company(?:'|’)s\s+)?(?!interim|acting)(?:Chief|Principal)", sentence[m.end(): m.end() + 120]):
            continue
        # an appositive about the person's current role: "Ciaran Long, the Interim Chief Executive Officer of the Company and ..., to the position of Chief Executive Officer"
        if re.search(r"(?i),\s*(?:who\s+(?:is|was)\s+)?(?:currently\s+)?(?:serving\s+as\s+)?(?:the\s+)?(?:Company(?:'|’)s\s+)?$", left) and re.search(r"(?i)\bto\s+(?:the\s+)?(?:position|role|office)\s+of\b|\bto\s+serve\s+as\s+(?!interim|acting)", sentence[m.end(): m.end() + 200]):
            continue
        return True
    return False


_STOP = {"board", "directors", "director", "company", "corporation", "inc", "chief", "executive", "officer", "officers", "president", "vice", "general", "counsel", "financial",
         "operating", "effective", "time", "the", "and", "each", "both", "appointment", "appointed", "co", "ceo", "ceos", "cfo", "messrs", "mses", "mr", "ms", "mrs", "dr",
         "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "chairman", "chair", "secretary",
         "treasurer", "principal", "interim", "acting", "new", "its", "his", "her", "their", "as", "to", "of", "in", "on", "a", "an", "current", "currently", "serve", "serving"}
_PLURAL = re.compile(r"(?i)\bco-?\s?(?:chief\s+executive|ceos?|presidents?)\b|\bMessrs?\.|\bMses\.|\beach\s+of\b|\bboth\b")
_VERB = re.compile(r"(?i)\b(?:appointment\s+of|election\s+of|appoint(?:ed|s)?|name[ds]?|elect(?:ed|s)?|designat(?:ed|es)|promot(?:ed|es)|select(?:ed|s)|determined\s+that|will\s+serve)\b")
_NAMES_FIRST = re.compile(r"(?i)\b(?:entered\s+into|agreed\s+to|will\s+serve|were\s+(?:appointed|named|elected)|have\s+been\s+(?:appointed|named))\b")
_TITLE = re.compile(r"(?i)\b(?:as\s+(?:the\s+)?(?:company(?:'|’)s\s+)?co-?\s?|to\s+serve\s+as\s+|to\s+the\s+position|will\s+serve\s+as\s+|to\s+be\s+the\s+)")
_NAME_TOKEN = re.compile(r"[A-Z][a-z]+(?:[-’'][A-Za-z]+)*|[A-Z]\.|[A-Z][A-Z]+(?=\s|,|$)")


def co_names(sentence: str) -> List[str]:
    """All people named in a plural appointment sentence, in order; [] when the sentence does not look plural."""
    if not sentence or not _PLURAL.search(sentence):
        return []
    s = re.sub(r"\([^)]{1,25}\)", " ", sentence)  # nicknames and abbreviations: (“JP”), (“Co-CEO”)
    v = _VERB.search(s)
    nf = _NAMES_FIRST.search(s)
    if nf and (not v or nf.start() < v.start() or re.search(r"(?i)Messrs?\.|Mses\.", s[:nf.start()])):
        seg = re.sub(r"(?i)^.*?(?:effective\s+time|closing|date),\s*", "", s[:nf.start()])  # "...immediately following the Effective Time, Messrs. A and B entered into ..."
    else:
        t = _TITLE.search(s, v.end() if v else 0)
        seg = s[v.end(): t.start()] if v and t else (s[v.end():] if v else s)
    seg = re.sub(r"(?i)\b(?:each\s+of|both\s+of|both)\b", " ", seg)
    out: List[str] = []
    for part in re.split(r",\s*(?:and\s+)?|\s+and\s+", seg):
        part = part.strip(" ;:.")
        toks = part.split()
        # "Andrew Main" / "Brent W. Clum" / "Mr. Vintz" / "Messrs. Erik B. Nordstrom"
        toks = [w for w in toks if w.lower().strip(".") not in ("messrs", "mses", "mr", "ms", "mrs", "dr")] if len(toks) > 1 else toks
        if not toks:
            continue
        words = [w for w in toks if _NAME_TOKEN.fullmatch(w)]
        core = [w for w in words if w.lower().strip(".") not in _STOP]
        if len(words) == len(toks) and 1 <= len(core) <= 4 and len(core) >= len(words) - 1:
            out.append(" ".join(toks))
        elif words and len(core) >= 1 and re.match(r"(?i)^(?:mr|ms|mrs|dr|messrs|mses)\.?\s", part):
            out.append(part)
    seen, res = set(), []
    for n in out:
        k = n.lower()
        if k not in seen:
            seen.add(k)
            res.append(n)
    return res if len(res) >= 2 else []


_REF = re.compile(r"(?i)incorporated\s+(?:herein\s+)?by\s+reference|set\s+forth\s+(?:in|under)\s+Item|described\s+(?:in|under)\s+Item|see\s+Item")


def referenced_items(section: str) -> List[str]:
    """Item numbers a very short Item 5.02 points to ('Item 8.01 under the caption ...')."""
    if not section or len(section) > 900 or not _REF.search(section):
        return []
    items = re.findall(r"Item\s+(\d\.\d\d)", section)
    return [i for i in dict.fromkeys(items) if i != "5.02"]


# ---- appointments the readers cannot see: rosters ("were appointed to serve in the positions indicated: • Paul A. Lang Chief Executive Officer") and "began serving as sole CEO"
_ROSTER_HEAD = re.compile(r"(?i)(?:were|was|have\s+been)\s+appointed\s+(?:to\s+serve\s+)?(?:in|as)\s+the\s+positions?\s+indicated|following\s+(?:individuals|persons|officers)[^:.]{0,140}\b(?:appointed|named|elected)\b[^:.]{0,80}:")
_ROSTER_TITLE = re.compile(r"(?i)\b(?:(?:President\s+and\s+)?Chief\s+Executive\s+Officer|Chief\s+Financial\s+Officer(?:\s+and\s+[A-Za-z ]{3,40}?)?|Co-Chief\s+Executive\s+Officer)\b")
_SOLE = re.compile(r"(?i)\b(?:Mr|Ms|Mrs|Dr)\.\s+([A-Z][\w'’\-]+)[^.]{0,80}?\b(?:began\s+serving|will\s+serve|will\s+begin\s+serving|became|has\s+become|will\s+become)\s+as\s+(?:the\s+)?(?:Company(?:'|’)s\s+)?sole\s+(?:CEO|Chief\s+Executive\s+Officer)\b")


def complete_name(surname: str, section: str) -> str:
    """'Heraud' -> 'Ben Heraud' when the section writes the full name somewhere."""
    m = re.search(rf"\b((?:[A-Z][a-z]+(?:[-’'][A-Za-z]+)*)(?:\s+[A-Z]\.)?\s+{re.escape(surname)})\b", section)
    return m.group(1) if m else surname


def rule_appointments(section: str):
    """[(role 'CEO'|'CFO', name, evidence)] for appointments written as a list of officers, or 'X began serving as the Company's sole CEO'."""
    out = []
    for h in _ROSTER_HEAD.finditer(section or ""):
        chunk = section[h.end(): h.end() + 1400]
        end = re.search(r"(?i)\beach\s+such\b|additional\s+information|\bin\s+addition\b", chunk)
        chunk = chunk[: end.start()] if end else chunk
        for row in re.split(r"[•·▪●]", chunk)[1:]:
            row = row.strip()
            t = _ROSTER_TITLE.search(row)
            if not t:
                continue
            name = row[: t.start()].strip(" ,;")
            toks = name.split()
            if 2 <= len(toks) <= 4 and all(re.fullmatch(r"[A-Z][\w.'’\-]*", w) for w in toks):
                role = "CEO" if re.search(r"(?i)executive", t.group(0)) and not re.search(r"(?i)financial", t.group(0)) else "CFO" if re.search(r"(?i)financial", t.group(0)) else None
                if role and not re.search(r"(?i)\bco-", t.group(0)):
                    out.append((role, name.replace("\n", " ").strip(), f"{name.strip()}, {t.group(0)}: {h.group(0)[:120]}"))
    for m in _SOLE.finditer(section or ""):
        start = section.rfind(".", 0, m.start()) + 1
        out.append(("CEO", complete_name(m.group(1), section), section[start: m.end()].strip()[:300]))
    return out


# ---- patterns found by reading our answers in the January-February 2025 scan
_PREVIOUSLY = re.compile(r"(?i)as\s+previously\s+(?:disclosed|announced|reported)|\bpreviously\s+(?:disclosed|announced|reported)\b")
_AFTER_APPOINTING = re.compile(r"(?i)\b(?:appointed|named|elected|promoted|designated|selected)\b")
_REPEAT = re.compile(
    r"(?i)(?:disclosure|information)\s+(?:set\s+forth\s+)?[^.]{0,80}(?:Current\s+Report|Form\s+8-K)\s+filed|"
    r"filing\s+this\s+amendment|^\s*(?:CEO\s+)?(?:Employment|Offer)\s+(?:Agreement|Letter)\b|\boffer\s+letter\s+with\b|"
    r"in\s+connection\s+with\s+(?:his|her|their|(?:Mr|Ms|Mrs|Dr)\.?\s+[\w'’\-]+['’]?s?)\s+appointment\b[^.]{0,100}(?:entered\s+into|employment\s+agreement|offer\s+letter)")
_SUB_UNIT = re.compile(r"(?i)\b(?:chief\s+executive\s+officer|CEO)\s+(?:of|at|for)\s+(?:the\s+)?(?!the\s+company\b)(?:[A-Z][\w&.’'\-]*\s+){0,5}(?:business|division|segment|unit|region|platform|bank|subsidiary|CIB)\b")
_SUCCEED = re.compile(r"((?:[A-Z][\w'’\-]+\.?\s+){1,3}[A-Z][\w'’\-]+)\s+(?:has\s+|have\s+)?succeed(?:ed|s)\s+(?:(?:Mr|Ms|Mrs|Dr)\.\s+)?((?:[A-Z][\w'’\-]+\.?\s+){1,3}[A-Z][\w'’\-]+)\s+as\b")
_DEPUTY = re.compile(r"(?i)\bdeputy\s+chief\s+financial\s+officer\b|\bassistant\s+(?:chief\s+financial|treasurer)\b")
_AS_DIRECTOR = re.compile(r"(?i)\bas\s+a\s+(?:member\s+of\s+the\s+board\s+of\s+)?director\b[^.]{0,120}\bin\s+addition\s+to\s+(?:his|her|their)\s+(?:current\s+)?(?:role|position)\b")


def repeats_earlier_announcement(sentence: str) -> bool:
    """The sentence recalls an appointment announced in an earlier filing, or gives only the pay terms of one."""
    sentence = sentence or ""
    if _REPEAT.search(sentence):
        return True
    # "As previously disclosed, the Board appointed X" recalls the appointment; "the Board appointed X ... Ms. Y's previously disclosed retirement" recalls something else
    m = _PREVIOUSLY.search(sentence)
    return bool(m and not _AFTER_APPOINTING.search(sentence[: m.start()]))


def sub_unit_title(sentence: str) -> bool:
    """CEO of a business unit, region or subsidiary ('CEO of the Intel Products business'), not of the company."""
    return bool(_SUB_UNIT.search(sentence or ""))


def successor_pair(sentence: str):
    """('Sabrina Simmons', 'Brian LaRose') from 'Sabrina Simmons succeeded Brian LaRose as the Company's CFO', else None."""
    m = _SUCCEED.search(sentence or "")
    return (m.group(1).strip(), m.group(2).strip()) if m else None


def not_a_cfo_appointment(sentence: str) -> Optional[str]:
    if _DEPUTY.search(sentence or ""):
        return "A deputy or assistant finance role, not the CFO."
    if _AS_DIRECTOR.search(sentence or ""):
        return "A board seat for the person who already is the CFO."
    return None
