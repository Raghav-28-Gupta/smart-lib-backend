// The librarian's copy actions: take a shelf copy out of service for maintenance,
// mark it lost (from the shelf, or while a student has it on loan), and bring a
// copy in maintenance or lost back.
//
// Every action is one transaction that takes the book's row lock first, so two
// librarians working on the same title queue up instead of reading the same
// numbers. Inside it the copy is changed by a conditional update on the status it
// was read with (as cancelBookingAsLibrary does for a booking), so a student who
// borrows or returns the copy at the same moment, which does not take that lock,
// still cannot be overwritten: the update then changes nothing, the copy is read
// again, and the librarian is told what it is now.
//
// Taking an available copy out of service (maintenance, or lost from the shelf)
// is also checked against the title's waitlist: stale claims are expired, and if
// the copies still available would be fewer than the live claims, the action is
// refused and the transaction rolls the update back.
//
// A copy lost while on loan closes the loan as lost in the same transaction, by
// an update conditional on the loan still being active. A student's return or
// renewal updates the loan on the same condition (loanService), so whichever
// lands first is the one that charges the overdue days, and a return that lands
// first makes the loss a 409. The loan is changed before the copy, the order a
// return changes them in, so the two never wait on each other in a circle.
// Restoring that copy can waive its replacement fine in the same transaction.
//
// Every success publishes catalogue.changed once, after it has committed. A
// refusal publishes nothing.
import type { CopyStatus, Prisma } from '../generated/prisma/client'
import { publishCatalogueChange } from '../lib/events'
import { ConflictError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { getAdminBook, LATEST_LOST_LOAN_FIRST, type AdminBookDto } from './adminCatalogueService'
import { overdueFineAmount } from './fineRules'
import { expireStaleClaims, onBookReturned } from './reservationService'

type CopyAction = 'maintenance' | 'lost' | 'restore'

const NOW_ON_LOAN = 'This copy is now on loan.'
const NO_LONGER_ON_LOAN = 'This copy is no longer on loan.'
const BORROWER_CHANGED = "This copy's borrower has changed. Check it before marking it lost."
const CHARGE_REQUIRED = 'Enter a replacement charge for the copy on loan.'
const BORROWER_REQUIRED = 'Name the borrower of the copy on loan.'
const HELD = 'This copy is held for a borrow request.'
const ALREADY_LOST = 'This copy is already lost.'
const ON_WAITLIST = 'This copy is set aside for a student on the waitlist.'
// Only for a copy that changed to a status the action would have accepted, between
// the librarian's read and the update; the console refetches on any 409.
const CHANGED = 'This copy was just changed. Refresh and try again.'
/** The reason recorded on a replacement fine waived because the book came back. */
const RETURNED_AFTER_LOST = 'Book returned after it was marked lost'

// What each action says to a copy that is not in a status it accepts. A status
// missing here is one the action accepts (a borrowed copy is judged by its loan,
// in loseCopy).
const REFUSALS: Record<CopyAction, Partial<Record<CopyStatus, string>>> = {
  maintenance: {
    borrowed: NOW_ON_LOAN,
    maintenance: 'This copy is already in maintenance.',
    lost: ALREADY_LOST,
    requested: HELD,
  },
  lost: { lost: ALREADY_LOST, requested: HELD },
  restore: { available: 'This copy is already available.', borrowed: 'This copy is on loan.', requested: HELD },
}

const TARGET: Record<CopyAction, CopyStatus> = { maintenance: 'maintenance', lost: 'lost', restore: 'available' }

export interface LostCopyInput {
  /** Whole rupees, 0 for none. Required for a copy on loan; ignored for one that is not. */
  replacementCharge?: number
  /**
   * The student the librarian saw holding the copy. Required for a copy on loan,
   * which is lost only while that student's loan is the one open. Sent for a copy
   * nobody has any more, it means the book came back since the librarian looked.
   */
  borrowerId?: string
}

async function bookOf(copyId: string): Promise<string> {
  const copy = await prisma.bookCopy.findUnique({ where: { id: copyId }, select: { bookId: true } })
  if (!copy) throw new NotFoundError('Copy')
  return copy.bookId
}

async function readStatus(tx: Prisma.TransactionClient, copyId: string): Promise<CopyStatus> {
  const copy = await tx.bookCopy.findUnique({ where: { id: copyId }, select: { status: true } })
  if (!copy) throw new NotFoundError('Copy')
  return copy.status
}

/** Locks the title against other copy actions for the rest of the transaction, then reads the copy's status. */
async function lockAndRead(tx: Prisma.TransactionClient, copyId: string, bookId: string): Promise<CopyStatus> {
  // NO KEY UPDATE, not UPDATE: it does not block the foreign-key checks of a
  // student joining the waitlist or requesting a copy meanwhile. $queryRaw, not
  // $executeRaw: it has to read the row to lock it; the result is not used.
  await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} FOR NO KEY UPDATE`
  return readStatus(tx, copyId)
}

/**
 * Moves the copy, read as `from`, to the status the action leads to. Throws the
 * 409 for a copy that cannot take the action, which rolls everything back.
 */
async function moveCopy(
  tx: Prisma.TransactionClient,
  copyId: string,
  bookId: string,
  action: CopyAction,
  from: CopyStatus,
  now: Date,
): Promise<void> {
  const refusal = REFUSALS[action][from]
  if (refusal) throw new ConflictError(refusal)

  const { count } = await tx.bookCopy.updateMany({ where: { id: copyId, status: from }, data: { status: TARGET[action] } })
  if (count === 0) {
    const current = await readStatus(tx, copyId)
    // Only a lost from the shelf has no refusal for a borrowed copy: it went out on loan meanwhile.
    throw new ConflictError(REFUSALS[action][current] ?? (current === 'borrowed' ? NOW_ON_LOAN : CHANGED))
  }

  // An available copy leaving service must not take the copy a waiting student has
  // been promised. Counted after the update, so "available" is what would be left.
  if (from === 'available' && action !== 'restore') {
    await expireStaleClaims(bookId, now, tx)
    const [available, claims] = await Promise.all([
      tx.bookCopy.count({ where: { bookId, status: 'available' } }),
      tx.reservation.count({ where: { bookId, status: 'fulfilled', claimExpiresAt: { gt: now } } }),
    ])
    if (available < claims) throw new ConflictError(ON_WAITLIST)
  }
}

/**
 * Closes the open loan as lost and charges its student: the overdue days so far
 * (the rule a late return uses) and the replacement, each only when above 0.
 * Then the copy goes from borrowed to lost.
 */
async function closeLoanAsLost(
  tx: Prisma.TransactionClient,
  loanId: string,
  copyId: string,
  replacementCharge: number,
  now: Date,
): Promise<void> {
  const { count } = await tx.loan.updateMany({ where: { id: loanId, status: 'active' }, data: { status: 'lost', lostAt: now } })
  if (count === 0) {
    // A return does not take the book lock: the student brought the book back a moment ago.
    const loan = await tx.loan.findUnique({ where: { id: loanId }, select: { status: true } })
    throw new ConflictError(loan?.status === 'lost' ? ALREADY_LOST : NO_LONGER_ON_LOAN)
  }
  // Read after the update, so a renewal that landed first is seen: it charged the
  // days up to then and moved the due date, and they must not be charged again.
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId }, select: { userId: true, dueAt: true } })

  const moved = await tx.bookCopy.updateMany({ where: { id: copyId, status: 'borrowed' }, data: { status: 'lost' } })
  if (moved.count === 0) throw new ConflictError(CHANGED)

  const fines: Prisma.FineCreateManyInput[] = []
  const overdue = overdueFineAmount(loan.dueAt, now)
  if (overdue > 0) fines.push({ userId: loan.userId, relatedLoanId: loanId, amount: overdue, reason: 'overdue' })
  if (replacementCharge > 0) fines.push({ userId: loan.userId, relatedLoanId: loanId, amount: replacementCharge, reason: 'lost' })
  if (fines.length > 0) await tx.fine.createMany({ data: fines })
}

/**
 * Marks the copy lost, in the transaction. A copy a student has on loan closes
 * their loan (closeLoanAsLost) and answers true; one on the shelf, or marked
 * borrowed with no open loan, moves like maintenance does and answers false.
 */
async function loseCopy(tx: Prisma.TransactionClient, copyId: string, bookId: string, input: LostCopyInput, now: Date): Promise<boolean> {
  const from = await lockAndRead(tx, copyId, bookId)
  const refusal = REFUSALS.lost[from]
  if (refusal) throw new ConflictError(refusal)

  const openLoan =
    from === 'borrowed'
      ? await tx.loan.findFirst({ where: { bookCopyId: copyId, status: 'active' }, select: { id: true, userId: true } })
      : null

  if (!openLoan) {
    // The librarian saw a student holding the copy, but nobody has it now: it came
    // back meanwhile, and a book on the return desk is not lost.
    if (input.borrowerId !== undefined) throw new ConflictError(NO_LONGER_ON_LOAN)
    await moveCopy(tx, copyId, bookId, 'lost', from, now)
    return false
  }

  // Neither field sent: the librarian's page showed the copy on the shelf (whose dialog has no such
  // fields) and a student has taken it since. Say so, not a 400 asking for fields the dialog lacks.
  if (input.replacementCharge === undefined && input.borrowerId === undefined) throw new ConflictError(NOW_ON_LOAN)
  if (input.replacementCharge === undefined) throw new ValidationError(CHARGE_REQUIRED)
  if (input.borrowerId === undefined) throw new ValidationError(BORROWER_REQUIRED)
  // Returned and lent to someone else since the librarian looked: never charge the wrong student.
  if (openLoan.userId !== input.borrowerId) throw new ConflictError(BORROWER_CHANGED)

  await closeLoanAsLost(tx, openLoan.id, copyId, input.replacementCharge, now)
  return true
}

/**
 * Waives the replacement fine of the copy's latest lost loan if it is still owed
 * (outstanding or adjusted), the way a librarian's waive does
 * (adminFineService.adjustFine): the original amount kept from the first
 * adjustment, who, when and why. ONE conditional UPDATE, so a payment that lands
 * first is seen and the fine is left alone. Answers whether a fine was waived.
 * `adjustedAt` is a plain `timestamp`, so `now` is cast `::timestamp`.
 */
async function waiveReplacementFine(tx: Prisma.TransactionClient, copyId: string, adminId: string, now: Date): Promise<boolean> {
  const loan = await tx.loan.findFirst({
    where: { bookCopyId: copyId, status: 'lost' },
    orderBy: LATEST_LOST_LOAN_FIRST,
    select: { id: true },
  })
  if (!loan) return false

  const waived = await tx.$executeRaw`
    UPDATE "Fine"
    SET "originalAmount" = COALESCE("originalAmount", amount),
        amount = 0,
        status = 'waived',
        "adjustedAt" = ${now}::timestamp,
        "adjustedById" = ${adminId},
        "adjustReason" = ${RETURNED_AFTER_LOST}
    WHERE "relatedLoanId" = ${loan.id}
      AND reason = 'lost'
      AND status IN ('pending', 'adjusted')`
  return waived > 0
}

/** Takes an available copy out of service. */
export async function markCopyMaintenance(copyId: string, now = new Date()): Promise<AdminBookDto> {
  const bookId = await bookOf(copyId)
  await prisma.$transaction(async (tx) => moveCopy(tx, copyId, bookId, 'maintenance', await lockAndRead(tx, copyId, bookId), now))
  publishCatalogueChange()
  return getAdminBook(bookId)
}

/**
 * Marks a copy lost. From the shelf (available or in maintenance), or borrowed
 * with no open loan, it just becomes lost and the input is not used. A copy a
 * student has on loan needs `replacementCharge` and `borrowerId` (400 when only
 * one is missing; 409 "now on loan" when neither is sent, a stale shelf view;
 * 409 if someone else has it now): their loan closes as lost, with an overdue
 * fine for the days so far and a lost fine for the charge.
 */
export async function markCopyLost(copyId: string, input: LostCopyInput = {}, now = new Date()): Promise<AdminBookDto> {
  const bookId = await bookOf(copyId)
  const onLoan = await prisma.$transaction((tx) => loseCopy(tx, copyId, bookId, input, now))
  // A loan closed as lost also moves the student's fines and the Dashboard's numbers.
  publishCatalogueChange(onLoan ? ['fines', 'metrics'] : [])
  return getAdminBook(bookId)
}

/**
 * Brings a copy in maintenance, or lost, back to available, then runs the waitlist
 * hand-off a return runs, so a waiting student gets it first. With
 * `waiveReplacementCharge`, a lost copy's replacement fine still owed on its
 * latest lost loan is waived in the same transaction (the loan stays closed as
 * lost and its overdue fine stands). `replacementWaived` is whether one was: not
 * when there was none, or it was paid or waived a moment earlier, and the copy is
 * restored either way.
 */
export async function restoreCopy(
  copyId: string,
  adminId: string,
  waiveReplacementCharge: boolean,
  now = new Date(),
): Promise<{ book: AdminBookDto; replacementWaived: boolean }> {
  const bookId = await bookOf(copyId)
  const replacementWaived = await prisma.$transaction(async (tx) => {
    const from = await lockAndRead(tx, copyId, bookId)
    await moveCopy(tx, copyId, bookId, 'restore', from, now)
    return waiveReplacementCharge && from === 'lost' ? waiveReplacementFine(tx, copyId, adminId, now) : false
  })

  try {
    await onBookReturned(bookId, now)
  } finally {
    // The copy is back even if the hand-off failed, so the console must hear of it.
    publishCatalogueChange(replacementWaived ? ['fines'] : [])
  }
  return { book: await getAdminBook(bookId), replacementWaived }
}
