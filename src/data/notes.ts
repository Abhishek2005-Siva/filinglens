// Every model built and tested so far, with every metric recorded in the project logs.
// Sources: ml/IMPROVEMENT_LOG.md (CEO detector, Item 5.02), ml/items/_distress/TRACKER.md (1.03 / 3.01),
// ml/items/TRACKER_401_507.md (4.01 / 5.07), ml/items/f5_common/EXPERIMENTS.md (2.01 / 1.01 / 1.02).
// P = precision, R = recall, F1 = balance of the two. "—" = not reported in the logs.

export interface NoteTable {
  id: string
  title: string
  intro?: string
  columns: string[]
  rows: string[][]
  footnote?: string
}

export interface NoteGroup {
  id: string
  title: string
  summary: string
  tables: NoteTable[]
}

export const noteGroups: NoteGroup[] = [
  {
    id: 'site-models',
    title: 'Models running on FilingLens (selected as the best for each event type)',
    summary:
      'For each type of event the best honestly-measured model was chosen (held-out months, fixed 0.5 threshold unless noted). All run on CPU on the model server. Adapters are fine-tuned LoRA layers stored privately; the public base models are RoBERTa and DeBERTa-v3.',
    tables: [
      {
        id: 'site-selected',
        title: 'Selected models, what they read, and how they were chosen',
        columns: ['Event type', 'Item', 'Model deployed', 'Input to the model', 'Decision rule', 'Why this one'],
        rows: [
          ['CEO appointed / leaving', '5.02', 'RoBERTa-large (seed 42, LoRA r=32) trained on 8,019 real filings', 'Only the sentences of the section that mention a CEO title (max 448 tokens), dates written as “[D-3]”', 'Probability ≥ 0.5 per label', 'Beat the earlier three-reader panel on the same 1,070 held-out filings: new CEO F1 0.920 vs 0.873, leaving 0.868 vs 0.794'],
          ['Bankruptcy / receivership', '1.03', 'RoBERTa-large (seed 42) + DeBERTa-v3-base (seed 42), both with date-offset input', 'The whole Item section (up to 1,900 characters), dates written as “[D-54]” = days before filing', 'Mean probability ≥ 0.5 per label', 'Mixed architecture beat same-architecture seed ensembles; 94.7% right / 96.0% found at the fixed 0.5 threshold'],
          ['Delisting / listing notice', '3.01', 'RoBERTa-large (seed 42) + RoBERTa-large (seed 7) + DeBERTa-v3-base (seed 42)', 'The whole Item section, date offsets', 'Mean probability ≥ 0.5 per label', 'Best honest 3.01 ensemble; adding RoBERTa-base lowered exchange-delisting precision'],
          ['Change of auditor', '4.01', 'RoBERTa-base v1 (LoRA r=16) + rule engine', 'One sentence at a time (max 320 tokens)', 'Per-label thresholds tuned on validation; flag if model OR rules', 'RoBERTa-large and DeBERTa were not better and were 2–3× slower'],
          ['Shareholder vote results', '5.07', 'RoBERTa-base v2 (LoRA r=16) + rule engine + vote-table parser', 'One sentence or proposal paragraph at a time; vote tables are parsed separately', 'Per-label thresholds; flag if model OR rules', 'v2 scored on two fresh months, v1 on earlier ones; model ≈ rules, union marginally best'],
          ['CFO appointed / leaving', '5.02', 'RoBERTa-large ×4 (one per hand-checked month fold, r=32)', 'Only CFO-title sentences of the section, dates as “[D-k]”', 'Mean probability ≥ 0.5 per label', 'Best CFO recipe in month-fold validation; no single frozen model exists yet, so the four fold models are averaged'],
          ['Acquisition / sale completed', '2.01', 'RoBERTa-base v2 (sentences) + RoBERTa-large doc2 seed 42 (direction)', 'Sentences from the section and the Introductory Note with the filer replaced by FILER; direction model reads company + intro + section', 'A sentence counts at ≥ 0.5; direction = most likely class of the filing-level model', 'Bigger encoders did not help the sentence model; the filing-level direction model reached 90.2%, ensembles added nothing'],
          ['Material agreements', '1.01 / 1.02', 'RoBERTa-base v2 event model + RoBERTa-base v2 type model', 'One sentence at a time (max 256 tokens)', '≥ 0.5; the most confident sentence per event stands for the filing', 'Best of the tested variants; the type model is no better than rules'],
          ['Unregistered equity sales', '3.02', 'RoBERTa-base event model + RoBERTa-base v2 type model', 'One sentence at a time (max 256 tokens)', 'Sale if probability ≥ 0.5', 'Only model available; trained on rule-made labels'],
          ['Earnings guidance direction', '2.02', 'RoBERTa-large, 5 classes (INITIATED merged into NONE)', 'First ~6,000 characters of the EX-99 press release (400 tokens)', 'Most likely class', 'Best of base/large and 5/6-class variants (macro-F1 0.770)'],
          ['Restructuring / impairment type', '2.05 / 2.06', 'RoBERTa-large seed 123, 6 classes', 'The Item section text (512 tokens)', 'Most likely class', 'Best single seed; a 3-seed majority vote scored lower (0.829 vs 0.864 macro-F1)'],
        ],
        footnote: 'Selection used the per-item trackers and logs in the training project. Models that were tested but not selected are listed under “Other 8-K item detectors”.',
      },
      {
        id: 'site-metrics',
        title: 'Held-out results for the detectors on the site',
        columns: ['Detector', 'Test set', 'Result'],
        rows: [
          ['CEO (5.02)', 'Four held-out months (Jun 2024, Jun 2025, Nov 2025, May 2026), 1,070 filings, 282 appointed / 264 resigned events, every labeller disagreement hand-adjudicated', 'Appointed P 87.0% R 97.5% F1 0.920 · Resigned P 82.1% R 92.0% F1 0.868 · any event P 81.5% R 98.0%. Earlier three-reader panel on the same filings: 0.873 / 0.794 (it had seen part of the June 2024 and May 2026 filings in training; on the two clean months: 0.886 / 0.794 vs new 0.918 / 0.843)'],
          ['Bankruptcy (1.03)', '149 events, 7 held-out windows (2024–2026)', 'Any event: P 0.947 R 0.960 at 0.5 (threshold-tuned: P 0.959 R 0.946); Petition P 0.962 R 0.935; Plan confirmed P 0.944 R 1.0; Receivership P 1.0 R 0.778 (n = 9)'],
          ['Delisting (3.01)', '477 events, 4 held-out months', 'Deficiency P 0.967 R 0.916 · Exchange delisting P 0.902 R 0.892 · Voluntary P 0.946 R 0.986 · Transfer P 0.739 R 0.895 · Compliance regained P 0.872 R 1.0'],
          ['Auditor (4.01)', '348 filings, 5 held-out months', 'F1: dismissed 0.986 · resigned 0.972 · engaged 0.982 · reportable event 0.981 · opinion modified 0.933; auditor names correct 94% / 91%'],
          ['CFO (5.02)', 'Month-fold validation: 410 appointments / 356 departures', 'Appointed P 0.958 R 0.937 · Resigned P 0.886 R 0.913 · any P 0.936 R 0.958 (roberta-large fold models, fixed 0.5)'],
          ['Acquisition (2.01)', 'Four dev months, 394 filings (tuned-on)', 'Deal completed F1 0.949 · direction accuracy 90.2% on 305 filings · our spot check on 52 filings: completed P 0.951 R 0.975, direction 82% of 39'],
          ['Agreements (1.01/1.02)', 'Four dev months, 689 filings', 'Entered F1 0.936 · terminated F1 0.875 · type F1 0.745 (rules 0.764) · our spot check on 70 filings: entered P 0.983 R 0.966, terminated P 0.875 R 0.824'],
          ['Equity sales (3.02)', 'Rule-made labels + 12 filings hand-checked', 'Sale flag F1 0.98 and type F1 0.98 on its own labels (circular); sale flag right on 10 of 12 hand-checked filings'],
          ['Guidance (2.02)', '821 press releases, March and June 2025', 'Accuracy 0.906, macro-F1 0.770; lowered is the weakest class (10 examples)'],
          ['Restructuring (2.05/2.06)', '215 filings (random 85/15 split)', 'Accuracy 0.954, macro-F1 0.864 (seed 123); 3-seed vote macro-F1 0.829'],
          ['Votes (5.07)', '589 filings, June 2025 and June 2026', 'F1: directors 0.989 · auditor 0.991 · say-on-pay 0.994 · frequency 0.981 · equity plan 0.964 · charter 0.850 · merger 0.769 · share issuance 0.793 · shareholder proposal 0.958 · adjournment 0.780 · special meeting 0.912 · any failed 0.857'],
        ],
      },
    ],
  },
  {
    id: 'ceo-history',
    title: 'CEO detector — version history (Item 5.02)',
    summary:
      'Every version of the CEO appointed / resigned detector, in the order it was built. Each was scored on a month it had never seen, against the independent answer key. Numbers are Precision / Recall / F1.',
    tables: [
      {
        id: 'versions',
        title: 'All versions and their out-of-time results',
        intro:
          'Left half = Appointed, right half = Resigned. Note: each version was tested on a different month, so rows are not directly comparable (see the controlled comparison below for a fair head-to-head).',
        columns: [
          'Version',
          'What it was',
          'Test month',
          'Appt P',
          'Appt R',
          'Appt F1',
          'Resg P',
          'Resg R',
          'Resg F1',
          'Verdict',
        ],
        rows: [
          ['v1', 'DistilBERT + LoRA, 204 training / 36 validation sentences (one week of 2024)', 'Internal val (tiny)', '60.0', '100', '0.75', '50.0', '50.0', '0.50', 'Smoke test only — 2–3 examples per class. Accuracy 0.889, macro-F1 0.728 (NONE 0.97/0.90/0.93)'],
          ['pre-v2', 'DistilBERT, Q1-2026 NVIDIA-labelled data', '2026 Q1', '80.0', '88.9', '0.842', '90.7', '58.8', '0.713', 'Baseline before v2'],
          ['v2', 'Full-year 2024 regex scan + Q1-2026 data; CFO/COO/director hard negatives. 5,317 train / 951 val', 'May 2026 (77 appt / 68 resg)', '83.3', '84.4', '0.839', '73.7', '82.4', '0.778', 'Better. Internal macro-F1 0.95'],
          ['v3', '+ "continuation" hard negatives ("will continue to serve as CEO"). 5,331 / 951', 'Jun 2026 (76 / 70)', '82.7', '88.2', '0.854', '83.8', '88.6', '0.861', 'Resigned precision +10 pts. Internal macro-F1 0.89'],
          ['v4', '+ cross-entity ("CEO of another company"), negation, "in addition to". 6,137 / 1,090', 'Jul 2026 (73 / 66)', '84.7', '83.6', '0.841', '78.7', '72.7', '0.756', 'Regression on Resigned (a "has served as" rule suppressed real departures). Internal macro-F1 0.93'],
          ['v5', 'Reverted the v4 "has served as" rule. 6,154 / 1,093', 'Aug 2026 (84 / 71)', '92.4', '86.9', '0.896', '81.4', '80.3', '0.809', 'Fixed. Internal macro-F1 0.90. 25 filings excluded (answer key itself failed)'],
          ['v6', 'Fixed sentence-splitter bug (company suffix + "(the Company)")', 'Sep 2025 (73 / 67)', '95.65', '90.41', '0.930', '86.21', '74.63', '0.800', 'First time Appointed cleared 95% precision. Internal macro-F1 0.91'],
          ['v7', 'Gerund ("remaining") + subsidiary-CEO fixes. 6,133 / 1,091', 'Oct 2025 (85 / 78)', '92.68', '89.41', '0.910', '90.14', '82.05', '0.859', 'Best single DistilBERT model. Internal macro-F1 0.91'],
          ['v8 (batch 32)', 'Added 6 evaluated months to training → 11,588 / 2,083 rows; GPU batch 32', 'Nov 2025 (75 / 67)', '71.84', '98.67', '0.831', '71.25', '85.07', '0.776', 'Regression: precision collapsed. Internal macro-F1 0.895'],
          ['v8 (batch 8)', 'Same data, corrected batch size', 'Nov 2025 (75 / 67)', '81.52', '100', '0.898', '77.03', '85.07', '0.809', 'Partly recovered; bigger data still hurt precision'],
          ['v9', 'Back to v7 data scale + Chairman-verb and future-search fixes. 6,103 / 1,086', 'Dec 2025 (83 / 71)', '85.23', '90.36', '0.877', '88.24', '84.51', '0.863', 'Resigned good, Appointed dipped. Internal macro-F1 0.9016'],
          ['v10', '+ past-tense-bio and additional-role fixes. 6,097 / 1,084', 'Jun 2025 (74 / 75)', '80.95', '91.89', '0.861', '68.24', '77.33', '0.725', 'Worst out-of-time result since v5 despite best internal macro-F1 (0.9163) → overfitting to hand-made rules'],
          ['v11', 'Sentence-window context (neighbours joined with |||). 2,772 rows', 'Jul 2025 (93 / 88)', '78.38', '91.58', '0.845', '54.49', '96.59', '0.697', 'Severe regression: model learned the "Item 5.02" heading as a shortcut'],
          ['v12', 'v11 + heading excluded', 'Jul 2025 (93 / 88)', '78.50', '88.42', '0.832', '57.14', '90.91', '0.702', 'Barely moved — windowing itself is the problem'],
          ['v13 (March)', 'Target-marked windowing (CEOTARGETSTART…END). 2,966 / 526 rows', 'Mar 2025', '85.9', '81.0', '—', '69.4', '86.2', '—', 'Regression vs v7 (96.7/82.9 · 78.5/71.3)'],
          ['v13 (August)', 'same', 'Aug 2025', '74.7', '69.4', '—', '57.3', '85.9', '—', 'Regression vs v7 (89.2/75.5 · 89.1/73.1). Windowing declared exhausted'],
        ],
      },
      {
        id: 'july-controlled',
        title: 'Controlled comparison — v6 vs v7 vs v9 vs v10 on the SAME month',
        intro: 'July 2025, 93 appointed / 88 resigned real events. The only fair head-to-head of the DistilBERT line.',
        columns: ['Version', 'Appt P', 'Appt R', 'Appt F1', 'Resg P', 'Resg R', 'Resg F1', 'Combined F1'],
        rows: [
          ['v6', '88.89', '84.21', '0.865', '80.61', '89.77', '0.850', '0.857'],
          ['v7 (winner)', '94.38', '88.42', '0.913', '84.09', '84.09', '0.841', '0.877'],
          ['v9', '84.16', '89.47', '0.867', '82.61', '86.36', '0.844', '0.856'],
          ['v10', '86.87', '90.53', '0.887', '82.11', '88.64', '0.853', '0.870'],
        ],
      },
      {
        id: 'seed-variance',
        title: 'Seed-variance check — how much is just luck?',
        intro: 'Same v7 dataset, only the random seed changed. A single seed moved the score by 0.016 — so differences under ~2 points are noise.',
        columns: ['Model', 'Appt P', 'Appt R', 'Appt F1', 'Resg P', 'Resg R', 'Resg F1', 'Combined F1'],
        rows: [
          ['v7 seed 42', '94.38', '88.42', '0.913', '84.09', '84.09', '0.841', '0.877'],
          ['v7 seed 123', '92.13', '86.32', '0.891', '82.22', '84.09', '0.832', '0.861'],
        ],
      },
      {
        id: 'v7-threshold',
        title: 'Decision-threshold sweep (v7, seed 42)',
        intro: 'Raising the confidence bar trades recall for precision. The best bar was different in each month, so no single value fixes everything. 0.90 was the chosen compromise.',
        columns: ['Month', 'Threshold', 'Appt P', 'Appt R', 'Resg P', 'Resg R'],
        rows: [
          ['Jul 2025', '0.50', '94.38', '88.42', '84.09', '84.09'],
          ['Jul 2025', '0.85', '95.29', '85.26', '88.61', '79.55'],
          ['Jul 2025', '0.95', '95.29', '85.26', '91.55', '73.86'],
          ['Oct 2025', '0.50', '92.68', '89.41', '90.14', '82.05'],
          ['Oct 2025', '0.85', '93.59', '85.88', '95.24', '75.95'],
          ['Oct 2025', '0.95', '95.77', '80.00', '96.30', '65.82'],
        ],
      },
      {
        id: 'v7-seeds',
        title: 'v7 five-seed ensemble (majority vote)',
        intro: 'Five DistilBERT seeds voting. Benefit is stability (no unlucky seed), not a guaranteed jump past 95%.',
        columns: ['Month', 'Rule', 'Appt P', 'Appt R', 'Appt F1', 'Resg P', 'Resg R', 'Resg F1'],
        rows: [
          ['Jul 2025', 'Best single seed (42 / 7)', '94.38', '88.42', '0.913', '82.11', '88.64', '0.853'],
          ['Jul 2025', 'Worst single seed (789)', '87.00', '91.58', '0.892', '77.78', '87.50', '0.824'],
          ['Jul 2025', 'Vote ≥ 3 of 5', '91.40', '89.47', '0.904', '81.91', '87.50', '0.846'],
          ['Jul 2025', 'Vote ≥ 4 of 5', '95.40', '87.37', '0.912', '83.33', '85.23', '0.843'],
          ['Jul 2025', 'Unanimous 5 of 5', '96.43', '85.26', '0.905', '86.42', '79.55', '0.828'],
          ['Oct 2025', 'Vote ≥ 4 of 5', '92.41', '85.88', '0.890', '90.14', '81.01', '0.853'],
        ],
        footnote: 'The “crosses 95% on Appointed” result on July did not replicate on October (92.41%).',
      },
      {
        id: 'bug-fix',
        title: 'Evaluation bug found and fixed (windowed vs plain text)',
        intro: 'The scoring scripts were feeding v7 text in a format it never trained on. Fixing it raised recall 6.5–14 points in all five months checked, precision unchanged.',
        columns: ['Month', 'Appt R before → after', 'Resg R before → after', 'Appt P before → after', 'Resg P before → after'],
        rows: [
          ['March 2025', '76.19 → 82.86', '62.07 → 71.26', '94.12 → 96.67', '80.60 → 78.48'],
          ['April 2025', '75.32 → 81.82', '49.23 → 60.00', '92.06 → 91.30', '86.49 → 90.70'],
          ['May 2025', '75.28 → 82.02', '52.56 → 60.26', '91.78 → 91.25', '87.23 → 90.38'],
          ['June 2025', '— → 86.49', '— → 65.33', '— → 90.14', '— → 94.23'],
          ['August 2025', '65.31 → 75.51', '58.97 → 73.08', '91.43 → 89.16', '86.79 → 89.06'],
        ],
      },
    ],
  },
  {
    id: 'ceo-roberta',
    title: 'CEO detector — bigger encoders and ensembles',
    summary:
      'After DistilBERT plateaued, bigger “reader” models (RoBERTa, DeBERTa) and teams of readers voting together were tried. These produced the winning model.',
    tables: [
      {
        id: 'roberta-4mo',
        title: 'RoBERTa-base vs v7 — four months, precision / recall',
        columns: ['Model', 'Class', 'March', 'May', 'June', 'August'],
        rows: [
          ['v7', 'Appointed P/R', '96.7 / 82.9', '91.3 / 82.0', '90.1 / 86.5', '89.2 / 75.5'],
          ['RoBERTa-base', 'Appointed P/R', '93.8 / 86.7', '92.8 / 86.5', '85.5 / 87.8', '86.2 / 76.5'],
          ['v7', 'Resigned P/R', '78.5 / 71.3', '90.4 / 60.3', '94.2 / 65.3', '89.1 / 73.1'],
          ['RoBERTa-base', 'Resigned P/R', '73.4 / 79.3', '76.3 / 74.4', '81.8 / 72.0', '80.0 / 82.1'],
        ],
        footnote: 'Averaged F1: v7 0.8126 (Appt 0.8642 / Resg 0.7611) · RoBERTa-base 0.8207 (Appt 0.8685 / Resg 0.7729). Seed-to-seed spread was tight (internal Appointed 85%P / 96%R in all three seeds).',
      },
      {
        id: 'rb-ens',
        title: 'RoBERTa-base 3-seed ensemble (vote ≥ 2 of 3)',
        columns: ['Metric', 'March', 'May', 'June', 'August'],
        rows: [
          ['Appointed P / R / F1', '95.8 / 87.6 / .915', '92.9 / 88.8 / .908', '85.7 / 89.2 / .874', '83.2 / 80.6 / .819'],
          ['Resigned P / R / F1', '76.1 / 80.5 / .782', '75.3 / 74.4 / .748', '82.4 / 74.7 / .783', '82.3 / 83.3 / .828'],
        ],
        footnote: '4-month average F1: Appointed 0.8791, Resigned 0.7854, overall 0.8323 (vs v7 0.8126).',
      },
      {
        id: 'rb-threshold',
        title: 'RoBERTa-base ensemble — confidence-threshold sweep',
        columns: ['Threshold', 'Appt P / R / F1', 'Resg P / R / F1', 'Overall F1'],
        rows: [
          ['0.50 (plain)', '89.4 / 86.6 / .879', '79.0 / 78.2 / .785', '0.8323'],
          ['0.85', '—', '—', '0.8366'],
          ['0.87', '—', '—', '0.8377'],
          ['0.88 (peak)', '93.2 / 83.7 / .881', '87.1 / 73.5 / .797', '0.8390'],
          ['0.89', '—', '—', '0.8346'],
          ['0.90', '93.5 / 83.7 / .883', '87.8 / 71.6 / .788', '0.8353'],
        ],
        footnote: 'Per-class thresholds (Appointed 0.9 / Resigned 0.6) scored 0.8382 — slightly worse than one shared 0.88.',
      },
      {
        id: 'rb-ens-month',
        title: 'RoBERTa-base ensemble @ 0.88 — per month precision / recall',
        columns: ['', 'March', 'May', 'June', 'August'],
        rows: [
          ['Appointed P / R', '96.70 / 83.81', '93.83 / 85.39', '92.86 / 87.84', '89.41 / 77.55'],
          ['Resigned P / R', '84.62 / 75.86', '85.25 / 66.67', '87.30 / 73.33', '91.04 / 78.21'],
        ],
      },
      {
        id: 'rl-ens',
        title: 'RoBERTa-LARGE 3-seed ensemble — threshold sweep',
        columns: ['Threshold', 'Appointed F1 (avg)', 'Resigned F1 (avg)', 'Overall F1'],
        rows: [
          ['0.5', '0.8917', '0.8074', '0.8495'],
          ['0.7 (peak)', '0.8889', '0.8186', '0.8537'],
          ['0.8', '0.8852', '0.8178', '0.8515'],
          ['0.88', '0.8845', '0.8129', '0.8487'],
        ],
      },
      {
        id: 'rl-ens-month',
        title: 'RoBERTa-LARGE 3-seed ensemble @ 0.7 — per month',
        columns: ['', 'March', 'May', 'June', 'August'],
        rows: [
          ['Appointed P / R / F1', '96.70 / 83.81 / .898', '97.50 / 87.64 / .923', '91.55 / 87.84 / .897', '92.59 / 76.53 / .838'],
          ['Resigned P / R / F1', '94.44 / 78.16 / .855', '93.10 / 69.23 / .794', '92.86 / 69.33 / .794', '92.19 / 75.64 / .831'],
        ],
      },
      {
        id: 'single-models-march',
        title: 'Single-encoder comparison (March 2025, one seed each)',
        columns: ['Model', 'Appt P', 'Appt R', 'Appt F1', 'Resg P', 'Resg R', 'Resg F1', 'Overall F1'],
        rows: [
          ['RoBERTa-large', '97.80', '84.76', '.908', '87.84', '74.71', '.808', '0.858'],
          ['DeBERTa-v3-base', '89.62', '90.48', '.901', '81.93', '78.16', '.800', '0.850'],
          ['SEC-BERT-base', '94.79', '86.67', '.906', '78.41', '79.31', '.789', '0.847'],
          ['FinBERT (ProsusAI)', '94.57', '82.86', '.883', '71.72', '81.61', '.763', '0.823'],
          ['RoBERTa-large + windowing', '95.74', '85.71', '.905', '67.52', '90.80', '.775', '0.840'],
        ],
        footnote: 'None of the three “web research” leads (SEC-BERT, FinBERT, large+windowing) beat the deployed components. Windowing failed a 4th time.',
      },
      {
        id: 'mixed-month',
        title: 'Mixed ensemble (WINNER) vs pure RoBERTa-large — F1 per month',
        intro: 'RoBERTa-large seed 7 + RoBERTa-large seed 123 + DeBERTa-v3-base seed 42, vote ≥ 2 of 3 at confidence 0.7. Beat the pure ensemble in all four months.',
        columns: ['Month', 'Pure RoBERTa-large (3 seeds)', 'Mixed (RL7 + RL123 + DeBERTa42)', 'Difference'],
        rows: [
          ['March 2025', '0.8767', '0.8812', '+0.0045'],
          ['May 2025', '0.8586', '0.8722', '+0.0137'],
          ['June 2025', '0.8452', '0.8557', '+0.0104'],
          ['August 2025', '0.8345', '0.8601', '+0.0256'],
          ['4-month average', '0.8537', '0.8673', '+0.0136'],
        ],
        footnote: 'Threshold re-swept for the mixed ensemble: 0.6 → 0.8630, 0.7 → 0.8673 (peak), 0.8 → 0.8657.',
      },
      {
        id: 'progression',
        title: 'Overall F1 progression (4 out-of-time months)',
        columns: ['Configuration', 'Overall F1'],
        rows: [
          ['v7 DistilBERT (single)', '0.8126'],
          ['RoBERTa-base (single)', '0.8207'],
          ['RoBERTa-base 3-seed, plain vote', '0.8323'],
          ['RoBERTa-base 3-seed @ 0.88', '0.8390'],
          ['RoBERTa-large (single)', '0.8470'],
          ['RoBERTa-large 3-seed @ 0.7', '0.8537'],
          ['Mixed: RL ×2 + DeBERTa ×1 @ 0.7  ← BEST', '0.8673'],
        ],
      },
      {
        id: 'runtime',
        title: 'Inference time for one month of filings',
        columns: ['Model', 'Hardware', 'Runtime', 'Overall F1'],
        rows: [
          ['v7 DistilBERT (single)', 'CPU', '~21.5 min', '0.8126'],
          ['RoBERTa-base (single)', 'CPU', '~36.5 min', '0.8207'],
          ['RoBERTa-base 3-seed ensemble', 'CPU (sequential)', '~110 min (est.)', '0.8390'],
          ['RoBERTa-large (single)', 'CPU', '~124 min', '0.8470'],
          ['RoBERTa-large (single)', 'GPU', '~5.7 min', '0.8470 (identical)'],
          ['DeBERTa-v3-base (single)', 'GPU', '~3.7 min', '0.850 (March only)'],
          ['RoBERTa-large 3-seed ensemble', 'GPU', '~13.3 min', '0.8537'],
        ],
        footnote: 'Final mixed ensemble, March 2025 run on Kaggle: 5,743 filings in ~11 minutes (656 s).',
      },
    ],
  },
  {
    id: 'other-items',
    title: 'Other 8-K item detectors (in progress by parallel sessions)',
    summary:
      'The same recipe applied to other kinds of 8-K news. These are earlier-stage than the CEO detector and are scored against labels from a language-model answer key.',
    tables: [
      {
        id: 'i103',
        title: 'Item 1.03 — Bankruptcy / receivership',
        intro: '653 train / 80 val; held-out windows. “ANY” = any bankruptcy event detected.',
        columns: ['Run', 'Recipe', 'Result (held-out)', 'Notes'],
        rows: [
          ['1', 'RoBERTa-base + LoRA, no filing date', 'ANY P/R by window: .92/.93, .96/1.0, .95/1.0, .73/1.0, .90/.90, 1.0/1.0', 'Recall high, precision short; mistakes on “is this event new?”'],
          ['2', 'RoBERTa-base + date offset', 'ANY P .946 / R .946; Petition P .951 R .916; Plan P .850 R 1.0; Receivership P 1.0 R .778 (n=9)', 'Date input lifted ANY precision .911 → .946'],
          ['3', 'RoBERTa-large + date offset', 'ANY P .948 / R .973; Petition P .945 R .963; Plan P .919 R 1.0; Receivership P 1.0 R .778', 'Best single model'],
          ['4', 'RoBERTa-large ×3 seeds', '@0.5 ANY P .947 / R .960; @0.7 P .958 / R .913; Petition P .953→.969; Plan P .919', 'Same-architecture ensemble adds nothing'],
          ['5', 'DeBERTa-v3-base + date', 'ANY P .926 / R .926', 'Weaker alone'],
          ['6', 'MIXED: RoBERTa-large + DeBERTa-v3', '@0.5 ANY P .947 / R .960; @0.6 ANY P .959 / R .946; Petition P .962 R .935; Plan P .944 R 1.0; Receivership P 1.0 R .778; @0.7 P .958 / R .926', 'Clears 95% precision; best 1.03 model'],
        ],
      },
      {
        id: 'i301',
        title: 'Item 3.01 — Delisting / listing notices',
        intro: '1,967 train / 233 val; 4 held-out months, 477 events.',
        columns: ['Run', 'Recipe', 'Result (held-out)', 'Notes'],
        rows: [
          ['7', 'RoBERTa-base + date', 'ANY P .994 / R .998; Deficiency P .961 R .899; Exchange-delisting P .781 R .882; Voluntary-delisting P .908 R .972; Transfer P .773 R .895; Regained P .830 R .951', 'Baseline'],
          ['8', 'RoBERTa-large + date', 'Deficiency P .935 R .933; Exch-delist P .878 R .849; Vol-delist P .932 R .972; Transfer P .708 R .895 (n=19); Regained P .930 R .976', 'Better on delisting + regained'],
          ['9', 'RoBERTa-base + large averaged @0.6', 'Deficiency P .965 R .916; Exch-delist P .897 R .839; Vol-delist P .933 R .986; Transfer P .773 R .895; Regained P .907 R .951', 'Ensemble helps precision'],
          ['10', '5-fold audit of training labels', '3.01: 182 flagged filings; 1.03: 71', 'Found systematic label-policy errors'],
          ['11', 'Retrained on policy-corrected labels', 'rb: Exch-delist P .730 R .957; rl: Exch-delist P .744 R .935, Deficiency P .968 R .927, Regained P .872 R 1.0; rb+rl @0.6: Vol-delist P .946 R .986, Exch-delist P .772 R .946', 'NOT adopted — rule too aggressive'],
        ],
      },
      {
        id: 'i401',
        title: 'Item 4.01 — Auditor changes',
        intro: '2,912 filings harvested; tested on 348 filings across 5 held-out months. Model labels come from regex rules, so the model ≈ regex.',
        columns: ['Run', 'Recipe', 'Result', 'Notes'],
        rows: [
          ['Regex v1', '5 rounds of rule tuning on 197 dev filings', 'Resigned recall .66→.96; opinion precision .89→1.0; reportable-event precision .88→.98; name extraction 72/85% → 81/85%', 'Frozen rule baseline; P/R 0.95–0.99 on dev'],
          ['T401-v1 / E401-v1', 'RoBERTa-base LoRA, 11.8k sentences', 'Test F1: dismissed .986, resigned .972, engaged .982, reportable .981, opinion-modified .933; names 94/91%', 'Within ±.03 of regex; union best for recall'],
          ['T401-v2', 'RoBERTa-large', 'Dev: engaged .959 vs .967, opinion .926 vs .909 (base)', 'Not better than base; 3.4× slower (151 vs 45 ms/filing)'],
          ['T401-v3', 'DeBERTa-v3-base', '—', 'Failed 4× (fp16 / dtype / OOM); retry running'],
        ],
      },
      {
        id: 'i201',
        title: 'Items 2.01 / 1.01 / 1.02 — Acquisitions & material agreements',
        intro: 'Scored on 4 held-out months against LLM answer key; compared with a regex baseline.',
        columns: ['Task', 'Model', 'Regex baseline', 'Notes'],
        rows: [
          ['2.01 completed (yes/no)', 'F1 0.957', '0.770', 'Strong'],
          ['2.01 direction (acquirer vs target)', 'Accuracy 0.656 (said UNCLEAR on 47)', '0.449', 'A single sentence often can’t tell filer from counterparty'],
          ['1.01 agreement entered', 'F1 0.940', '0.936', 'Near-identical to rules'],
          ['1.02 agreement terminated', 'P 0.933 · R 0.667 · F1 0.778', 'F1 0.745', 'Misses terminations phrased without the word “terminated”'],
          ['Agreement type (filing, type)', 'F1 0.738', '0.766', 'Model NOT better than rules'],
          ['Weak-label validation (circular)', '2.01 macro-F1 0.81 · events 0.98 · types 0.94', '—', 'Not a real accuracy; labels came from the same rules'],
        ],
        footnote: 'v2 retrains (filer marking, termination rules) were running at the last log update.',
      },
      {
        id: 'i507',
        title: 'Items 5.07, 2.02, 2.05 / 2.06 — earlier stage',
        columns: ['Item', 'Status', 'Numbers so far'],
        rows: [
          ['5.07 shareholder votes', 'Regex parser frozen; RoBERTa-base training running; 20,624 filings harvested', 'Regex vs LLM on 322 dev filings: any-failed P .43→.92; merger P .63→.91; special P .87→.98; directors .96/.98; weakest recall: charter .85, share issuance .84, equity .88'],
          ['2.02 guidance direction', 'Harvest done (16,225 press releases); LLM labelling running', 'No model trained yet'],
          ['2.05 / 2.06 restructuring & impairments', 'Harvest done (1,233 + 221 filings); LLM labelling running', 'No model trained yet'],
        ],
      },
    ],
  },
  {
    id: 'lessons',
    title: 'Key lessons so far',
    summary: 'The short list of what actually mattered, in plain terms.',
    tables: [
      {
        id: 'lessons-table',
        title: 'What worked and what didn’t',
        columns: ['Finding', 'Evidence'],
        rows: [
          ['Fixing the sentence splitter was a big win', 'v6: Appointed precision hit 95.65%'],
          ['A bigger reader (RoBERTa-large) beats a smaller one', 'F1 0.847 vs 0.821 (single models)'],
          ['A mixed team of different models beats a team of clones', 'Mixed 0.8673 vs pure RoBERTa-large 0.8537, better in 4 of 4 months'],
          ['More training data from evaluated months hurt', 'v8: precision fell 20 points'],
          ['Adding many narrow rules overfit', 'v9/v10: internal score up, real-world score down'],
          ['Showing neighbouring sentences failed four times', 'v11, v12, v13, RoBERTa-large + windowing'],
          ['Single-run differences under ~2 points are noise', 'Seed change alone moved F1 by 0.016'],
          ['Testing the tester matters', 'Eval bug understated recall by 6.5–14 points'],
        ],
      },
    ],
  },
]
