// A student disputing a fine, and a librarian resolving the dispute. A fine is
// disputed once, ever, and only while it is still owed (outstanding or adjusted).
// The fine row itself records that a dispute is open (`disputedAt`), so opening a
// dispute, marking the fine paid, adjusting it and upholding the dispute are all
// conditional updates on the same row: whichever commits first wins, and the
// others find the row changed and are told how (see adminFineService).
//
// A dispute is resolved three ways, and each one closes it, clears the marker and
// writes the student's notice in the same transaction as the change: the fine is
// waived or adjusted (adminFineService.adjustFine, or a restored copy's replacement
// fine waived in adminCopyService), both through closeDisputeOnFine, or the
// librarian upholds it (upholdDispute) and the fine stands. The email is attempted
// only after the commit (deliverNotice, once per notice), and the live events are
// published after its outcome is stored; a refusal writes, sends and publishes
// nothing.
import { Prisma, type Notice } from '../generated/prisma/client'
import { publishAttentionChange, publishFineChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { createNotice, deliverNotice } from './noticeService'

export const FINE_ALREADY_SETTLED = "This fine can't be disputed because it is already paid or waived."
export const FINE_ALREADY_DISPUTED = "You've already disputed this fine."
/** A change to a fine that has an open dispute must name the dispute the librarian read. */
export const FINE_JUST_DISPUTED = 'This fine was just disputed. Read the dispute before changing the fine.'
export const DISPUTE_ALREADY_RESOLVED = 'This dispute was already resolved.'

// The unique fineId rejects a second dispute on a fine. Prisma reports a unique
// violation as P2002; through the pg driver adapter it can also arrive as a
// generic P2039 carrying SQLSTATE 23505 in its message (as in borrowRequestService).
function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2002' || (e.code === 'P2039' && e.message.includes('23505')))
  )
}

/**
 * Called when the conditional update changed no row: reads the fine again and
 * says why. 404 for an unknown fine or another student's (the same answer, so a
 * student cannot probe for ids); 409 for one already paid or waived; otherwise
 * it carries a dispute already.
 */
async function refuse(userId: string, fineId: string): Promise<never> {
  const fine = await prisma.fine.findFirst({ where: { id: fineId, userId }, select: { status: true } })
  if (!fine) throw new NotFoundError('Fine')
  if (fine.status === 'paid' || fine.status === 'waived') throw new ConflictError(FINE_ALREADY_SETTLED)
  throw new ConflictError(FINE_ALREADY_DISPUTED)
}

/**
 * Opens the student's dispute of one of their own fines.
 *
 * One transaction: a conditional update of the fine (the caller's own, still
 * pending or adjusted, with no dispute marker) sets the marker, then the dispute
 * row is inserted. The unique `fineId` refuses a second dispute of the same fine
 * even when the first was resolved and the marker cleared; the insert then fails,
 * the transaction rolls the marker back, and the student is told they already
 * disputed it. Nothing is read first and written blindly: a payment, a waive or
 * another dispute that lands first is seen by the update, which then changes
 * nothing.
 *
 * `fine.changed` and `attention.changed` are published once, after the commit; a
 * refusal publishes nothing.
 */
export async function createDispute(userId: string, fineId: string, reason: string): Promise<{ id: string; status: 'open' }> {
  const now = new Date()
  let created: { id: string } | null
  try {
    created = await prisma.$transaction(async (tx) => {
      const { count } = await tx.fine.updateMany({
        where: { id: fineId, userId, status: { in: ['pending', 'adjusted'] }, disputedAt: null },
        data: { disputedAt: now },
      })
      if (count === 0) return null
      return tx.fineDispute.create({ data: { fineId, userId, reason, createdAt: now }, select: { id: true } })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(FINE_ALREADY_DISPUTED)
    throw error
  }
  if (!created) return refuse(userId, fineId)

  publishFineChange()
  publishAttentionChange()
  return { id: created.id, status: 'open' }
}

type Outcome = 'waived' | 'adjusted' | 'upheld'

// What the student is told (the Needs attention design, section 5.3). The note, when
// there is one, is a paragraph of its own so it does not read as part of the sentence.
// A fine with no book or resource (none exists today) says no item rather than "for .".
function outcomeNotice(outcome: Outcome, item: string, now: number, was: number, note: string | null) {
  const forItem = item ? ` for ${item}` : ''
  const withNote = (sentence: string) => (note ? `${sentence}\n\nNote from the library: ${note}` : sentence)
  switch (outcome) {
    case 'waived':
      return { title: 'Your fine was waived', body: withNote(`The library waived the ₹${was} fine${forItem}.`) }
    case 'adjusted':
      return { title: 'Your fine was reduced', body: withNote(`The library reduced your fine${forItem} to ₹${now} (it was ₹${was}).`) }
    case 'upheld':
      return { title: 'Your fine stands', body: withNote(`The library kept your ₹${now} fine${forItem}.`) }
  }
}

/**
 * Closes the fine's open dispute as `outcome` with the librarian's note, who and
 * when, and writes the student's notice, inside the caller's transaction. A
 * conditional update on `open`: answers null (and writes nothing) when the fine has
 * no open dispute, so a caller that waives or adjusts a fine nobody disputed does
 * not need to know. The caller has locked the fine's row.
 *
 * `wasAmount` is what the fine stood at just before this change, for "it was ₹150"
 * and "waived the ₹150 fine": a fine lowered once already and disputed afterwards
 * was last seen by the student at its lowered amount. The caller reads it under the
 * lock; without it the fine's original amount (what it was before any librarian
 * lowered it) is used. Not needed to uphold: the amount stays.
 */
async function resolveDispute(
  tx: Prisma.TransactionClient,
  fineId: string,
  outcome: Outcome,
  note: string | null,
  adminId: string,
  now: Date,
  wasAmount?: number,
): Promise<Notice | null> {
  const { count } = await tx.fineDispute.updateMany({
    where: { fineId, status: 'open' },
    data: { status: outcome, resolutionNote: note, resolvedById: adminId, resolvedAt: now },
  })
  if (count === 0) return null

  const fine = await tx.fine.findUniqueOrThrow({
    where: { id: fineId },
    select: {
      userId: true,
      amount: true,
      originalAmount: true,
      relatedLoan: { select: { bookCopy: { select: { book: { select: { title: true } } } } } },
      relatedBooking: { select: { resource: { select: { name: true } } } },
    },
  })
  // The same label the librarian's Fines list shows for this fine.
  const item = fine.relatedLoan?.bookCopy.book.title ?? fine.relatedBooking?.resource.name ?? ''
  const { title, body } = outcomeNotice(outcome, item, fine.amount, wasAmount ?? fine.originalAmount ?? fine.amount, note)
  return createNotice(tx, { userId: fine.userId, kind: 'dispute_outcome', title, body, fineId, createdById: adminId })
}

/**
 * The fine was just waived (`waived`) or lowered (`adjusted`) by `adminId` in this
 * transaction: closes its open dispute, if it has one, with `note` (the adjustment's
 * reason, or the restore's) and creates the notice. Answers the notice, to be
 * emailed with deliverNotice after the commit, or null when no dispute was open.
 * The fine's own update has already cleared its marker.
 */
export function closeDisputeOnFine(
  tx: Prisma.TransactionClient,
  fineId: string,
  outcome: 'waived' | 'adjusted',
  note: string,
  adminId: string,
  now: Date,
  wasAmount?: number,
): Promise<Notice | null> {
  return resolveDispute(tx, fineId, outcome, note, adminId, now, wasAmount)
}

/**
 * The librarian keeps the fine: closes the dispute as `upheld` with an optional
 * note, clears the fine's marker (so it can be paid) and writes the notice; the
 * amount is unchanged. 404 for an id that is no dispute; 409 for one already
 * resolved, by an earlier uphold or by an adjustment.
 *
 * The fine's row is locked first (NO KEY UPDATE, like the other writes on it), so
 * an uphold cannot interleave with an adjustment or a payment: whichever commits
 * first wins, and the dispute is then closed by a conditional update on `open`. The
 * email is attempted after the commit, then `fine.changed` and `attention.changed`
 * are published once; a refusal sends and publishes nothing.
 */
export async function upholdDispute(disputeId: string, adminId: string, note: string | null, now = new Date()): Promise<{ id: string }> {
  const notice = await prisma.$transaction(async (tx) => {
    const dispute = await tx.fineDispute.findUnique({ where: { id: disputeId }, select: { fineId: true } })
    if (!dispute) throw new NotFoundError('Dispute')

    // $queryRaw, not $executeRaw: it has to read the row to lock it.
    await tx.$queryRaw`SELECT id FROM "Fine" WHERE id = ${dispute.fineId} FOR NO KEY UPDATE`
    const closed = await resolveDispute(tx, dispute.fineId, 'upheld', note, adminId, now)
    if (!closed) throw new ConflictError(DISPUTE_ALREADY_RESOLVED)
    await tx.fine.updateMany({ where: { id: dispute.fineId }, data: { disputedAt: null } })
    return closed
  })

  await deliverNotice(notice)
  publishFineChange()
  publishAttentionChange()
  return { id: disputeId }
}
