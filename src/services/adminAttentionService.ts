// The librarian's "Needs attention" queue. This file holds its overdue-loan
// items and the two follow-ups a librarian can send on one: a reminder and a
// formal (escalation) notice, its open fine disputes (resolved in
// disputeService and adminFineService) and its open problem reports (confirmed
// or dismissed in reportService).
//
// An overdue item is not stored. It is an active loan that is a whole day or
// more past due, valued by fineRules.accruingAmountSql, the rule the Fines page
// and the student's loan line use, so the amount shown here always equals the
// student's own. The newest `overdue_*` notice for the loan supplies "Reminded 2
// days ago" or "Escalated", and any escalation notice at all says the loan was
// escalated (a reminder may follow an escalation, so the newest notice alone
// cannot say). One query returns every item with its student, title, newest
// notice and escalation flag, so the queue costs one round trip however long it
// is.
//
// Remind and escalate lock the loan row, re-check it is still active and still a
// whole day overdue, apply their rule, write the notice and read the loan's item
// (the answer), all in one transaction. Only after the commit is the email
// attempted (deliverNotice, once per notice), and only after its outcome is
// stored is the live event published, so the console's refetch shows the true
// "emailed" or "not emailed". A refused action writes, sends and publishes
// nothing; once the notice has committed nothing can refuse it, even a student
// who returns the book while the email is being sent.
import { FINE_PER_DAY_INR } from '../config/constants'
import { Prisma, type EmailStatus, type Notice, type NoticeKind } from '../generated/prisma/client'
import { publishAttentionChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { isEmailConfigured } from '../lib/mailer'
import { prisma } from '../lib/prisma'
import { dateLabel } from '../lib/timeLabels'
import { accruingAmountSql, overdueFineAmount } from './fineRules'
import { createNotice, deliverNotice } from './noticeService'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type AttentionKind = 'overdue' | 'fine_dispute' | 'report'

export interface AttentionStudent {
  id: string
  name: string
  email: string
}

export type OverdueAttentionItem = {
  /** The loan's id. */
  id: string
  kind: 'overdue'
  student: AttentionStudent
  /** The due date. */
  waitingSince: Date
  overdue: {
    loanId: string
    title: string
    dueAt: Date
    /** Whole 24-hour days past due, at least 1. */
    daysOverdue: number
    /** The fine so far, in whole rupees. */
    amount: number
    /** The loan has ever had an escalation notice, even if a reminder came after it. */
    escalated: boolean
    /** The newest overdue notice of either kind. */
    lastNotice: { kind: 'reminder' | 'escalation'; at: Date; emailStatus: EmailStatus } | null
  }
}

export type FineDisputeAttentionItem = {
  /** The dispute's id (also `dispute.disputeId`). */
  id: string
  kind: 'fine_dispute'
  student: AttentionStudent
  /** When the student opened the dispute. */
  waitingSince: Date
  dispute: {
    disputeId: string
    /** The student's own words, at most 300 characters. */
    studentReason: string
    fine: {
      id: string
      /** The book's title or the resource's name: the label the Fines page shows for this fine. */
      item: string
      reason: 'overdue' | 'no_show' | 'lost'
      /** Whole rupees, as the fine stands now. */
      amount: number
      /** What the fine was before a librarian lowered it; the amount when never adjusted. */
      originalAmount: number
      /** The fine's own status word, `outstanding` or `adjusted`: never `disputed` (the item itself says that). */
      status: string
    }
  }
}

export type ReportAttentionItem = {
  /** The report's own id (also `report.reportId`): the console confirms and dismisses with it. */
  id: string
  kind: 'report'
  student: AttentionStudent
  /** When the student filed the report. */
  waitingSince: Date
  report: {
    reportId: string
    target: 'copy' | 'resource'
    /** `damaged`, `missing_pages`, `not_working`, `dirty` or `other`. */
    category: string
    /** The student's own words, at most 300 characters. */
    note: string | null
    /** A copy report only: the copy, as the Catalogue labels it, and its book's title. */
    copy?: { id: string; barcode: string; title: string }
    /** A resource report only. */
    resource?: { id: string; name: string }
  }
}

export type AttentionItemDto = OverdueAttentionItem | FineDisputeAttentionItem | ReportAttentionItem

export interface AttentionCounts {
  all: number
  overdue: number
  fine_dispute: number
  report: number
}

export interface AttentionQueue {
  items: AttentionItemDto[]
  counts: AttentionCounts
  /** Whether a notice also goes out by email (the mailer is set up). */
  emailEnabled: boolean
}

export const REMINDER_TITLE = 'Overdue book reminder'
export const ESCALATION_TITLE = 'Formal overdue notice'
const NO_LONGER_OVERDUE = 'This loan is no longer overdue.'
const ALREADY_ESCALATED = 'This loan was already escalated.'

interface OverdueRow {
  loanId: string
  dueAt: Date
  title: string
  studentId: string
  studentName: string
  studentEmail: string
  amount: number
  escalated: boolean
  noticeKind: NoticeKind | null
  noticeAt: Date | null
  noticeEmailStatus: EmailStatus | null
}

/** Whole days behind an amount from fineRules: the rate is the only thing between them. */
const daysFor = (amount: number) => Math.round(amount / FINE_PER_DAY_INR)

const dayCount = (n: number) => (n === 1 ? '1 day' : `${n} days`)

/**
 * Every overdue loan, or just `loanId`'s when it is still one, as one row each,
 * read through `db` (a transaction's client, to see that transaction's own
 * uncommitted notice).
 *
 * Loan.dueAt and Notice.createdAt are plain `timestamp(3)` holding UTC, and
 * `now` is compared as `::timestamp` inside accruingAmountSql for the same
 * reason adminFineService does: Prisma binds a Date as UTC wall-clock text, and
 * a `::timestamptz` cast would shift it by the session's time zone. A loan
 * exactly at its due time, or less than a whole day late, owes nothing and is
 * not listed.
 */
async function overdueRows(
  now: Date,
  loanId?: string,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<OverdueRow[]> {
  return db.$queryRaw<OverdueRow[]>(Prisma.sql`
    SELECT l.id AS "loanId", l."dueAt", b.title,
           u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
           owed.amount,
           EXISTS (
             SELECT 1 FROM "Notice" e WHERE e."loanId" = l.id AND e.kind = 'overdue_escalation'
           ) AS escalated,
           newest.kind::text AS "noticeKind",
           newest."createdAt" AS "noticeAt",
           newest."emailStatus"::text AS "noticeEmailStatus"
    FROM "Loan" l
    JOIN "User" u ON u.id = l."userId"
    JOIN "BookCopy" c ON c.id = l."bookCopyId"
    JOIN "Book" b ON b.id = c."bookId"
    CROSS JOIN LATERAL (SELECT ${accruingAmountSql(now, Prisma.sql`l."dueAt"`)} AS amount) AS owed
    LEFT JOIN LATERAL (
      SELECT n.kind, n."createdAt", n."emailStatus"
      FROM "Notice" n
      WHERE n."loanId" = l.id AND n.kind IN ('overdue_reminder', 'overdue_escalation')
      ORDER BY n."createdAt" DESC, n.id DESC
      LIMIT 1
    ) AS newest ON true
    WHERE l.status = 'active' AND owed.amount > 0
      ${loanId === undefined ? Prisma.empty : Prisma.sql`AND l.id = ${loanId}`}`)
}

interface DisputeRow {
  disputeId: string
  studentReason: string
  waitingSince: Date
  studentId: string
  studentName: string
  studentEmail: string
  fineId: string
  reason: 'overdue' | 'no_show' | 'lost'
  item: string
  amount: number
  originalAmount: number
  status: string
}

/**
 * Every open dispute with its student, the fine and the fine's label, as one row
 * each. `d."createdAt"` is a plain `timestamp(3)` holding UTC, read back as it is:
 * no date is bound, so there is no cast to get wrong. The item and the fine's
 * status words are derived as adminFineService derives them.
 */
async function disputeRows(): Promise<DisputeRow[]> {
  return prisma.$queryRaw<DisputeRow[]>(Prisma.sql`
    SELECT d.id AS "disputeId", d.reason AS "studentReason", d."createdAt" AS "waitingSince",
           u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
           f.id AS "fineId", f.reason::text AS reason,
           COALESCE(b.title, r.name, '') AS item,
           f.amount AS amount,
           COALESCE(f."originalAmount", f.amount) AS "originalAmount",
           CASE WHEN f.status = 'pending' THEN 'outstanding' ELSE f.status::text END AS status
    FROM "FineDispute" d
    JOIN "Fine" f ON f.id = d."fineId"
    JOIN "User" u ON u.id = d."userId"
    LEFT JOIN "Loan" fl ON fl.id = f."relatedLoanId"
    LEFT JOIN "BookCopy" fc ON fc.id = fl."bookCopyId"
    LEFT JOIN "Book" b ON b.id = fc."bookId"
    LEFT JOIN "ResourceBooking" rb ON rb.id = f."relatedBookingId"
    LEFT JOIN "Resource" r ON r.id = rb."resourceId"
    WHERE d.status = 'open'`)
}

function toDisputeItem(row: DisputeRow): FineDisputeAttentionItem {
  return {
    id: row.disputeId,
    kind: 'fine_dispute',
    student: { id: row.studentId, name: row.studentName, email: row.studentEmail },
    waitingSince: row.waitingSince,
    dispute: {
      disputeId: row.disputeId,
      studentReason: row.studentReason,
      fine: {
        id: row.fineId,
        item: row.item,
        reason: row.reason,
        amount: row.amount,
        originalAmount: row.originalAmount,
        status: row.status,
      },
    },
  }
}

interface ReportRow {
  reportId: string
  category: string
  note: string | null
  waitingSince: Date
  studentId: string
  studentName: string
  studentEmail: string
  copyId: string | null
  copyBarcode: string | null
  copyTitle: string | null
  resourceId: string | null
  resourceName: string | null
}

/**
 * Every open report with its student and its target (a copy with its book's title, or
 * a resource), as one row each. `r."createdAt"` is a plain `timestamp(3)` holding UTC,
 * read back as it is: no date is bound, so there is no cast to get wrong. A report has
 * exactly one target (a CHECK), so one of the two joins finds its row.
 */
async function reportRows(): Promise<ReportRow[]> {
  return prisma.$queryRaw<ReportRow[]>(Prisma.sql`
    SELECT r.id AS "reportId", r.category::text AS category, r.note, r."createdAt" AS "waitingSince",
           u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
           c.id AS "copyId", c.barcode AS "copyBarcode", b.title AS "copyTitle",
           rs.id AS "resourceId", rs.name AS "resourceName"
    FROM "IssueReport" r
    JOIN "User" u ON u.id = r."userId"
    LEFT JOIN "BookCopy" c ON c.id = r."bookCopyId"
    LEFT JOIN "Book" b ON b.id = c."bookId"
    LEFT JOIN "Resource" rs ON rs.id = r."resourceId"
    WHERE r.status = 'open'`)
}

function toReportItem(row: ReportRow): ReportAttentionItem {
  const isCopy = row.copyId !== null
  return {
    id: row.reportId,
    kind: 'report',
    student: { id: row.studentId, name: row.studentName, email: row.studentEmail },
    waitingSince: row.waitingSince,
    report: {
      reportId: row.reportId,
      target: isCopy ? 'copy' : 'resource',
      category: row.category,
      note: row.note,
      ...(isCopy
        ? { copy: { id: row.copyId!, barcode: row.copyBarcode!, title: row.copyTitle! } }
        : { resource: { id: row.resourceId!, name: row.resourceName! } }),
    },
  }
}

function toItem(row: OverdueRow): OverdueAttentionItem {
  return {
    id: row.loanId,
    kind: 'overdue',
    student: { id: row.studentId, name: row.studentName, email: row.studentEmail },
    waitingSince: row.dueAt,
    overdue: {
      loanId: row.loanId,
      title: row.title,
      dueAt: row.dueAt,
      daysOverdue: daysFor(row.amount),
      amount: row.amount,
      escalated: row.escalated,
      lastNotice:
        row.noticeKind && row.noticeAt && row.noticeEmailStatus
          ? {
              kind: row.noticeKind === 'overdue_escalation' ? 'escalation' : 'reminder',
              at: row.noticeAt,
              emailStatus: row.noticeEmailStatus,
            }
          : null,
    },
  }
}

/**
 * The queue, oldest waiting first, with how many items each kind holds (always
 * the whole queue's, whatever `kind` filters the list to) and whether email is set up.
 */
export async function listAttention(q: { kind?: AttentionKind }, now = new Date()): Promise<AttentionQueue> {
  // One query per kind, however many items it holds: nothing is read per row.
  const [overdueFound, disputesFound, reportsFound] = await Promise.all([overdueRows(now), disputeRows(), reportRows()])
  const overdue = overdueFound.map(toItem)
  const fine_dispute = disputesFound.map(toDisputeItem)
  const report = reportsFound.map(toReportItem)
  const byKind: Record<AttentionKind, AttentionItemDto[]> = { overdue, fine_dispute, report }

  const counts: AttentionCounts = {
    all: byKind.overdue.length + byKind.fine_dispute.length + byKind.report.length,
    overdue: byKind.overdue.length,
    fine_dispute: byKind.fine_dispute.length,
    report: byKind.report.length,
  }
  const shown = q.kind ? byKind[q.kind] : Object.values(byKind).flat()
  // The id breaks a tie on equal dates, so a refetch never reorders.
  const items = [...shown].sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime() || a.id.localeCompare(b.id))
  return { items, counts, emailEnabled: isEmailConfigured() }
}

interface LockedLoan {
  userId: string
  title: string
  dueAt: Date
  amount: number
  days: number
}

/**
 * Locks the loan's row for the rest of the transaction and reads it as it is
 * now, so a return, renewal or loss that committed meanwhile is seen and none
 * can land before the caller's write (NO KEY UPDATE, like the loan service's own
 * lock: it does not block a fine being written against the loan). 404 for an id
 * that is no loan; 409 when it is not active or not yet a whole day late.
 */
async function lockOverdueLoan(tx: Prisma.TransactionClient, loanId: string, now: Date): Promise<LockedLoan> {
  // $queryRaw, not $executeRaw: it has to read the row to lock it.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Loan" WHERE id = ${loanId} FOR NO KEY UPDATE`
  if (locked.length === 0) throw new NotFoundError('Loan')

  const loan = await tx.loan.findUniqueOrThrow({
    where: { id: loanId },
    select: { userId: true, status: true, dueAt: true, bookCopy: { select: { book: { select: { title: true } } } } },
  })
  const amount = overdueFineAmount(loan.dueAt, now)
  if (loan.status !== 'active' || amount === 0) throw new ConflictError(NO_LONGER_OVERDUE)
  return { userId: loan.userId, title: loan.bookCopy.book.title, dueAt: loan.dueAt, amount, days: daysFor(amount) }
}

/** "Whole hours, rounded down: 23 hours 59 minutes is still 23 hours". */
function reminderRefusal(sinceMs: number): string {
  // A reminder committed a moment after this request began reads as just now.
  const hours = Math.max(0, Math.floor(sinceMs / HOUR_MS))
  if (hours === 0) return 'A reminder was sent less than an hour ago.'
  return `A reminder was sent ${hours === 1 ? '1 hour' : `${hours} hours`} ago.`
}

/** What the action's transaction wrote and read: the notice, and the loan's item with that notice counted in. */
interface Written {
  notice: Notice
  item: OverdueAttentionItem
}

/**
 * Reads the loan's item inside the action's transaction, right after its notice
 * was written: the loan is locked and was just checked overdue, so its row is
 * there, and it counts the new notice (as `lastNotice`, with the status
 * `skipped` until the email is attempted). Reading it here, not after the
 * commit, is what lets the answer never fail once the notice is out: a loan
 * returned meanwhile (the email can take 5 seconds) is no longer an item.
 */
async function readItem(tx: Prisma.TransactionClient, notice: Notice, loanId: string, now: Date): Promise<Written> {
  const [row] = await overdueRows(now, loanId, tx)
  // Unreachable under the loan's lock. A refusal here rolls the notice back, so nothing is left half done.
  if (!row) throw new ConflictError(NO_LONGER_OVERDUE)
  return { notice, item: toItem(row) }
}

/**
 * After the commit: emails the notice (never throws; stores the outcome on it),
 * announces the change, and answers the item read in the transaction with the
 * email outcome `deliverNotice` returned (the item was read before the email was
 * attempted). It never throws: the notice is committed and the email sent, so
 * the librarian is told it went out whatever became of the loan meanwhile.
 */
async function finish({ notice, item }: Written): Promise<OverdueAttentionItem> {
  const emailStatus = await deliverNotice(notice)
  publishAttentionChange()
  if (item.overdue.lastNotice) item.overdue.lastNotice.emailStatus = emailStatus
  return item
}

/**
 * Sends the student a reminder: a notice in the app, and an email when email is
 * set up. At most one reminder per loan in 24 hours (409 with how long ago); an
 * escalation does not count and does not stop one.
 */
export async function remindOverdueLoan(loanId: string, adminId: string, now = new Date()): Promise<OverdueAttentionItem> {
  const written = await prisma.$transaction(async (tx) => {
    const loan = await lockOverdueLoan(tx, loanId, now)

    const last = await tx.notice.findFirst({
      where: { loanId, kind: 'overdue_reminder' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (last) {
      const sinceMs = now.getTime() - last.createdAt.getTime()
      if (sinceMs < DAY_MS) throw new ConflictError(reminderRefusal(sinceMs))
    }

    const notice = await createNotice(tx, {
      userId: loan.userId,
      kind: 'overdue_reminder',
      title: REMINDER_TITLE,
      body:
        `Your copy of ${loan.title} was due on ${dateLabel(loan.dueAt)} and is ${dayCount(loan.days)} overdue. ` +
        `The fine is ₹${loan.amount} so far and grows by ₹${FINE_PER_DAY_INR} a day. Please return it to the library.`,
      loanId,
      createdById: adminId,
    })
    return readItem(tx, notice, loanId, now)
  })

  return finish(written)
}

/**
 * Sends the student a formal notice, once per loan (409 after that), with the
 * librarian's `note` after it when given. It changes no amount: the fine keeps
 * growing and becomes a stored fine when the book is returned or marked lost.
 */
export async function escalateOverdueLoan(
  loanId: string,
  adminId: string,
  note: string | null,
  now = new Date(),
): Promise<OverdueAttentionItem> {
  const written = await prisma.$transaction(async (tx) => {
    const loan = await lockOverdueLoan(tx, loanId, now)

    // Read under the loan's lock, so two escalations at once cannot both find none.
    const already = await tx.notice.findFirst({ where: { loanId, kind: 'overdue_escalation' }, select: { id: true } })
    if (already) throw new ConflictError(ALREADY_ESCALATED)

    const base = `${loan.title} is now ${dayCount(loan.days)} overdue (₹${loan.amount} so far). The library needs it back now.`
    const notice = await createNotice(tx, {
      userId: loan.userId,
      kind: 'overdue_escalation',
      title: ESCALATION_TITLE,
      body: note ? `${base}\n\nNote from the library: ${note}` : base,
      loanId,
      createdById: adminId,
    })
    return readItem(tx, notice, loanId, now)
  })

  return finish(written)
}
