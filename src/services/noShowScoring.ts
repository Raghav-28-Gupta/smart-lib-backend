// Scores a new booking with the no-show model (slice 7; spec
// 2026-11-24-no-show-handling-design.md, section 6, "When it runs").
//
// `createBooking` starts `scoreBooking(id)` after its transaction has committed, for a seat and for a
// room request, and never waits for it: `void scoreBooking(id).catch(log)`. The scorer builds the
// features from the database, asks the AI service (2-second timeout, PREDICT_TIMEOUT_MS), and writes
//  - `NoShowEvent.predictedProbability` (the row is created now with `actualNoShow` null, or, when it
//    exists, only its probability changes: the outcome belongs to the sweep and the check-in, and a
//    booking that has become a no-show, cancelled or released in the meantime keeps its status and
//    its outcome),
//  - `ResourceBooking.priorityScore = 1 - clamp(penalty_factor, 0, MAX_PENALTY_CAP)`, the nudge the
//    librarian's Requests page reads (spec: 1.0 and no nudge when this is null);
// and, for a ROOM request, publishes ONE `request.scored` on the `requests` topic so an open Requests
// page refetches and shows the suggested order (`request.created` fired before the score existed).
//
// The rules this file keeps:
//  - NEVER inside a transaction and never on a request's critical path: the features are read and the
//    service is called first, with no transaction open; only the two writes share one, opened AFTER.
//  - FAIL OPEN: any failure (the service down or slow, garbage in its answer, a database error) leaves
//    `priorityScore` null and writes nothing. `scoreBooking` never throws.
//  - LOCK ORDER: the booking row, then the event row, as the sweep, a check-in and an overturn take
//    them, so the scorer cannot wait on any of them in a circle.
//  - NOTHING without an AI service: `AI_BACKEND_URL` unset (production today) is a no-op, so a booking
//    never causes a doomed request to a guessed address.
import { MAX_PENALTY_CAP } from '../config/constants'
import { isAiBackendConfigured, NoShowPredictionError, predictNoShow } from '../lib/aiClient'
import { publish } from '../lib/events'
import { prisma } from '../lib/prisma'
import { buildNoShowFeatures } from './noShowFeatures'
import { SWEEP_TX_OPTIONS } from './noShowService'

// True under a test run: Vitest always sets VITEST (the same test the mailer and the lazy sweep use).
const underTest = () => process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)

/** Set by a test (enableScoringForTests); undefined means "the default for this process". */
let scoringOverride: boolean | undefined

/** The scorers still running, so a test can wait for them (settleScoringForTests). */
const inFlight = new Set<Promise<void>>()

/**
 * Whether `scoreBooking` does anything. It needs a configured AI service, and under test it also
 * needs a test to have asked for it: a developer's `.env` sets AI_BACKEND_URL for every test file, and
 * the many tests that book something must not each start a request to it (or, with the service up,
 * write a score after their own cleanup). Same pattern as the lazy sweep (`sweepIfDue`).
 */
function scoringEnabled(): boolean {
  return (scoringOverride ?? !underTest()) && isAiBackendConfigured()
}

// A system error code such as ECONNREFUSED or UND_ERR_CONNECT_TIMEOUT. Only a value of this shape is
// logged from a cause: anything else (a message, an address) might carry data and is left out.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/

/**
 * What to say about a failure, from its class or message only (a message can carry data, except the
 * fixed ones of NoShowPredictionError):
 *  - the service's own refusals and bad answers: their fixed message;
 *  - a TypeError, which is what `fetch` throws when it cannot reach the service (`TypeError: fetch
 *    failed`, the socket error in its `cause`): the cause's code (ECONNREFUSED when the service is not
 *    running), or "AI service unreachable" when the cause has none. "TypeError" alone told a developer
 *    nothing, and a dev machine without the AI service logs this for every booking;
 *  - anything else (a timeout, bad JSON, a database error): its class name.
 */
function failureReason(error: unknown): string {
  if (error instanceof NoShowPredictionError) return error.message
  if (error instanceof TypeError) {
    const code = (error.cause as { code?: unknown } | null | undefined)?.code
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code
    if (error.message === 'fetch failed') return 'AI service unreachable'
  }
  return error instanceof Error ? error.name : 'unknown error'
}

/** Logs why a booking was not scored: its id and what failed, never the features, a name or a body. */
export function logScoringFailure(bookingId: string, error: unknown): void {
  console.warn(`no-show scoring: booking ${bookingId} was not scored (${failureReason(error)})`)
}

async function score(bookingId: string, now: Date): Promise<void> {
  // Reads and the service call first, with no transaction open.
  const features = await buildNoShowFeatures(bookingId, now)
  const prediction = await predictNoShow(features)

  // The service caps the penalty itself and the answer is checked for being a sane number, but this
  // number decides where a student sits in a librarian's list: it is clamped here once more, so no
  // answer can ever cost more than MAX_PENALTY_CAP (a score of at least 1 - cap). A rejected answer
  // (negative, not a number) never gets this far; one above the cap is cut down, not refused.
  const penalty = Math.min(Math.max(prediction.penalty_factor, 0), MAX_PENALTY_CAP)
  const priorityScore = 1 - penalty

  await prisma.$transaction(async (tx) => {
    // The booking row first (the order everyone takes), then the event.
    const { userId } = await tx.resourceBooking.update({ where: { id: bookingId }, data: { priorityScore }, select: { userId: true } })
    await tx.noShowEvent.upsert({
      where: { resourceBookingId: bookingId },
      create: { resourceBookingId: bookingId, userId, predictedProbability: prediction.predicted_probability },
      // Only the probability: `actualNoShow` and `reliabilityDelta` are the sweep's and check-in's.
      update: { predictedProbability: prediction.predicted_probability },
    })
  }, SWEEP_TX_OPTIONS)

  // After the commit, once, for a room request only (a seat booking is not in the librarian's queue).
  if (features.resource_type === 'room') publish({ type: 'request.scored', topics: ['requests'] })
}

/**
 * Scores one booking: see the top of this file. Resolves when it is done or has given up; NEVER
 * rejects (a failure is logged by booking id and error class). Does nothing, at once, when scoring
 * is not enabled (no AI_BACKEND_URL; under test, unless a test turned it on).
 */
export async function scoreBooking(bookingId: string, now: Date = new Date()): Promise<void> {
  if (!scoringEnabled()) return
  const run = score(bookingId, now)
  inFlight.add(run)
  try {
    await run
  } catch (error) {
    logScoringFailure(bookingId, error)
  } finally {
    inFlight.delete(run)
  }
}

/** Test only. Turns scoring on (true) or off (false) whatever the process default is; undefined puts the default back (off under test). */
export function enableScoringForTests(enabled: boolean | undefined): void {
  scoringOverride = enabled
}

/**
 * Test only. Waits for every scorer still running, so none runs into the next test's database reset.
 * A scorer that failed is not an error here (`scoreBooking` logs it); this only waits.
 */
export async function settleScoringForTests(): Promise<void> {
  await Promise.allSettled([...inFlight])
}
