// The detectors that run on the site, with the held-out results recorded in the project logs.
// Sources: ml/IMPROVEMENT_LOG.md (CEO), ml/items/_distress/TRACKER.md (1.03, 3.01), ml/items/TRACKER_401_507.md (4.01, 5.07).

export interface DetectorInfo {
  key: string
  item: string
  title: string
  icon: string
  tone: 'blue' | 'red' | 'amber' | 'violet' | 'green'
  what: string
  model: string
  tested: string
  metrics: { label: string; value: string }[]
  caveat?: string
  experimental?: boolean
}

export const detectors: DetectorInfo[] = [
  {
    key: 'ceo',
    item: '5.02',
    title: 'CEO appointed or leaving',
    icon: '👤',
    tone: 'green',
    what: 'Finds when a company names a new CEO (including interim) or its CEO resigns, retires or is replaced.',
    model: 'One RoBERTa-large reader on the whole leadership section. It sees only the sentences that mention a CEO title, with dates converted to "days before filing".',
    tested: 'Four months never used in training (June 2024, June 2025, Nov 2025, May 2026): 1,070 filings, 546 hand-checked CEO events',
    metrics: [
      { label: 'New CEO: alerts that were right', value: '87.0%' },
      { label: 'New CEO: real events found', value: '97.5%' },
      { label: 'CEO leaving: alerts that were right', value: '82.1%' },
      { label: 'CEO leaving: real events found', value: '92.0%' },
    ],
    caveat: 'Misses far fewer real events than the old three-reader panel (found 92% of departures, was 75%) but raises more false alarms. F1: new CEO 0.920, leaving 0.868 (old panel: 0.873 and 0.794 on the same filings).',
  },
  {
    key: 'bankruptcy',
    item: '1.03',
    title: 'Bankruptcy or receivership',
    icon: '⚖',
    tone: 'red',
    what: 'Finds new bankruptcy petitions, receiverships, confirmed reorganization plans and converted or dismissed cases. Pulls out the chapter, court and case number.',
    model: 'Two AI readers (RoBERTa-large + DeBERTa-v3) average their answers on the whole section. Dates are converted to "days before filing" so it can tell new events from old recaps.',
    tested: '149 real events across 7 held-out windows (2024–2026)',
    metrics: [
      { label: 'Alerts that were right', value: '94.7%' },
      { label: 'Real events found', value: '96.0%' },
      { label: 'Held-out events tested', value: '149' },
    ],
    caveat: 'Receivership has only 9 test events. Small samples.',
  },
  {
    key: 'delisting',
    item: '3.01',
    title: 'Delisting or listing notice',
    icon: '⇩',
    tone: 'amber',
    what: 'Finds exchange deficiency notices (such as a share price below $1), delistings, voluntary delistings, exchange transfers and regained compliance. Pulls out the exchange, rule and cure deadline.',
    model: 'Three AI readers (RoBERTa-large ×2 + DeBERTa-v3) average their answers on the whole section.',
    tested: '477 real events across 4 held-out months, hand-checked where labelers disagreed',
    metrics: [
      { label: 'Deficiency notice: right / found', value: '97% / 92%' },
      { label: 'Delisted by exchange: right / found', value: '90% / 89%' },
      { label: 'Voluntary delisting: right / found', value: '95% / 99%' },
      { label: 'Compliance regained: right / found', value: '87% / 100%' },
    ],
    caveat: 'Exchange transfers are the weakest (74% right) and have only 19 test events.',
  },
  {
    key: 'auditor',
    item: '4.01',
    title: 'Change of auditor',
    icon: '✎',
    tone: 'violet',
    what: 'Finds when a company dismisses or loses its auditor or engages a new one, and flags any disagreement, reportable event or adverse audit opinion. Names the firms.',
    model: 'A RoBERTa-base reader plus a rule engine, combined: a flag counts if either one raises it.',
    tested: '348 filings across 5 held-out months',
    metrics: [
      { label: 'Auditor dismissed (F1)', value: '0.986' },
      { label: 'Auditor resigned (F1)', value: '0.972' },
      { label: 'New auditor engaged (F1)', value: '0.982' },
      { label: 'Reportable event (F1)', value: '0.981' },
    ],
    caveat: 'The AI scores about the same as the rules it learned from; "disagreement" is too rare to measure.',
  },
  {
    key: 'votes',
    item: '5.07',
    title: 'Shareholder vote results',
    icon: '☑',
    tone: 'blue',
    what: 'Finds what shareholders voted on: directors, auditor, pay, equity plans, mergers, reverse splits, proposals. Flags votes that failed and reads the vote-count tables.',
    model: 'A RoBERTa-base reader plus a rule engine and a vote-table parser.',
    tested: '589 filings from two fresh months (June 2025, June 2026)',
    metrics: [
      { label: 'Directors elected (F1)', value: '0.989' },
      { label: 'Auditor ratified (F1)', value: '0.991' },
      { label: 'Say-on-pay (F1)', value: '0.994' },
      { label: 'A proposal failed (F1)', value: '0.857' },
    ],
    caveat: 'Mergers and adjournments are weaker (F1 about 0.77–0.78).',
  },
  {
    key: 'cfo',
    item: '5.02',
    title: 'CFO appointed or leaving',
    icon: '👔',
    tone: 'green',
    what: 'Finds when a company names a new CFO (including interim or acting) or its CFO resigns, retires or is replaced. Names the person where the text allows.',
    model: 'Four RoBERTa-large readers, each trained on three of four hand-checked months, average their answers. Only sentences that mention a CFO title are read, and dates are converted to "days before filing".',
    tested: 'Month-by-month cross-validation: each model scored on a month it never saw (410 appointments, 356 departures)',
    metrics: [
      { label: 'New CFO: alerts that were right', value: '95.8%' },
      { label: 'New CFO: real events found', value: '93.7%' },
      { label: 'CFO leaving: alerts that were right', value: '88.6%' },
      { label: 'CFO leaving: real events found', value: '91.3%' },
    ],
    caveat: 'These are the cross-validation numbers; the four models together have not been scored as one group.',
    experimental: true,
  },
  {
    key: 'acquisition',
    item: '2.01',
    title: 'Acquisition or sale of assets completed',
    icon: '🤝',
    tone: 'blue',
    what: 'Finds when a deal closes and tells you which way it went: the company bought something, sold something, or was itself acquired.',
    model: 'A RoBERTa-base reader spots the closing sentence. A RoBERTa-large reader decides the direction by reading the company name, the introduction and the section together, with the company\'s own name replaced by "FILER".',
    tested: 'Four dev months (394 filings) for "deal completed"; 305 filings with a known direction',
    metrics: [
      { label: 'Deal completed (F1)', value: '0.949' },
      { label: 'Direction correct', value: '90.2%' },
      { label: 'Our spot check: completed, right / found', value: '95% / 98%' },
      { label: 'Our spot check: direction (39 filings)', value: '82%' },
    ],
    caveat: 'Those months were used to tune the rules, so the first two figures are slightly optimistic. "Who bought whom" is the hardest part.',
    experimental: true,
  },
  {
    key: 'agreements',
    item: '1.01 / 1.02',
    title: 'Material agreement entered or ended',
    icon: '📄',
    tone: 'violet',
    what: 'Finds new material agreements (loans, mergers, supply deals) and agreements that end. Guesses the type, the counterparty and the amount.',
    model: 'Two RoBERTa-base readers: one spots "entered" or "terminated" sentences, one labels the type of agreement.',
    tested: 'Four dev months, 689 filings with an LLM answer key',
    metrics: [
      { label: 'Agreement entered (F1)', value: '0.936' },
      { label: 'Agreement ended (F1)', value: '0.875' },
      { label: 'Our spot check: entered, right / found', value: '98% / 97%' },
      { label: 'Our spot check: ended, right / found', value: '88% / 82%' },
    ],
    caveat: 'The agreement type is no better than simple rules (F1 0.745 vs 0.764), so treat it as a hint.',
    experimental: true,
  },
  {
    key: 'equity',
    item: '3.02',
    title: 'Unregistered sale of equity securities',
    icon: '📈',
    tone: 'amber',
    what: 'Finds private placements and other unregistered share sales, the kind of security, and pulls out the proceeds, price and the legal exemption used.',
    model: 'Two RoBERTa-base readers: one spots sale sentences, one labels the security type (common, preferred, notes, warrants, units, awards).',
    tested: 'Only checked against its own rule-made labels (F1 0.98) plus a 12-filing hand check where the sale flag was right 10 times',
    metrics: [
      { label: 'Sale flag (own labels, F1)', value: '0.98' },
      { label: 'Security type (own labels, F1)', value: '0.98' },
      { label: 'Hand check, sale flag right', value: '10 of 12' },
    ],
    caveat: 'Early model: no independent accuracy measure yet. Those two F1 scores are circular because the labels came from rules.',
    experimental: true,
  },
  {
    key: 'guidance',
    item: '2.02',
    title: 'Earnings guidance direction',
    icon: '📊',
    tone: 'blue',
    what: 'Reads the earnings press release attached to an 8-K and says whether the company raised, lowered, reaffirmed or withdrew its outlook.',
    model: 'A RoBERTa-large reader on the first part of the press release (it sees about the first 400 words).',
    tested: '821 press releases from two held-out months (March and June 2025)',
    metrics: [
      { label: 'Overall accuracy', value: '90.6%' },
      { label: 'Macro-F1 (balance over 5 outcomes)', value: '0.770' },
    ],
    caveat: '"Lowered" is the weakest outcome (only 10 test examples).',
    experimental: true,
  },
  {
    key: 'restructuring',
    item: '2.05 / 2.06',
    title: 'Restructuring, exit costs or impairment',
    icon: '🏭',
    tone: 'red',
    what: 'Classifies what kind of restructuring or impairment a company announced: layoffs, a closure, a divestiture, a discontinued product or a write-down. Shows the largest amount mentioned.',
    model: 'A RoBERTa-large reader on the whole Item text (the strongest of three seeds; averaging seeds did not help).',
    tested: '215 filings held out from 1,428, a random split rather than separate months',
    metrics: [
      { label: 'Accuracy', value: '95.4%' },
      { label: 'Macro-F1 (balance over 6 types)', value: '0.864' },
    ],
    caveat: 'Random split, so slightly optimistic compared with testing on a later month.',
    experimental: true,
  },
]

export const comingSoon: { title: string; item: string; status: string }[] = [
  { title: 'CFO model as one frozen, scored model', item: '5.02', status: 'A single model trained on all four hand-checked months is still training' },
  { title: 'Restatements (non-reliance)', item: '4.02', status: 'Planned, not started' },
  { title: 'Cybersecurity incidents', item: '1.05', status: 'Planned, not started' },
  { title: 'Other events', item: '8.01', status: 'Planned, not started' },
]
