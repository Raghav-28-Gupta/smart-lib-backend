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
// A librarian can also mark a fine paid, or waive or lower it. Both are
// conditional writes on the fine's current status (as cancelBookingAsLibrary is
// on a booking's), and a payment also on the amount the librarian saw, so a
// payment and an adjustment, two payments, or two adjustments racing on one fine
// cannot interleave: the database applies one, the other finds the fine changed
// and is told how.
import { Prisma } from '../generated/prisma/client'
import { publishFineChange } from '../lib/events'
import { ConflictError, NotFoundError, ValidationError } from '../lib/httpError'
import { escapeLike } from '../lib/like'
import { prisma } from '../lib/prisma'
import { accruingAmountSql } from './fineRules'

export type AdminFineStatus = 'accruing' | 'outstanding' | 'adjusted' | 'paid' | 'waived'

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
  status: AdminFineStatus
  /** When the fine was created; for an accruing row, the loan's due date. */
  date: Date
  /** The librarian's reason, for adjusted and waived fines. */
  note: string | null
  /** The librarian who adjusted or waived it, or who recorded the payment; null when none, or the account is gone. */
  recordedBy: string | null
  /** Whether the librarian can still mark it paid or adjust it: exactly when it is outstanding or adjusted. */
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
             CASE f.status WHEN 'pending' THEN 'outstanding' ELSE f.status::text END AS status,
             f."createdAt" AS "date",
             CASE WHEN f.status IN ('adjusted', 'waived') THEN f."adjustReason" END AS note,
             CASE f.status
               WHEN 'paid' THEN payer.name
               WHEN 'adjusted' THEN adjuster.name
               WHEN 'waived' THEN adjuster.name
             END AS "recordedBy"
      FROM "Fine" f
      JOIN "User" u ON u.id = f."userId"
      LEFT JOIN "Loan" fl ON fl.id = f."relatedLoanId"
      LEFT JOIN "BookCopy" fc ON fc.id = fl."bookCopyId"
      LEFT JOIN "Book" b ON b.id = fc."bookId"
      LEFT JOIN "ResourceBooking" rb ON rb.id = f."relatedBookingId"
      LEFT JOIN "Resource" r ON r.id = rb."resourceId"
      LEFT JOIN "User" adjuster ON adjuster.id = f."adjustedById"
      LEFT JOIN "User" payer ON payer.id = f."paidRecordedById"

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
             NULL::text AS "recordedBy"
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
    canSettle: row.status === 'outstanding' || row.status === 'adjusted',
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
 * caller can say why its own condition failed. 404 for an id that is not a
 * stored fine (an accruing row's id included); 409 for one already settled.
 */
async function refuseUnlessOpen(fineId: string): Promise<{ amount: number }> {
  const fine = await prisma.fine.findUnique({ where: { id: fineId }, select: { status: true, amount: true } })
  if (!fine) throw new NotFoundError('Fine')
  if (fine.status === 'paid') throw new ConflictError('This fine is already paid.')
  if (fine.status === 'waived') throw new ConflictError('This fine was waived.')
  return fine
}

/**
 * Records that the student paid an outstanding or adjusted fine, and who
 * recorded it. `amount` is what the librarian saw and collected.
 *
 * ONE conditional update: the fine must still be outstanding or adjusted AND
 * still be exactly `amount`. So a fine waived or paid a moment earlier is
 * refused with which, and so is one a colleague lowered after the librarian's
 * screen loaded: that payment was made against the old amount, and recording it
 * as paying the new one would put the wrong money on the record. (An adjusted
 * fine can still be paid, at the amount shown.)
 */
export async function markFinePaid(fineId: string, adminId: string, amount: number, now = new Date()): Promise<AdminFineDto> {
  const { count } = await prisma.fine.updateMany({
    where: { id: fineId, status: { in: ['pending', 'adjusted'] }, amount },
    data: { status: 'paid', paidAt: now, paidRecordedById: adminId },
  })
  if (count === 0) {
    // Unknown, paid and waived are said first; still open means the amount moved.
    const { amount: current } = await refuseUnlessOpen(fineId)
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
 * ONE conditional UPDATE, not a read then a write: `amount > new` and the
 * status are checked by the database on the row's current version, so a payment
 * or another adjustment that lands first is seen (the UPDATE waits for its row
 * lock, then re-checks) and this one changes nothing, rather than raising a fine
 * somebody had just lowered or adjusting one that was just paid. `adjustedAt` is
 * a plain `timestamp` column, so `now` is bound as UTC wall-clock text and cast
 * `::timestamp` (never `::timestamptz`, which the session's time zone would shift).
 */
export async function adjustFine(
  fineId: string,
  adminId: string,
  amount: number,
  reason: string,
  now = new Date(),
): Promise<AdminFineDto> {
  const updated = await prisma.$executeRaw(Prisma.sql`
    UPDATE "Fine"
    SET "originalAmount" = COALESCE("originalAmount", amount),
        amount = ${amount}::float8,
        status = (CASE WHEN ${amount}::float8 = 0 THEN 'waived' ELSE 'adjusted' END)::"FineStatus",
        "adjustedAt" = ${now}::timestamp,
        "adjustedById" = ${adminId},
        "adjustReason" = ${reason}
    WHERE id = ${fineId}
      AND status IN ('pending', 'adjusted')
      AND amount > ${amount}::float8`)
  if (updated === 0) {
    // Nothing matched: say why. Still open means the amount was not lower.
    const { amount: current } = await refuseUnlessOpen(fineId)
    throw new ValidationError(`The new amount must be lower than ₹${current}.`)
  }

  publishFineChange()
  return findFineDto(fineId, now)
}
