import { comingSoon, detectors } from '../data/detectors'

export default function Overview() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">FilingLens</span>
        <h1>See what happened in any SEC 8-K filing.</h1>
        <p className="lead">AI reads the filing. You get the answer and the sentence it came from.</p>
        <div className="hero-actions">
          <a className="btn primary" href="#/search">Search filings</a>
          <a className="btn" href="#/build">How it works</a>
        </div>
        <ul className="hero-points">
          <li><b>{detectors.length} AI detectors</b> run on every filing.</li>
          <li><b>Analyze hundreds of filings</b> into one spreadsheet.</li>
          <li><b>Every answer shows its evidence</b> and links to the SEC.</li>
        </ul>
      </section>

      <section aria-labelledby="h-detect">
        <h2 id="h-detect">What it detects</h2>
        <div className="det-grid">
          {detectors.map((d) => (
            <article key={d.key} className={`card det tone-${d.tone}`}>
              <div className="det-head">
                <span className={`dicon t-${d.tone}`} aria-hidden="true">{d.icon}</span>
                <div>
                  <h3>{d.title} {d.experimental && <span className="pill exp">Experimental</span>}</h3>
                  <p className="muted small">Item {d.item}</p>
                </div>
              </div>
              <p>{d.what}</p>
              <dl className="det-metrics">
                {d.metrics.slice(0, 2).map((x) => (
                  <div key={x.label}><dd>{x.value}</dd><dt>{x.label}</dt></div>
                ))}
              </dl>
              <details className="more">
                <summary>How it was tested</summary>
                <p className="muted small">{d.tested}.{d.caveat ? ` ${d.caveat}` : ''}</p>
              </details>
            </article>
          ))}
        </div>
        <details className="soon">
          <summary>Coming next ({comingSoon.length})</summary>
          <ul>
            {comingSoon.map((c) => (
              <li key={c.title}><b>{c.title}</b> <span className="muted">Item {c.item}</span></li>
            ))}
          </ul>
        </details>
      </section>

      <p className="note"><a href="#/build">How it was built</a> · <a href="#/results">CEO examples</a> · <a href="#/notes">Every metric</a></p>
    </>
  )
}
