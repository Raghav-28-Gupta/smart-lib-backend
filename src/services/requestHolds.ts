// Releasing what a request holds. A pending borrow request holds one copy
// (CopyStatus 'requested'); a pending room request holds its slot through the
// no_overlapping_bookings constraint, which frees it as soon as the row leaves
// 'requested'.
import { publish } from '../lib/events'
import { prisma } from '../lib/prisma'
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
