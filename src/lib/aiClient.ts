import { PREDICT_TIMEOUT_MS } from '../config/constants'

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

export interface RecommendResult {
  book_id: string
  score: number
  method: 'content' | 'collaborative' | 'hybrid'
}

// The real path is POST /recommend/books, not POST /recommend as
// SMARTLIB_PROJECT_CONTEXT.md §5.3 previously documented (fixed alongside
// this). Returns stub results ([]) until the Phase 3 model lands --
// recommendationService.ts is the one that falls back when this is empty.
export async function fetchRecommendations(userId: string, limit = 10): Promise<RecommendResult[]> {
  const res = await fetch(`${AI_BACKEND_URL}/recommend/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, limit }),
  })
  if (!res.ok) throw new Error(`AI backend recommend failed: ${res.status}`)
  const data = (await res.json()) as { results: RecommendResult[] }
  return data.results
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
 * means "not deployed" (production today), and `scoreBooking` then does nothing at all.
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
