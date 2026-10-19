import { march } from '../data/march'
import { num, pct } from '../utils'
import Stat from '../components/Stat'
import Dots from '../components/Dots'
import BarChart from '../components/BarChart'
import { comingSoon, detectors } from '../data/detectors'

const progress = [
  { label: 'First reliable model', sub: 'DistilBERT (small)', value: 0.8126 },
  { label: 'Bigger reader', sub: 'RoBERTa-base', value: 0.8207 },
  { label: 'Three readers voting', sub: 'RoBERTa-base ×3', value: 0.839 },
  { label: 'Large reader', sub: 'RoBERTa-large ×3', value: 0.8537 },
  { label: 'Mixed team (best)', sub: 'RoBERTa-large ×2 + DeBERTa', value: 0.8673, highlight: true },
]

export default function Overview() {
  const { metrics: m, funnel: f } = march
  const apptReal = m.appointed.tp + m.appointed.fn
  const resgReal = m.resigned.tp + m.resigned.fn
  const flagged = m.appointed.tp + m.appointed.fp + m.resigned.tp + m.resigned.fp
  const correct = m.appointed.tp + m.resigned.tp
  const falseAlarms = m.appointed.fp + m.resigned.fp

  return (
    <>
      <section className="hero">
        <span className="eyebrow">FilingLens · AI that reads SEC filings for you</span>
        <h1>See what happened in any SEC 8-K filing, in plain English.</h1>
        <p className="lead">
          When something important happens at a US public company, it has to tell the SEC in a document called an <strong>8-K</strong>. Thousands are filed every month,
          most of them long and technical. FilingLens finds the filing, reads it with AI, and tells you what changed: a new CEO or CFO, a bankruptcy, a delisting notice,
          a closed acquisition, a new auditor, how shareholders voted, a layoff or a raised forecast. Every answer comes with the exact sentence it is based on.
        </p>
        <div className="hero-actions">
          <a className="btn primary" href="#/search">Search and analyze a filing</a>
          <a className="btn" href="#/how">See how it works</a>
        </div>
        <ul className="hero-points">
          <li><b>{detectors.length} AI detectors</b> run on every filing you open: leadership, bankruptcy, delisting, auditors, votes, deals, agreements, equity sales, earnings and restructuring.</li>
          <li><b>Analyze a whole search at once.</b> Hundreds or thousands of filings go into one spreadsheet. It keeps running if you close the page.</li>
          <li><b>Every answer shows its evidence:</b> the exact sentence, how sure the AI is, and a link to the original filing.</li>
        </ul>
      </section>

      <section aria-labelledby="h-detect">
        <h2 id="h-detect">What FilingLens detects <span className="tag">{detectors.length} AI detectors · every one is tested on filings it never saw; “Experimental” ones have thinner testing</span></h2>
        <div className="det-grid">
          {detectors.map((d) => (
            <article key={d.key} className={`card det tone-${d.tone}`}>
              <div className="det-head">
                <span className={`dicon t-${d.tone}`} aria-hidden="true">{d.icon}</span>
                <div>
                  <h3>{d.title} {d.experimental && <span className="pill exp">Experimental</span>}</h3>
                  <p className="muted small">Form 8-K Item {d.item}</p>
                </div>
              </div>
              <p>{d.what}</p>
              <dl className="det-metrics">
                {d.metrics.map((m) => (
                  <div key={m.label}><dd>{m.value}</dd><dt>{m.label}</dt></div>
                ))}
              </dl>
              <p className="muted small"><b>Tested on:</b> {d.tested}.{d.caveat ? ` ${d.caveat}` : ''}</p>
            </article>
          ))}
        </div>
        <details className="soon">
          <summary>Coming next ({comingSoon.length})</summary>
          <ul>
            {comingSoon.map((c) => (
              <li key={c.title}><b>{c.title}</b> <span className="muted">Item {c.item}: {c.status}</span></li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-labelledby="h-proof">
        <h2 id="h-proof">Closer look at one detector: CEO changes <span className="tag">Tested on {march.period.label}, a month the AI never saw during training</span></h2>
        <p className="note">The CEO detector is the one tested most thoroughly, so it is used here to show how every detector is measured. The scores for all {detectors.length} are in the cards above and in Model notes.</p>
        <div className="grid-4">
          <Stat big={pct(m.appointed.precision, 0)} title="of “new CEO” alerts were right" tone="green">
            {m.appointed.tp} of {m.appointed.tp + m.appointed.fp} appointment alerts were genuine. Only {m.appointed.fp} false alarms.
          </Stat>
          <Stat big={pct(m.appointed.recall, 0)} title="of real new-CEO news was caught" tone="blue">
            Found {m.appointed.tp} of {apptReal} real appointments. The other {m.appointed.fn} slipped past.
          </Stat>
          <Stat big={pct(m.resigned.precision, 0)} title="of “CEO leaving” alerts were right" tone="green">
            {m.resigned.tp} of {m.resigned.tp + m.resigned.fp} departure alerts were genuine. Only {m.resigned.fp} false alarms.
          </Stat>
          <Stat big={pct(m.resigned.recall, 0)} title="of real departures were caught" tone="violet">
            Found {m.resigned.tp} of {resgReal} real departures. Departures are harder because they are phrased in more ways.
          </Stat>
        </div>
        <p className="note">
          Think of it as a careful assistant: when it raises its hand, it is almost always right. It is a little more cautious than perfect, so it occasionally misses a case.
        </p>
      </section>

      <section aria-labelledby="h-dots">
        <h2 id="h-dots">CEO example: every real CEO event in {march.period.label}, and what the AI did with it</h2>
        <div className="grid-2">
          <div className="card">
            <h3>New CEO named — {apptReal} real events</h3>
            <Dots found={m.appointed.tp} missed={m.appointed.fn} label="New CEO named" />
            <p className="legend">
              <span className="dot found" /> found ({m.appointed.tp}) <span className="dot miss" /> missed ({m.appointed.fn})
              <span className="pill warn">+{m.appointed.fp} false alarms</span>
            </p>
          </div>
          <div className="card">
            <h3>CEO leaving — {resgReal} real events</h3>
            <Dots found={m.resigned.tp} missed={m.resigned.fn} label="CEO leaving" />
            <p className="legend">
              <span className="dot found" /> found ({m.resigned.tp}) <span className="dot miss" /> missed ({m.resigned.fn})
              <span className="pill warn">+{m.resigned.fp} false alarms</span>
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-funnel">
        <h2 id="h-funnel">From a mountain of filings to a short list <span className="tag">CEO example</span></h2>
        <div className="funnel">
          <div className="funnel-step" style={{ ['--w' as string]: '100%' }}>
            <b>{num(f.filings)}</b>
            <span>8-K filings filed in {march.period.label}</span>
          </div>
          <div className="funnel-step" style={{ ['--w' as string]: '62%' }}>
            <b>{num(f.withItem502)}</b>
            <span>mention a change in directors or officers (the filings the CEO detector reads closely)</span>
          </div>
          <div className="funnel-step" style={{ ['--w' as string]: '34%' }}>
            <b>{flagged}</b>
            <span>CEO events flagged (new CEO named or CEO leaving)</span>
          </div>
          <div className="funnel-step good" style={{ ['--w' as string]: '28%' }}>
            <b>{correct}</b>
            <span>confirmed correct · {falseAlarms} false alarms</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-prog">
        <h2 id="h-prog">How the best model was chosen <span className="tag">CEO example</span></h2>
        <div className="grid-2 tight">
          <div className="card">
            <h3>CEO detector: overall accuracy score on four unseen months</h3>
            <BarChart bars={progress} min={0.8} max={0.875} ariaLabel="Overall accuracy score of each model generation, rising from 0.8126 to 0.8673" />
          </div>
          <div className="card">
            <h3>The winner for CEO changes: one reader that sees the whole section</h3>
            <p>
              The earlier winner was a panel of three AI readers that each judged one sentence at a time. It has been replaced by a single <strong>RoBERTa-large</strong> reader
              that reads all the CEO-related sentences of the section together, so it can tell “will continue as CEO” from a real change using the sentences around it.
            </p>
            <p className="muted">
              Trained on 8,019 real filings and tested on 1,070 filings from four months it never saw, it beat the old panel on both questions: new CEO <strong>0.920</strong> (was 0.873) and CEO leaving <strong>0.868</strong> (was 0.794).
            </p>
            <a className="btn" href="#/models">Read the full comparison</a>
          </div>
        </div>
      </section>
    </>
  )
}
