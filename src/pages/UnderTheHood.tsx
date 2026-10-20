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

      <section aria-labelledby="h-names" className="grid-2 tight">
        <div>
          <h2 id="h-names">Reading names and dates</h2>
          <div className="card">
            <BarChart bars={reading} min={0.7} max={1} format={(v) => `${Math.round(v * 100)}%`} ariaLabel="Share of names and dates read correctly on filings the model never saw" />
          </div>
        </div>
        <div>
          <h2>Finding the best CEO model</h2>
          <div className="card">
            <BarChart bars={journey} min={0.8} max={0.875} ariaLabel="Overall score of each CEO model generation, rising from 0.8126 to 0.8673" />
          </div>
        </div>
      </section>

      <section aria-labelledby="h-next">
        <h2 id="h-next">What is next <span className="pill exp">Planned</span></h2>
        <ol className="aloop small">
          <li><Node icon="🔎" title="Filter" sub="which filings have an event" tone="blue" /><Arrow /></li>
          <li><Node icon="👀" title="Two readers" sub="trained model + LLM" tone="green" /><Arrow /></li>
          <li><Node icon="✅" title="Checks" sub="text, dates, names" tone="violet" /><Arrow /></li>
          <li className="split">
            <Node icon="✔" title="Agree: accept" tone="green" />
            <Node icon="🚩" title="Disagree: review" tone="amber" />
          </li>
        </ol>
      </section>

      <p className="note">AI can be wrong. Every answer shows the sentence it used and links to the SEC filing, so you can check it.</p>
    </>
  )
}
