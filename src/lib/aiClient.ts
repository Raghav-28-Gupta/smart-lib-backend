import { PREDICT_TIMEOUT_MS, RECOMMEND_TIMEOUT_MS } from '../config/constants'

// 127.0.0.1 rather than localhost on purpose: on Windows, Node resolves
// `localhost` to ::1 first, while uvicorn binds IPv4 only — that combination
// fails with ECONNREFUSED even though the service is up.
const AI_BACKEND_URL = process.env.AI_BACKEND_URL ?? 'http://127.0.0.1:8000'

// Node 18+ ships fetch natively, so there's no HTTP client dependency here.
// This is the only place the FastAPI service is reached from — the client never
// talks to it directly.
export async function checkAiBackendHealth() {
  const res = await fetch(`${AI_BACKEND_URL}/health`)
  if (!res.ok) throw new Error(`AI backend unhealthy: ${res.status}`)
  return res.json()
}

// --- No-show prediction (slice 7; spec 2026-11-24-no-show-handling-design.md, section 6) ---------

/**
 * The ten features of one booking, exactly the fields of the AI service's `NoShowRequest`
 * (ai-backend/app/schemas/noshow.py, which rejects any other). Built by
 * services/noShowFeatures.ts; the key order is the service's `FEATURE_ORDER`.
 */
export interface NoShowFeatures {
  hour_of_day: number
  day_of_week: number
  duration_minutes: number
  lead_time_hours: number
  resource_type: 'seat' | 'room'
  past_attendance_ratio: number
  consecutive_attended_count: number
  recent_noshows_count: number
  reliability_score: number
  bookings_last_30d: number
}

// A Record over the interface's keys, so the compiler refuses a missing or an extra one: the list
// below can never drift from the interface (a test compares it to the shared fixture's keys).
const FEATURE_KEYS_IN_ORDER: Record<keyof NoShowFeatures, true> = {
  hour_of_day: true,
  day_of_week: true,
  duration_minutes: true,
  lead_time_hours: true,
  resource_type: true,
  past_attendance_ratio: true,
  consecutive_attended_count: true,
  recent_noshows_count: true,
  reliability_score: true,
  bookings_last_30d: true,
}
export const NO_SHOW_FEATURE_KEYS = Object.keys(FEATURE_KEYS_IN_ORDER) as Array<keyof NoShowFeatures>

export interface NoShowPrediction {
  predicted_probability: number
  penalty_factor: number
  model_version: string
}

/** The prediction call failed in a way whose message is safe to log (it never carries a body or a feature). */
export class NoShowPredictionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoShowPredictionError'
  }
}

/**
 * Whether the prediction service is set up. Read from the environment on every call, unlike
 * AI_BACKEND_URL above (read once at import, with a localhost default): a blank or missing value
 * means "no AI service is set up here", and `scoreBooking` then does nothing at all.
 */
export function isAiBackendConfigured(): boolean {
  return (process.env.AI_BACKEND_URL ?? '').trim() !== ''
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Checks the service's answer. The probability must lie in [0, 1]; the penalty must be a finite
 * number of at least 0. A penalty ABOVE the cap is not refused here: the service caps it itself and
 * `scoreBooking` clamps it again (to MAX_PENALTY_CAP) before it uses it, so the second line of
 * defence works on whatever number arrives. Messages are fixed strings: they reach the log.
 */
function parsePrediction(data: unknown): NoShowPrediction {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new NoShowPredictionError('AI backend answered with something other than an object')
  const { predicted_probability, penalty_factor, model_version } = data as Record<string, unknown>
  if (!isNumber(predicted_probability) || predicted_probability < 0 || predicted_probability > 1) {
    throw new NoShowPredictionError('AI backend answered with a probability outside [0, 1]')
  }
  if (!isNumber(penalty_factor) || penalty_factor < 0) throw new NoShowPredictionError('AI backend answered with a penalty that is not a number of at least 0')
  if (typeof model_version !== 'string' || model_version === '') throw new NoShowPredictionError('AI backend answered without a model version')
  return { predicted_probability, penalty_factor, model_version }
}

/**
 * Asks the AI service for the no-show probability of one booking: POST /predict/no-show with the
 * ten features. Throws on anything but a good answer (a refusal, an unreachable service, a timeout,
 * bad JSON, a value out of range); the caller decides what that means (`scoreBooking` leaves the
 * booking unscored).
 *
 * The URL is read from AI_BACKEND_URL on every call and there is NO default: an unset variable is an
 * error here, never a request to a guessed address. `signal` defaults to the PREDICT_TIMEOUT_MS
 * (2 s) timeout; a caller may pass its own.
 */
export async function predictNoShow(features: NoShowFeatures, signal: AbortSignal = AbortSignal.timeout(PREDICT_TIMEOUT_MS)): Promise<NoShowPrediction> {
  const base = (process.env.AI_BACKEND_URL ?? '').trim().replace(/\/+$/, '')
  if (base === '') throw new NoShowPredictionError('AI_BACKEND_URL is not set')
  // Only the ten fields, in the service's order: it forbids extras and a drifting caller must fail loudly there.
  const body = Object.fromEntries(NO_SHOW_FEATURE_KEYS.map((key) => [key, features[key]]))
  const res = await fetch(`${base}/predict/no-show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    // Not reading the body would hold the connection until it is collected.
    void res.body?.cancel().catch(() => undefined)
    throw new NoShowPredictionError(`AI backend no-show prediction failed: ${res.status}`)
  }
  return parsePrediction(await res.json())
}

// --- Book recommendations (slice 8; spec 2026-11-25-book-recommender-design.md, sections 1 to 3) -----
// The contract of POST /recommend/batch, field for field (ai-backend/app/schemas/recommend.py and the
// shared fixture test/fixtures/recommend-batch-example.json). The backend sends the catalog and every
// student's interactions in one call and stores the answer in RecommendationCache: user ids and book
// ids only, never a name or an email.

export interface RecommendBatchBook {
  id: string
  title: string
  author: string
  genre: string | null
  description: string | null
}

/** One student's strength of interest in one book: above 0 and at most 3 (loan 1, renewal +0.5, reservation 0.5, summed and capped). */
export interface RecommendBatchInteraction {
  user_id: string
  book_id: string
  weight: number
}

export interface RecommendBatchRequest {
  books: RecommendBatchBook[]
  interactions: RecommendBatchInteraction[]
  limit: number
}

export type RecommendMethod = 'content' | 'collaborative' | 'hybrid'

export interface RecommendBatchResponse {
  model_version: string
  users: Array<{ user_id: string; results: Array<{ book_id: string; score: number; method: RecommendMethod }> }>
}

/** The recommendation call failed in a way whose message is safe to log (it never carries a body, an id or the token). */
export class RecommendationBatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecommendationBatchError'
  }
}

/**
 * Whether the recommender can be reached: AI_BACKEND_URL and AI_TOKEN are both set and not blank. Read
 * from the environment on every call, like isAiBackendConfigured: a missing value means "not deployed"
 * and the refresh then does nothing at all.
 */
export function isRecommenderConfigured(): boolean {
  return isAiBackendConfigured() && (process.env.AI_TOKEN ?? '').trim() !== ''
}

const RECOMMEND_METHODS: ReadonlySet<unknown> = new Set<RecommendMethod>(['content', 'collaborative', 'hybrid'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function refuseBatch(what: string): never {
  throw new RecommendationBatchError(`AI backend recommendation batch answered ${what}`)
}

/**
 * Checks the service's answer against what was sent, before anything is written to the cache: an
 * object with a non-empty `model_version` and a `users` list; every user was one that was sent
 * interactions for (and is listed once); every book was in the catalog that was sent; every score is a
 * finite number in [0, 1]; every method is one of the three; no book repeats for a user; no user gets
 * more than `limit` results. Returns a copy with only the known fields. Messages are fixed strings:
 * they reach the log, so they never quote an id, a value or the body.
 */
function parseRecommendationBatch(data: unknown, sent: RecommendBatchRequest): RecommendBatchResponse {
  if (!isRecord(data)) refuseBatch('with something other than an object')
  const { model_version, users } = data
  if (typeof model_version !== 'string' || model_version === '') refuseBatch('without a model version')
  if (!Array.isArray(users)) refuseBatch('without a users list')

  const sentUsers = new Set(sent.interactions.map((interaction) => interaction.user_id))
  const sentBooks = new Set(sent.books.map((book) => book.id))
  const seenUsers = new Set<string>()
  const answer: RecommendBatchResponse = { model_version, users: [] }

  for (const entry of users) {
    if (!isRecord(entry) || typeof entry.user_id !== 'string' || !Array.isArray(entry.results)) refuseBatch('with a malformed user')
    const userId = entry.user_id
    if (!sentUsers.has(userId)) refuseBatch('for a user that was not sent')
    if (seenUsers.has(userId)) refuseBatch('with a user twice')
    seenUsers.add(userId)
    if (entry.results.length > sent.limit) refuseBatch('with more results than the limit')

    const seenBooks = new Set<string>()
    const results: RecommendBatchResponse['users'][number]['results'] = []
    for (const result of entry.results) {
      if (!isRecord(result) || typeof result.book_id !== 'string') refuseBatch('with a malformed result')
      const { book_id, score, method } = result
      if (!sentBooks.has(book_id)) refuseBatch('with a book that was not sent')
      if (!isNumber(score) || score < 0 || score > 1) refuseBatch('with a score outside [0, 1]')
      if (!RECOMMEND_METHODS.has(method)) refuseBatch('with an unknown method')
      if (seenBooks.has(book_id)) refuseBatch('with a book twice for one user')
      seenBooks.add(book_id)
      results.push({ book_id, score, method: method as RecommendMethod })
    }
    answer.users.push({ user_id: userId, results })
  }
  return answer
}

/**
 * Asks the AI service for every student's picks in one call: POST /recommend/batch with the shared
 * secret in `x-ai-token`. Throws a RecommendationBatchError on anything but a good answer (a refusal,
 * bad JSON, an answer that does not match `payload`); an unreachable service rejects with fetch's own
 * error and a timeout or abort with the signal's. The caller decides what that means (the refresh keeps
 * the old cache and waits before it tries again).
 *
 * The URL and the token are read from AI_BACKEND_URL and AI_TOKEN on every call and there is NO
 * default for either: unset or blank is an error here, and nothing is sent. `signal` defaults to the
 * RECOMMEND_TIMEOUT_MS (90 s: a free host's cold start) timeout; a caller may pass its own.
 */
export async function fetchRecommendationBatch(
  payload: RecommendBatchRequest,
  signal: AbortSignal = AbortSignal.timeout(RECOMMEND_TIMEOUT_MS),
): Promise<RecommendBatchResponse> {
  const base = (process.env.AI_BACKEND_URL ?? '').trim().replace(/\/+$/, '')
  if (base === '') throw new RecommendationBatchError('AI_BACKEND_URL is not set')
  const token = (process.env.AI_TOKEN ?? '').trim()
  if (token === '') throw new RecommendationBatchError('AI_TOKEN is not set')
  let headers: Headers
  try {
    headers = new Headers({ 'Content-Type': 'application/json', 'x-ai-token': token })
  } catch {
    // Node's own error for a bad header value quotes the value: the token must not reach a log.
    throw new RecommendationBatchError('AI_TOKEN is not a valid header value')
  }
  const res = await fetch(`${base}/recommend/batch`, { method: 'POST', headers, body: JSON.stringify(payload), signal })
  if (!res.ok) {
    // Not reading the body would hold the connection until it is collected.
    void res.body?.cancel().catch(() => undefined)
    throw new RecommendationBatchError(`AI backend recommendation batch failed: ${res.status}`)
  }
  let data: unknown
  try {
    data = await res.json()
  } catch (error) {
    // V8's message for bad JSON quotes the start of the body; an abort while the body streams is not bad JSON.
    if (error instanceof Error && error.name === 'SyntaxError') throw new RecommendationBatchError('AI backend recommendation batch answered with invalid JSON')
    throw error
  }
  return parseRecommendationBatch(data, payload)
}
