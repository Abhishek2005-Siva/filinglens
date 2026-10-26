import BarChart from '../components/BarChart'
import { detectors } from '../data/detectors'

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

const fallbacks = [
  ['Reaching the AI server', 'Free Cloudflare tunnel', 'ngrok tunnel'],
  ['Main CEO model', 'Two AI copies vote (newest)', 'The single original model'],
  ['Name and dates', 'Trained reader (97% names)', 'Pattern rules (84% names)'],
  ['Wrong sentence picked', 'Try the next-best sentences', 'Mark it “Needs review”'],
  ['The checker is missing', 'Checker scores each answer', 'Answer shown without a score'],
]

const checkerGain = [
  { label: 'Without the checker', sub: 'answers that were right', value: 0.856 },
  { label: 'With the checker', sub: 'accepted answers that were right', value: 0.944, highlight: true },
]

const steps = [
  ['1', 'Get the filing', 'from the SEC'],
  ['2', 'Cut it into sections', 'called Items'],
  ['3', 'AI detectors read', 'each in its own Item'],
  ['4', 'Check the evidence', 'the exact sentence'],
  ['5', 'Show the answer', 'page, sheet, CSV, Excel'],
]

const groups: { name: string; tone: string; keys: string[] }[] = [
  { name: 'People', tone: 'green', keys: ['ceo', 'cfo'] },
  { name: 'Trouble', tone: 'red', keys: ['bankruptcy', 'delisting', 'cyber_incident'] },
  { name: 'Deals', tone: 'violet', keys: ['acquisition', 'agreements', 'equity', 'restructuring'] },
  { name: 'Company news', tone: 'amber', keys: ['auditor', 'votes', 'guidance'] },
]

const made = [
  ['📥', 'Collect', 'real filings from EDGAR'],
  ['🏷', 'Label', 'big AI + rules + human check'],
  ['🧠', 'Train', 'small models learn from labels'],
  ['🧪', 'Test', 'on months it never saw'],
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

export default function UnderTheHood() {
  const byKey = Object.fromEntries(detectors.map((d) => [d.key, d]))
  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Under the hood</span>
        <h1>How FilingLens works</h1>
        <p className="lead">It reads SEC filings and tells you what happened. Here is the whole picture.</p>
      </section>

      <section aria-labelledby="h-big">
        <h2 id="h-big">The big picture</h2>
        <figure className="arch card">
          <div className="arch-top">
            <Node icon="🧑" title="You" sub="in your browser" tone="blue" />
          </div>
          <Arrow down label="search · analyze" />
          <div className="arch-mid">
            <Node icon="🌐" title="Website" sub="pages + API on Vercel" tone="blue" />
          </div>
          <div className="arch-row">
            <div className="arch-col">
              <Arrow down label="get filings" />
              <Node icon="🏛" title="SEC EDGAR" sub="public filings" tone="amber" />
            </div>
            <div className="arch-col">
              <Arrow down label="ask the AI" />
              <Node icon="⚡" title="AI server" sub="12 detectors + readers on a free Kaggle GPU" tone="green" />
            </div>
            <div className="arch-col">
              <Arrow down label="save results" />
              <Node icon="🗄" title="Saved results" sub="private storage, open by link" tone="violet" />
            </div>
          </div>
          <figcaption>The AI server turns itself off when nobody uses it, so it stays free.</figcaption>
        </figure>
      </section>

      <section aria-labelledby="h-steps">
        <h2 id="h-steps">One filing, five steps</h2>
        <ol className="asteps">
          {steps.map(([n, t, s]) => (
            <li key={n} className="astep">
              <span className="anum">{n}</span>
              <b>{t}</b>
              <small>{s}</small>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="h-flow">
        <h2 id="h-flow">How a CEO answer is made</h2>
        <figure className="arch card">
          <Node icon="📄" title="The filing" sub="an 8-K from the SEC" tone="blue" />
          <Arrow down label="cut out Item 5.02" />
          <Node icon="✂" title="Leadership section" sub="no CEO or president in it? Stop: nothing to find" tone="blue" />
          <Arrow down label="first try" />
          <Node icon="🧠" title="Main AI: two copies vote" sub="Is a new CEO named? Is the CEO leaving?" tone="green" />
          <Arrow down label="show the proof" />
          <Node icon="🔎" title="Pick the sentence, name and dates" sub="trained readers first, pattern rules as backup" tone="green" />
          <Arrow down label="second look" />
          <Node icon="✅" title="Checker AI" sub="Does this sentence really show a CEO change here? If not, try the next sentence." tone="violet" />
          <Arrow down label="the answer is marked" />
          <div className="arch-row">
            <Node icon="✔" title="Accepted" sub="the checker agrees" tone="green" />
            <Node icon="🚩" title="Needs review" sub="the checker is unsure: a person looks" tone="amber" />
            <Node icon="⚠" title="Probably wrong" sub="no CEO sentence, or the checker doubts it a lot" tone="red" />
          </div>
          <figcaption>Nothing is deleted. Every answer keeps its sentence and a link to the filing.</figcaption>
        </figure>
      </section>

      <section aria-labelledby="h-fallback">
        <h2 id="h-fallback">First try, then the fallback</h2>
        <div className="fb card">
          <div className="fb-row fb-head"><span>Part</span><span>First try</span><span>If it fails</span></div>
          {fallbacks.map(([part, first, back]) => (
            <div className="fb-row" key={part}>
              <b>{part}</b>
              <span><i className="fb-tag one">1st</i> {first}</span>
              <span><i className="fb-tag two">then</i> {back}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="h-metrics">
        <h2 id="h-metrics">What the scores mean</h2>
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
            <p><b>1.0 is perfect.</b> It cannot be tricked by saying “yes” to everything or “no” to everything.</p>
          </div>
        </div>
        <p className="note">Plain accuracy would be misleading: only about 1 filing in 8 has a CEO change, so always answering “no” would be 87% accurate and useless.</p>
        <div className="grid-2 tight">
          <div>
            <h3>New CEO named</h3>
            <div className="card">
              <BarChart bars={[
                { label: 'Precision', sub: 'alerts that are real', value: 0.906 },
                { label: 'Recall', sub: 'real events found', value: 0.983 },
                { label: 'F1', sub: 'both together', value: 0.943, highlight: true },
              ]} min={0.7} max={1} format={(v) => `${(v * 100).toFixed(1)}%`} ariaLabel="New CEO named: precision 90.6 percent, recall 98.3 percent, F1 94.3 percent" />
            </div>
          </div>
          <div>
            <h3>CEO leaving</h3>
            <div className="card">
              <BarChart bars={[
                { label: 'Precision', sub: 'alerts that are real', value: 0.841 },
                { label: 'Recall', sub: 'real events found', value: 0.917 },
                { label: 'F1', sub: 'both together', value: 0.877, highlight: true },
              ]} min={0.7} max={1} format={(v) => `${(v * 100).toFixed(1)}%`} ariaLabel="CEO leaving: precision 84.1 percent, recall 91.7 percent, F1 87.7 percent" />
            </div>
          </div>
        </div>
        <p className="note">These are scored per filing, on filings the AI never saw. “CEO leaving” is harder: departures are written in more different ways.</p>
      </section>

      <section aria-labelledby="h-data">
        <h2 id="h-data">What it learned from, and what it was tested on</h2>
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
          <figcaption>The AI never sees the four test months while learning, so the scores say how it does on new filings.</figcaption>
        </figure>
        <div className="grid-3">
          <div className="card metric">
            <h3>Main CEO AI</h3>
            <p><b>Learned from</b> about 9,000 real filings. The answers (“labels”) came from two big AIs plus rules agreeing, then 239 doubtful labels were fixed, and 195 false-alarm filings were added.</p>
            <p><b>Tested on</b> 1,070 filings from the 4 kept-back months. About 350 label disagreements were decided by hand.</p>
          </div>
          <div className="card metric">
            <h3>Checker AI</h3>
            <p><b>Learned from</b> about 7,000 short passages from the same learning months, marked “real change” or “not”.</p>
            <p><b>Tested on</b> the same 4 kept-back months, plus 93 held-back filings the old model got wrong and 696 recent unseen filings.</p>
          </div>
          <div className="card metric">
            <h3>Name and date readers</h3>
            <p><b>Learned from</b> 4,600 passages whose names and dates were marked by a big AI.</p>
            <p><b>Tested on</b> 589 passages from the 4 kept-back months. A big AI is not perfect: it agrees with itself only 91–95% of the time, so scores near that are close to the limit.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-checker">
        <h2 id="h-checker">Does the checker help?</h2>
        <div className="grid-2 tight">
          <div className="card">
            <BarChart bars={checkerGain} min={0.8} max={0.96} format={(v) => `${(v * 100).toFixed(1)}%`} ariaLabel="Share of shown answers that were right: 85.6 percent without the checker, 94.4 percent with it" />
            <p className="note">On the 4 test months, the answers it accepts are right 94% of the time.</p>
          </div>
          <div className="card">
            <ul className="checks">
              <li><b>93 → 0</b> false alarms shown as accepted, on 92 held-back filings the old model got wrong (the newest AI still fires on 9, all marked “Probably wrong”).</li>
              <li><b>2%</b> of answers left for a person to review (the goal was 3%).</li>
              <li><b>2 to 4 in 10</b> answers on real recent filings (months the AI never trained on) had no CEO sentence at all with the old model. They are now marked “Probably wrong”.</li>
            </ul>
          </div>
        </div>
        <p className="note">Why it matters: our test filings are about half real events, but in real life only about 1 in 8 filings has a CEO change. False alarms hurt much more in real life than the test score shows. The checker is there for that.</p>
      </section>

      <section aria-labelledby="h-finds">
        <h2 id="h-finds">What it finds</h2>
        <div className="agroups">
          {groups.map((g) => (
            <div key={g.name} className={`card agroup tone-${g.tone}`}>
              <h3>{g.name}</h3>
              <ul>
                {g.keys.map((k) => {
                  const d = byKey[k]
                  return d ? (
                    <li key={k}>
                      <span className={`dicon t-${d.tone}`} aria-hidden="true">{d.icon}</span>
                      <span>{d.title.replace(/ \(.*\)/, '')}<small>Item {d.item}{d.experimental ? ' · experimental' : ''}</small></span>
                    </li>
                  ) : null
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="h-made">
        <h2 id="h-made">How the AI was made</h2>
        <ol className="aloop">
          {made.map(([icon, t, s], i) => (
            <li key={t}>
              <Node icon={icon} title={t} sub={s} tone="blue" />
              {i < made.length - 1 && <Arrow />}
            </li>
          ))}
        </ol>
        <p className="aloop-back" aria-hidden="true">↺ look at the mistakes, fix the labels, train again</p>
        <ul className="afacts">
          <li><b>Small models</b>RoBERTa and DeBERTa, tuned with LoRA</li>
          <li><b>Thousands</b>of real filings per task</li>
          <li><b>Unseen months</b>are kept aside for testing</li>
        </ul>
      </section>

      <section aria-labelledby="h-score">
        <h2 id="h-score">How well it works</h2>
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
        <p className="note">Every score comes from filings the model never saw while learning. F1 mixes “how often it is right” and “how many real events it finds” into one number (1.0 is perfect).</p>
      </section>

      <section aria-labelledby="h-mcap">
        <h2 id="h-mcap">How the market value is worked out</h2>
        <p className="lead small">Market value on the filing date = shares outstanding × the closing price. No AI model is involved: the shares come from SEC data, the price from Yahoo Finance.</p>
        <ol className="aloop small">
          <li><Node icon="📄" title="Shares" sub="cover of the latest 10-K / 10-Q (SEC)" tone="blue" /><Arrow /></li>
          <li><Node icon="📈" title="Price" sub="Yahoo Finance history page" tone="violet" /><Arrow /></li>
          <li><Node icon="✍" title="If it fails" sub="type the value, or leave it empty" tone="amber" /><Arrow /></li>
          <li><Node icon="💲" title="Market value" sub="shares × price" tone="green" /></li>
        </ol>
        <div className="grid-2 tight">
          <div className="card">
            <h3>Shares outstanding</h3>
            <p className="small">From the SEC’s tagged data on the front page of the company’s latest 10-K or 10-Q filed on or before the filing date. A company with several share classes has them added up. The count is about 3 months old on average (86 days) because the cover is dated when the report was written.</p>
          </div>
          <div className="card">
            <h3>Closing price</h3>
            <p className="small">A headless browser opens Yahoo Finance’s public history page, presses “Accept all” if a cookie dialog shows, and reads the price table from the page Yahoo sends (scripts, style sheets, pictures and fonts are skipped). It takes the last close on or before the filing date. Yahoo has no public data service, so this reads the same page a person sees.</p>
          </div>
          <div className="card">
            <h3>A second, SEC-only estimate</h3>
            <p className="small">The price of the latest insider trade (Form 4) in the 120 days before the filing, shown next to the Yahoo value. It is found for about half of the filings and is a median 31 days old, so it is an estimate. Against the Yahoo close the median gap was 7.6%.</p>
          </div>
          <div className="card">
            <h3>When nothing is found</h3>
            <p className="small">If Yahoo shows no prices (a delisted or renamed company) or the SEC has no share count, the card says so. The person can type in the price or the share count, or choose “Leave empty”. Typed values are marked “entered by hand”, win over the automatic ones and can be removed.</p>
          </div>
        </div>
        <ul className="afacts">
          <li><b>2.6 s</b>median wait to read one company from Yahoo (it was 20 s before the page was slimmed down)</li>
          <li><b>0.8 s</b>per company when many are read in one call</li>
          <li><b>7 days</b>a stored price is used (6 hours for the last 3 days), then it is read again</li>
        </ul>
        <p className="note">Limits: Yahoo’s closing prices are adjusted for later stock splits, so for a company that split afterwards the price is not the one paid that day. Reading Yahoo’s pages by program is against Yahoo’s terms and the site’s server could be blocked after heavy use. Stored prices are deleted by a daily job. Full timings are in the Model notes.</p>
      </section>

      <section aria-labelledby="h-names" className="grid-2 tight">
        <div>
          <h2 id="h-names">Reading names and dates</h2>
          <div className="card">
            <BarChart bars={reading} min={0.7} max={1} format={(v) => `${Math.round(v * 100)}%`} ariaLabel="Share of names and dates read correctly on filings the model never saw" />
          </div>
        </div>
        <div>
          <h2>Older CEO models (per sentence)</h2>
          <div className="card">
            <BarChart bars={journey} min={0.8} max={0.875} ariaLabel="Overall score of each CEO model generation, rising from 0.8126 to 0.8673" />
          </div>
          <p className="note">Earlier versions read one sentence at a time. Today’s model reads the whole section (scores above), so the two sets of numbers are not comparable.</p>
        </div>
      </section>

      <section aria-labelledby="h-next">
        <h2 id="h-next">What is built, and what is next</h2>
        <ol className="aloop small">
          <li><Node icon="🧠" title="Two AI copies vote" sub="live" tone="green" /><Arrow /></li>
          <li><Node icon="✅" title="Checker" sub="live" tone="green" /><Arrow /></li>
          <li className="split">
            <Node icon="✔" title="Accepted" sub="live" tone="green" />
            <Node icon="🚩" title="Needs review / Probably wrong" sub="live" tone="amber" />
          </li>
          <li><Arrow /><Node icon="📝" title="Review queue" sub="next: your decisions teach the AI" tone="blue" /></li>
        </ol>
        <span className="pill exp">Next: a review queue that learns from your decisions</span>
      </section>

      <p className="note">AI can be wrong. Every answer shows the sentence it used and links to the SEC filing, so you can check it.</p>
    </>
  )
}
