// A student's own fines, for the Fines section under My Loans. Not the
// librarian's list (adminFineService): no student, no librarian name, no accruing
// rows (the student already sees what an overdue loan has accrued on the loan).
import type { FineStatus } from '../generated/prisma/client'
import { prisma } from '../lib/prisma'

/** How many fines the list shows, newest first. The total is over all of them. */
export const MY_FINES_LIMIT = 50

export interface StudentFineDto {
  id: string
  reason: 'overdue' | 'no_show' | 'lost'
  /** The book's title (overdue, lost) or the resource's name (no_show); empty when the fine names neither. */
  item: string
  amount: number
  /** What the fine was before a librarian lowered it; the amount when never adjusted. */
  originalAmount: number
  /** A stored `pending` fine is `outstanding`: the API never says `pending`. */
  status: 'outstanding' | 'adjusted' | 'paid' | 'waived'
  /** When the fine was created. */
  date: Date
  /** The librarian's reason, for adjusted and waived fines only. */
  note: string | null
}

const STATUS_TO_STUDENT: Record<FineStatus, StudentFineDto['status']> = {
  pending: 'outstanding',
  adjusted: 'adjusted',
  paid: 'paid',
  waived: 'waived',
}

/**
 * The student's newest 50 fines, and what they still owe over ALL their fines
 * (outstanding plus adjusted amounts), not only the 50 listed.
 */
export async function listMyFines(userId: string): Promise<{ fines: StudentFineDto[]; outstandingTotal: number }> {
  const [rows, owed] = await Promise.all([
    prisma.fine.findMany({
      where: { userId },
      // Same tiebreak as the librarian's list, so a page never shuffles equal dates.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: MY_FINES_LIMIT,
      select: {
        id: true,
        reason: true,
        amount: true,
        originalAmount: true,
        status: true,
        createdAt: true,
        adjustReason: true,
        relatedLoan: { select: { bookCopy: { select: { book: { select: { title: true } } } } } },
        relatedBooking: { select: { resource: { select: { name: true } } } },
      },
    }),
    prisma.fine.aggregate({
      where: { userId, status: { in: ['pending', 'adjusted'] } },
      _sum: { amount: true },
    }),
  ])

  return {
    fines: rows.map((fine) => ({
      id: fine.id,
      reason: fine.reason,
      item: fine.relatedLoan?.bookCopy.book.title ?? fine.relatedBooking?.resource.name ?? '',
      amount: fine.amount,
      originalAmount: fine.originalAmount ?? fine.amount,
      status: STATUS_TO_STUDENT[fine.status],
      date: fine.createdAt,
      note: fine.status === 'adjusted' || fine.status === 'waived' ? fine.adjustReason : null,
    })),
    outstandingTotal: owed._sum.amount ?? 0,
  }
}
