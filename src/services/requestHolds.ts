// Releasing what a request holds. A pending borrow request holds one copy
// (CopyStatus 'requested'); a pending room request holds its slot through the
// no_overlapping_bookings constraint, which frees it as soon as the row leaves
// 'requested'.
import { publish } from '../lib/events'
import { prisma } from '../lib/prisma'
import { logSweepFailure, logSweepResult, sweepUnlessRunning } from './noShowService'
import { describeRefreshFailure, logRecommendationRefresh, refreshRecommendationsIfDue } from './recommendationRefresh'
import { onBookReturned } from './reservationService'

/**
 * Moves a pending borrow request to `data.status` and hands its copy back: the
 * copy is available again, then the waitlist cascade runs (the next waiting
 * student gets a claim). Conditional on 'pending', so of two racing decisions
 * only one lands; returns false for the one that lost. A failing cascade is
 * logged, not thrown: the release has committed either way.
 */
export async function releaseBorrowRequest(
  request: { id: string; bookId: string; bookCopyId: string },
  data: { status: 'declined' | 'expired' | 'cancelled'; decidedAt: Date; decidedById?: string; declineReason?: string | null },
): Promise<boolean> {
  const released = await prisma.$transaction(async (tx) => {
    const { count } = await tx.borrowRequest.updateMany({ where: { id: request.id, status: 'pending' }, data })
    if (count === 0) return false
    await tx.bookCopy.updateMany({ where: { id: request.bookCopyId, status: 'requested' }, data: { status: 'available' } })
    return true
  })
  if (released) {
    try {
      await onBookReturned(request.bookId, data.decidedAt)
    } catch (error) {
      // Throwing here would answer 500 for a decision that stuck (without its
      // event, and a retry would find it already settled), or abort the expiry
      // sweep half way. The cascade re-runs lazily on the next waitlist read
      // or join, or when a copy is returned.
      console.error('Waitlist cascade failed after releasing a request:', error)
    }
  }
  return released
}

/**
 * Expires every pending request whose deadline has passed: a borrow request
 * 24 hours after it was made, a room request once its slot's grace period
 * has ended. Returns how many it expired, and publishes one request.expired
 * when that is more than none.
 */
export async function expireStaleRequests(now = new Date()): Promise<number> {
  const staleBorrows = await prisma.borrowRequest.findMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    select: { id: true, bookId: true, bookCopyId: true },
  })
  let expired = 0
  for (const request of staleBorrows) {
    if (await releaseBorrowRequest(request, { status: 'expired', decidedAt: now })) expired += 1
  }

  // Each row's own grace period, as bookingService.computeWindow uses.
  const staleRooms = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ResourceBooking"
    SET status = 'expired', "decidedAt" = ${now}
    WHERE status = 'requested'
      AND "startTime" + make_interval(mins => "gracePeriodMinutes") < ${now}
    RETURNING id`
  expired += staleRooms.length

  if (expired > 0) publish({ type: 'request.expired', topics: ['requests'] })
  return expired
}

export const SWEEP_INTERVAL_MS = 60_000

/**
 * What the 60-second timer runs (src/index.ts passes it to startExpirySweep): the expiry
 * sweep above, the no-show sweep and the recommendation refresh, at the same time. None
 * waits for another or loses its work to another's failure, and each failure is logged by
 * its own message. Never rejects, so startExpirySweep's own catch is not the only thing
 * standing between a failing sweep and a crashed server.
 *
 * The first two touch different rows (requests that are still `requested` or `pending`, and
 * bookings that are `booked`) and the refresh writes only RecommendationCache, and the
 * booking sweep is safe to run at the same instant as itself (the route), so none of the
 * three needs ordering. Don't lengthen SWEEP_INTERVAL_MS: a
 * reminder has a 30-minute window and a no-show is about a minute behind only while this
 * beat runs.
 *
 * The booking sweep goes through the in-process guard it shares with `sweepIfDue`
 * (`sweepUnlessRunning`): when a sweep started by either is still running (a slow
 * database), this beat skips the booking sweep, logs nothing for the skip (except one error
 * line, once, when that sweep is over 10 minutes old: it is hung), and still runs the expiry
 * sweep.
 *
 * The refresh (`refreshRecommendationsIfDue`, recommendationRefresh.ts) fills RecommendationCache from the
 * AI service. It asks at most once a day and not at all unless AI_BACKEND_URL and AI_TOKEN are both set,
 * so almost every beat it answers `null` at once; when it does ask, it can run for up to 90 seconds, and
 * until it ends this beat's promise stays pending (the timer does not wait for it: the next beat starts on
 * time, finds the refresh running and skips it). A failure is logged as
 * `Recommendation refresh failed: <text>` where the text is `describeRefreshFailure`'s and nothing else:
 * never the error object, its `cause` or another error's message, because an unreachable service's error
 * carries its address and a malformed AI_BACKEND_URL makes `fetch` quote the URL, credentials included.
 */
export async function runScheduledSweeps(): Promise<void> {
  const [expiry, bookings, recommendations] = await Promise.allSettled([expireStaleRequests(), sweepUnlessRunning(), refreshRecommendationsIfDue()])
  if (expiry.status === 'rejected') console.error('Expiry sweep failed:', expiry.reason)
  if (bookings.status === 'rejected') logSweepFailure(bookings.reason)
  else if (bookings.value) logSweepResult(bookings.value) // null: a sweep was already running, nothing to say
  if (recommendations.status === 'rejected') console.error(`Recommendation refresh failed: ${describeRefreshFailure(recommendations.reason)}`)
  else if (recommendations.value) logRecommendationRefresh(recommendations.value) // null: it did nothing, nothing to say
}

/**
 * Runs `sweep` now and then every SWEEP_INTERVAL_MS until the returned
 * function is called. Started by src/index.ts only, so tests never run it.
 */
export function startExpirySweep(
  sweep: () => Promise<unknown> = () => expireStaleRequests(),
  intervalMs = SWEEP_INTERVAL_MS,
): () => void {
  const run = () => {
    sweep().catch((error: unknown) => console.error('Expiry sweep failed:', error))
  }
  run()
  const timer = setInterval(run, intervalMs)
  return () => clearInterval(timer)
}
