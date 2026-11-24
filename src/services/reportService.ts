// Problem reports: a student telling the library that something is wrong with a seat,
// a room or (reported as the book is returned) a copy, and a librarian confirming or
// dismissing the report from the Needs attention queue. The student's side comes
// first; the librarian's confirm and dismiss are at the end of the file and work on
// the same IssueReport rows.
//
// A student has at most one open report per target, and a report has exactly one
// target. Both are the database's to enforce (a CHECK, and two partial unique indexes
// WHERE status = 'open', in the attention_reports migration), so a second report is
// refused by the insert itself, never by reading first: two requests at once cannot
// both get in. A refused report writes and publishes nothing.
import { REPORT_BOOKING_LOOKAHEAD_HOURS, REPORT_BOOKING_LOOKBACK_DAYS } from '../config/constants'
import { Prisma, type BookingStatus, type CopyStatus } from '../generated/prisma/client'
import { publishAttentionChange } from '../lib/events'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { markCopyLost, markCopyMaintenance } from './adminCopyService'
import { takeOffline } from './adminResourceService'
import { createNotice, deliverNotice } from './noticeService'

export const NOT_BOOKED = 'You can only report a seat or room you have booked.'
export const ALREADY_REPORTED = 'You already reported this. The library is looking into it.'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * The bookings that entitle a student to report their resource: a raw status of
 * `booked`, `checked_in` or `completed`. A booking never checked into stays `booked`
 * and counts (a student who finds the seat broken and leaves is the likely case); a
 * cancelled booking, a request and the other endings do not.
 */
export const REPORTABLE_BOOKING_STATUSES: BookingStatus[] = ['booked', 'checked_in', 'completed']

/** The start times that qualify, both limits included: from 7 days ago to 24 hours from now. */
export function reportableStartWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - REPORT_BOOKING_LOOKBACK_DAYS * DAY_MS),
    to: new Date(now.getTime() + REPORT_BOOKING_LOOKAHEAD_HOURS * HOUR_MS),
  }
}

/** Whether this booking, by itself, entitles its student to report the resource (the same rule createResourceReport asks the database). */
export function isReportableBooking(booking: { status: BookingStatus; startTime: Date }, now: Date): boolean {
  const { from, to } = reportableStartWindow(now)
  return REPORTABLE_BOOKING_STATUSES.includes(booking.status) && booking.startTime >= from && booking.startTime <= to
}

/**
 * Whether `error` is the unique index refusing a second open report from the same
 * student on the same target. Prisma reports a unique violation as P2002; through the
 * pg driver adapter it can also arrive as a generic P2039 carrying SQLSTATE 23505 in
 * its message (as in disputeService and borrowRequestService).
 */
export function isDuplicateOpenReport(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || (error.code === 'P2039' && error.message.includes('23505')))
  )
}

export interface ResourceReportInput {
  resourceId: string
  category: 'not_working' | 'dirty' | 'other'
  /** Already trimmed and at most 300 characters; required for `other` (the route's schema sees to both). */
  note?: string
}

/**
 * Files the student's report of a seat or room. 403 unless one of their own bookings
 * of it qualifies (see REPORTABLE_BOOKING_STATUSES and reportableStartWindow); an
 * unknown resource id is the same 403, since the student has not booked it. 409 when
 * they already have an open report on it, and also when a request made at the same
 * moment wins the unique index. `attention.changed` is published once, after the
 * insert; a refusal publishes nothing.
 */
export async function createResourceReport(userId: string, input: ResourceReportInput, now = new Date()): Promise<{ id: string }> {
  const { resourceId, category, note } = input
  const { from, to } = reportableStartWindow(now)
  const booking = await prisma.resourceBooking.findFirst({
    where: { userId, resourceId, status: { in: REPORTABLE_BOOKING_STATUSES }, startTime: { gte: from, lte: to } },
    select: { id: true },
  })
  if (!booking) throw new ForbiddenError(NOT_BOOKED)

  let report: { id: string }
  try {
    report = await prisma.issueReport.create({
      data: { userId, resourceId, category, note: note ?? null, createdAt: now },
      select: { id: true },
    })
  } catch (error) {
    if (isDuplicateOpenReport(error)) throw new ConflictError(ALREADY_REPORTED)
    throw error
  }

  publishAttentionChange()
  return report
}

// --- The librarian's side: confirm or dismiss ---------------------------------------
//
// A resolution is two steps in a fixed order, and the order is the point.
//
//   1. The action on the target (a copy to maintenance or lost, a resource offline) runs
//      first, through the services the Catalogue and Resources pages already use, each
//      in its own transactions (they take the book's row lock, publish their own
//      `catalogue.changed` / `resource.changed`, and refuse what cannot be done).
//   2. Then one small transaction closes the report (a conditional update on `open`) and
//      writes the student's notice. After the report row is updated, no loan, copy or
//      book is locked: a student's return takes the loan's lock and then writes a report
//      row, so a closing step that went on to lock a loan, copy or book would wait for it
//      in a circle (Postgres 40P01, a 500).
//
// The report is read first. One that is not open is a 409 before any action is run, so
// a dismissed report can never move a copy; the conditional update is still the
// authority when two librarians race (the loser's action has stood, and the target is in
// the requested state either way). An action's refusal is returned as it is and the
// report stays open, except when the refusal only means the target is already where the
// librarian wanted it: that is decided by reading the target again, never by comparing
// the action's message. After the commit the notice is emailed once (deliverNotice) and
// only then is `attention.changed` published; a refusal publishes nothing.
export const REPORT_ALREADY_RESOLVED = 'This report was already resolved.'
export const CHOOSE_COPY_OUTCOME = 'Choose what to do with the copy.'

/** What a librarian does about a copy report: out for repair, or lost from the shelf. */
export type CopyOutcome = 'maintenance' | 'lost'

export interface ConfirmReportInput {
  /** Required for a copy report; a resource report is always taken offline and ignores it. */
  outcome?: CopyOutcome
  /** Already trimmed and at most 300 characters; blank (or missing) means none. */
  note?: string | null
}

const COPY_STATE_FOR: Record<CopyOutcome, CopyStatus> = { maintenance: 'maintenance', lost: 'lost' }

/** The note as text, or null for none (the routes' schema has trimmed it already). */
function noteOrNull(note: string | null | undefined): string | null {
  const trimmed = note?.trim()
  return trimmed ? trimmed : null
}

/**
 * The student's notice (the Needs attention design, section 5.3). The librarian's note is
 * a paragraph of its own, the way the dispute notices write it, so it does not read as part
 * of the sentence.
 */
function outcomeNotice(outcome: 'confirmed' | 'dismissed', target: string, note: string | null) {
  const sentence =
    outcome === 'confirmed'
      ? `Thanks for reporting a problem with ${target}. The library has taken it out of use for now.`
      : `The library looked at your report about ${target} and no action was needed.`
  return {
    title: outcome === 'confirmed' ? 'Thanks for the report' : 'About your report',
    body: note ? `${sentence}\n\nNote from the library: ${note}` : sentence,
  }
}

/** The open report with what its notice and its action need, or 404 (no such report) / 409 (not open any more). */
async function readOpenReport(reportId: string) {
  const report = await prisma.issueReport.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      userId: true,
      status: true,
      note: true,
      bookCopyId: true,
      resourceId: true,
      bookCopy: { select: { status: true, book: { select: { title: true } } } },
      resource: { select: { name: true, status: true } },
    },
  })
  if (!report) throw new NotFoundError('Report')
  if (report.status !== 'open') throw new ConflictError(REPORT_ALREADY_RESOLVED)
  return report
}

type OpenReport = Awaited<ReturnType<typeof readOpenReport>>

/**
 * Runs `act` unless the target is already where the librarian wants it (`alreadyThere`,
 * read before). When `act` is refused with a 409, the target is read again
 * (`isThereNow`): if it is where the librarian wants it now (another librarian just got
 * there, or a second click), the refusal means nothing and the report can close; if not,
 * the action's own refusal is returned and the report stays open. Any other failure is
 * not a refusal and goes on up.
 */
async function actUnlessAlready(alreadyThere: boolean, act: () => Promise<unknown>, isThereNow: () => Promise<boolean>): Promise<void> {
  if (alreadyThere) return
  try {
    await act()
  } catch (error) {
    if (!(error instanceof ConflictError) || !(await isThereNow())) throw error
  }
}

/**
 * Closes the report by a conditional update on `open` and writes the student's notice,
 * in one transaction that takes no loan, copy or book lock; then emails the notice and
 * announces the change. 409 when another resolution got there first.
 */
async function closeReport(
  report: OpenReport,
  status: 'confirmed' | 'dismissed',
  resolutionNote: string | null,
  noticeNote: string | null,
  adminId: string,
  now: Date,
): Promise<void> {
  const target = report.bookCopy?.book.title ?? report.resource?.name ?? ''
  const { title, body } = outcomeNotice(status, target, noticeNote)

  const notice = await prisma.$transaction(async (tx) => {
    const { count } = await tx.issueReport.updateMany({
      where: { id: report.id, status: 'open' },
      data: { status, resolutionNote, resolvedById: adminId, resolvedAt: now },
    })
    if (count === 0) throw new ConflictError(REPORT_ALREADY_RESOLVED)
    return createNotice(tx, { userId: report.userId, kind: 'report_outcome', title, body, createdById: adminId })
  })

  await deliverNotice(notice)
  publishAttentionChange()
}

/**
 * The librarian agrees with the report. A copy report needs an `outcome` (400 without):
 * `maintenance` calls markCopyMaintenance, `lost` calls markCopyLost with no charge
 * fields, so a copy that a student has on loan again answers its own 409 ("This copy is
 * now on loan.") and a report can never charge anyone. A resource report calls
 * takeOffline with the librarian's note (the console prefills it with the student's own
 * words). Then the report is closed as `confirmed` and the student told.
 *
 * The student's notice carries the librarian's note, except that a resource note equal to
 * the student's own report text is not sent back to the student who wrote it.
 */
export async function confirmReport(
  reportId: string,
  adminId: string,
  input: ConfirmReportInput = {},
  now = new Date(),
): Promise<{ id: string }> {
  const report = await readOpenReport(reportId)
  const note = noteOrNull(input.note)

  if (report.bookCopyId !== null) {
    const { outcome } = input
    if (!outcome) throw new ValidationError(CHOOSE_COPY_OUTCOME)
    const copyId = report.bookCopyId
    const wanted = COPY_STATE_FOR[outcome]
    await actUnlessAlready(
      report.bookCopy?.status === wanted,
      () => (outcome === 'maintenance' ? markCopyMaintenance(copyId, now) : markCopyLost(copyId, {}, now)),
      async () => (await prisma.bookCopy.findUnique({ where: { id: copyId }, select: { status: true } }))?.status === wanted,
    )
    await closeReport(report, 'confirmed', note, note, adminId, now)
  } else {
    const resourceId = report.resourceId!
    await actUnlessAlready(
      report.resource?.status === 'offline',
      () => takeOffline(resourceId, note),
      async () => (await prisma.resource.findUnique({ where: { id: resourceId }, select: { status: true } }))?.status === 'offline',
    )
    // The console's prefill is the student's own report text: not echoed back to them.
    const echoed = note !== null && note !== noteOrNull(report.note) ? note : null
    await closeReport(report, 'confirmed', note, echoed, adminId, now)
  }
  return { id: reportId }
}

/** The librarian finds nothing to do: closes the report as `dismissed` with the note, and the student is told no action was needed. */
export async function dismissReport(reportId: string, adminId: string, note: string | null, now = new Date()): Promise<{ id: string }> {
  const report = await readOpenReport(reportId)
  const clean = noteOrNull(note)
  await closeReport(report, 'dismissed', clean, clean, adminId, now)
  return { id: reportId }
}
