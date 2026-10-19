import BarChart from '../components/BarChart'

const candidates = [
  { label: 'Mixed team: RoBERTa-large ×2 + DeBERTa ×1', value: 0.8673, highlight: true, sub: 'Chosen' },
  { label: 'RoBERTa-large ×3', value: 0.8537, sub: 'Three copies of one design' },
  { label: 'RoBERTa-large (one)', value: 0.847 },
  { label: 'RoBERTa-base ×3', value: 0.839 },
  { label: 'RoBERTa-base (one)', value: 0.8207 },
  { label: 'DistilBERT v7 (one)', value: 0.8126, sub: 'Earlier best' },
]

const explain = [
  ['Why a team?', 'Different AI designs make different mistakes. When they vote, one model’s slip is outvoted by the others, so the team is steadier than any single member.'],
  ['Why mixed?', 'Three copies of the same design tend to make the same mistakes together. Swapping one for a different design (DeBERTa) fixed more errors, and it won in all four test months.'],
  ['Why a 70% confidence bar?', 'Requiring each vote to be fairly sure reduces false alarms. Testing 0.5 up to 0.88 showed 0.7 gave the best balance.'],
]

const failed = [
  ['Training on more data', 'Added six evaluated months to training. Precision fell about 20 points.'],
  ['Many hand-made rules', 'Looked better in practice tests, worse on new months. The model memorised the rules.'],
  ['Showing neighbouring sentences', 'Tried four times. Always caught more events but raised far too many false alarms.'],
  ['Finance-specialised models', 'SEC-BERT and FinBERT sounded ideal but scored lower than general-purpose models here.'],
]

export default function ModelLab() {
  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Model selection</span>
        <h1>Why these models</h1>
        <p className="lead">
          Dozens of models and variations were built and tested for each type of event. Each was graded on months it had never seen. FilingLens uses the best honestly-measured one for each. The CEO detector, the most thoroughly tuned, is shown below; the full list is under Model notes.
        </p>
      </section>

      <section className="grid-2 tight">
        <div className="card">
          <h3>CEO detector: overall score of the strongest candidates</h3>
          <p className="muted small">Average F1 across four unseen months (March, May, June, August 2025). 1.0 would be perfect.</p>
          <BarChart bars={candidates} min={0.8} max={0.875} ariaLabel="Overall score of each candidate model; the mixed team scores highest at 0.8673" />
        </div>
        <div className="card">
          <h3>The chosen CEO model in numbers</h3>
          <table className="kv">
            <tbody>
              <tr><th>Design</th><td>1× RoBERTa-large reading the whole section</td></tr>
              <tr><th>Decision rule</th><td>Probability ≥ 50% per label</td></tr>
              <tr><th>New CEO score</th><td>F1 0.920 (old panel 0.873)</td></tr>
              <tr><th>CEO leaving score</th><td>F1 0.868 (old panel 0.794)</td></tr>
              <tr><th>Test</th><td>1,070 filings from 4 unseen months, hand-checked</td></tr>
              <tr><th>Speed</th><td>One pass per filing instead of one per sentence</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Why it works</h2>
        <div className="grid-3">
          {explain.map(([t, d]) => (
            <div className="card" key={t}>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>The trade-off every detector faces</h2>
        <div className="card tradeoff">
          <div>
            <b>Strict</b>
            <p>Flags only when very sure. Few false alarms, but real events get missed.</p>
          </div>
          <div className="slider" aria-hidden="true"><span /></div>
          <div>
            <b>Generous</b>
            <p>Flags anything plausible. Catches nearly everything, but many false alarms.</p>
          </div>
        </div>
        <p className="note">The CEO model leans slightly strict: about 95% of its alerts are right and it finds about 80–85% of real events. Other detectors sit at their own points on this scale; see the cards on the Overview.</p>
      </section>

      <section>
        <h2>What was tried and did not help</h2>
        <div className="grid-2">
          {failed.map(([t, d]) => (
            <div className="card fail" key={t}>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
        <p className="note">Full numbers for every model are in <a href="#/notes">Model notes</a>.</p>
      </section>
    </>
  )
}
