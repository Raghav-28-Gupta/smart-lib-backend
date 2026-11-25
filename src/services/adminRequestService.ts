// The librarian's side of requests: the pending queue, and approving or
// declining a borrow or room request. Every decision is a conditional update
// on the pending status, so of two librarians deciding at once only the first
// lands; the second is told what happened (requestMessages.ts).
import { LOAN_PERIOD_DAYS, MAX_PENALTY_CAP, PRIORITY_WINDOW_HOURS } from '../config/constants'
import { publish } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { graceEnd } from './bookingService'
import { totalCopiesByBook } from './bookService'
import { expireStaleRequests, releaseBorrowRequest } from './requestHolds'
import { settledMessage, type Settled } from './requestMessages'

export type RequestKind = 'borrow' | 'room'

export interface AdminRequestDto {
  id: string
  kind: RequestKind
  student: { id: string; name: string; email: string }
  requestedAt: Date
  expiresAt: Date
  book?: { id: string; title: string; author: string; availableCopies: number; totalCopies: number }
  room?: {
    resourceId: string
    name: string
    location: string | null
    startTime: Date
    endTime: Date
    // Present only when the booking was scored (priorityScore not null): how much later than its
    // request time the suggested order puts it (0 to 72 minutes), and the model's no-show risk.
    priority?: { suggestedDelayMinutes: number; riskPercent: number | null }
  }
}

export interface DecisionDto {
  id: string
  kind: RequestKind
  status: 'approved' | 'declined'
  decidedAt: Date
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const studentFields = { select: { id: true, name: true, email: true } } as const

// --- Bounded priority (slice 7, spec section 6) ----------------------------------------
// A scored room request sits up to MAX_PENALTY_CAP * PRIORITY_WINDOW_HOURS (72 minutes) later in the
// librarian's list than its request time says. Only the order moves: nothing is hidden, declined or
// expired because of it, and a request with no score (null) is read as 1.0, no nudge.

/** 'suggested' (the default): room requests by the bounded priority; 'request': plain request time. */
export type RequestOrder = 'suggested' | 'request'

/** What the ordering needs of a request; `priorityScore` is only ever read for a room request. */
export interface QueueEntry {
  id: string
  kind: RequestKind
  requestedAt: Date
  priorityScore?: number | null
}

/** A stored score read safely: null or NaN is 1 (no nudge), above 1 is 1, below 1 - MAX_PENALTY_CAP is that. */
export function clampPriorityScore(score: number | null): number {
  if (score === null || Number.isNaN(score)) return 1
  return Math.min(Math.max(score, 1 - MAX_PENALTY_CAP), 1)
}

/** How many ms later than its request time a score puts a room request: 0 to 72 minutes, whatever is stored. */
export function priorityDelayMs(score: number | null): number {
  // Rounded to the millisecond (the precision of the dates) so two equal keys compare equal.
  return Math.round((1 - clampPriorityScore(score)) * PRIORITY_WINDOW_HOURS * HOUR_MS)
}

/** The same delay in whole minutes, as the console shows it. */
export function suggestedDelayMinutes(score: number | null): number {
  return Math.round((1 - clampPriorityScore(score)) * PRIORITY_WINDOW_HOURS * 60)
}

/**
 * Sorts by the queue key: `requestedAt` plus, for a ROOM request in the 'suggested' order, its delay.
 * Borrow requests always keep `requestedAt`. Equal key: the earlier real `requestedAt`, then the id, so the
 * order is the same on every call. Returns a new array.
 */
export function orderRequests<T extends QueueEntry>(entries: T[], order: RequestOrder): T[] {
  const key = (e: T) => e.requestedAt.getTime() + (order === 'suggested' && e.kind === 'room' ? priorityDelayMs(e.priorityScore ?? null) : 0)
  return [...entries].sort(
    (a, b) => key(a) - key(b) || a.requestedAt.getTime() - b.requestedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export async function listPendingRequests(
  now = new Date(),
  order: RequestOrder = 'suggested',
): Promise<{ requests: AdminRequestDto[]; counts: { all: number; borrow: number; room: number } }> {
  await expireStaleRequests(now)
  const [borrows, rooms] = await Promise.all([
    prisma.borrowRequest.findMany({
      where: { status: 'pending' },
      include: { user: studentFields, book: { select: { id: true, title: true, author: true } } },
    }),
    prisma.resourceBooking.findMany({
      where: { status: 'requested' },
      // The event comes with the rows (one query for all of them), for the predicted risk.
      include: {
        user: studentFields,
        resource: { select: { id: true, name: true, location: true } },
        noShowEvent: { select: { predictedProbability: true } },
      },
    }),
  ])

  const bookIds = [...new Set(borrows.map((b) => b.bookId))]
  // The total is the same count a student sees (bookService), not the stored column.
  const [available, totalByBook] = await Promise.all([
    bookIds.length === 0
      ? []
      : prisma.bookCopy.groupBy({ by: ['bookId'], where: { bookId: { in: bookIds }, status: 'available' }, _count: true }),
    totalCopiesByBook(bookIds),
  ])
  const availableByBook = new Map(available.map((g) => [g.bookId, g._count]))

  const entries: (QueueEntry & { dto: AdminRequestDto })[] = [
    ...borrows.map((b) => ({
      id: b.id,
      kind: 'borrow' as const,
      requestedAt: b.requestedAt,
      dto: {
        id: b.id,
        kind: 'borrow' as const,
        student: b.user,
        requestedAt: b.requestedAt,
        expiresAt: b.expiresAt,
        book: {
          id: b.book.id,
          title: b.book.title,
          author: b.book.author,
          availableCopies: availableByBook.get(b.bookId) ?? 0,
          totalCopies: totalByBook.get(b.bookId) ?? 0,
        },
      },
    })),
    ...rooms.map((r) => {
      const risk = r.noShowEvent?.predictedProbability
      return {
        id: r.id,
        kind: 'room' as const,
        requestedAt: r.requestedAt,
        priorityScore: r.priorityScore,
        dto: {
          id: r.id,
          kind: 'room' as const,
          student: r.user,
          requestedAt: r.requestedAt,
          expiresAt: graceEnd(r),
          room: {
            resourceId: r.resource.id,
            name: r.resource.name,
            location: r.resource.location,
            startTime: r.startTime,
            endTime: r.endTime,
            // Absent (no key at all) when the booking was never scored.
            ...(r.priorityScore === null
              ? {}
              : { priority: { suggestedDelayMinutes: suggestedDelayMinutes(r.priorityScore), riskPercent: risk == null ? null : Math.round(risk * 100) } }),
          },
        },
      }
    }),
  ]
  const requests = orderRequests(entries, order).map((e) => e.dto)

  return { requests, counts: { all: requests.length, borrow: borrows.length, room: rooms.length } }
}

// --- Borrow requests ---------------------------------------------------------

async function findBorrow(id: string) {
  const request = await prisma.borrowRequest.findUnique({ where: { id }, include: { decidedBy: { select: { name: true } } } })
  if (!request) throw new NotFoundError('Request')
  return request
}

function borrowSettled(status: string): Settled | null {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'declined':
      return 'declined'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'withdrawn'
    default:
      return null
  }
}

async function refuseSettledBorrow(id: string): Promise<never> {
  const current = await findBorrow(id)
  throw new ConflictError(settledMessage(borrowSettled(current.status), current.decidedBy?.name ?? null))
}

async function refuseIfBorrowLapsed(request: { id: string; bookId: string; bookCopyId: string; expiresAt: Date }, now: Date) {
  if (request.expiresAt > now) return
  if (await releaseBorrowRequest(request, { status: 'expired', decidedAt: now })) {
    publish({ type: 'request.expired', topics: ['requests'] })
  }
  throw new ConflictError('This request expired.')
}

async function approveBorrow(id: string, adminId: string, now: Date): Promise<DecisionDto> {
  const request = await findBorrow(id)
  if (request.status !== 'pending') return refuseSettledBorrow(id)
  await refuseIfBorrowLapsed(request, now)

  const approved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.borrowRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'approved', decidedAt: now, decidedById: adminId },
    })
    if (count === 0) return false
    // The loan starts now: approval is the moment the student gets the book.
    const loan = await tx.loan.create({
      data: { userId: request.userId, bookCopyId: request.bookCopyId, borrowedAt: now, dueAt: new Date(now.getTime() + LOAN_PERIOD_DAYS * DAY_MS) },
    })
    await tx.bookCopy.update({ where: { id: request.bookCopyId }, data: { status: 'borrowed' } })
    await tx.borrowRequest.update({ where: { id }, data: { loanId: loan.id } })
    return true
  })
  if (!approved) return refuseSettledBorrow(id)

  publish({ type: 'request.decided', topics: ['requests', 'metrics'], kind: 'borrow' })
  return { id, kind: 'borrow', status: 'approved', decidedAt: now }
}

async function declineBorrow(id: string, adminId: string, reason: string | null, now: Date): Promise<DecisionDto> {
  const request = await findBorrow(id)
  if (request.status !== 'pending') return refuseSettledBorrow(id)
  await refuseIfBorrowLapsed(request, now)

  const declined = await releaseBorrowRequest(request, { status: 'declined', decidedAt: now, decidedById: adminId, declineReason: reason })
  if (!declined) return refuseSettledBorrow(id)

  publish({ type: 'request.decided', topics: ['requests'], kind: 'borrow' })
  return { id, kind: 'borrow', status: 'declined', decidedAt: now }
}

// --- Room requests -----------------------------------------------------------

async function findRoom(id: string) {
  const booking = await prisma.resourceBooking.findUnique({
    where: { id },
    include: { resource: { select: { type: true } }, decidedBy: { select: { name: true } } },
  })
  // A seat booking is never a request.
  if (!booking || booking.resource.type !== 'room') throw new NotFoundError('Request')
  return booking
}

function roomSettled(booking: { status: string; decidedById: string | null }): Settled | null {
  if (booking.status === 'declined') return 'declined'
  if (booking.status === 'expired') return 'expired'
  // Approved, whatever happened to the booking since (checked in, cancelled...).
  if (booking.decidedById !== null) return 'approved'
  if (booking.status === 'cancelled') return 'withdrawn'
  return null
}

async function refuseSettledRoom(id: string): Promise<never> {
  const current = await findRoom(id)
  throw new ConflictError(settledMessage(roomSettled(current), current.decidedBy?.name ?? null))
}

async function refuseIfRoomLapsed(booking: { id: string; startTime: Date; gracePeriodMinutes: number }, now: Date) {
  if (now <= graceEnd(booking)) return
  const { count } = await prisma.resourceBooking.updateMany({
    where: { id: booking.id, status: 'requested' },
    data: { status: 'expired', decidedAt: now },
  })
  if (count > 0) publish({ type: 'request.expired', topics: ['requests'] })
  throw new ConflictError('This request expired.')
}

async function approveRoom(id: string, adminId: string, now: Date): Promise<DecisionDto> {
  const booking = await findRoom(id)
  if (booking.status !== 'requested') return refuseSettledRoom(id)
  await refuseIfRoomLapsed(booking, now)

  const { count } = await prisma.resourceBooking.updateMany({
    where: { id, status: 'requested' },
    data: { status: 'booked', decidedAt: now, decidedById: adminId },
  })
  if (count === 0) return refuseSettledRoom(id)

  publish({ type: 'request.decided', topics: ['requests', 'metrics', 'bookings'], kind: 'room' })
  return { id, kind: 'room', status: 'approved', decidedAt: now }
}

async function declineRoom(id: string, adminId: string, reason: string | null, now: Date): Promise<DecisionDto> {
  const booking = await findRoom(id)
  if (booking.status !== 'requested') return refuseSettledRoom(id)
  await refuseIfRoomLapsed(booking, now)

  const { count } = await prisma.resourceBooking.updateMany({
    where: { id, status: 'requested' },
    data: { status: 'declined', decidedAt: now, decidedById: adminId, declineReason: reason },
  })
  if (count === 0) return refuseSettledRoom(id)

  publish({ type: 'request.decided', topics: ['requests'], kind: 'room' })
  return { id, kind: 'room', status: 'declined', decidedAt: now }
}

export function approveRequest(kind: RequestKind, id: string, adminId: string, now = new Date()): Promise<DecisionDto> {
  return kind === 'borrow' ? approveBorrow(id, adminId, now) : approveRoom(id, adminId, now)
}

export function declineRequest(
  kind: RequestKind,
  id: string,
  adminId: string,
  reason: string | null,
  now = new Date(),
): Promise<DecisionDto> {
  return kind === 'borrow' ? declineBorrow(id, adminId, reason, now) : declineRoom(id, adminId, reason, now)
}
