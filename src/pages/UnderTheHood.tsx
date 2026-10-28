import type { ReactNode } from 'react'
import BarChart from '../components/BarChart'
import { detectors } from '../data/detectors'

// ------------------------------------------------------------------ small building blocks

// A box in a drawing: an icon, a short title and one line under it.
function Node({ icon, title, sub, tone = 'blue' }: { icon: string; title: string; sub?: string; tone?: string }) {
  return (
    <div className={`anode tone-${tone}`}>
      <span className="aicon" aria-hidden="true">{icon}</span>
      <b>{title}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}

const Arrow = ({ label, down }: { label?: string; down?: boolean }) => (
  <div className={`aarrow ${down ? 'down' : ''}`} aria-hidden="true">
    <span>{label}</span>
    <i />
  </div>
)

type Box = [icon: string, title: string, sub: string, tone?: string]

/** A left-to-right chain of boxes. */
function Flow({ boxes, label }: { boxes: Box[]; label: string }) {
  return (
    <ol className="aloop small flow" aria-label={label}>
      {boxes.map(([icon, title, sub, tone], i) => (
        <li key={title}>
          <Node icon={icon} title={title} sub={sub} tone={tone ?? 'blue'} />
          {i < boxes.length - 1 && <Arrow />}
        </li>
      ))}
    </ol>
  )
}

/** Numbered steps, each with a short title and what happens in it. */
function Steps({ items }: { items: [string, string][] }) {
  return (
    <ol className="stepsl">
      {items.map(([t, d]) => (
        <li key={t}><b>{t}</b><span>{d}</span></li>
      ))}
    </ol>
  )
}

function Table({ title, intro, cols, rows, foot }: { title: string; intro?: string; cols: string[]; rows: string[][]; foot?: string }) {
  return (
    <div className="card table-card">
      <h3>{title}</h3>
      {intro && <p className="muted small">{intro}</p>}
      <div className="table-wrap" tabIndex={0} role="region" aria-label={title}>
        <table className="data">
          <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} className={c.length > 60 ? 'long' : undefined}>{c}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {foot && <p className="muted small foot">{foot}</p>}
    </div>
  )
}

function Part({ id, title, summary, children }: { id: string; title: string; summary: string; children: ReactNode }) {
  return (
    <section id={id} className="note-group uth-part" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="muted">{summary}</p>
      {children}
    </section>
  )
}

// A row of dots: green = right, red = false alarm, hollow = missed.
function DotRow({ right, wrong = 0, missed = 0, label }: { right: number; wrong?: number; missed?: number; label: string }) {
  return (
    <div className="dotrow" role="img" aria-label={label}>
      {Array.from({ length: right }, (_, i) => <i key={`r${i}`} className="dot ok" />)}
      {Array.from({ length: wrong }, (_, i) => <i key={`w${i}`} className="dot bad" />)}
      {Array.from({ length: missed }, (_, i) => <i key={`m${i}`} className="dot miss" />)}
    </div>
  )
}

// ------------------------------------------------------------------ data for the evidence part

// Months we collected filings for: trained on, kept back for testing, or not used.
const HELD_OUT = ['2024-06', '2025-06', '2025-11', '2026-05']
const TRAINED = new Set([
  '2023-01', '2023-03', '2023-07', '2023-09', '2023-11', '2023-12',
  ...Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`),
  '2026-01', '2026-02', '2026-04', '2026-06', '2026-07', '2026-08',
])
HELD_OUT.forEach((m) => TRAINED.delete(m))
const MONTHS: string[] = []
for (let y = 2023; y <= 2026; y++) for (let m = 1; m <= 12; m++) if (y < 2026 || m <= 9) MONTHS.push(`${y}-${String(m).padStart(2, '0')}`)

const checkerGain = [
  { label: 'Without the checker', sub: 'answers that were right', value: 0.856 },
  { label: 'With the checker', sub: 'accepted answers that were right', value: 0.944, highlight: true },
]

const journey = [
  { label: 'First model', sub: 'DistilBERT', value: 0.8126 },
  { label: 'Bigger model', sub: 'RoBERTa-base', value: 0.8207 },
  { label: '3 models vote', sub: 'RoBERTa-base ×3', value: 0.839 },
  { label: 'Large models', sub: 'RoBERTa-large ×3', value: 0.8537 },
  { label: 'Mixed team', sub: 'RoBERTa ×2 + DeBERTa', value: 0.8673, highlight: true },
]

const reading = [
  { label: 'Names', sub: 'old pattern rules', value: 0.835 },
  { label: 'Names', sub: 'trained model', value: 0.974, highlight: true },
  { label: 'Effective date', sub: 'trained model', value: 0.879 },
  { label: 'Decided date', sub: 'trained model', value: 0.912 },
]

const TOC: [string, string][] = [
  ['parts', 'The parts'],
  ['find', '1 · Finding filings'],
  ['download', '2 · Downloading a filing'],
  ['items', '3 · Cutting out the Items'],
  ['input', '4 · What a model is shown'],
  ['run', '5 · Running the detectors'],
  ['ceo', '6 · A CEO answer, step by step'],
  ['others', '7 · The other detectors'],
  ['single', '8 · One filing, live'],
  ['batch', '9 · Many filings in the background'],
  ['server', '10 · The AI server’s life'],
  ['store', '11 · What is stored, and where'],
  ['sheet', '12 · The sheet and downloads'],
  ['mcap', '13 · Market value'],
  ['site', '14 · Sign-in and location'],
  ['evidence', 'How it was built and scored'],
]

export default function UnderTheHood() {
  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Under the hood</span>
        <h1>How FilingLens works, step by step</h1>
        <p className="lead">Every stage a filing goes through, from the search box to a cell in the spreadsheet: what is downloaded, what is cut out, which model reads it, what is kept and where. Each line below was taken from the code that runs the site.</p>
      </section>

      <div className="notes-layout">
        <nav className="toc" aria-label="Sections">
          <ul>
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href="#/build" onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }) }}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="notes-body">
          {/* ------------------------------------------------------------------------- parts */}
          <Part id="parts" title="The parts" summary="Six pieces. The browser only ever talks to the website’s own functions; those talk to everything else.">
            <Table
              title="What each part is and does"
              cols={['Part', 'Where it runs', 'What it does', 'Talks to']}
              rows={[
                ['Web pages', 'Your browser (one React page, routes after the # sign)', 'Search form, analysis pages, filing page, spreadsheet, notes. Draws what the functions return.', 'Only the website’s own functions'],
                ['Website functions', 'Vercel serverless functions (12: login, presence, companies, filings, search, analyze, batch, host, marketcap, yahoo, prices, manual)', 'Check the sign-in, ask the SEC for lists, pass work to the AI server (adding the secret key), keep results and prices, start and stop the AI server.', 'SEC, AI server, Kaggle, Yahoo, private storage'],
                ['Private storage', 'Vercel Blob (private files, no public links)', 'Keeps finished analyses, the AI server’s current address, stored Yahoo prices, typed-in market values and the list of visitors.', 'Written and read by the functions'],
                ['AI server', 'A private Kaggle notebook with a GPU, running a Python (FastAPI) service', 'Downloads each filing from the SEC, cuts it into Items, runs the detectors, runs background analyses and reports back.', 'SEC, the website’s functions'],
                ['SEC EDGAR', 'sec.gov and data.sec.gov', 'The only source of filings. Nothing is copied into a local filing database.', '—'],
                ['Yahoo Finance', 'Read by a headless browser inside one function', 'Closing prices and today’s market cap.', '—'],
              ]}
              foot="The AI server is not always on: it starts when someone presses “Turn on AI model” and turns itself off after 7 idle minutes (section 10). Searching, the company list and market values need no AI server."
            />
          </Part>

          {/* ------------------------------------------------------------------------- 1 find */}
          <Part id="find" title="1 · Finding filings" summary="Lists only. No filing text is read in this stage.">
            <Flow label="Finding filings" boxes={[
              ['⌨', 'Your search', 'words, form, dates, company, event type', 'blue'],
              ['⚡', 'Website function', '/api/search or /api/filings', 'blue'],
              ['🏛', 'SEC EDGAR', 'full-text search or the company’s list', 'amber'],
              ['📋', 'List of filings', 'one row each, newest first', 'green'],
            ]} />
            <Steps items={[
              ['Keyword, form and date search', 'The Search page calls /api/search, which forwards the request to EDGAR’s full-text search (efts.sec.gov/LATEST/search-index) with the words, the form types (8-K by default), a custom date range and, if chosen, a company number (CIK). EDGAR answers a page at a time; the site asks for the next page by passing an offset.'],
              ['Event-type filter', 'Choosing an event type adds the phrase “Item 5.02” (or 1.03, 2.01 …) to the EDGAR search. That phrase also matches cross-references and boilerplate in unrelated filings, so the function then keeps only filings whose EDGAR record lists that Item as declared.'],
              ['Company search', 'The company box calls /api/companies. The SEC’s company_tickers.json is read once per function instance and held in memory. Matches are ranked: exact ticker or CIK first, then ticker prefix, name prefix, name contains; the top 8 are shown.'],
              ['One company’s filings', '/api/filings reads data.sec.gov/submissions/CIK##########.json (the company’s recent-filings list) and filters it by form, dates and Item. That list already holds each filing’s declared Items, primary document and company location.'],
              ['Clean-up', 'Each row keeps: accession number, CIK, company, ticker, date, form, declared Items, location, description and two links. Duplicates are removed by accession number and rows are sorted newest first. Answers are cached privately in the browser for 5 minutes.'],
              ['Large background searches', 'For an analysis the AI server asks the same two functions. EDGAR will not page past 10,000 hits for one query, so a bigger range is split in half again and again until every window fits; with no dates it covers 2001 to today. It pauses 0.15 s between pages. One company with no keywords is fetched as its whole list in one call.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 2 download */}
          <Part id="download" title="2 · Downloading a filing" summary="Done by the AI server. The whole filing is downloaded, one filing per request. Nothing is saved from it except the answers.">
            <Flow label="Downloading a filing" boxes={[
              ['🏛', 'SEC archive', 'the complete .txt of the filing', 'amber'],
              ['📦', 'Split into documents', 'header · 8-K · exhibits', 'blue'],
              ['🧹', 'Turn HTML into text', 'two versions of the 8-K', 'blue'],
              ['🏷', 'Note the facts', 'company, form, date, Items', 'green'],
            ]} />
            <Steps items={[
              ['One request per filing', 'The server fetches sec.gov/Archives/edgar/data/<CIK>/<accession>.txt: the complete submission, a single file holding the header and every document of the filing (the 8-K itself, exhibits, XBRL). It does not use EDGAR’s bulk archives, and the filing’s other pages are never requested.'],
              ['Polite and patient', 'Every request carries a User-Agent with contact details, as the SEC requires. A failed request (timeout, or HTTP 403, 429, 500, 502, 503, 504) is retried up to 4 times with waits of 1, 2, 4 and 8 seconds; a 404 means “the SEC did not return this filing”. Up to 3 single-filing jobs and 4 batch workers can be downloading at the same time.'],
              ['Read the header', 'From the first 6,000 characters: company name, form type, filed-on date and every “ITEM INFORMATION” line (the Items the filer declared).'],
              ['Pick the documents', 'The main document is the first one whose type starts with 8-K (otherwise the first document). The press release is the first exhibit typed EX-99 or EX-99.x; only the earnings-guidance detector uses it. Every other exhibit is dropped.'],
              ['Turn HTML into text, twice', 'Plain text: scripts, styles, inline-XBRL header and hidden elements and anything styled display:none are removed and each block of text becomes a line; most models were trained on this form. Table-preserving text: each table row becomes “cell | cell | cell”, empty cells and lone $ ) % spacers are dropped, invisible characters removed and non-breaking spaces turned into spaces; the auditor and vote detectors need the rows. The press release is also kept in the table-preserving form.'],
              ['Find the Items actually present', 'The list of Items shown for the filing is found by scanning the text for real Item headings (section 3), not copied from the SEC header, and is recorded together with the text length.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 3 items */}
          <Part id="items" title="3 · Cutting out the Items" summary="An 8-K is a set of numbered Items. Each detector reads only the Item it is about, so the filing is split first.">
            <Steps items={[
              ['What counts as a heading', 'A line that starts with “Item” and a number (also “It em 4.01” split by a line break, “Item | 5.07 |” laid out as a table row, or the bare number for a real 8-K Item), and whose next words look like a caption: a capital letter, a digit or an opening quote. “… described in Item 5.07 below” and “Item 5.07 is incorporated herein” are cross-references and are rejected because a lowercase word follows. This mistake once returned a whole 5.02 section as “Item 5.07”.'],
              ['Several headings for one Item', 'When an Item number appears at more than one genuine heading, the one followed by the official caption from Form 8-K wins (known for 1.03, 3.01, 4.01, 5.02 and 5.07).'],
              ['Where the section ends', 'At the next heading of a different Item, or at the SIGNATURE line, whichever comes first. The heading itself is part of the section.'],
              ['Short sections that point elsewhere', 'A very short Item 5.02 that says “Item 8.01 under the caption … is incorporated herein” gets that other Item’s text (up to 6,000 characters) added, so the readers see the real announcement.'],
              ['No heading, no work', 'If no genuine heading exists for any Item a detector reads, that detector is marked “not applicable” at once and its model is never run.'],
              ['Splitting into sentences', 'A custom splitter keeps “U.S.”, “Mr.”, initials (“L.J.”) and “Corp.” + “(the Company)” together, joins accounting-firm suffixes (“LLP”, “P.C.”) to their name, drops fragments of 15 characters or fewer and removes the Item’s own caption. The caption is removed on purpose: it is almost identical in every filing of that Item and would teach a model “caption present, so positive”.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 4 input */}
          <Part id="input" title="4 · What a model is shown" summary="Models see a short, cleaned input, never the whole filing. The input is built the same way as when the models were trained.">
            <Table
              title="Building the input for the leadership and distress readers (Items 5.02, 1.03, 3.01)"
              cols={['Step', 'What happens']}
              rows={[
                ['1 · Cap', 'The Item section is cut at 30,000 characters.'],
                ['2 · Remove the caption', 'The full official caption of the Item is deleted before splitting.'],
                ['3 · Drop boilerplate', 'Sentences about forward-looking statements, safe harbor, “attached as Exhibit”, “incorporated by reference”, “copy of the press release”, “financial statements and exhibits” and the signature line are removed.'],
                ['4 · Keep the relevant sentences', 'Only sentences with the Item’s keywords are kept: CEO titles for the CEO reader, CFO titles for the CFO reader, bankruptcy words, listing words. If none match, all remaining sentences are kept.'],
                ['5 · Add the rest of the filing when needed', 'If the section is a stub (under 350 characters of text) or has no keyword sentence, up to 6,000 characters of keyword sentences from the rest of the filing are added.'],
                ['6 · Turn dates into distances', 'Every full date gets its distance from the filing date: “April 5, 2024 [D-54]” means 54 days before the filing. Whether an event is new is mostly a date-gap question, and a text model cannot do date arithmetic, so the code does it.'],
                ['7 · Limit the size', 'At most 1,900 characters (about 450 tokens) in total, and no single sentence longer than 600 characters.'],
              ]}
              foot="The other detectors build their own inputs: company name plus the start of the Items with the filer’s own name replaced by FILER (agreements, equity), the first 6,000 characters of the press release (guidance) or of the Item (restructuring), each sentence with the filer masked (acquisitions). See sections 6 and 7."
            />
          </Part>

          {/* ------------------------------------------------------------------------- 5 run */}
          <Part id="run" title="5 · Running the detectors" summary="Twelve detectors run on every filing; the ones whose Item is missing cost nothing.">
            <Steps items={[
              ['The CEO reader runs first', 'It has its own code path (section 6). Then the other eleven are called in a fixed list: bankruptcy, delisting, auditor, votes, CFO, acquisition, agreements, equity, guidance, restructuring and cyber.'],
              ['Is the Item there?', 'Each detector first checks for a genuine heading of its Item(s). No heading: it answers “not applicable” immediately.'],
              ['A failure stays local', 'If one detector raises an error, the error is recorded for that detector and the others still return their answers.'],
              ['Models stay loaded', 'Each model is a small LoRA adapter on top of a standard base model (RoBERTa-base, RoBERTa-large or DeBERTa-v3-base). The base weights come from the Hugging Face hub, the adapter from the private Kaggle dataset. The adapter is merged into the base weights when the model loads (same arithmetic, no adapter overhead) and kept in memory. Each model is placed on the GPU with the most free memory (it needs the model’s size plus 1.5 GB spare), or on the CPU if none has room.'],
              ['Loaded before the first filing', 'When the server starts it loads the CEO model, then loads every other detector in the background, three at a time, so the first filing is not slowed by loading.'],
              ['Turning scores into answers', 'Multi-label models give an independent probability per label (sigmoid); single-label models give one distribution (softmax). When several models read the same input their probabilities are averaged. A label is reported when its average reaches the cut-off (0.5 unless stated below).'],
              ['Tried and dropped', 'Compressing the models to 8-bit numbers was about 3 times faster but flipped real decisions (a 99.9% CEO resignation was missed), so full precision is used.'],
            ]} />
            <Table
              title="The twelve detectors"
              cols={['Detector', 'Item', 'Text it reads', 'Models', 'How it decides']}
              rows={[
                ['CEO appointed / leaving', '5.02', 'CEO-title sentences of the section, dates as distances, up to 1,900 characters', 'RoBERTa-large, two seeds averaged (one model if the second is missing)', '≥ 0.5 per label, a gate before it, a checker after it'],
                ['CFO appointed / leaving', '5.02', 'CFO-title sentences, same builder', 'RoBERTa-large ×4, each trained with a different month held out', 'Average ≥ 0.5; skipped if the section never says CFO'],
                ['Bankruptcy or receivership', '1.03', 'Sentences with bankruptcy words', 'RoBERTa-large + DeBERTa-v3-base', 'Average ≥ 0.5 for 4 labels; “unsure” rescue below'],
                ['Delisting or listing notice', '3.01', 'Sentences with listing words', 'RoBERTa-large ×2 + DeBERTa-v3-base', 'Average ≥ 0.5 for 5 labels'],
                ['Change of auditor', '4.01', 'Every sentence, table-preserving text', 'RoBERTa-base (6 labels) + a rule engine', 'Either one says yes (union), per-label cut-offs'],
                ['Shareholder vote results', '5.07', 'Every sentence and every vote table', 'RoBERTa-base (12 labels) + rules + a vote-table parser', 'Union of model and rules; counts by arithmetic'],
                ['Acquisition or sale completed', '2.01', 'Every sentence of the Item and the filing’s intro, filer masked', 'RoBERTa-base sentence reader + RoBERTa-large direction reader', 'Sentence ≥ 0.5; wording rule can overrule the direction'],
                ['Material agreements', '1.01 / 1.02', 'Company name + start of both Items, filer masked', 'RoBERTa-large ×2 seeds (12 scores) + RoBERTa-base sentence readers', 'Entered ≥ 0.6, ended ≥ 0.8'],
                ['Unregistered equity sales', '3.02', 'Company name + start of 3.02 + start of 1.01, filer masked', 'RoBERTa-large (13 scores) + RoBERTa-base sentence readers', 'Each score ≥ 0.5'],
                ['Earnings guidance', '2.02', 'First 6,000 characters of the EX-99 press release', 'RoBERTa-large, 5 classes', 'Most likely class; a wording rule can add one'],
                ['Restructuring or impairment', '2.05 / 2.06', 'First 6,000 characters of each Item', 'RoBERTa-large, 6 types', 'Most likely type per Item'],
                ['Cybersecurity incident', '1.05', 'The whole Item (up to 30,000 characters)', 'RoBERTa-large, 3 classes', 'Most likely class; the Item’s own words overrule it'],
              ]}
            />
          </Part>

          {/* ------------------------------------------------------------------------- 6 CEO */}
          <Part id="ceo" title="6 · A CEO answer, step by step" summary="The most developed path. Every step is in the code in this order.">
            <Flow label="The CEO path" boxes={[
              ['✂', 'Item 5.02', 'cut out and split', 'blue'],
              ['🚪', 'Gate', 'no CEO word, stop', 'amber'],
              ['🧠', 'Reader', 'appointed? leaving?', 'green'],
              ['🔎', 'Proof', 'sentence, name, dates', 'green'],
              ['✅', 'Checker', 'is it real?', 'violet'],
              ['🏷', 'Marked', 'accepted · review · wrong', 'amber'],
            ]} />
            <Steps items={[
              ['1 · Cut the section', 'The standard finder first (the one the models were trained with); the older finder only as a backup, because it sometimes returned a one-line cross-reference instead of the section. No Item 5.02, no CEO answer.'],
              ['2 · Gate', 'If the section never contains “chief executive”, “CEO”, “principal executive” or “president”, the model is skipped and the page says why: no CEO change is possible.'],
              ['3 · Read once', 'The input from section 4 (CEO-title sentences, dates as distances) goes through the RoBERTa-large reader (448 tokens at most). With two trained copies the probabilities are averaged. Two numbers come out: “new CEO named” and “CEO leaving”. A number of 0.5 or more means found.'],
              ['4 · Choose the proof sentence', 'In order: a CEO sentence that matches a fixed appointment or resignation phrasing of the right kind; the rule layer’s sentence; the CEO sentence containing the right verb; else the first CEO sentence.'],
              ['5 · Find the name', 'From the phrase pattern. Otherwise the name finder: capitalised phrases, minus titles, company names and dates, tied to the right verb. A surname alone (“Mr. Janik”) is completed from elsewhere in the filing. Last resort: the honorific and surname.'],
              ['6 · Find the dates', 'A trained date reader (RoBERTa-base) marks the words giving the date the change takes effect and the date it was decided in the proof sentence and two sentences either side. If it is missing, pattern rules read “effective March 3, 2025” and “effective immediately”. The trained reader also supplies the name when it finds one (97% right against 84% for the patterns on unseen months).'],
              ['7 · Check the proof', 'A second RoBERTa-large model (the checker) reads “role, kind | company | name” plus the passage and scores 0 to 1 how likely it is a real change of this company’s CEO announced in this filing. 0.5 or more: accepted.'],
              ['8 · Try other sentences', 'Below 0.5, the checker scores up to 6 other CEO sentences of the section, ordered by closeness and verb, and moves the answer to the best one that reaches 0.5 (“re-pointed”). If none does, the answer stays.'],
              ['9 · Mark, never delete', 'Still below 0.5: under 0.1 is “Probably wrong”, otherwise “Needs review”. A model answer with no CEO sentence at all is also “Probably wrong”.'],
              ['10 · Rule flags', '“X succeeded Y as CEO” swaps the name to X. Head of a business unit or subsidiary: probably wrong. A repeat of an earlier filing’s appointment or only its pay terms: review. Several people appointed together (Co-CEOs): all are listed. “Interim” counts only when it describes the new role, not the old one.'],
              ['11 · Does the leaver stay?', 'When the CEO leaves the CEO role, a rule finder looks for the role kept (Executive Chairman, division CEO, advisor …) and a trained reader (RoBERTa-large, two seeds) gives the chance of staying as employee or on the board. It is shown when that chance is at least 0.85, and a rule match is hidden if the reader says the person leaves.'],
              ['12 · Same person twice', 'If the same person is named as joining and as leaving, both answers are marked for review (CEO to Executive Chairman is sometimes real).'],
              ['13 · A rule backup', 'If the reader found no appointment, a rule looks for appointments written as a list of officers or “X began serving as the Company’s sole CEO”. A hit is shown and marked for review.'],
              ['14 · Output', 'For appointed and for leaving: found, name(s), proof sentence, confidence, effective date or note, decided date, interim, checker score and state, stays-as. The filing gets “needs review” when any shown answer is marked.'],
            ]} />
            <div className="grid-2 tight">
              <Table
                title="The three marks"
                cols={['Mark', 'When']}
                rows={[
                  ['Accepted', 'The checker scores the proof 0.5 or more (possibly after moving to a better sentence).'],
                  ['Needs review', 'Checker between 0.1 and 0.5; a repeat of an earlier announcement; same person joining and leaving; found only by the list-of-officers rule.'],
                  ['Probably wrong', 'Checker under 0.1; no CEO sentence in the section; head of a unit or subsidiary rather than the company.'],
                ]}
              />
              <Table
                title="First try, then the fallback"
                cols={['Part', 'First try', 'If it fails']}
                rows={[
                  ['Reaching the AI server', 'Free Cloudflare tunnel', 'ngrok tunnel'],
                  ['Main CEO model', 'Two copies averaged', 'The single original model'],
                  ['Name and dates', 'Trained reader', 'Pattern rules'],
                  ['Wrong sentence picked', 'Try the next-best sentences', 'Mark it “Needs review”'],
                  ['Checker missing', 'Checker scores each answer', 'Answer shown without a score'],
                  ['Stay reader missing', 'Trained reader + rules', 'Rules only'],
                ]}
              />
            </div>
          </Part>

          {/* ------------------------------------------------------------------------- 7 others */}
          <Part id="others" title="7 · The other detectors" summary="Each one in the order the code does it.">
            <div className="det-steps">
              <div className="card">
                <h3>👥 CFO appointed or leaving · Item 5.02</h3>
                <Steps items={[
                  ['Cut and gate', 'Item 5.02; if the section never says CFO, “principal financial officer” or similar, stop with a note.'],
                  ['Read', 'The same input as the CEO reader but with CFO-title sentences. Four RoBERTa-large readers, each trained with a different month kept back, are averaged; 0.5 or more is found.'],
                  ['Proof, name, dates', 'The same selection and date reading as for the CEO, plus the interim flag.'],
                  ['Repair', 'If the “appointed” person is the one leaving, or the sentence says they were removed from the CFO job, it looks for the successor named inside the departure sentence (“a transition to X, who will serve as interim CFO”) or for another sentence that appoints someone else. “X succeeded Y” swaps the name.'],
                  ['Flags and backup', 'Not a real CFO appointment: probably wrong. Repeat of an earlier announcement: review. If nothing was found, the list-of-officers rule is tried. There is no checker model for CFOs.'],
                ]} />
              </div>
              <div className="card">
                <h3>⚖ Bankruptcy or receivership · Item 1.03</h3>
                <Steps items={[
                  ['Input', 'Item 1.03 with bankruptcy words (petition, Chapter 7/11, receiver, trustee, plan, dismiss …), dates as distances so an event five days old is told from a recap 54 days old.'],
                  ['Read', 'RoBERTa-large and DeBERTa-v3 average their probabilities for petition filed, receivership or assignment for creditors, plan confirmed, case converted or dismissed. 0.5 or more is shown.'],
                  ['Unsure rescue', 'If nothing reaches 0.5, the section is long (600+ characters) and the best label reaches 0.25 or a rule finds a matching sentence, that label is shown marked “unsure” (the two readers sometimes split).'],
                  ['Proof and fields', 'Rules choose the evidence sentence, which must be “new” (dated close to the filing, or undated without “as previously reported”), and read chapter, court and case number.'],
                ]} />
              </div>
              <div className="card">
                <h3>⇩ Delisting or listing notice · Item 3.01</h3>
                <Steps items={[
                  ['Input', 'Item 3.01 with listing words (Nasdaq, NYSE, bid price, deficiency, Form 25, transfer …) and dates as distances.'],
                  ['Read', 'Three readers (RoBERTa-large ×2, DeBERTa-v3) are averaged for deficiency notice, delisting by the exchange, voluntary delisting, transfer, compliance regained.'],
                  ['Proof and fields', 'Rules choose the new-event sentence and read the exchange, the rule, the deficiency kind and the cure deadline.'],
                ]} />
              </div>
              <div className="card">
                <h3>🧾 Change of auditor · Item 4.01</h3>
                <Steps items={[
                  ['Text', 'The table-preserving version; Item 4.01 split into sentences (a sentence can carry several facts).'],
                  ['Two paths', 'A RoBERTa-base model scores 6 flags per sentence: dismissed, resigned, engaged, disagreement, reportable event, opinion modified. Independently a rule engine does the same with careful negation: “there were no disagreements” is not a positive, “no reportable events, other than the material weaknesses” is.'],
                  ['Union', 'A flag is shown if either path says yes, labelled “model”, “rules” or “model and rules”.'],
                  ['Firm names', 'Old (dismissed or resigning) and new firms are pulled from the sentences and normalised (“E&Y”, “Ernst & Young LLP” and “EY” are one firm).'],
                ]} />
              </div>
              <div className="card">
                <h3>🗳 Shareholder vote results · Item 5.07</h3>
                <Steps items={[
                  ['Vote tables', 'A parser finds table headers (For, Against, Abstain, Broker non-votes), reads each row and computes pass or fail by arithmetic, the percentage for, director nominees below a majority and the say-on-pay percentage.'],
                  ['Narrative', 'A RoBERTa-base model and rules score 12 flags on the surrounding sentences: directors, auditor, say-on-pay, frequency, equity plan, charter, merger, share issuance or split, shareholder proposal, adjournment, special meeting, proposal failed. Union of the two.'],
                  ['Output', 'The flags plus a table with each proposal under its own wording (the sentence before its table) and its counts.'],
                ]} />
              </div>
              <div className="card">
                <h3>🤝 Acquisition or sale completed · Item 2.01</h3>
                <Steps items={[
                  ['Input', 'Sentences of Item 2.01 and of the filing’s opening paragraph, with the filer’s own name (and its aliases) replaced by FILER.'],
                  ['Completed?', 'A RoBERTa-base sentence reader labels each sentence none, acquisition, disposition, acquired or completed; 0.5 or more counts. If none clears it, a filing that declares 2.01 still shows its most deal-like sentence, marked “from the Item”.'],
                  ['Who bought whom', 'A RoBERTa-large reader gets “Filer: company || intro || Item text || Item 1.01 if 2.01 is short” and picks acquisition, disposition, acquired or unclear.'],
                  ['Wording rule', 'If the text says in so many words that a target “became a wholly owned subsidiary of FILER”, that FILER “became a subsidiary of” another company, or that FILER completed a sale of a business, the rule decides the direction.'],
                  ['Amount', 'The largest dollar amount in the proof sentence, or a price per share, by pattern.'],
                ]} />
              </div>
              <div className="card">
                <h3>📑 Material agreements · Items 1.01 and 1.02</h3>
                <Steps items={[
                  ['Input', 'Company name plus the start of Items 1.01 and 1.02, filer name replaced by FILER.'],
                  ['Read', 'Two RoBERTa-large copies give 12 scores: for each of six agreement types (M&A, debt, equity, commercial, governance, other), “entered” and “terminated”. Entered counts at 0.6, terminated at 0.8.'],
                  ['Item declared but no score', 'A declared 1.01 always reports an entry and a declared 1.02 an ending: the most likely type is shown, marked “from the Item”. An ending drawn only from 1.01 text needs a sentence that says it (a termination clause in a new contract is not a termination).'],
                  ['Proof, party, amount', 'RoBERTa-base sentence readers pick the most confident sentence; patterns read the counterparty and the amount.'],
                ]} />
              </div>
              <div className="card">
                <h3>💰 Unregistered equity sales · Item 3.02</h3>
                <Steps items={[
                  ['Input', 'Company name, the start of Item 3.02 and the start of Item 1.01 (about a quarter of 3.02 sections only point there), filer replaced by FILER.'],
                  ['Read', 'One RoBERTa-large reader gives 13 scores: seven security types (common, preferred, convertible notes, warrants, units, equity award, other) and six exemptions (4(a)(2), Regulation D, Regulation S, 3(a)(9), 3(a)(10), other). 0.5 or more is shown.'],
                  ['Amounts', 'Proceeds, price and share count come from patterns, not from the model. The proof sentence comes from the sentence reader. Without the reader’s files, the older sentence pipeline runs instead.'],
                ]} />
              </div>
              <div className="card">
                <h3>📈 Earnings guidance · Item 2.02</h3>
                <Steps items={[
                  ['Needs two things', 'A genuine Item 2.02 heading and an EX-99 press release in the filing. Without the press release the page says there is nothing to read.'],
                  ['Read', 'RoBERTa-large reads the first 6,000 characters of the release and picks none, raised, lowered, reaffirmed or withdrawn.'],
                  ['Wording rule', 'If the model says none but the release states it plainly (“raising our 2025 … guidance”), that wording is shown, labelled “the press release’s own words”.'],
                ]} />
              </div>
              <div className="card">
                <h3>🏭 Restructuring or impairment · Items 2.05 and 2.06</h3>
                <Steps items={[
                  ['Input', 'The first 6,000 characters of each of the two Items. An Item whose heading is followed by another Item’s caption (a mistyped number) is skipped.'],
                  ['Read', 'RoBERTa-large picks workforce reduction, facility closure, divestiture, discontinued product, impairment only or other.'],
                  ['Rules', 'A “divestiture” in a wind-down text with no sale wording becomes “discontinued product”. A 2.06 that only points to 2.05 is merged into one event. The charge amount is read only from sentences about charges, impairments or severance.'],
                ]} />
              </div>
              <div className="card">
                <h3>🛡 Material cybersecurity incident · Item 1.05</h3>
                <Steps items={[
                  ['Read', 'One RoBERTa-large model (only 55 filings exist, too few for several copies) reads the section and picks material, not material or still assessing.'],
                  ['The Item’s own words win', 'If the Item states a conclusion (“has not had a material impact”, “is likely to have a material impact”), that wording decides and is shown as the proof; “could have the potential to” means still assessing.'],
                ]} />
              </div>
            </div>
          </Part>

          {/* ------------------------------------------------------------------------- 8 single */}
          <Part id="single" title="8 · One filing, live" summary="What happens when you open a filing page.">
            <Flow label="One filing" boxes={[
              ['🖥', 'Filing page', 'starts the job', 'blue'],
              ['⚡', '/api/analyze', 'adds the key', 'blue'],
              ['🧠', 'AI server', '/jobs', 'green'],
              ['🔁', 'Asked again', 'about every second', 'blue'],
              ['📄', 'Result', 'sentences + cards', 'green'],
            ]} />
            <Steps items={[
              ['Start', 'The page sends the CIK and accession number to /api/analyze, which checks both for the right shape (digits; ten digits, two, six), adds the secret key and passes them to the AI server’s /jobs. The browser never learns the server’s address.'],
              ['A job with stages', 'The server returns a job number at once and works in a pool of 3. Stages and progress: downloading 5% → locating the Item 20% → splitting 30% → reading 35–85% → detectors 86–88% → done. The page shows the stage and a time estimate worked out from the live rate.'],
              ['Asking again', 'The page asks for the job status about once a second until it is done or has failed.'],
              ['Server off or booting', 'If nothing answers, the page says the server is not running or still starting and keeps retrying for up to about 4 minutes. A switched-off server is told apart from a problem at the model host.'],
              ['Result', 'The page shows the cut-out Item with the proof sentences highlighted, one card per detector with events, evidence, confidence and which readers agreed, the market value card (section 13) and the raw data.'],
              ['Repeat visits', 'The finished result is remembered by the server under CIK and accession for as long as it is on, so reopening is instant. Nothing is written to disk.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 9 batch */}
          <Part id="batch" title="9 · Many filings in the background" summary="An analysis runs on the AI server, saves itself to private storage in small parts, and does not need your browser.">
            <Flow label="Background analysis" boxes={[
              ['▶', 'Start', 'search or list', 'blue'],
              ['🔎', 'Collect', 'all matching filings', 'amber'],
              ['⚙', '4 workers', 'one filing each', 'green'],
              ['📦', 'Parts of 50', 'saved as they fill', 'violet'],
              ['🔁', 'Page', 'live view + stored', 'blue'],
            ]} />
            <Steps items={[
              ['Start', 'The page asks /api/batch to create the analysis with either the search settings or the list shown. The function first checks that the AI server is healthy (otherwise it refuses and stores nothing), then writes the analysis’s details and a “stop” flag to private storage, and tells the AI server the analysis number and the site address. Limit: 12 new analyses per connection every 10 minutes.'],
              ['Collect', 'The AI server asks the site’s search functions for every matching filing (section 1), removes duplicates by accession number and, on a resume, skips the ones already finished.'],
              ['Work', 'Four workers take filings from one queue. Each runs the whole single-filing path (download, Items, detectors) on one filing at a time and shares the loaded models. A filing that fails becomes an error row; the batch carries on.'],
              ['Slim the result', 'Only what the sheet needs is kept (section 11). The filing text and all per-sentence scores are dropped.'],
              ['Save in parts', 'Every 50 finished filings become one part, posted to /api/batch with the secret key and stored as its own file, together with a progress note (total, done, errors, status). A note is also sent every 90 seconds when nothing else is saved. Each post is tried 4 times with growing waits; unsent parts wait in a queue.'],
              ['Live view', 'While the server is reachable the page asks it directly every 4 seconds for the counts and for finished filings that are not stored yet; otherwise it reads the stored notes every 8 seconds (4 times slower while the tab is hidden).'],
              ['Stop', 'The stop button writes the flag and calls the server; every save response also carries the flag, so a worker stops after its current filing.'],
              ['Interrupted and resume', 'If no note arrives for 5 minutes, or the server announces it is shutting down, the analysis shows as “interrupted”. Resume reads every stored part, collects the finished accession numbers, and the server skips them and continues with the next part number.'],
              ['The server stays on', 'An analysis in progress keeps the idle clock at zero, and neither the idle timer nor “Turn off” can stop the server under it (a queued turn-off waits for the end).'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 10 server */}
          <Part id="server" title="10 · The AI server’s life" summary="A free Kaggle GPU, started on demand and shared by every visitor.">
            <Steps items={[
              ['Choose an account', '“Turn on AI model” reads how many GPU hours each of the three Kaggle accounts has left (answers are cached; a rate-limit refusal counts as unknown, not as zero) and offers the ones with at least 1 hour. Only one server runs at a time; starting is refused while one is running.'],
              ['Push the notebook', 'The function pushes a private notebook to that account with a GPU, a 3-hour run limit and the model data attached: the adapters dataset plus small extra datasets (dates, agreements, cyber, equity, verifier, CEO v2, stays).'],
              ['Boot', 'The notebook installs its Python packages, finds the model folders, starts the web service on port 7860 and loads the CEO model, then the other detectors three at a time.'],
              ['Publish the address', 'It opens a free Cloudflare tunnel (a new address each time) and registers that address with the site, which keeps it in private storage. If the tunnel fails it uses ngrok. Anyone using the site then reaches the same server: if one person turns it on, everyone can use it.'],
              ['Ready signal', '/health reports each detector as off, loading, ready or error. A self-test runs every model on a short sentence and checks the output has the right size and finite values.'],
              ['Turn off', 'Automatic after 7 minutes without a request (checked once a minute, and never in the first 5 minutes), at the 3-hour limit, or when someone presses “Turn off” (this deletes the notebook and releases the reserved GPU time). Status checks do not count as use, so an open status panel cannot keep it awake.'],
              ['Every call is signed', 'The website’s functions add the secret key to every call; the server refuses calls without it. The server’s own saves back to the site use the same key.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 11 store */}
          <Part id="store" title="11 · What is stored, and where" summary="Only answers are kept. The filings themselves are never copied: EDGAR is fetched again whenever a filing is opened.">
            <Table
              title="Stored in private files (Vercel Blob)"
              cols={['File', 'Holds', 'Kept']}
              rows={[
                ['batches/<id>/meta.json', 'Title, the search or the list of filings, status, counts, start and finish times, number of parts', 'No expiry; rewritten on every progress note'],
                ['batches/<id>/part-<n>.json', '50 slimmed results each (below)', 'No expiry'],
                ['batches/<id>/stop.json', 'The stop flag', 'Rewritten on stop and resume'],
                ['model/url.json', 'The AI server’s current address', 'Replaced at every start'],
                ['prices/yahoo_<TICKER>.json', 'Daily closing prices read from Yahoo, each with the time it was read', '7 days, or 6 hours for the last 3 days; a daily job at 03:00 deletes what has expired'],
                ['manual/<cik>_<date>.json', 'A price or share count typed in by hand', 'Never expires; can be removed on the filing page'],
                ['presence/<visitor>.json', 'A visitor who shared their location', 'Updated while they use the site'],
              ]}
            />
            <div className="grid-2 tight">
              <div className="card">
                <h3>What a stored result keeps</h3>
                <ul className="checks">
                  <li>The Items found in the filing.</li>
                  <li>CEO appointed and leaving: found, name(s), confidence, effective date or note, decided date, proof sentence (600 characters), checker score and state, stays-as.</li>
                  <li>For every other detector with its Item present: each event’s title, detail, confidence, kind, name, interim flag, dates and proof sentence (600 characters).</li>
                  <li>The filing’s list entry: company, ticker, CIK, form, date, links, accession number.</li>
                </ul>
              </div>
              <div className="card">
                <h3>What is never stored</h3>
                <ul className="checks">
                  <li>The filing text, the cut-out Item sections, the per-sentence scores and the per-reader probabilities.</li>
                  <li>Any exhibit.</li>
                  <li>The server holds a filing’s text in memory only while it is being analysed, and a single filing’s full result only until the server turns off (the last 200 jobs are listed).</li>
                  <li>Opening a filing from the sheet therefore runs the analysis again, which needs the AI server on.</li>
                </ul>
              </div>
            </div>
            <p className="note">The browser also keeps small conveniences in its own storage: the last search, and a “left empty” choice for a market value. They never leave your browser.</p>
          </Part>

          {/* ------------------------------------------------------------------------- 12 sheet */}
          <Part id="sheet" title="12 · The sheet and downloads" summary="One row per filing, one column per kind of event.">
            <Steps items={[
              ['From result to row', 'Each stored result becomes a row: filing details, the Items found, an event count, a summary line (“title (detail) [confidence]” per event), one column per event type, “needs review”, the highest confidence, the first proof sentence, the SEC link, the accession number and a status. Failed filings get a row with the error.'],
              ['Working with it', 'Filter box, “only filings with events”, event chips that match any or all of the chosen events, an answer-check filter (all, flagged, clean) and sorting by date, company, event count or market cap. Rows show 300 at a time.'],
              ['Market cap column', 'Shown and downloaded in millions of dollars (a plain number, so it sorts and filters as a number). While the analysis runs, the sheet reads today’s market cap by itself for every company that has a filing with events (no button; companies already read in the last 6 hours in this browser are not asked again). The “Show only filings with” box has a “Market cap above X” filter (section 13).'],
              ['CSV and Excel', 'Both contain exactly the rows shown. The Excel file has a frozen header, filters, a link on each SEC cell, green event cells, and an “About” sheet that explains the columns and the caveats.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- 13 market value */}
          <Part id="mcap" title="13 · Market value" summary="Two values. No AI model is involved: SEC numbers and Yahoo Finance pages.">
            <Flow label="Market value" boxes={[
              ['🏛', 'Ticker + shares', 'SEC data', 'amber'],
              ['📈', 'Closing price', 'Yahoo, stored or read', 'violet'],
              ['✍', 'If it fails', 'type it in or leave empty', 'amber'],
              ['💲', 'Shares × price', 'on the filing date', 'green'],
            ]} />
            <Steps items={[
              ['Market cap today', 'The company’s Yahoo quote page is fetched as plain HTML (it is built on the server, so no browser is needed) and the “Market Cap (intraday)” field, for example “893.0M”, is turned into dollars. Only if the plain read finds nothing is a headless browser used as a fallback. It is never stored on the server. On the filing page it is the bright box; in the sheet it is the “Market cap” column.'],
              ['Reading many at once', 'The sheet watches the rows arriving from the running analysis. Each time filings with events appear, the companies not read yet are sent to the site 12 per call, 3 calls side by side, once per company however many filings it has. The “Market cap” cell shows “…” until its company has been read.'],
              ['Shares on the filing date', 'From the SEC’s tagged data for the cover page (dei:EntityCommonStockSharesOutstanding) of the latest 10-K or 10-Q filed on or before the filing date. Several share classes are added up. The count is about 3 months old on average, because the cover is dated when the report was written.'],
              ['Closing price', 'The same browser opens Yahoo’s history page (cookie dialog accepted, scripts, style sheets, pictures and fonts skipped) and takes the last close on or before the filing date. Closes are stored for 7 days (6 hours for the last 3) and then read again.'],
              ['A second, SEC-only estimate', 'The price of the latest insider trade (Form 4, up to 10 filings from the 120 days before, read side by side, capped at 14 seconds). Found for about half of filings and a median 31 days old, so it is an estimate; against the Yahoo close the median gap was 7.6%.'],
              ['When nothing is found', 'The card says so and offers to type the price or share count, or “Leave empty”. Typed values are marked, win over automatic ones and can be removed.'],
            ]} />
            <ul className="afacts">
              <li><b>1.9 s</b>median wait for today’s market cap of one company (slowest 4.3 s)</li>
              <li><b>0.63 s</b>per company when 40 are read in one call (39 of 40 found, 25 s in total)</li>
              <li><b>2.6 s</b>median wait to read one company’s closing prices from Yahoo (it was 20 s before the page was slimmed down)</li>
            </ul>
            <p className="note">Limits: Yahoo’s closes are adjusted for later stock splits, so for a company that split afterwards the price is not the one paid that day. Reading Yahoo’s pages by program is against Yahoo’s terms and the site’s server could be blocked after heavy use. Full timings are in the Model notes.</p>
          </Part>

          {/* ------------------------------------------------------------------------- 14 site */}
          <Part id="site" title="14 · Sign-in and location" summary="Who can use the site, and what the site knows about visitors.">
            <Steps items={[
              ['Sign-in', 'One shared password. The site stores only a scrypt hash of it, in a server setting, never in the code. A correct password sets a signed cookie; every data function checks the cookie, and scripts can send the password in a header. Answers are marked private so shared caches cannot hand them to a signed-out caller.'],
              ['Location', 'After signing in, the browser asks for location permission. The site is unusable until it is allowed. A second signed cookie records that it was shared.'],
              ['Who is online', 'Each visitor’s place and last-seen time are stored as one small file; the “Who’s online” page lists the visitors seen recently.'],
              ['The AI server', 'Its own calls to the site (saving analysis parts, registering its address) use the secret key instead of the cookie.'],
            ]} />
          </Part>

          {/* ------------------------------------------------------------------------- evidence */}
          <Part id="evidence" title="How it was built and scored" summary="The models are small adapters trained on labelled real filings and tested on months they never saw.">
            <Flow label="Building a model" boxes={[
              ['📥', 'Collect', 'real filings from EDGAR', 'blue'],
              ['🏷', 'Label', 'big AI + rules + human check', 'amber'],
              ['🧠', 'Train', 'small models learn from labels', 'green'],
              ['🧪', 'Test', 'on months it never saw', 'violet'],
            ]} />
            <p className="aloop-back" aria-hidden="true">↺ look at the mistakes, fix the labels, train again</p>
            <figure className="card months-fig">
              <div className="months" role="img" aria-label="Months of filings: most used for learning, four kept back for testing">
                {MONTHS.map((m) => {
                  const kind = HELD_OUT.includes(m) ? 'test' : TRAINED.has(m) ? 'train' : 'none'
                  return <i key={m} className={`month ${kind}`} title={`${m}: ${kind === 'test' ? 'kept back for testing' : kind === 'train' ? 'used for learning' : 'not used'}`} />
                })}
              </div>
              <div className="months-axis"><span>Jan 2023</span><span>Jan 2024</span><span>Jan 2025</span><span>Jan 2026</span></div>
              <ul className="legend">
                <li><i className="month train" /> Learned from</li>
                <li><i className="month test" /> Kept back for testing: Jun 2024, Jun 2025, Nov 2025, May 2026</li>
                <li><i className="month none" /> Not used (later used for extra real-world checks)</li>
              </ul>
            </figure>
            <div className="grid-3">
              <div className="card metric">
                <h3>Main CEO AI</h3>
                <p><b>Learned from</b> about 9,000 real filings. Labels came from two big AIs plus rules agreeing; 239 doubtful labels were fixed and 195 false-alarm filings added.</p>
                <p><b>Tested on</b> 1,070 filings from the 4 kept-back months; about 350 label disagreements were decided by hand.</p>
              </div>
              <div className="card metric">
                <h3>Checker AI</h3>
                <p><b>Learned from</b> about 7,000 short passages marked “real change” or “not”.</p>
                <p><b>Tested on</b> the 4 kept-back months, 93 held-back filings the old model got wrong and 696 recent unseen filings.</p>
              </div>
              <div className="card metric">
                <h3>Name and date readers</h3>
                <p><b>Learned from</b> 4,600 passages whose names and dates were marked by a big AI.</p>
                <p><b>Tested on</b> 589 passages from the kept-back months. The big AI agrees with itself only 91–95% of the time, so scores near that are close to the limit.</p>
              </div>
            </div>
            <div className="grid-3">
              <div className="card metric">
                <h3>Precision</h3>
                <p className="muted small">Of the alerts it raises, how many are real?</p>
                <DotRow right={18} wrong={2} label="18 of 20 alerts are real" />
                <p><b>18 of 20 = 90%.</b> Low precision means false alarms.</p>
              </div>
              <div className="card metric">
                <h3>Recall</h3>
                <p className="muted small">Of the real events, how many does it find?</p>
                <DotRow right={19} missed={1} label="19 of 20 real events found" />
                <p><b>19 of 20 = 95%.</b> Low recall means missed events.</p>
              </div>
              <div className="card metric">
                <h3>F1</h3>
                <p className="muted small">One number that is high only when both are high.</p>
                <div className="f1">
                  <span><b>90%</b> and <b>95%</b> → <b>92%</b></span>
                  <span><b>100%</b> and <b>10%</b> → <b>18%</b></span>
                </div>
                <p><b>1.0 is perfect.</b></p>
              </div>
            </div>
            <p className="note">Plain accuracy would mislead: only about 1 filing in 8 has a CEO change, so always answering “no” would be 87% accurate and useless. The test filings are about half real events, so in real life false alarms hurt more than the scores show; the checker is there for that.</p>
            <h3>Score of each detector</h3>
            <div className="ascore">
              {detectors.map((d) => (
                <div key={d.key} className="card ascore-row">
                  <span className={`dicon t-${d.tone}`} aria-hidden="true">{d.icon}</span>
                  <div className="ascore-name">
                    <b>{d.title.replace(/ \(.*\)/, '')}</b>
                    <small>Item {d.item}{d.experimental ? ' · experimental' : ''}</small>
                  </div>
                  <dl className="ascore-nums">
                    {d.metrics.slice(0, 1).map((m) => (
                      <div key={m.label}>
                        <dd>{m.value}</dd>
                        <dt>{m.label}</dt>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            <p className="note">Every score comes from filings the model never saw while learning. The Model notes page has every table.</p>
            <div className="grid-2 tight">
              <div className="card">
                <h3>Does the checker help?</h3>
                <BarChart bars={checkerGain} min={0.8} max={0.96} format={(v) => `${(v * 100).toFixed(1)}%`} ariaLabel="Share of shown answers that were right: 85.6 percent without the checker, 94.4 percent with it" />
                <ul className="checks">
                  <li><b>93 → 0</b> false alarms shown as accepted, on 92 held-back filings the old model got wrong (the newest AI still fires on 9, all marked “Probably wrong”).</li>
                  <li><b>2%</b> of answers are left for a person to review.</li>
                </ul>
              </div>
              <div className="card">
                <h3>Reading names and dates</h3>
                <BarChart bars={reading} min={0.7} max={1} format={(v) => `${Math.round(v * 100)}%`} ariaLabel="Share of names and dates read correctly on filings the model never saw" />
                <h3>Older CEO models (per sentence)</h3>
                <BarChart bars={journey} min={0.8} max={0.875} ariaLabel="Overall score of each CEO model generation, rising from 0.8126 to 0.8673" />
                <p className="note">Earlier versions read one sentence at a time; today’s model reads the whole section, so the two sets of numbers are not comparable.</p>
              </div>
            </div>
            <p className="note">AI can be wrong. Every answer shows the sentence it used and links to the SEC filing, so you can check it.</p>
          </Part>
        </div>
      </div>
    </>
  )
}
