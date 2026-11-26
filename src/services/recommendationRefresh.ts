// The background refresh of RecommendationCache (slice 8; spec 2026-11-25-book-recommender-design.md, section 3,
// "Refresh"). The 60-second timer (`runScheduledSweeps`) calls `refreshRecommendationsIfDue`, which sends the catalog and
// the students' interactions to the AI service in one call and replaces the table with its answer. The read path
// (`recommendationService.getRecommendations`) only ever reads the table, so this can fail, be slow or never run (the AI
// service asleep, down or not deployed) and students still get the popularity list.
import { RECOMMEND_REFRESH_MS, RECOMMEND_RETRY_MS } from '../config/constants'
import { fetchRecommendationBatch, isRecommenderConfigured, RecommendationBatchError } from '../lib/aiClient'
import { prisma } from '../lib/prisma'
import { SWEEP_TX_OPTIONS } from './noShowService'
import { buildRecommendationPayload } from './recommendationPayload'

export interface RefreshResult {
  /** Students who got at least one pick. */
  students: number
  /** Rows written to the cache. */
  rows: number
  /** The AI service's `model_version` (`tfidf-1` or `tfidf-als-1`). */
  modelVersion: string
}

/** How many rows one `createMany` carries. */
const WRITE_CHUNK = 1000

/** A system error code such as ECONNREFUSED or UND_ERR_CONNECT_TIMEOUT (the same shape slice 7's `failureReason` accepts): only a cause's code of this shape is logged. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/

/**
 * The in-process guard: true while a refresh is running. Taken before anything is awaited and released in a `finally`, so a
 * refresh that fails or throws cannot leave it set (the same shape as noShowService's `sweepRunning`).
 */
let refreshRunning = false
/** The `now` of this process's last attempt: stamped for every attempt, a failed one and a "nothing to send" one included. Null before the first, and after a reset. */
let lastAttemptAt: number | null = null

/**
 * Refreshes the cache if it is due, and says what it wrote. Answers `null` when it did nothing: the recommender is not
 * configured (`AI_BACKEND_URL` and `AI_TOKEN` both set and not blank), a refresh is already running in this process, this
 * process tried less than RECOMMEND_RETRY_MS ago (success or failure), the newest cache row is not older than
 * RECOMMEND_REFRESH_MS, or there is nothing to send (no student has borrowed or reserved a book). It REJECTS when the AI call
 * or the store failed: the cache then holds exactly what it held before, and the attempt still counts, so the next try is
 * RECOMMEND_RETRY_MS away. `runScheduledSweeps` logs the rejection through `describeRefreshFailure` and never lets it escape.
 *
 * Steps: payload from the database, the call (the client validates the whole answer against what was sent), then ONE
 * transaction that deletes every row and inserts the answer in chunks with `generatedAt` = `now`. Nothing touches the table
 * before the answer has been validated, and a failure inside the transaction rolls the delete back.
 *
 * `generatedAt` is a plain `timestamp` column, so it is always passed from JavaScript through the Prisma API (never raw SQL
 * and never the database default, which would be the session's wall clock).
 */
export async function refreshRecommendationsIfDue(now: Date = new Date()): Promise<RefreshResult | null> {
  if (!isRecommenderConfigured()) return null
  if (refreshRunning) return null
  const at = now.getTime()
  if (lastAttemptAt !== null && at - lastAttemptAt < RECOMMEND_RETRY_MS) return null

  // Taken before the first await: of two calls that start together, only the first gets past this line.
  refreshRunning = true
  try {
    // Due when there is no row at all, or the newest one is older than a day. Finding it not due is not an attempt.
    const { _max } = await prisma.recommendationCache.aggregate({ _max: { generatedAt: true } })
    if (_max.generatedAt !== null && at - _max.generatedAt.getTime() <= RECOMMEND_REFRESH_MS) return null

    lastAttemptAt = at
    const payload = await buildRecommendationPayload()
    if (payload === null) return null

    const answer = await fetchRecommendationBatch(payload)

    const rows = answer.users.flatMap((user) =>
      user.results.map((result) => ({ userId: user.user_id, bookId: result.book_id, score: result.score, method: result.method, generatedAt: now })),
    )
    await prisma.$transaction(async (tx) => {
      await tx.recommendationCache.deleteMany()
      for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
        await tx.recommendationCache.createMany({ data: rows.slice(start, start + WRITE_CHUNK) })
      }
    }, SWEEP_TX_OPTIONS)

    return { students: new Set(rows.map((row) => row.userId)).size, rows: rows.length, modelVersion: answer.model_version }
  } finally {
    refreshRunning = false
  }
}

/** Test only. Clears the single-flight guard and the attempt stamp, so one test's refresh cannot hold back the next. */
export function resetRecommendationRefreshForTests(): void {
  refreshRunning = false
  lastAttemptAt = null
}

/**
 * Logs a refresh that wrote something (the timer calls this): one line with counts and the model version, never an id, a
 * name, an email, a title or the token. The model version comes from the AI service's answer, so it is cut to plain
 * token characters and 40 of them: whatever the service sends, the line stays one line.
 */
export function logRecommendationRefresh(result: RefreshResult): void {
  const model = result.modelVersion.replace(/[^\w.-]/g, '?').slice(0, 40)
  console.log(`recommendation refresh: students=${result.students} rows=${result.rows} model=${model}`)
}

/**
 * The only text of a failed refresh that may be logged (`runScheduledSweeps` writes it after "Recommendation refresh failed: ").
 *
 *  - A RecommendationBatchError: its own message (fixed strings, written to be logged: no id, value, body or token).
 *  - A timeout or an abort (the 90-second signal): `timed out`.
 *  - An unreachable service, which is how fetch rejects (a wrong host, a refused connection, a TLS failure): a TypeError whose
 *    message is exactly `fetch failed`, with the socket error in its `cause`. It reads as the cause's `code` (`ECONNREFUSED`,
 *    `ENOTFOUND`) only when that is a string shaped like a system error code (`ERROR_CODE`), else `AI service unreachable`.
 *    Only that code is taken from the cause: never its message, which carries the address.
 *  - Any other error: its class name only, plus its `code` when that is a string (so a database error reads
 *    `PrismaClientKnownRequestError P2002`). Never the error object and never `cause`, and never another error's message:
 *    a malformed `AI_BACKEND_URL` makes fetch throw a TypeError that quotes the URL (credentials included), so any TypeError
 *    whose message is not `fetch failed` reads as `TypeError` alone, and a database error's message can quote row values.
 *  - Anything that is not an Error: `unknown error`.
 */
export function describeRefreshFailure(error: unknown): string {
  if (error instanceof RecommendationBatchError) return error.message
  if (!(error instanceof Error)) return 'unknown error'
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out'
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const causeCode = (error.cause as { code?: unknown } | null | undefined)?.code
    return typeof causeCode === 'string' && ERROR_CODE.test(causeCode) ? causeCode : 'AI service unreachable'
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? `${error.name} ${code}` : error.name
}
