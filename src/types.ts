export type Kind = 'appointed' | 'resigned'
export type Verdict = 'correct' | 'false_alarm' | 'missed'

export interface EventRow {
  id: string
  company: string
  date: string
  url: string
  kind: Kind
  verdict: Verdict
  confidence: number | null
  aiSentence: string
  aiName: string
  truthName: string
  truthSentence: string
}

export interface ClassMetrics {
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
}

export interface MarchData {
  period: { start: string; end: string; label: string }
  funnel: {
    filings: number
    withItem502: number
    skippedByPrefilter: number
    flaggedAppointed: number
    flaggedResigned: number
  }
  scoring: { scoredFilings: number; excludedUnresolved: number }
  metrics: { appointed: ClassMetrics; resigned: ClassMetrics }
  events: EventRow[]
}

// ---- live search + analysis ----
export interface FilingRow {
  accession: string
  cik: string
  company: string
  ticker: string
  date: string
  form: string
  items: string[]
  location: string
  description: string
  docUrl: string
  indexUrl: string
}

export interface SearchResponse {
  total: number
  from: number
  pageSize: number
  filings: FilingRow[]
  company?: { name: string; ticker: string; cik: string }
}

export interface Company {
  cik: string
  name: string
  ticker: string
}

export interface ReaderVote {
  reader: string
  voted: boolean
  confidence: number | null
}

export interface Extraction {
  found: boolean
  name?: string
  sentence?: string
  sentenceIndex?: number | null
  confidence?: number | null
  effective?: string | null // ISO date the change takes effect, when the filing gives one
  effectiveNote?: string | null // 'immediately' or 'upon ...' when there is no calendar date
  decided?: string | null // the date the board acted or notice was given, when stated
  votesFor?: number
  readers?: ReaderVote[]
  check?: ResultCheck | null // the result checker's second opinion (absent when the checker is not running)
}

export interface ResultCheck {
  score: number | null // 0 to 1: how likely this is a real change of this company's CEO announced in this filing
  state: 'ok' | 'review' | 'likely_wrong'
  reason?: string | null
  repointed?: boolean // the checker moved to a better sentence of the same section
  firstScore?: number
}

export interface SentenceRow {
  text: string
  readers: { reader: string; label: 'NONE' | 'APPOINTED' | 'RESIGNED'; confidence: number; counts: boolean }[]
}

export interface DetectorEvent {
  label: string
  title: string
  confidence?: number | null
  evidence?: string | null
  detail?: string
  source?: string
  readers?: { reader: string; probability: number }[]
  kind?: 'appointed' | 'resigned'
  name?: string | null
  interim?: boolean
  effective?: string | null
  effectiveNote?: string | null
  decided?: string | null
}

export interface DetectorResult {
  key: string
  item: string
  title: string
  applicable: boolean
  found: boolean
  events: DetectorEvent[]
  fields?: Record<string, unknown>
  readerNames?: string[]
  seconds?: number
  error?: string
  note?: string
  experimental?: string
  voteRows?: Record<string, unknown>[]
}

export interface AnalysisResult {
  filing: { cik: string; accession: string; company: string; form: string; filed: string; items: string[]; url: string; characters: number }
  item502Found: boolean
  section: string
  readers?: string[]
  sentences: SentenceRow[]
  appointed: Extraction
  resigned: Extraction
  seconds: number
  skippedModel?: string
  detectors?: DetectorResult[]
}

export interface JobStatus {
  id: string
  stage: 'queued' | 'fetching' | 'locating' | 'splitting' | 'reading' | 'detectors' | 'done' | 'error'
  progress: number
  sentenceCount?: number
  readersDone?: number
  unitsDone?: number
  unitsTotal?: number
  elapsed?: number
  etaSeconds?: number
  detail?: string
  filing?: AnalysisResult['filing']
  result?: AnalysisResult
  error?: string
}

// ---- model status sign ----
export type ModelState = 'ready' | 'loading' | 'off' | 'error'

export interface ModelStatus {
  key: string
  item: string
  title: string
  state: ModelState
  error?: string | null
  lastError?: string | null
  adapters: number
  loadSeconds?: number | null
  readers?: string[]
}

export interface SelfTestModel {
  name: string
  ok: boolean
  ms: number
  error?: string | null
}

export interface SelfTestResult {
  key: string
  ok: boolean
  error?: string
  ms?: number
  models: SelfTestModel[]
}

// ---- stored analyses (what the model server keeps per filing for the spreadsheet) ----
export interface SlimEvent {
  title: string
  detail?: string
  confidence?: number | null
  evidence?: string | null
  kind?: 'appointed' | 'resigned'
  name?: string | null
  interim?: boolean
  effective?: string | null
  effectiveNote?: string | null
  decided?: string | null
}

export interface SlimResult {
  filing: { items: string[] }
  item502Found: boolean
  appointed: Pick<Extraction, 'found' | 'name' | 'confidence' | 'sentence' | 'effective' | 'effectiveNote' | 'decided' | 'check'>
  resigned: Pick<Extraction, 'found' | 'name' | 'confidence' | 'sentence' | 'effective' | 'effectiveNote' | 'decided' | 'check'>
  detectors?: { key: string; applicable: boolean; found: boolean; events: SlimEvent[] }[]
}
