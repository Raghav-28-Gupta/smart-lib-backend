// A student asks to borrow a book; a librarian approves or declines it in the
// admin console (adminRequestService.ts). While it waits, the request holds one
// copy, so nobody else can take it.
import { BORROW_REQUEST_HOURS, REQUEST_OUTCOME_VISIBLE_DAYS } from '../config/constants'
import { Prisma } from '../generated/prisma/client'
import type { BorrowRequest } from '../generated/prisma/client'
import { publish } from '../lib/events'
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { expireStaleRequests, releaseBorrowRequest } from './requestHolds'
import { assertNotReservedForAnother, consumeClaimIfAny } from './reservationService'

const HOUR_MS = 60 * 60 * 1000

export interface BorrowRequestDto {
  id: string
  bookId: string
  bookTitle: string
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'cancelled'
  requestedAt: Date
  expiresAt: Date
  decidedAt: Date | null
  declineReason: string | null
}

function toDto(r: BorrowRequest & { book: { title: string } }): BorrowRequestDto {
  return {
    id: r.id,
    bookId: r.bookId,
    bookTitle: r.book.title,
    status: r.status,
    requestedAt: r.requestedAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    declineReason: r.declineReason,
  }
}

// The partial unique index BorrowRequest_one_pending_per_title rejects a
// second pending request for a title. Prisma reports a unique violation as
// P2002; through the pg driver adapter it can also arrive as a generic P2039
// carrying SQLSTATE 23505 in its message (see bookingService.isExclusionViolation).
function isDuplicatePending(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2002' || (e.code === 'P2039' && e.message.includes('23505')))
  )
}

export async function createBorrowRequest(userId: string, bookId: string): Promise<BorrowRequestDto> {
  await expireStaleRequests()
  const book = await prisma.book.findUnique({ where: { id: bookId } })
  if (!book) throw new NotFoundError('Book')

  const activeLoan = await prisma.loan.findFirst({ where: { userId, status: 'active', bookCopy: { bookId } } })
  if (activeLoan) throw new ConflictError('You already have this book borrowed.')
  const pending = await prisma.borrowRequest.findFirst({ where: { userId, bookId, status: 'pending' } })
  if (pending) throw new ConflictError("You've already requested this book.")

  const now = new Date()
  // "No available copies right now." or the waitlist message, as borrowing had.
  await assertNotReservedForAnother(userId, bookId, now)

  let created
  try {
    created = await prisma.$transaction(async (tx) => {
      // The same race-safe claim borrowing used: the conditional update
      // re-checks 'available' against the committed row, so two requests can
      // never hold one copy.
      const candidates = await tx.bookCopy.findMany({ where: { bookId, status: 'available' }, select: { id: true }, take: 5 })
      for (const candidate of candidates) {
        const { count } = await tx.bookCopy.updateMany({
          where: { id: candidate.id, status: 'available' },
          data: { status: 'requested' },
        })
        if (count === 1) {
          return tx.borrowRequest.create({
            data: {
              userId,
              bookId,
              bookCopyId: candidate.id,
              requestedAt: now,
              expiresAt: new Date(now.getTime() + BORROW_REQUEST_HOURS * HOUR_MS),
            },
            include: { book: { select: { title: true } }, user: { select: { name: true } } },
          })
        }
      }
      throw new ConflictError('No available copies right now.')
    })
  } catch (e) {
    if (isDuplicatePending(e)) throw new ConflictError("You've already requested this book.")
    throw e
  }

  // A waitlist claim the student held is now this request.
  await consumeClaimIfAny(userId, bookId)
  publish({
    type: 'request.created',
    topics: ['requests'],
    kind: 'borrow',
    summary: `${created.user.name} wants to borrow ${created.book.title}`,
  })
  return toDto(created)
}

export async function listMyBorrowRequests(userId: string): Promise<BorrowRequestDto[]> {
  await expireStaleRequests()
  const since = new Date(Date.now() - REQUEST_OUTCOME_VISIBLE_DAYS * 24 * HOUR_MS)
  const rows = await prisma.borrowRequest.findMany({
    where: {
      userId,
      OR: [{ status: 'pending' }, { status: { in: ['declined', 'expired'] }, decidedAt: { gte: since } }],
    },
    include: { book: { select: { title: true } } },
    orderBy: { requestedAt: 'desc' },
  })
  return rows.map(toDto)
}

export async function cancelBorrowRequest(userId: string, requestId: string): Promise<BorrowRequestDto> {
  const request = await prisma.borrowRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new NotFoundError('Borrow request')
  if (request.userId !== userId) throw new ForbiddenError('This request belongs to another user.')

  const withdrawn =
    request.status === 'pending' && (await releaseBorrowRequest(request, { status: 'cancelled', decidedAt: new Date() }))
  if (!withdrawn) throw new ConflictError('This request is no longer pending.')

  publish({ type: 'request.cancelled', topics: ['requests'], kind: 'borrow' })
  const updated = await prisma.borrowRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { book: { select: { title: true } } },
  })
  return toDto(updated)
}
