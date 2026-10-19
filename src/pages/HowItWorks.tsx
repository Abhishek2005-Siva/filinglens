import Highlight from '../components/Highlight'

const example =
  'On February 28, 2025, the Board of Directors of Douglas Dynamics, Inc. elected Mark Van Genderen, the Company’s then-current Chief Operating Officer, as President and Chief Executive Officer of the Company and a member of the Company’s Board, effective March 3, 2025.'

const steps = [
  {
    n: 1,
    title: 'Find the filing',
    body: 'Search the SEC’s public filings database by company, date, keywords or type of event. You see the same filings you would find on sec.gov.',
  },
  {
    n: 2,
    title: 'Download and split it into sections',
    body: 'Every 8-K is organised in numbered “Items”: 5.02 is leadership changes, 1.03 bankruptcy, 2.01 completed acquisitions, 3.01 delisting, 4.01 auditors, 5.07 shareholder votes, and more. We cut the filing into those sections so each detector only reads the part that matters.',
  },
  {
    n: 3,
    title: 'Send each section to the right AI readers',
    body: 'Each type of event has its own AI detector, trained on real filings, and every filing is checked by all eleven of them. Each only speaks up when its Item is in the filing. CEO changes are read by one reader that sees all the CEO-related sentences of the section together. Bankruptcy, delisting and CFO changes are read as a whole by several readers that average their answers. Acquisitions, agreements, equity sales and restructuring each have their own readers, and earnings guidance is read from the attached press release.',
  },
  {
    n: 4,
    title: 'Double-check with rules where it helps',
    body: 'Some detectors pair the AI with plain rules (for example, for auditor changes and vote tables). Rules also pull out details the AI does not: the court and case number in a bankruptcy, the exchange and deadline in a delisting notice, the firms in an auditor change.',
  },
  {
    n: 5,
    title: 'Show the evidence',
    body: 'You get a short list of what happened, how sure the AI is, which readers agreed, and the exact sentence it relied on, with a link to the original filing so you can verify anything in seconds.',
  },
]

const glossary = [
  ['8-K', 'A short report US public companies file with the SEC when something important happens.'],
  ['Item', 'Form 8-K is split into numbered sections called Items. Each Item covers one kind of event, for example 5.02 for leadership changes.'],
  ['Precision', 'When the AI says “this event happened”, how often is it right? High precision means few false alarms.'],
  ['Recall', 'Of all the events that really happened, how many did the AI find? High recall means few misses.'],
  ['F1 score', 'One number (0 to 1) that balances precision and recall. Higher is better.'],
  ['Answer key', 'The correct answers we score against. Here, an independent large AI model labelled every filing separately.'],
  ['Held-out month', 'A month of filings the AI never saw while learning, like an exam with new questions.'],
  ['Ensemble', 'Several models voting together. Usually steadier than any single one.'],
]

export default function HowItWorks() {
  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Plain-English walkthrough</span>
        <h1>How FilingLens turns a long, technical filing into a short, checkable answer</h1>
      </section>

      <ol className="steps">
        {steps.map((s) => (
          <li key={s.n} className="card step">
            <span className="step-n">{s.n}</span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <section aria-labelledby="h-ex">
        <h2 id="h-ex">A real example: a CEO appointment</h2>
        <div className="card example">
          <p className="quote">
            <Highlight text={example} names={['Mark Van Genderen']} />
          </p>
          <div className="vote">
            {['Reader A', 'Reader B', 'Reader C'].map((r) => (
              <div key={r} className="voter">
                <span className="check" aria-hidden="true">✓</span>
                <b>{r}</b>
                <span>“New CEO named”</span>
              </div>
            ))}
            <div className="verdict good">
              <b>Result: New CEO named</b>
              <span>Confidence 99.96% · Mark Van Genderen · Douglas Dynamics, March 2025</span>
            </div>
          </div>
          <p className="muted small">The sentence and confidence are real output from the March 2025 run. The three-reader panel is simplified for illustration.</p>
        </div>
      </section>

      <section aria-labelledby="h-trick">
        <h2 id="h-trick">What makes this hard</h2>
        <div className="grid-3">
          <div className="card">
            <h3>Look-alikes</h3>
            <p>“Mr. Lee will <em>continue to serve</em> as CEO” sounds like CEO news but means nobody changed. In the same way, a filing that only <em>mentions</em> an old bankruptcy or an earlier delisting notice is not a new event. Many early mistakes were exactly this.</p>
          </div>
          <div className="card">
            <h3>Old news and other companies</h3>
            <p>“…to focus on his role as CEO of Acme Corp” is about a different company, and a recap of last year’s lawsuit is not today’s. The AI has to know who and when. Dates in a filing are turned into “days before filing” so it can tell.</p>
          </div>
          <div className="card">
            <h3>Many ways to say one thing</h3>
            <p>“Moving to Executive Chairman” means the CEO is leaving the CEO job, even though nobody “resigned”. And “guidance is expected to increase” is not quite “guidance raised”. Detectors read the whole wording, and the evidence sentence lets you judge.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-gl">
        <h2 id="h-gl">Glossary</h2>
        <dl className="glossary">
          {glossary.map(([t, d]) => (
            <div key={t} className="card">
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  )
}
