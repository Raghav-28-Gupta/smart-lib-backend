// The librarian's side of requests: the pending queue, and approving or
// declining a borrow or room request. Every decision is a conditional update
// on the pending status, so of two librarians deciding at once only the first
// lands; the second is told what happened (requestMessages.ts).
import { LOAN_PERIOD_DAYS } from '../config/constants'
import { publish } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { graceEnd } from './bookingService'
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
  room?: { resourceId: string; name: string; location: string | null; startTime: Date; endTime: Date }
}

export interface DecisionDto {
  id: string
  kind: RequestKind
  status: 'approved' | 'declined'
  decidedAt: Date
}

const DAY_MS = 24 * 60 * 60 * 1000
const studentFields = { select: { id: true, name: true, email: true } } as const

export async function listPendingRequests(
  now = new Date(),
): Promise<{ requests: AdminRequestDto[]; counts: { all: number; borrow: number; room: number } }> {
  await expireStaleRequests(now)
  const [borrows, rooms] = await Promise.all([
    prisma.borrowRequest.findMany({
      where: { status: 'pending' },
      include: { user: studentFields, book: { select: { id: true, title: true, author: true, totalCopies: true } } },
    }),
    prisma.resourceBooking.findMany({
      where: { status: 'requested' },
      include: { user: studentFields, resource: { select: { id: true, name: true, location: true } } },
    }),
  ])

  const bookIds = [...new Set(borrows.map((b) => b.bookId))]
  const available =
    bookIds.length === 0
      ? []
      : await prisma.bookCopy.groupBy({ by: ['bookId'], where: { bookId: { in: bookIds }, status: 'available' }, _count: true })
  const availableByBook = new Map(available.map((g) => [g.bookId, g._count]))

  const requests: AdminRequestDto[] = [
    ...borrows.map((b) => ({
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
        totalCopies: b.book.totalCopies,
      },
    })),
    ...rooms.map((r) => ({
      id: r.id,
      kind: 'room' as const,
      student: r.user,
      requestedAt: r.requestedAt,
      expiresAt: graceEnd(r),
      room: { resourceId: r.resource.id, name: r.resource.name, location: r.resource.location, startTime: r.startTime, endTime: r.endTime },
    })),
  ].sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())

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

  publish({ type: 'request.decided', topics: ['requests', 'metrics'], kind: 'room' })
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
