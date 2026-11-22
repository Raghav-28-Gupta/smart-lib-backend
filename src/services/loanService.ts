// A student's loans: the list on My Loans, and returning or renewing one.
//
// Return and renew each run in one transaction that locks the loan's row first
// and then updates it on the condition that it is still active, so they cannot
// interleave with each other or with a librarian marking the copy lost
// (adminCopyService), which closes the loan on the same condition. The overdue
// fine is written in that transaction, from the due date read under the lock, and
// only when the update won: the overdue days are charged once, by whichever of
// them got there first.
import { LOAN_PERIOD_DAYS, MAX_RENEWALS } from '../config/constants'
import type { Loan, LoanStatus, Prisma } from '../generated/prisma/client'
import { publishLoanChange } from '../lib/events'
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { overdueFineAmount } from './fineRules'
import { onBookReturned } from './reservationService'

const DAY_MS = 24 * 60 * 60 * 1000

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
  const fineAmount = isActive ? overdueFineAmount(loan.dueAt, now) : 0
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

/** The student's open loans. A loan closed as lost is left out, like a returned one. */
export async function listMyLoans(userId: string): Promise<LoanDto[]> {
  const now = new Date()
  const loans = await prisma.loan.findMany({
    where: { userId, status: { notIn: ['returned', 'lost'] } },
    include: { bookCopy: { select: { bookId: true } } },
    orderBy: { dueAt: 'asc' },
  })
  return Promise.all(loans.map((loan) => toLoanDto(loan, now)))
}

/** The 409 for returning or renewing a loan that is no longer active. */
function closedLoan(status: LoanStatus): ConflictError {
  if (status === 'lost') return new ConflictError('This loan was closed because the copy was marked lost.')
  if (status === 'returned') return new ConflictError('This loan has already been returned.')
  return new ConflictError('This loan is no longer open.')
}

/** The caller's loan while it is still active: 404, 403 for someone else's, 409 for a closed one. */
async function getOwnedActiveLoan(userId: string, loanId: string) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { bookCopy: { select: { bookId: true } } },
  })
  if (!loan) throw new NotFoundError('Loan')
  if (loan.userId !== userId) throw new ForbiddenError('This loan belongs to another user.')
  if (loan.status !== 'active') throw closedLoan(loan.status)
  return loan
}

/**
 * Locks the loan's row for the rest of the transaction and reads it as it is now:
 * a return, renewal or loss that committed meanwhile is seen, and none can land
 * before the caller's write. NO KEY UPDATE, like the copy actions' book lock: it
 * does not block a fine being written against the loan.
 */
async function lockLoan(tx: Prisma.TransactionClient, loanId: string): Promise<Loan> {
  await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId} FOR NO KEY UPDATE`
  return tx.loan.findUniqueOrThrow({ where: { id: loanId } })
}

export async function renewLoan(userId: string, loanId: string): Promise<LoanDto> {
  const loan = await getOwnedActiveLoan(userId, loanId)
  const now = new Date()

  const { updated, wasPastDue } = await prisma.$transaction(async (tx) => {
    const current = await lockLoan(tx, loan.id)
    // A closed loan is refused by the update below, with why; only an open one is judged for renewal.
    if (current.status === 'active') {
      const waitlistCount = await tx.reservation.count({ where: { bookId: loan.bookCopy.bookId, status: 'waiting' } })
      const { canRenew, blockedReason } = computeRenewability(current.renewedCount, waitlistCount)
      if (!canRenew) throw new ConflictError(blockedReason ?? 'This loan cannot be renewed.')
    }

    const { count } = await tx.loan.updateMany({
      where: { id: loan.id, status: 'active' },
      data: { dueAt: new Date(now.getTime() + LOAN_PERIOD_DAYS * DAY_MS), renewedCount: { increment: 1 } },
    })
    if (count === 0) throw closedLoan(current.status)

    // The days so far, from the due date this renewal replaced.
    const fineAmount = overdueFineAmount(current.dueAt, now)
    if (fineAmount > 0) {
      await tx.fine.create({ data: { userId, relatedLoanId: loan.id, amount: fineAmount, reason: 'overdue' } })
    }
    const updated = await tx.loan.findUniqueOrThrow({ where: { id: loan.id }, include: { bookCopy: { select: { bookId: true } } } })
    return { updated, wasPastDue: current.dueAt < now }
  })

  // The new due date reaches the Catalogue and student pages; a loan that was past due also
  // turns its accruing row on the Fines page into a stored fine (or removes it).
  publishLoanChange(wasPastDue)
  return toLoanDto(updated, now)
}

export async function returnLoan(userId: string, loanId: string): Promise<LoanDto> {
  const loan = await getOwnedActiveLoan(userId, loanId)
  const now = new Date()

  // The loan before the copy, the order a librarian's loss changes them in, so the two never wait on each other.
  const { updated, wasPastDue } = await prisma.$transaction(async (tx) => {
    const current = await lockLoan(tx, loan.id)
    const { count } = await tx.loan.updateMany({
      where: { id: loan.id, status: 'active' },
      data: { status: 'returned', returnedAt: now },
    })
    if (count === 0) throw closedLoan(current.status)

    const fineAmount = overdueFineAmount(current.dueAt, now)
    if (fineAmount > 0) {
      await tx.fine.create({ data: { userId, relatedLoanId: loan.id, amount: fineAmount, reason: 'overdue' } })
    }
    await tx.bookCopy.update({ where: { id: current.bookCopyId }, data: { status: 'available' } })
    const updated = await tx.loan.findUniqueOrThrow({ where: { id: loan.id }, include: { bookCopy: { select: { bookId: true } } } })
    return { updated, wasPastDue: current.dueAt < now }
  })

  await onBookReturned(loan.bookCopy.bookId, now)
  publishLoanChange(wasPastDue)
  return toLoanDto(updated, now)
}
