import { WAITLIST_CLAIM_HOURS } from '../config/constants'
import type { Reservation } from '../generated/prisma/client'
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

export interface ReservationDto {
  id: string
  userId: string
  bookId: string
  requestedAt: Date
  status: string
  claimExpiresAt: Date | null
  queuePosition: number | null
}

// At most `availableCopies` reservations should be 'fulfilled' for a book at
// once -- each fulfilled claim earmarks one of the currently-available
// copies for its holder, without physically flipping that copy's status
// (CopyStatus has no "held" state). Expires stale claims, then promotes the
// oldest waiting reservation(s) into whatever headroom opens up.
async function rebalanceClaims(bookId: string, now: Date): Promise<void> {
  const staleClaims = await prisma.reservation.findMany({
    where: { bookId, status: 'fulfilled', claimExpiresAt: { lt: now } },
    select: { id: true },
  })
  if (staleClaims.length > 0) {
    await prisma.reservation.updateMany({
      where: { id: { in: staleClaims.map((c) => c.id) } },
      data: { status: 'expired' },
    })
  }

  const [availableCopies, activeFulfilled] = await Promise.all([
    prisma.bookCopy.count({ where: { bookId, status: 'available' } }),
    prisma.reservation.count({ where: { bookId, status: 'fulfilled' } }),
  ])

  let headroom = availableCopies - activeFulfilled
  while (headroom > 0) {
    const next = await prisma.reservation.findFirst({
      where: { bookId, status: 'waiting' },
      orderBy: { requestedAt: 'asc' },
    })
    if (!next) break
    await prisma.reservation.update({
      where: { id: next.id },
      data: { status: 'fulfilled', claimExpiresAt: new Date(now.getTime() + WAITLIST_CLAIM_HOURS * 60 * 60 * 1000) },
    })
    headroom -= 1
  }
}

async function toReservationDto(r: Reservation, now: Date): Promise<ReservationDto> {
  const queuePosition =
    r.status === 'waiting'
      ? 1 +
        (await prisma.reservation.count({
          where: { bookId: r.bookId, status: 'waiting', requestedAt: { lt: r.requestedAt } },
        }))
      : null
  return {
    id: r.id,
    userId: r.userId,
    bookId: r.bookId,
    requestedAt: r.requestedAt,
    status: r.status,
    claimExpiresAt: r.claimExpiresAt,
    queuePosition,
  }
}

export async function joinWaitlist(userId: string, bookId: string): Promise<ReservationDto> {
  const book = await prisma.book.findUnique({ where: { id: bookId } })
  if (!book) throw new NotFoundError('Book')

  const now = new Date()
  await rebalanceClaims(bookId, now)

  const [availableCopies, activeFulfilled] = await Promise.all([
    prisma.bookCopy.count({ where: { bookId, status: 'available' } }),
    prisma.reservation.count({ where: { bookId, status: 'fulfilled' } }),
  ])
  if (availableCopies - activeFulfilled > 0) {
    throw new ConflictError('Copies are currently available — borrow it directly instead.')
  }

  const existing = await prisma.reservation.findFirst({
    where: { userId, bookId, status: { in: ['waiting', 'fulfilled'] } },
  })
  if (existing) throw new ConflictError("You're already on the waitlist for this title.")

  const reservation = await prisma.reservation.create({ data: { userId, bookId, requestedAt: now } })
  return toReservationDto(reservation, now)
}

export async function listMyReservations(userId: string): Promise<ReservationDto[]> {
  const now = new Date()
  const mine = await prisma.reservation.findMany({
    where: { userId, status: { in: ['waiting', 'fulfilled'] } },
    select: { bookId: true },
  })
  const bookIds = [...new Set(mine.map((r) => r.bookId))]
  await Promise.all(bookIds.map((bookId) => rebalanceClaims(bookId, now)))

  const reservations = await prisma.reservation.findMany({
    where: { userId, status: { in: ['waiting', 'fulfilled'] } },
    orderBy: { requestedAt: 'asc' },
  })
  return Promise.all(reservations.map((r) => toReservationDto(r, now)))
}

export async function cancelReservation(userId: string, reservationId: string): Promise<ReservationDto> {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } })
  if (!reservation) throw new NotFoundError('Reservation')
  if (reservation.userId !== userId) throw new ForbiddenError('This reservation belongs to another user.')
  if (reservation.status === 'cancelled' || reservation.status === 'expired') {
    throw new ConflictError('This reservation is no longer active.')
  }

  const now = new Date()
  const wasFulfilled = reservation.status === 'fulfilled'
  const updated = await prisma.reservation.update({ where: { id: reservationId }, data: { status: 'cancelled' } })
  if (wasFulfilled) await rebalanceClaims(reservation.bookId, now)

  return toReservationDto(updated, now)
}

// Used by loanService.borrowBook: blocks a non-claimant from taking a copy
// that's earmarked for someone else's active claim, while still letting
// unclaimed headroom (or the claimant's own claim) through.
export async function assertNotReservedForAnother(userId: string, bookId: string, now: Date): Promise<void> {
  await rebalanceClaims(bookId, now)
  const [availableCopies, claimsByOthers] = await Promise.all([
    prisma.bookCopy.count({ where: { bookId, status: 'available' } }),
    prisma.reservation.count({ where: { bookId, status: 'fulfilled', userId: { not: userId } } }),
  ])
  if (availableCopies - claimsByOthers <= 0) {
    throw new ConflictError('All available copies are reserved for waitlisted students right now.')
  }
}

// Called by loanService.borrowBook after a successful borrow: if the
// borrower was consuming their own active claim, that reservation is done —
// deleted rather than tracked under a separate terminal status, since a
// 'fulfilled' row's only meaning is "waiting to be claimed".
export async function consumeClaimIfAny(userId: string, bookId: string): Promise<void> {
  await prisma.reservation.deleteMany({ where: { userId, bookId, status: 'fulfilled' } })
}

// Task 5's returnLoan calls this once the copy is freed, to cascade the
// claim to the next waiter if anyone is queued.
export async function onBookReturned(bookId: string, now: Date): Promise<void> {
  await rebalanceClaims(bookId, now)
}
