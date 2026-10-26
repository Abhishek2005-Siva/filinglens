"""More detectors, each running the pipeline it was trained and evaluated with.

  cfo          Item 5.02  4 x RoBERTa-large (month-fold models), mean probability, 0.5
  acquisition  Item 2.01  RoBERTa-base per sentence (completed?) + RoBERTa-large per filing (direction)
  agreements   1.01/1.02  RoBERTa-base per sentence (entered / terminated) + RoBERTa-base type model
  equity       Item 3.02  RoBERTa-base per sentence (sale?) + RoBERTa-base security-type model
  guidance     Item 2.02  RoBERTa-large on the earnings press release (EX-99): raised / lowered / reaffirmed / withdrawn
  restructure  2.05/2.06  RoBERTa-large (seed 123) on the Item text: type of restructuring or impairment
"""
import re
import time
from typing import Dict, List, Optional

import torch

from . import agreements, rules302
from . import context as ctxmod
from .deal_text import charge_amount, deal_sentences, extract_amounts
from .families import SECTION_CAP, DistressFamily, Family, _load
from .items import find_item_section, list_headings, normalize_filing_text
from ..dates import best_name, extract as extract_dates, window as date_window
from ..appointees import interim_of_new_role, not_a_cfo_appointment, repeats_earlier_announcement, rule_appointments, successor_pair
from ..people import _APPOINT, _LEAVE, pick_name, pick_name_from_sentences
from .labelers201 import mark_self, self_aliases
from .deal_text import strip_caption

MAX_SECTION = 20000

_SUCCESSOR = re.compile(r"(?:transition\s+to|succeeded\s+by|replaced\s+by|hand(?:ing)?\s*over\s+to|will\s+be\s+succeeded\s+by)\s+(?:(?:Mr|Ms|Mrs|Dr)\.\s+)?((?:[A-Z][\w'’\-]+\.?\s+){1,2}[A-Z][\w'’\-]+)")
_REMOVED = re.compile(r"(?i)removed\s+(?:him|her|them)\s+from|\bwill\s+(?:resign|retire|step\s+down)\b|\b(?:resigned|retired|departed|stepped\s+down)\b")


def _toks(n: Optional[str]) -> set:
    return {w for w in re.sub(r"[^a-z' \-]", " ", (n or "").lower()).split() if len(w) > 1 and w not in ("mr", "ms", "mrs", "dr", "jr", "sr")}


def _same_person(a: Optional[str], b: Optional[str]) -> bool:
    ta, tb = _toks(a), _toks(b)
    return bool(ta and tb and (ta <= tb or tb <= ta))


def _softmax_probs(texts: List[str], tok, model, max_length: int, batch: int = 16) -> List[List[float]]:
    out: List[Optional[List[float]]] = [None] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for i in range(0, len(order), batch):
        idx = order[i : i + batch]
        enc = tok([texts[j] for j in idx], truncation=True, max_length=max_length, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            p = torch.softmax(model(**enc).logits.float(), dim=-1).tolist()
        for j, row in zip(idx, p):
            out[j] = row
    return out  # type: ignore[return-value]


def _money(v: float) -> str:
    return f"${v / 1e9:.2f} billion" if v >= 1e9 else f"${v / 1e6:.1f} million" if v >= 1e6 else f"${v:,.2f}" if v < 1000 else f"${v:,.0f}"


_INTRO_RE = re.compile(r"^[ \t]*(?:introductory|explanatory)\s+note", re.IGNORECASE | re.MULTILINE)


def _extract_intro(text: str) -> Optional[str]:
    m = _INTRO_RE.search(text)
    heads = list_headings(text)
    if not m or not heads or m.start() >= heads[0][0]:
        return None
    return text[m.start() : heads[0][0]].strip()[:8000] or None


# --------------------------------------------------------------------------------- CFO (5.02)
class CFO(DistressFamily):
    key, item, title = "cfo", "5.02", "CFO appointed or leaving"
    spec = [(f"cfo_{m}", 448, f"Reader {chr(65 + i)} · RoBERTa-large (fold {m[1:]})") for i, m in enumerate(["c2406", "c2506", "c2511", "c2605"])]
    models = [s[0] for s in spec]
    event_titles = {"CFO_APPOINTED": "New CFO named", "CFO_RESIGNED": "CFO leaving"}
    experimental = "Trained on four adjudicated months; scored month by month (each model tested on a month it never saw)."

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        section = find_item_section(plain, self.item)
        if section is None:
            return self.not_applicable()
        if not re.search(ctxmod.CFO_TITLE_PATTERN, section, re.I):
            res = self.not_applicable()
            res.update({"applicable": True, "note": "This leadership section never mentions a CFO, so no CFO change is possible."})
            return res
        res = super().run(plain, tables, filing_date, **ctx)
        if not res.get("found"):
            return res
        all_sents = ctxmod._sentences(section, "5.02")
        cfo_sents = [x for x in all_sents if re.search(ctxmod.CFO_TITLE_PATTERN, x, re.I)]
        fields = res.get("fields") or {}
        for ev in res["events"]:
            kind = "appointed" if ev["label"] == "CFO_APPOINTED" else "resigned"
            verb = _APPOINT if kind == "appointed" else _LEAVE
            evidence = ev.get("evidence")
            if not evidence:  # the rule layer found no sentence: take the CFO sentence that talks about this kind of change
                evidence = next((x for x in cfo_sents if verb.search(x)), cfo_sents[0] if cfo_sents else None)
                ev["evidence"] = evidence
            name = fields.get(f"{kind}_name") or (pick_name(evidence, kind, section) if evidence else None) or pick_name_from_sentences(cfo_sents, kind, section)
            interim = interim_of_new_role(evidence or "", name or "") if kind == "appointed" else bool(fields.get(f"{kind}_interim"))
            idx = all_sents.index(evidence) if evidence in all_sents else None
            when = extract_dates(evidence, name, [s for s in all_sents[max(0, (idx or 0) - 2):(idx or 0) + 3] if s != evidence] if idx is not None else all_sents[:6], role="CFO", kind=kind, context=date_window(all_sents, idx))
            name = best_name(when.get("name"), name, section) or name  # the trained tagger's name beats the patterns (97% vs 84% held-out)
            ev.update({
                "kind": kind, "name": name, "interim": interim, "effective": when["effective"], "effectiveNote": when["effectiveNote"], "decided": when["decided"],
                "title": ("New interim CFO named" if interim else "New CFO named") if kind == "appointed" else ("Interim CFO leaving" if interim else "CFO leaving"),
            })
        # The appointee can be the wrong person: the sentence that announces a departure also names the successor in a later clause
        # ("... a smooth transition to Casey Mueller, who will serve as interim CFO"), or the first CFO sentence is about a CEO promotion that
        # removes the person from the CFO job. Look for the successor / a different appointment sentence before accepting the name.
        leaving = next((e.get("name") for e in res["events"] if e.get("kind") == "resigned"), None)
        for ev in res["events"]:
            if ev.get("kind") != "appointed":
                continue
            ev_text = ev.get("evidence") or ""
            if not ((leaving and _same_person(ev.get("name"), leaving)) or re.search(r"(?i)removed\s+(?:him|her|them)\s+from", ev_text)):
                continue
            swap = None
            for x in cfo_sents:  # 1) a successor named inside a departure sentence
                m = _SUCCESSOR.search(x)
                if m and not _same_person(m.group(1), leaving) and not _same_person(m.group(1), ev.get("name")):
                    swap = (x, m.group(1))
                    break
            if swap is None:  # 2) another sentence that appoints somebody else as CFO
                for x in cfo_sents:
                    if x == ev_text or _REMOVED.search(x) or not _APPOINT.search(x):
                        continue
                    nm = pick_name(x, "appointed", section)
                    if nm and not _same_person(nm, leaving) and not _same_person(nm, ev.get("name")):
                        swap = (x, nm)
                        break
            if swap:
                x, nm = swap
                i2 = all_sents.index(x) if x in all_sents else None
                w2 = extract_dates(x, nm, [t for t in all_sents[max(0, (i2 or 0) - 2):(i2 or 0) + 3] if t != x] if i2 is not None else all_sents[:6], role="CFO", kind="appointed", context=date_window(all_sents, i2))
                nm = best_name(w2.get("name"), nm, section) or nm
                itm = interim_of_new_role(x, nm)
                ev.update({"evidence": x, "name": nm, "interim": itm, "effective": w2["effective"], "effectiveNote": w2["effectiveNote"], "decided": w2["decided"],
                           "title": "New interim CFO named" if itm else "New CFO named"})
        for ev in res["events"]:
            if ev.get("kind") != "appointed":
                continue
            ev_text = ev.get("evidence") or ""
            sp = successor_pair(ev_text)
            if sp and ev.get("name") and _same_person(ev["name"], sp[1]):
                ev["name"] = sp[0]  # "X succeeded Y as CFO": the new CFO is X
            why = not_a_cfo_appointment(ev_text)
            if why:
                ev["flag"], ev["detail"] = "likely_wrong", why
            elif repeats_earlier_announcement(ev_text):
                ev["flag"], ev["detail"] = "review", "Repeats an appointment announced in an earlier filing, or gives only its pay terms."
        if not any(e.get("kind") == "appointed" for e in res["events"]):
            ra = [r for r in rule_appointments(section) if r[0] == "CFO"]
            if ra:
                _r, nm, ev_text = ra[0]
                res["events"].append({"label": "CFO_APPOINTED", "title": "New CFO named", "confidence": None, "evidence": ev_text, "kind": "appointed", "name": nm, "interim": False,
                                      "effective": None, "effectiveNote": None, "decided": None, "readers": [], "fromRule": True})
        res["fields"] = {}  # names, dates and the interim flag now live on each event
        return res


# --------------------------------------------------------------------------------- 2.01
_SUB_OF_FILER = re.compile(r"(?i)\b(?:became|become|becomes|shall\s+become|will\s+become|is\s+now|are\s+now|now)\s+an?\s+(?:direct\s+or\s+indirect\s+)?(?:indirect\s+)?(?:wholly[- ]owned|majority[- ]owned)\s+(?:direct\s+)?subsidiar(?:y|ies)\s+of\s+FILER\b")
_FILER_BECAME = re.compile(r"\bFILER\b[^.]{0,120}?\b(?:became|become|becomes|shall\s+become|will\s+become|is\s+now|survived\s+as|continued\s+as)\s+an?\s+(?:direct\s+or\s+indirect\s+)?(?:indirect\s+)?(?:wholly[- ]owned)\s+(?:direct\s+)?subsidiar(?:y|ies)\s+of\b")
_FILER_SOLD = re.compile(r"\bFILER\b[^.]{0,60}?\b(?:completed|consummated|closed)\s+(?:its\s+|the\s+)?(?:previously\s+announced\s+)?(?:sale|disposition|divestiture)\s+of\b|"
                         r"\bFILER\b[^.]{0,40}(?<!issued and )(?<!and )\bsold\s+(?:all|substantially\s+all|its|the)\s+(?:of\s+)?(?:the\s+|its\s+)?(?:issued\s+and\s+outstanding\s+)?(?:business|subsidiar|stock|shares\s+of|assets|equity|membership|interest|property|properties)")


def direction_from_wording(marked_text: str):
    """ACQUISITION / ACQUIRED / DISPOSITION when the text says in so many words who became whose subsidiary ('Target became a wholly owned subsidiary of FILER')
    or that the filer sold a business or assets; None when it does not. Checked on 1,855 training filings (consensus of two labelers: right 218 of 228
    that fired) and 110 hand-labelled test filings (19 of 19)."""
    for m in _SUB_OF_FILER.finditer(marked_text):
        if not re.search(r"FILER[^.]{0,25}$", marked_text[max(0, m.start() - 40):m.start()]):  # not 'FILER became a subsidiary of FILER' (namesake merger)
            return "ACQUISITION"
    if _FILER_BECAME.search(marked_text):
        return "ACQUIRED"
    if _FILER_SOLD.search(marked_text):
        return "DISPOSITION"
    return None


class Acquisition(Family):
    key, item, title = "acquisition", "2.01", "Acquisition or sale of assets completed"
    models = ["acq_sent", "acq_doc"]
    ACQ_TITLES = {
        "ACQUISITION": "The company completed an acquisition",
        "DISPOSITION": "The company completed a sale or disposal of assets",
        "ACQUIRED": "The company was acquired (merger or buyout closed)",
        "UNCLEAR": "A transaction was completed (direction not clear from the text)",
    }
    experimental = "Spotting a completed deal is strong (F1 0.95); working out who bought whom is about 90% accurate."

    def _load_models(self) -> None:
        self._sent = _load("acq_sent", 5)
        self._doc = _load("acq_doc", 4)

    def test_models(self) -> list:
        return [("Sentence reader · RoBERTa-base", *self._sent[:2], 5), ("Direction reader · RoBERTa-large", *self._doc[:2], 4)]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        sec = find_item_section(text, "2.01")
        if sec is None:
            return self.not_applicable()
        self.ensure_loaded()
        sec = sec[:MAX_SECTION]
        intro = _extract_intro(text)
        sec101 = find_item_section(text, "1.01")
        company = ctx.get("company", "")
        blob = sec + " " + (intro or "")
        aliases = self_aliases(company, blob)
        sents, seen = [], set()
        for txt in (sec, intro or ""):
            for s in deal_sentences(txt, "2.01") if txt else []:
                if s not in seen:
                    seen.add(s)
                    sents.append(s)
        prepped = [mark_self(s, aliases) for s in sents]
        labels = ["NONE", "ACQUISITION", "DISPOSITION", "ACQUIRED", "COMPLETED"]
        tok, model, _ = self._sent
        probs = _softmax_probs(prepped, tok, model, 256) if prepped else []
        positives = []
        for s, p in zip(sents, probs):
            k = max(range(5), key=p.__getitem__)
            if labels[k] != "NONE" and p[k] >= 0.5:
                positives.append((p[k], s, labels[k]))
        from_item = False
        if not positives and sents:
            # a filing that declares Item 2.01 reports a completed acquisition or sale: when no sentence clears the bar, show the sentence the reader found most deal-like
            from_item = True
            k_best = max(range(len(sents)), key=lambda i: 1 - probs[i][0])
            positives.append((1 - probs[k_best][0], sents[k_best], "COMPLETED"))
        completed = bool(positives)
        res = {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
               "found": completed, "events": [], "readerNames": ["Sentence reader · RoBERTa-base", "Direction reader · RoBERTa-large"]}
        if completed:
            parts = []
            if intro:
                parts.append(" ".join(intro.split())[:500])
            body = strip_caption(sec, "2.01")
            parts.append(" ".join(body.split())[:1100])
            if len(body) < 500 and sec101:
                parts.append(" ".join(strip_caption(sec101[:MAX_SECTION], "1.01").split())[:600])
            doc = "Filer: " + company + " || " + mark_self(" || ".join(parts), aliases)
            dtok, dmodel, _ = self._doc
            dp = _softmax_probs([doc], dtok, dmodel, 384)[0]
            dl = ["ACQUISITION", "DISPOSITION", "ACQUIRED", "UNCLEAR"]
            dk = max(range(4), key=dp.__getitem__)
            wide = " || ".join(x for x in (" ".join(intro.split())[:1500] if intro else "", " ".join(body.split())[:3000], " ".join(strip_caption(sec101[:MAX_SECTION], "1.01").split())[:1500] if sec101 else "") if x)
            said = direction_from_wording(mark_self(wide, aliases))
            by_rule = bool(said and said != dl[dk])
            if said:
                dk = dl.index(said)
            best = max(positives)
            amounts = extract_amounts(sec)
            per_share = [] if amounts else extract_amounts(sec, per_unit=True)
            res["events"].append({
                "label": dl[dk], "title": self.ACQ_TITLES[dl[dk]], "confidence": round(dp[dk], 4),
                "evidence": best[1], "detail": f"Largest amount mentioned: {_money(max(amounts))}" if amounts else (f"Price per share mentioned: {_money(max(per_share))}" if per_share else ""),
                **({"fromItem": True} if from_item else {}),
                **({"source": "wording rule (the text says who became whose subsidiary, or that the filer sold)"} if by_rule else {}),
                "readers": [{"reader": "Direction reader · RoBERTa-large", "probability": round(dp[dk], 4)},
                            {"reader": "Sentence reader · RoBERTa-base (deal completed)", "probability": round(best[0], 4)}],
            })
            res["probabilities"] = {l: round(v, 4) for l, v in zip(dl, dp)}
        res["seconds"] = round(time.time() - t0, 2)
        return res


# --------------------------------------------------------------------------------- 1.01 / 1.02
class Agreements(Family):
    key, item, title = "agreements", "1.01 / 1.02", "Material agreement entered or ended"
    items = ["1.01", "1.02"]
    models = ["agree_events", "agree_types"]
    experimental = "Spotting entered/terminated agreements is strong (F1 0.94 / 0.88); the agreement type is no better than simple rules (F1 0.75)."
    TYPE_NAMES = {"MNA": "merger or acquisition", "DEBT": "debt or credit", "EQUITY": "equity or securities", "COMMERCIAL": "commercial or supply", "GOVERNANCE": "governance or employment"}

    def _load_models(self) -> None:
        self._ev = _load("agree_events", 3)
        self._ty = _load("agree_types", 5)

    def test_models(self) -> list:
        return [("Event reader · RoBERTa-base", *self._ev[:2], 3), ("Type reader · RoBERTa-base", *self._ty[:2], 5)]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        secs = {it: find_item_section(text, it) for it in ("1.01", "1.02")}
        if not any(secs.values()):
            return self.not_applicable()
        self.ensure_loaded()
        rows = []  # (item, sentence)
        for it, sec in secs.items():
            if sec:
                rows += [(it, s) for s in deal_sentences(sec[:MAX_SECTION], it)]
        etok, emodel, _ = self._ev
        probs = _softmax_probs([s for _, s in rows], etok, emodel, 256) if rows else []
        el = ["NONE", "ENTERED", "TERMINATED"]
        cand: Dict[str, list] = {"ENTERED": [], "TERMINATED": []}
        for (it, s), p in zip(rows, probs):
            k = max(range(3), key=p.__getitem__)
            if el[k] != "NONE" and p[k] >= 0.5:
                cand[el[k]].append((p[k], s, it))
        ttok, tmodel, _ = self._ty
        events = []
        for ev, title in (("ENTERED", "Material agreement entered"), ("TERMINATED", "Material agreement terminated")):
            if not cand[ev]:
                continue
            conf, sent, it = max(cand[ev])  # 'top1' policy: the most confident sentence stands for the filing
            tp = _softmax_probs([sent], ttok, tmodel, 256)[0]
            tl = ["MNA", "DEBT", "EQUITY", "COMMERCIAL", "GOVERNANCE"]
            tk = max(range(5), key=tp.__getitem__)
            amounts = extract_amounts(sent)
            party = agreements.extract_counterparty(sent)
            bits = [f"Type: {self.TYPE_NAMES[tl[tk]]}"]
            if party:
                bits.append(f"Counterparty: {party}")
            if amounts:
                bits.append(f"Amount: {_money(max(amounts))}")
            events.append({
                "label": ev, "title": f"{title} (Item {it})", "confidence": round(conf, 4), "evidence": sent, "detail": " · ".join(bits),
                "readers": [{"reader": "Event reader · RoBERTa-base", "probability": round(conf, 4)}, {"reader": f"Type reader · RoBERTa-base ({tl[tk].lower()})", "probability": round(tp[tk], 4)}],
            })
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": bool(events), "events": events, "readerNames": ["RoBERTa-base event reader", "RoBERTa-base type reader"],
                "seconds": round(time.time() - t0, 2)}


# --------------------------------------------------------------------------------- 3.02
class Equity(Family):
    key, item, title = "equity", "3.02", "Unregistered sale of equity securities"
    models = ["equity_events", "equity_types"]
    experimental = "Early model: trained on rule-made labels, so its scores look high but have not been checked against independent answers."
    TYPE_NAMES = {"COMMON": "common stock", "PREFERRED": "preferred stock", "CONVERTIBLE_DEBT": "convertible notes", "WARRANT": "warrants", "UNITS": "units", "EQUITY_AWARD": "equity award"}

    def _load_models(self) -> None:
        self._ev = _load("equity_events", 2)
        self._ty = _load("equity_types", 6)

    def test_models(self) -> list:
        return [("Sale reader · RoBERTa-base", *self._ev[:2], 2), ("Type reader · RoBERTa-base", *self._ty[:2], 6)]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        sec = find_item_section(text, "3.02")
        if sec is None:
            return self.not_applicable()
        self.ensure_loaded()
        sec = sec[:MAX_SECTION]
        sents = deal_sentences(sec, "3.02")
        etok, emodel, _ = self._ev
        probs = _softmax_probs(sents, etok, emodel, 256) if sents else []
        sales = [(p[1], s) for s, p in zip(sents, probs) if p[1] >= 0.5]
        events = []
        if sales:
            ttok, tmodel, _ = self._ty
            tl = ["COMMON", "PREFERRED", "CONVERTIBLE_DEBT", "WARRANT", "UNITS", "EQUITY_AWARD"]
            tp_all = _softmax_probs([s for _, s in sales], ttok, tmodel, 256)
            types: List[str] = []
            for (_, s), tp in zip(sales, tp_all):
                t = tl[max(range(6), key=tp.__getitem__)]
                if t not in types:
                    types.append(t)
            conf, sent = max(sales)
            nums = rules302.extract_numbers(sec)
            ex = rules302.extract_exemptions(sec)
            bits = ["Security: " + ", ".join(self.TYPE_NAMES[t] for t in types)]
            if nums.get("gross_proceeds_usd"):
                bits.append(f"Proceeds: {_money(nums['gross_proceeds_usd'])}")
            if nums.get("price_per_share_usd"):
                bits.append(f"Price per share: ${nums['price_per_share_usd']:g}")
            if ex:
                bits.append("Exemption: " + ", ".join(ex))
            events.append({"label": "SALE", "title": "Unregistered equity securities sold", "confidence": round(conf, 4), "evidence": sent,
                           "detail": " · ".join(bits), "readers": [{"reader": "Sale reader · RoBERTa-base", "probability": round(conf, 4)}]})
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": bool(events), "events": events, "readerNames": ["RoBERTa-base sale reader", "RoBERTa-base type reader"],
                "seconds": round(time.time() - t0, 2)}


# --------------------------------------------------------------------------------- 2.02
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])|\s*[•|]\s*")  # also break at bullets and table bars, which headlines use instead of full stops
_GUIDE_KW = re.compile(r"\b(guidance|outlook)\b", re.IGNORECASE)
_DIRECTION = re.compile(r"(?i)\b(rais\w*|increas\w*|lower\w*|reduc\w*|cut|reiterat\w*|reaffirm\w*|maintain\w*|withdr\w+|suspend\w*|updat\w*|narrow\w*|expect\w*)\b")


def _clip(sentence: str, width: int = 360) -> str:
    """A very long run of text is trimmed to the stretch around the guidance wording."""
    if len(sentence) <= width:
        return sentence
    m = _GUIDE_KW.search(sentence)
    mid = m.start() if m else 0
    lo = max(0, mid - width // 2)
    return ("… " if lo else "") + sentence[lo:lo + width].strip() + " …"


def _guidance_sentences(text: str, context: int = 0) -> List[str]:
    sents = [x for x in _SENT_SPLIT.split(re.sub(r"\s+", " ", text).strip()) if x]
    hits = [i for i, s in enumerate(sents) if _GUIDE_KW.search(s)]
    hits.sort(key=lambda i: (not _DIRECTION.search(sents[i]), i))  # the lines that say which way it moved come first
    win = []
    for h in hits:
        for i in range(max(0, h - context), min(len(sents), h + context + 1)):
            if i not in win:
                win.append(i)
    return [_clip(sents[i]) for i in win]


_G_NOUN = r"(?:guidance|outlook|forecast|expectations)"
_G_VERBS = [
    ("WITHDRAWN", r"withdr(?:aw|ew|awing|awn|aws)|suspend(?:s|ed|ing)?|no\s+longer\s+(?:provid\w+|expect\w*)"),
    ("REAFFIRMED", r"reaffirm\w*|reiterat\w*|maintain\w*|confirm(?:s|ed|ing)?"),
    ("LOWERED", r"lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|cut(?:s|ting)?|trim\w*|decreas(?:e|es|ed|ing)"),
    ("RAISED", r"rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|boost\w*|hik(?:e|es|ed|ing)|improv(?:e|es|ed|ing)"),
]
_G_HEDGE = re.compile(r"(?i)\b(?:may|might|could|would|should|if|unless|whether|no\s+assurance|cannot|can\s?not|not\s+(?:provide|update|intend|undertake)|do(?:es)?\s+not|undertake\w*|obligation|forward-looking)\b")


def stated_guidance_move(text: str):
    """(label, sentence) when the release itself says it raised, lowered, reaffirmed or withdrew its guidance ('raising our 2025 Adjusted EBITDA guidance'),
    else None. Hedged sentences ('may raise', 'we do not undertake to update') and forward-looking boilerplate do not count."""
    sents = [x for x in _SENT_SPLIT.split(re.sub(r"\s+", " ", text).strip()) if x]
    for label, verbs in _G_VERBS:
        for sent in sents:
            if _G_HEDGE.search(sent) or not re.search(_G_NOUN, sent, re.I):
                continue
            if re.search(rf"(?i)\b(?:{verbs})\b\s+(?:(?:also|further|again|its|our|the|full[- ]year|fiscal(?:\s+year)?|annual|\d{{4}})\s+){{1,4}}(?:[\w$%.\-]+\s+){{0,5}}?{_G_NOUN}|{_G_NOUN}[^.;]{{0,40}}\b(?:was|were|is|are|has\s+been|have\s+been)\s+(?:{verbs})", sent):
                return label, _clip(sent)
    return None


class Guidance(Family):
    key, item, title = "guidance", "2.02", "Earnings guidance direction"
    models = ["guidance"]
    experimental = "Experimental: macro-F1 0.77 on its held-out set; it reads the first part of the earnings press release."
    TITLES = {"RAISED": "Company raised its guidance", "LOWERED": "Company lowered its guidance", "REAFFIRMED": "Company reaffirmed its guidance", "WITHDRAWN": "Company withdrew its guidance"}

    def present(self, plain: str, tables: str) -> bool:
        return find_item_section(plain, "2.02") is not None

    def test_models(self) -> list:
        return [("Guidance reader · RoBERTa-large", *self._m[:2], 5)]

    def _load_models(self) -> None:
        self._m = _load("guidance", 5)

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        if find_item_section(plain, "2.02") is None:
            return self.not_applicable()
        pr = ctx.get("exhibit")
        base = {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental, "found": False, "events": []}
        if not pr:
            return {**base, "note": "This filing has no earnings press release attached (no EX-99 exhibit), so there is nothing to read."}
        self.ensure_loaded()
        tok, model, _ = self._m
        text = pr[:6000]
        p = _softmax_probs([text], tok, model, 400)[0]
        labels = ["NONE", "RAISED", "LOWERED", "REAFFIRMED", "WITHDRAWN"]
        k = max(range(5), key=p.__getitem__)
        events = []
        said = stated_guidance_move(pr) if labels[k] == "NONE" else None
        if said:
            # the reader saw only the first 6,000 characters in a way that missed it: the release says in so many words what it did to its guidance
            events.append({"label": said[0], "title": self.TITLES[said[0]], "confidence": None, "evidence": said[1], "source": "the press release's own words",
                           "readers": [{"reader": "Wording rule", "probability": None}]})
        if labels[k] != "NONE":
            cands = _guidance_sentences(pr)
            events.append({"label": labels[k], "title": self.TITLES[labels[k]], "confidence": round(p[k], 4),
                           "evidence": " … ".join(cands[:2])[:700] if cands else None,
                           "readers": [{"reader": "Guidance reader · RoBERTa-large", "probability": round(p[k], 4)}]})
        return {**base, "found": bool(events), "events": events, "probabilities": {l: round(v, 4) for l, v in zip(labels, p)},
                "readerNames": ["RoBERTa-large press-release reader"], "seconds": round(time.time() - t0, 2)}


# --------------------------------------------------------------------------------- 2.05 / 2.06
class Restructuring(Family):
    key, item, title = "restructuring", "2.05 / 2.06", "Restructuring, exit costs or impairment"
    items = ["2.05", "2.06"]
    models = ["restructuring"]
    experimental = "Trained on 1,213 filings with a random split (macro-F1 0.86, accuracy 95% on held-out filings)."
    TITLES = {
        "WORKFORCE_REDUCTION": "Workforce reduction", "FACILITY_CLOSURE": "Facility closure", "DIVESTITURE": "Divestiture",
        "DISCONTINUED_PRODUCT": "Discontinued product or line", "IMPAIRMENT_ONLY": "Asset impairment charge", "OTHER": "Other exit or impairment activity",
    }

    def _load_models(self) -> None:
        self._m = _load("restructuring", 6)

    def test_models(self) -> list:
        return [("Type reader · RoBERTa-large", *self._m[:2], 6)]

    def run(self, plain: str, tables: str, filing_date: str, **ctx) -> dict:
        t0 = time.time()
        text = normalize_filing_text(plain)
        secs = {it: find_item_section(text, it) for it in ("2.05", "2.06")}
        if not any(secs.values()):
            return self.not_applicable()
        self.ensure_loaded()
        tok, model, _ = self._m
        labels = ["WORKFORCE_REDUCTION", "FACILITY_CLOSURE", "DIVESTITURE", "DISCONTINUED_PRODUCT", "IMPAIRMENT_ONLY", "OTHER"]
        events = []
        also_206 = False
        for it, sec in secs.items():
            if not sec:
                continue
            body = sec[:6000]
            if re.search(r"(?i)^\W*item\s*2\.0[56]\W+(?:departure\s+of\s+directors|submission\s+of\s+matters|entry\s+into|changes\s+in\s+registrant|regulation\s+fd)", body[:160]):
                continue  # a mistyped Item number (Vuzix: 'Item 2.06 Departure of Directors ...'): the text is about something else
            if it == "2.06" and secs.get("2.05") and len(body) < 400 and re.search(r"(?i)incorporated|set\s+forth|contained|described", body):
                also_206 = True  # 'The information in Item 2.05 is incorporated into this Item 2.06': the same event, not a second one
                continue
            p = _softmax_probs([body], tok, model, 512)[0]
            k = max(range(6), key=p.__getitem__)
            if labels[k] == "DIVESTITURE" and re.search(r"(?i)\b(?:wind\s*(?:ing)?\s*down|cessation|discontinu\w+|ceas(?:e|ing))\b", body) and \
                    not re.search(r"(?i)\b(?:sell|sold|sale|divest\w*|purchaser|buyer|acquirer)\b|dispos\w+\s+of\s+(?:the\s+|its\s+)?(?:business|segment|subsidiary|division)", body):
                k = labels.index("DISCONTINUED_PRODUCT")  # closing a business is not selling it
            amount = charge_amount(body)
            plain_body = re.sub(r"^\s*item\s*2\.0[56][^\n]*\n", "", body, flags=re.IGNORECASE)
            sents = [s for s in re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", plain_body)) if len(s) > 30]
            events.append({
                "label": labels[k], "title": f"{self.TITLES[labels[k]]} (Item {it})", "confidence": round(p[k], 4),
                "evidence": " ".join(sents[:2])[:600] if sents else None,
                "detail": f"Charge mentioned: {_money(amount)}" if amount else "",
                "readers": [{"reader": "Type reader · RoBERTa-large", "probability": round(p[k], 4)}],
            })
        if also_206 and events:
            events[0]["title"] = events[0]["title"].replace("(Item 2.05)", "(Items 2.05 and 2.06)")
        return {"key": self.key, "item": self.item, "title": self.title, "applicable": True, "experimental": self.experimental,
                "found": bool(events), "events": events, "readerNames": ["RoBERTa-large type reader"], "seconds": round(time.time() - t0, 2)}
