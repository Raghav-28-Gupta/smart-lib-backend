// A student disputing a recorded no-show (slice 7). A no-show is disputed once, ever, by the
// student it was recorded against, and only for NO_SHOW_DISPUTE_DAYS after the booking's own
// grace period ended. The librarian's answer (overturn or uphold) is below it; what the
// student's booking list says about a dispute (`BookingDto.noShow`) is `noShowInfo` in
// bookingService, next to the window it shares with this service.
import { Prisma } from '../generated/prisma/client'
import { publishAttentionChange, publishBookingChange, publishStudentChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { dayLabel } from '../lib/timeLabels'
import { noShowDisputeDeadline } from './bookingService'
import { DISPUTE_ALREADY_RESOLVED } from './disputeService'
import { createNotice, deliverNotice } from './noticeService'
import { scoreText, SWEEP_TX_OPTIONS } from './noShowService'
import { applyReliabilityDelta } from './reliabilityService'

export const NOT_A_NO_SHOW = 'This booking is not a recorded no-show.'
export const NO_SHOW_WINDOW_PASSED = 'The 7 days to dispute this no-show have passed.'
export const NO_SHOW_ALREADY_DISPUTED = "You've already disputed this no-show."

// The unique bookingId rejects a second dispute of a booking, answered or not. Prisma reports a
// unique violation as P2002; through the pg driver adapter it can also arrive as a generic P2039
// carrying SQLSTATE 23505 in its message (as in disputeService and borrowRequestService).
function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2002' || (e.code === 'P2039' && e.message.includes('23505')))
  )
}

/**
 * Opens the student's dispute of one of their own recorded no-shows.
 *
 * The refusals come in this order: 404 for a booking that does not exist or is another student's
 * (the same answer, so a student cannot probe for ids), 409 when the booking is not a no-show,
 * 409 once `now` is past the window (7 days after the booking's own grace end, so a late sweep
 * does not move it), and 409 for a second dispute, which the unique `bookingId` refuses at the
 * insert.
 *
 * The booking is read plainly and never locked: nothing turns a `no_show` booking into anything
 * else except an overturn, and an overturn needs this very dispute. The insert runs on its own
 * (no transaction around it) and takes the foreign keys' KEY SHARE locks on the booking row and on
 * the student's row. The booking's does not block a sweep or a check-in updating the booking (and
 * is not blocked by them). The student's DOES wait behind `applyReliabilityDelta`'s FOR UPDATE on
 * that row, so while a sweep, a check-in or an overturn is changing this student's score the
 * dispute can queue behind it. It cannot deadlock (the insert holds nothing that writer needs),
 * but it can wait.
 *
 * `attention.changed` is published once, after the insert has committed; a refusal publishes
 * nothing. There is no notice and no email: the student has just done the thing themselves.
 */
export async function createNoShowDispute(
  userId: string,
  bookingId: string,
  reason: string,
  now = new Date(),
): Promise<{ id: string; status: 'open' }> {
  const booking = await prisma.resourceBooking.findFirst({
    where: { id: bookingId, userId },
    select: { status: true, startTime: true, gracePeriodMinutes: true },
  })
  if (!booking) throw new NotFoundError('Booking')
  if (booking.status !== 'no_show') throw new ConflictError(NOT_A_NO_SHOW)
  if (now > noShowDisputeDeadline(booking)) throw new ConflictError(NO_SHOW_WINDOW_PASSED)

  let created: { id: string }
  try {
    created = await prisma.noShowDispute.create({ data: { bookingId, userId, reason, createdAt: now }, select: { id: true } })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(NO_SHOW_ALREADY_DISPUTED)
    throw error
  }

  publishAttentionChange()
  return { id: created.id, status: 'open' }
}

// --- The librarian's answer -------------------------------------------------------------------
// An overturn removes the no-show and gives back what it took; an uphold leaves it standing. Both
// close the dispute and write the student's notice in the same transaction; only after the commit
// is the notice emailed (deliverNotice, which never throws) and the live events published, once, so
// the console's refetch sees the true "emailed" or "not emailed". A refused answer writes, sends
// and publishes nothing.

export const NO_SHOW_REMOVED_TITLE = 'No-show removed'
export const NO_SHOW_STANDS_TITLE = 'No-show stands'

// The reason on the restore row in the student's reliability history. Its colon comes after
// "overturned", so it does not start with NO_SHOW_REASON_PREFIX ("No-show: "): the history reads
// the restore as an ok row, not as a miss (see reliabilityService).
const OVERTURNED_REASON_PREFIX = 'No-show overturned: '

// An overturn is about eleven round trips; on a slow hop to the database Prisma's default 5 seconds
// can run out, and the answer would roll back and be asked again. The sweep's longer limits fit it.
const ANSWER_TX_OPTIONS = SWEEP_TX_OPTIONS

interface LockedBooking {
  userId: string
  startTime: Date
  resourceName: string
}

/**
 * Locks the dispute's booking row for the rest of the transaction (NO KEY UPDATE, like every other
 * booking writer, so a notice written about the booking is not blocked) and reads what the notice
 * needs from it. This is the FIRST lock an answer takes: the booking row, then the dispute, then
 * the event, then the student. The sweep and a check-in take booking, event, student, so the orders
 * agree and none of them can wait on another in a circle.
 */
async function lockBooking(tx: Prisma.TransactionClient, bookingId: string): Promise<LockedBooking> {
  // $queryRaw, not $executeRaw: it has to read the row to lock it. `OF b` leaves the resource's row free.
  // `startTime` is a timestamptz, which the driver adapter reads as the session's wall clock taken for
  // UTC: `AT TIME ZONE 'UTC'` makes it the instant it is whatever the session's zone (the notice names its day).
  const [booking] = await tx.$queryRaw<LockedBooking[]>`
    SELECT b."userId", b."startTime" AT TIME ZONE 'UTC' AS "startTime", r.name AS "resourceName"
    FROM "ResourceBooking" b
    JOIN "Resource" r ON r.id = b."resourceId"
    WHERE b.id = ${bookingId}
    FOR NO KEY UPDATE OF b`
  // Unreachable: a dispute's booking cannot be deleted while the dispute exists (a foreign key).
  if (!booking) throw new NotFoundError('Booking')
  return booking
}

// The note, when there is one, is a paragraph of its own so it does not read as part of the sentence.
const withNote = (sentence: string, note: string | null) => (note ? `${sentence}\n\nNote from the library: ${note}` : sentence)

/**
 * Removes a recorded no-show the student disputed: the dispute goes `open` to `overturned` (the
 * librarian's `reason` is its note), the booking `no_show` to `released` (what a grace-period miss
 * without a penalty looks like), the event is relabelled `actualNoShow = false`, the points the
 * no-show took are given back, and the student is told.
 *
 * One transaction, every change a conditional update, rows taken in this order and never another:
 *  1. the booking row, FOR NO KEY UPDATE (`lockBooking`);
 *  2. the dispute row: ONE conditional update `WHERE id AND status = 'open'`. It goes first on
 *     purpose: the loser of two answers at once (another overturn, an uphold) finds it matched
 *     nothing and answers 409 "This dispute was already resolved." having taken no event or student
 *     lock, written nothing (its transaction rolls back whole) and sent nothing;
 *  3. the booking, `WHERE status = 'no_show'` (409 "This booking is not a recorded no-show." and a
 *     full rollback if it is anything else: the dispute and the booking never part ways);
 *  4. the event row, one `UPDATE ... RETURNING` that relabels it and reads `reliabilityDelta`, the
 *     points the no-show actually took (negative, after the sweep's clamp at 0). A booking can have
 *     no event row (a seed-made no-show that was never scored): then nothing was recorded as taken,
 *     none is created, and the rest of the answer goes on;
 *  5. the student, through `applyReliabilityDelta` (FOR UPDATE), giving back EXACTLY what the event
 *     says was taken, never above 100 (its own clamp: the history records what was applied).
 *     Nothing is restored, and no history row is written, when the figure is 0 (the student was
 *     already at 0) or unknown; the notice then names the score the student has now.
 *
 * The notice is created in the same transaction. After the commit it is emailed, then
 * `booking.changed`, `student.changed` and `attention.changed` are published once each. 404 for an
 * id that is no no-show dispute.
 */
export async function overturnNoShow(disputeId: string, adminId: string, reason: string, now = new Date()): Promise<{ id: string }> {
  const notice = await prisma.$transaction(async (tx) => {
    const dispute = await tx.noShowDispute.findUnique({ where: { id: disputeId }, select: { bookingId: true } })
    if (!dispute) throw new NotFoundError('No-show dispute')
    const { bookingId } = dispute
    const booking = await lockBooking(tx, bookingId)

    const closed = await tx.noShowDispute.updateMany({
      where: { id: disputeId, status: 'open' },
      data: { status: 'overturned', resolutionNote: reason, resolvedById: adminId, resolvedAt: now },
    })
    if (closed.count === 0) throw new ConflictError(DISPUTE_ALREADY_RESOLVED)

    const released = await tx.resourceBooking.updateMany({ where: { id: bookingId, status: 'no_show' }, data: { status: 'released' } })
    if (released.count === 0) throw new ConflictError(NOT_A_NO_SHOW)

    const [event] = await tx.$queryRaw<Array<{ reliabilityDelta: number | null }>>`
      UPDATE "NoShowEvent" SET "actualNoShow" = false
      WHERE "resourceBookingId" = ${bookingId}
      RETURNING "reliabilityDelta"`
    const taken = event?.reliabilityDelta ?? 0

    const score =
      taken < 0
        ? (await applyReliabilityDelta(tx, booking.userId, -taken, `${OVERTURNED_REASON_PREFIX}${booking.resourceName}`)).score
        : (await tx.user.findUniqueOrThrow({ where: { id: booking.userId }, select: { reliabilityScore: true } })).reliabilityScore

    return createNotice(tx, {
      userId: booking.userId,
      kind: 'no_show_outcome',
      title: NO_SHOW_REMOVED_TITLE,
      body: withNote(
        `The library removed the no-show for ${booking.resourceName} (${dayLabel(booking.startTime)}) and restored your reliability score to ${scoreText(score)}.`,
        reason,
      ),
      bookingId,
      createdById: adminId,
    })
  }, ANSWER_TX_OPTIONS)

  await deliverNotice(notice)
  publishBookingChange()
  publishStudentChange()
  publishAttentionChange()
  return { id: disputeId }
}

/**
 * The librarian keeps the no-show: the dispute goes `open` to `upheld` (with the optional `note`),
 * the booking stays `no_show`, no points move, and the student is told. The same lock order as an
 * overturn (the booking row first, then the dispute's conditional update), so the two never wait on
 * each other in a circle, and one of two answers at once is refused with 409 "This dispute was
 * already resolved." having written nothing. After the commit the notice is emailed, then only
 * `attention.changed` is published: nothing but the queue changed. 404 for an id that is no no-show
 * dispute.
 */
export async function upholdNoShow(disputeId: string, adminId: string, note: string | null, now = new Date()): Promise<{ id: string }> {
  const notice = await prisma.$transaction(async (tx) => {
    const dispute = await tx.noShowDispute.findUnique({ where: { id: disputeId }, select: { bookingId: true } })
    if (!dispute) throw new NotFoundError('No-show dispute')
    const { bookingId } = dispute
    const booking = await lockBooking(tx, bookingId)

    const closed = await tx.noShowDispute.updateMany({
      where: { id: disputeId, status: 'open' },
      data: { status: 'upheld', resolutionNote: note, resolvedById: adminId, resolvedAt: now },
    })
    if (closed.count === 0) throw new ConflictError(DISPUTE_ALREADY_RESOLVED)

    return createNotice(tx, {
      userId: booking.userId,
      kind: 'no_show_outcome',
      title: NO_SHOW_STANDS_TITLE,
      body: withNote(`The library kept the no-show for ${booking.resourceName} (${dayLabel(booking.startTime)}).`, note),
      bookingId,
      createdById: adminId,
    })
  }, ANSWER_TX_OPTIONS)

  await deliverNotice(notice)
  publishAttentionChange()
  return { id: disputeId }
}
