import { LOAN_PERIOD_DAYS, MAX_RENEWALS, FINE_PER_DAY_INR } from '../config/constants'
import type { Loan } from '../generated/prisma/client'
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

export interface LoanDto {
  id: string
  userId: string
  bookId: string
  borrowedAt: Date
  dueAt: Date
  returnedAt: Date | null
  renewedCount: number
  status: string
  frontendStatus: 'normal' | 'overdue'
  fineAmount: number
  canRenew: boolean
  blockedReason: string | null
}

function daysOverdue(dueAt: Date, at: Date): number {
  const ms = at.getTime() - dueAt.getTime()
  if (ms <= 0) return 0
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

function computeFineAmount(dueAt: Date, at: Date): number {
  return daysOverdue(dueAt, at) * FINE_PER_DAY_INR
}

// Waitlist-block takes precedence over the renewal cap: someone else waiting
// on the title is a domain reason (the book is needed elsewhere); the cap is
// just this reader's personal usage limit.
function computeRenewability(renewedCount: number, waitlistCount: number): { canRenew: boolean; blockedReason: string | null } {
  if (waitlistCount > 0) {
    const noun = waitlistCount === 1 ? 'student is' : 'students are'
    return { canRenew: false, blockedReason: `${waitlistCount} ${noun} waiting for this title.` }
  }
  if (renewedCount >= MAX_RENEWALS) {
    return { canRenew: false, blockedReason: `You've reached the maximum of ${MAX_RENEWALS} renewals for this loan.` }
  }
  return { canRenew: true, blockedReason: null }
}

async function toLoanDto(loan: Loan & { bookCopy: { bookId: string } }, now: Date): Promise<LoanDto> {
  const isActive = loan.status === 'active'
  const overdue = isActive && loan.dueAt < now
  const fineAmount = isActive ? computeFineAmount(loan.dueAt, now) : 0
  const waitlistCount = isActive
    ? await prisma.reservation.count({ where: { bookId: loan.bookCopy.bookId, status: 'waiting' } })
    : 0
  const { canRenew, blockedReason } = isActive
    ? computeRenewability(loan.renewedCount, waitlistCount)
    : { canRenew: false, blockedReason: null }

  return {
    id: loan.id,
    userId: loan.userId,
    bookId: loan.bookCopy.bookId,
    borrowedAt: loan.borrowedAt,
    dueAt: loan.dueAt,
    returnedAt: loan.returnedAt,
    renewedCount: loan.renewedCount,
    status: loan.status,
    frontendStatus: overdue ? 'overdue' : 'normal',
    fineAmount,
    canRenew,
    blockedReason,
  }
}

export async function borrowBook(userId: string, bookId: string): Promise<LoanDto> {
  const existing = await prisma.loan.findFirst({
    where: { userId, status: 'active', bookCopy: { bookId } },
  })
  if (existing) throw new ConflictError('You already have this book borrowed.')

  const now = new Date()
  // Claims one available copy via a guarded conditional update, which is
  // race-safe under Postgres's row locking without needing SELECT ... FOR
  // UPDATE: if two requests race for the same copy, the second's updateMany
  // re-checks status='available' against the now-committed row, affects 0
  // rows, and falls through to the next candidate.
  const loan = await prisma.$transaction(async (tx) => {
    const candidates = await tx.bookCopy.findMany({
      where: { bookId, status: 'available' },
      select: { id: true },
      take: 5,
    })
    for (const candidate of candidates) {
      const { count } = await tx.bookCopy.updateMany({
        where: { id: candidate.id, status: 'available' },
        data: { status: 'borrowed' },
      })
      if (count === 1) {
        return tx.loan.create({
          data: {
            userId,
            bookCopyId: candidate.id,
            dueAt: new Date(now.getTime() + LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000),
          },
          include: { bookCopy: { select: { bookId: true } } },
        })
      }
    }
    throw new ConflictError('No available copies right now.')
  })

  return toLoanDto(loan, now)
}

export async function listMyLoans(userId: string): Promise<LoanDto[]> {
  const now = new Date()
  const loans = await prisma.loan.findMany({
    where: { userId, status: { not: 'returned' } },
    include: { bookCopy: { select: { bookId: true } } },
    orderBy: { dueAt: 'asc' },
  })
  return Promise.all(loans.map((loan) => toLoanDto(loan, now)))
}

async function getOwnedActiveLoan(userId: string, loanId: string) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { bookCopy: { select: { bookId: true } } },
  })
  if (!loan) throw new NotFoundError('Loan')
  if (loan.userId !== userId) throw new ForbiddenError('This loan belongs to another user.')
  if (loan.status === 'returned') throw new ConflictError('This loan has already been returned.')
  return loan
}

export async function renewLoan(userId: string, loanId: string): Promise<LoanDto> {
  const loan = await getOwnedActiveLoan(userId, loanId)
  const now = new Date()

  const waitlistCount = await prisma.reservation.count({ where: { bookId: loan.bookCopy.bookId, status: 'waiting' } })
  const { canRenew, blockedReason } = computeRenewability(loan.renewedCount, waitlistCount)
  if (!canRenew) throw new ConflictError(blockedReason ?? 'This loan cannot be renewed.')

  const overdueDays = daysOverdue(loan.dueAt, now)
  if (overdueDays > 0) {
    await prisma.fine.create({
      data: { userId, relatedLoanId: loan.id, amount: overdueDays * FINE_PER_DAY_INR, reason: 'overdue' },
    })
  }

  const updated = await prisma.loan.update({
    where: { id: loan.id },
    data: {
      dueAt: new Date(now.getTime() + LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000),
      renewedCount: { increment: 1 },
    },
    include: { bookCopy: { select: { bookId: true } } },
  })
  return toLoanDto(updated, now)
}

export async function returnLoan(userId: string, loanId: string): Promise<LoanDto> {
  const loan = await getOwnedActiveLoan(userId, loanId)
  const now = new Date()

  const overdueDays = daysOverdue(loan.dueAt, now)
  if (overdueDays > 0) {
    await prisma.fine.create({
      data: { userId, relatedLoanId: loan.id, amount: overdueDays * FINE_PER_DAY_INR, reason: 'overdue' },
    })
  }

  const [updated] = await prisma.$transaction([
    prisma.loan.update({
      where: { id: loan.id },
      data: { status: 'returned', returnedAt: now },
      include: { bookCopy: { select: { bookId: true } } },
    }),
    prisma.bookCopy.update({ where: { id: loan.bookCopyId }, data: { status: 'available' } }),
  ])
  // Task 6 (waitlist cascade) hooks in here: if anyone is waiting on
  // loan.bookCopy.bookId, promote the oldest waiting reservation.
  return toLoanDto(updated, now)
}
