// The librarian's Fines list. It merges two kinds of row into one newest-first
// list: the fines that are stored (a pending one is shown as "outstanding"), and
// "accruing" rows that are not stored at all, one for each loan still out and
// past its due date, valued by fineRules.accruingAmountSql (the same rule the
// student app's loan line uses). The accruing row disappears by itself when the
// loan is returned or renewed late, because the existing code then writes the
// fine and closes or moves the loan.
//
// Like adminBookingService, one query returns a page with its student, item and
// librarian names, and, through count(*) OVER(), the total behind the filters, so
// a page costs one round trip however many rows it holds. The status filter and
// the search run in SQL, over the merged rows, so a filtered page is still a
// full page.
//
// A fine a student has disputed (disputeService) is listed as "disputed", not as
// outstanding or adjusted, with the student's reason; it can still be waived or
// lowered, but only by a request that names the dispute (which the adjustment then
// closes, with a notice to the student), and not marked paid.
//
// A librarian can also mark a fine paid, or waive or lower it. Both are
// conditional writes on the fine's current status (as cancelBookingAsLibrary is
// on a booking's), a payment also on the amount the librarian saw and on there
// being no open dispute, so a payment and an adjustment, a payment and a dispute,
// two payments, or two adjustments racing on one fine cannot interleave: the
// database applies one, the other finds the fine changed and is told how.
import { Prisma } from '../generated/prisma/client'
import { publishAttentionChange, publishFineChange } from '../lib/events'
import { ConflictError, NotFoundError, ValidationError } from '../lib/httpError'
import { escapeLike } from '../lib/like'
import { prisma } from '../lib/prisma'
import { closeDisputeOnFine, DISPUTE_ALREADY_RESOLVED, FINE_JUST_DISPUTED } from './disputeService'
import { accruingAmountSql } from './fineRules'
import { deliverNotice } from './noticeService'

export type AdminFineStatus = 'accruing' | 'outstanding' | 'adjusted' | 'disputed' | 'paid' | 'waived'

export interface AdminFineDto {
  /** The fine's id; for an accruing row, the loan's id (the paid and adjust routes do not accept it). */
  id: string
  kind: 'fine' | 'accruing'
  student: { id: string; name: string; email: string }
  reason: 'overdue' | 'no_show' | 'lost'
  /** The book's title (overdue, lost) or the resource's name (no_show). */
  item: string
  amount: number
  /** What the fine was before a librarian lowered it; the amount when never adjusted. */
  originalAmount: number
  /** `disputed` (derived: the fine carries an open dispute) is listed instead of outstanding or adjusted. */
  status: AdminFineStatus
  /** When the fine was created; for an accruing row, the loan's due date. */
  date: Date
  /** The librarian's reason for lowering or waiving the fine, kept after it is paid; null when it was never adjusted. */
  note: string | null
  /** The librarian who adjusted or waived it, or who recorded the payment; null when none, or the account is gone. */
  recordedBy: string | null
  /** The open dispute on this fine (the student's reason and when it was opened), or null. */
  dispute: { id: string; reason: string; createdAt: Date } | null
  /**
   * Whether the librarian can still waive or adjust it: exactly when the stored
   * fine is still pending or adjusted, so also while it is disputed. (Mark paid is
   * not offered on a disputed fine: it has a `dispute`.)
   */
  canSettle: boolean
}

// A type alias, not an interface, so the route can cast req.validatedQuery to it.
export type AdminFineListQuery = {
  search?: string
  status?: AdminFineStatus
  page: number
  pageSize: number
}

export interface AdminFineList {
  fines: AdminFineDto[]
  total: number
  page: number
  pageSize: number
}

interface FineRow {
  id: string
  kind: 'fine' | 'accruing'
  studentId: string
  studentName: string
  studentEmail: string
  reason: 'overdue' | 'no_show' | 'lost'
  item: string
  amount: number
  originalAmount: number
  status: AdminFineStatus
  date: Date
  note: string | null
  recordedBy: string | null
  disputeId: string | null
  disputeReason: string | null
  disputeCreatedAt: Date | null
  canSettle: boolean
}

/**
 * The FROM and WHERE shared by the page query, the total-only query and the
 * per-student list: every stored fine and every accruing loan as one row shape,
 * narrowed by the status filter, the search and, for one student, their id, or
 * down to one stored fine by its id (an accruing row's id, a loan's, never
 * matches). Values go in as bound parameters, never text.
 *
 * Both halves of the UNION give `date` as a plain `timestamp` (Fine.createdAt
 * and Loan.dueAt are both `timestamp(3)` holding UTC), so the two sort on one
 * timeline. `now` is compared as `::timestamp` for the same reason: Prisma binds
 * a Date as UTC wall-clock text, and a `::timestamptz` cast would shift it by the
 * session's time zone. A loan exactly at its due time is not yet overdue, as
 * with the student app's `dueAt < now`.
 */
function filteredFines(
  q: Pick<AdminFineListQuery, 'search' | 'status'> & { userId?: string; id?: string },
  now: Date,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = []
  if (q.id) conditions.push(Prisma.sql`"kind" = 'fine' AND "id" = ${q.id}`)
  if (q.userId) conditions.push(Prisma.sql`"studentId" = ${q.userId}`)
  if (q.status) conditions.push(Prisma.sql`"status" = ${q.status}`)

  const search = q.search?.trim()
  if (search) {
    const pattern = `%${escapeLike(search)}%`
    conditions.push(Prisma.sql`("studentName" ILIKE ${pattern} ESCAPE '\\' OR "studentEmail" ILIKE ${pattern} ESCAPE '\\')`)
  }
  const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty

  return Prisma.sql`
    FROM (
      SELECT f.id, 'fine'::text AS kind,
             u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
             f.reason::text AS reason,
             COALESCE(b.title, r.name, '') AS item,
             f.amount AS amount,
             COALESCE(f."originalAmount", f.amount) AS "originalAmount",
             CASE WHEN f."disputedAt" IS NOT NULL THEN 'disputed'
                  WHEN f.status = 'pending' THEN 'outstanding'
                  ELSE f.status::text END AS status,
             f."createdAt" AS "date",
             f."adjustReason" AS note,
             CASE f.status
               WHEN 'paid' THEN payer.name
               WHEN 'adjusted' THEN adjuster.name
               WHEN 'waived' THEN adjuster.name
             END AS "recordedBy",
             d.id AS "disputeId",
             d.reason AS "disputeReason",
             d."createdAt" AS "disputeCreatedAt",
             (f.status IN ('pending', 'adjusted')) AS "canSettle"
      FROM "Fine" f
      JOIN "User" u ON u.id = f."userId"
      LEFT JOIN "Loan" fl ON fl.id = f."relatedLoanId"
      LEFT JOIN "BookCopy" fc ON fc.id = fl."bookCopyId"
      LEFT JOIN "Book" b ON b.id = fc."bookId"
      LEFT JOIN "ResourceBooking" rb ON rb.id = f."relatedBookingId"
      LEFT JOIN "Resource" r ON r.id = rb."resourceId"
      LEFT JOIN "User" adjuster ON adjuster.id = f."adjustedById"
      LEFT JOIN "User" payer ON payer.id = f."paidRecordedById"
      LEFT JOIN "FineDispute" d ON d."fineId" = f.id AND f."disputedAt" IS NOT NULL

      UNION ALL

      SELECT l.id, 'accruing'::text AS kind,
             u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
             'overdue'::text AS reason,
             b.title AS item,
             owed.amount AS amount,
             owed.amount AS "originalAmount",
             'accruing'::text AS status,
             l."dueAt" AS "date",
             NULL::text AS note,
             NULL::text AS "recordedBy",
             NULL::text AS "disputeId",
             NULL::text AS "disputeReason",
             NULL::timestamp AS "disputeCreatedAt",
             FALSE AS "canSettle"
      FROM "Loan" l
      JOIN "User" u ON u.id = l."userId"
      JOIN "BookCopy" lc ON lc.id = l."bookCopyId"
      JOIN "Book" b ON b.id = lc."bookId"
      CROSS JOIN LATERAL (SELECT ${accruingAmountSql(now, Prisma.sql`l."dueAt"`)} AS amount) AS owed
      WHERE l.status = 'active' AND l."dueAt" < ${now}::timestamp
    ) AS fine
    ${where}`
}

function toDto(row: FineRow): AdminFineDto {
  return {
    id: row.id,
    kind: row.kind,
    student: { id: row.studentId, name: row.studentName, email: row.studentEmail },
    reason: row.reason,
    item: row.item,
    amount: row.amount,
    originalAmount: row.originalAmount,
    status: row.status,
    date: row.date,
    note: row.note,
    recordedBy: row.recordedBy,
    dispute: row.disputeId
      ? { id: row.disputeId, reason: row.disputeReason as string, createdAt: row.disputeCreatedAt as Date }
      : null,
    canSettle: row.canSettle,
  }
}

/** One page of fines and accruing rows, newest first, with the total behind the filters. */
export async function listFines(q: AdminFineListQuery, now = new Date()): Promise<AdminFineList> {
  const from = filteredFines(q, now)
  const offset = (q.page - 1) * q.pageSize

  const rows = await prisma.$queryRaw<Array<FineRow & { total: number }>>(Prisma.sql`
    SELECT fine.*, (count(*) OVER ())::int AS total
    ${from}
    ORDER BY fine."date" DESC, fine.id
    LIMIT ${q.pageSize} OFFSET ${offset}`)

  let total = rows[0]?.total ?? 0
  // A page past the end has no row to carry the window count; ask for it on its
  // own so the console can still say how many fines match.
  if (rows.length === 0 && q.page > 1) {
    const [counted] = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total ${from}`)
    total = counted?.total ?? 0
  }

  return { fines: rows.map(toDto), total, page: q.page, pageSize: q.pageSize }
}

/** One student's fines and accruing rows, newest first, at most `limit`. For the student's page in the console. */
export async function listFinesForStudent(userId: string, limit: number, now = new Date()): Promise<AdminFineDto[]> {
  const rows = await prisma.$queryRaw<FineRow[]>(Prisma.sql`
    SELECT fine.*
    ${filteredFines({ userId }, now)}
    ORDER BY fine."date" DESC, fine.id
    LIMIT ${limit}`)
  return rows.map(toDto)
}

/** One stored fine as the console lists it. Never an accruing row. */
async function findFineDto(id: string, now: Date): Promise<AdminFineDto> {
  const [row] = await prisma.$queryRaw<FineRow[]>(Prisma.sql`SELECT fine.* ${filteredFines({ id }, now)}`)
  if (!row) throw new NotFoundError('Fine')
  return toDto(row)
}

/**
 * Called when a conditional write changed no row: reads the fine again and
 * refuses with what it finds, and returns it when it is still open, so the
 * caller can say why its own condition failed (`disputedAt` is set while a
 * student's dispute is open). 404 for an id that is not a stored fine (an
 * accruing row's id included); 409 for one already settled.
 */
async function refuseUnlessOpen(
  fineId: string,
  db: { fine: Prisma.TransactionClient['fine'] } = prisma,
): Promise<{ amount: number; disputedAt: Date | null }> {
  const fine = await db.fine.findUnique({ where: { id: fineId }, select: { status: true, amount: true, disputedAt: true } })
  if (!fine) throw new NotFoundError('Fine')
  if (fine.status === 'paid') throw new ConflictError('This fine is already paid.')
  if (fine.status === 'waived') throw new ConflictError('This fine was waived.')
  return fine
}

/**
 * Records that the student paid an outstanding or adjusted fine, and who
 * recorded it. `amount` is what the librarian saw and collected.
 *
 * ONE conditional update: the fine must still be outstanding or adjusted, still
 * be exactly `amount`, AND carry no open dispute. So a fine waived or paid a
 * moment earlier is refused with which, so is one a student disputed (it can be
 * paid once the librarian has resolved the dispute), and so is one a colleague
 * lowered after the librarian's screen loaded: that payment was made against the
 * old amount, and recording it as paying the new one would put the wrong money on
 * the record. (An adjusted fine can still be paid, at the amount shown.)
 */
export async function markFinePaid(fineId: string, adminId: string, amount: number, now = new Date()): Promise<AdminFineDto> {
  const { count } = await prisma.fine.updateMany({
    where: { id: fineId, status: { in: ['pending', 'adjusted'] }, amount, disputedAt: null },
    data: { status: 'paid', paidAt: now, paidRecordedById: adminId },
  })
  if (count === 0) {
    // Unknown, paid and waived are said first, then a dispute; still open means the amount moved.
    const { amount: current, disputedAt } = await refuseUnlessOpen(fineId)
    if (disputedAt) throw new ConflictError('This fine is being disputed. Resolve the dispute first.')
    if (current === amount) {
      // Open and exactly the amount sent, though the write changed nothing. An
      // amount only ever goes down and a settled fine stays settled, so this
      // should not happen; refuse rather than answer 200 for an unrecorded payment.
      throw new ConflictError('This fine can no longer be marked paid.')
    }
    throw new ConflictError(`This fine was just changed to ₹${current}. Check it before marking it paid.`)
  }

  publishFineChange()
  return findFineDto(fineId, now)
}

/**
 * Lowers an outstanding or adjusted fine to `amount` (whole rupees), or waives
 * it at 0, and records who, when and why. The original amount is kept from the
 * first adjustment.
 *
 * One transaction. It locks the fine's row first (NO KEY UPDATE, so the notice's
 * foreign key is not blocked), so a student's dispute, a payment, another
 * adjustment or an uphold that is committing at the same moment is seen whole:
 *  - a fine carrying an open dispute is changed only by a request that NAMES it
 *    (`disputeId`, the dispute the librarian read): without it, 409 "This fine was
 *    just disputed. Read the dispute before changing the fine." and nothing changes;
 *  - a `disputeId` that is not the fine's open dispute (already resolved, or no
 *    such dispute) is 409 "This dispute was already resolved.".
 * Then ONE conditional UPDATE, not a read then a write: `amount > new` and the
 * status are checked by the database on the row's current version, so a payment
 * or another adjustment that lands first is seen and this one changes nothing,
 * rather than raising a fine somebody had just lowered or adjusting one that was
 * just paid. The same statement clears the dispute marker. `adjustedAt` is a plain
 * `timestamp` column, so `now` is bound as UTC wall-clock text and cast
 * `::timestamp` (never `::timestamptz`, which the session's time zone would shift).
 * Last, the named dispute is closed (waived at 0, adjusted otherwise, the reason as
 * its note) and the student's notice written, in the same transaction.
 *
 * After the commit: the notice is emailed once (deliverNotice, which never throws),
 * then `fine.changed` is published, and `attention.changed` too when a dispute was
 * closed (an adjustment of a fine nobody disputed moves nothing in the queue). A
 * refusal writes, sends and publishes nothing.
 */
export async function adjustFine(
  fineId: string,
  adminId: string,
  amount: number,
  reason: string,
  disputeId: string | null = null,
  now = new Date(),
): Promise<AdminFineDto> {
  const notice = await prisma.$transaction(async (tx) => {
    // $queryRaw, not $executeRaw: it has to read the row to lock it. The amount is
    // what the fine stands at now, for the notice's "it was ₹...".
    const [locked] = await tx.$queryRaw<Array<{ disputed: boolean; amount: number }>>`
      SELECT ("disputedAt" IS NOT NULL) AS disputed, amount FROM "Fine" WHERE id = ${fineId} FOR NO KEY UPDATE`
    if (!locked) throw new NotFoundError('Fine')

    if (disputeId === null) {
      if (locked.disputed) throw new ConflictError(FINE_JUST_DISPUTED)
    } else {
      const open = locked.disputed ? await tx.fineDispute.findFirst({ where: { fineId, status: 'open' }, select: { id: true } }) : null
      if (open?.id !== disputeId) throw new ConflictError(DISPUTE_ALREADY_RESOLVED)
    }

    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "Fine"
      SET "originalAmount" = COALESCE("originalAmount", amount),
          amount = ${amount}::float8,
          status = (CASE WHEN ${amount}::float8 = 0 THEN 'waived' ELSE 'adjusted' END)::"FineStatus",
          "adjustedAt" = ${now}::timestamp,
          "adjustedById" = ${adminId},
          "adjustReason" = ${reason},
          "disputedAt" = NULL
      WHERE id = ${fineId}
        AND status IN ('pending', 'adjusted')
        AND amount > ${amount}::float8`)
    if (updated === 0) {
      // Nothing matched: say why. Still open means the amount was not lower. Throwing
      // rolls the transaction back, so the dispute stays open and no notice is written.
      const { amount: current } = await refuseUnlessOpen(fineId, tx)
      throw new ValidationError(`The new amount must be lower than ₹${current}.`)
    }

    return locked.disputed ? closeDisputeOnFine(tx, fineId, amount === 0 ? 'waived' : 'adjusted', reason, adminId, now, locked.amount) : null
  })

  if (notice) await deliverNotice(notice)
  publishFineChange()
  if (notice) publishAttentionChange()
  return findFineDto(fineId, now)
}
