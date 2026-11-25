// Library notices: one message from the library to one student, shown on My
// Loans for REQUEST_OUTCOME_VISIBLE_DAYS and, when the library has set up email,
// sent to the student's address too.
//
// A notice is written inside the transaction of the action that causes it
// (createNotice), so it is committed or rolled back with that action. The email
// is attempted only after the commit (deliverNotice): awaited for at most the
// mailer's 5 seconds, its outcome written to the notice, and never allowed to
// fail or hold up the action. The caller publishes its live event after
// deliverNotice returns, so a console refetch sees the true email status.
import { REQUEST_OUTCOME_VISIBLE_DAYS } from '../config/constants'
import type { EmailStatus, Notice, NoticeKind, Prisma } from '../generated/prisma/client'
import { sendEmail } from '../lib/mailer'
import { prisma } from '../lib/prisma'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

/** How many notices the student sees, newest first. */
export const MY_NOTICES_LIMIT = 20

/** Said under every notice email, so a student can tell why it arrived. */
export const NOTICE_EMAIL_FOOTER =
  'You are getting this email because the library sent you this notice through SmartLib. It also appears under Library notices in the SmartLib app.'

export interface NoticeInput {
  userId: string
  kind: NoticeKind
  title: string
  body: string
  loanId?: string
  fineId?: string
  // The booking a no-show or reminder notice is about (kinds booking_reminder,
  // no_show and no_show_outcome).
  bookingId?: string
  createdById?: string
}

export interface NoticeDto {
  id: string
  kind: NoticeKind
  title: string
  body: string
  createdAt: Date
}

/**
 * Writes a notice inside the action's transaction. Its email status starts as
 * `skipped` (nothing attempted); deliverNotice records the real outcome.
 */
export function createNotice(tx: Prisma.TransactionClient, input: NoticeInput): Promise<Notice> {
  const { userId, kind, title, body, loanId, fineId, bookingId, createdById } = input
  return tx.notice.create({ data: { userId, kind, title, body, loanId, fineId, bookingId, createdById } })
}

// The email's outcome and when it was attempted. A failed write is logged by
// error name only (no text, no address) and does not change what is answered:
// the email did or did not go regardless of whether this note of it was saved.
async function recordOutcome(noticeId: string, status: EmailStatus): Promise<void> {
  try {
    await prisma.notice.update({
      where: { id: noticeId },
      // Only an attempt (sent or failed) has a time.
      data: { emailStatus: status, emailedAt: status === 'skipped' ? null : new Date() },
    })
  } catch (err) {
    console.warn(`notice: could not record the email outcome (${err instanceof Error ? err.name : 'unknown error'})`)
  }
}

/**
 * Emails a committed notice to its student: subject "SmartLib: " + title, the
 * body, then the footer. Answers `sent`, `failed` or `skipped` (email off, a
 * placeholder demo address, an address outside MAIL_ALLOWED_DOMAINS) and records
 * it on the notice. Never throws, and logs no body or address.
 */
export async function deliverNotice(notice: Notice): Promise<EmailStatus> {
  try {
    const student = await prisma.user.findUnique({ where: { id: notice.userId }, select: { email: true } })
    if (!student) return 'skipped'

    const outcome = await sendEmail({
      to: student.email,
      subject: `SmartLib: ${notice.title}`,
      text: `${notice.body}\n\n--\n${NOTICE_EMAIL_FOOTER}`,
    })
    await recordOutcome(notice.id, outcome)
    return outcome
  } catch (err) {
    console.warn(`notice: email not sent (${err instanceof Error ? err.name : 'unknown error'})`)
    return 'failed'
  }
}

/**
 * How many of the student's notices are read before the moot reminders are dropped
 * and MY_NOTICES_LIMIT applied. A reminder is at most one per booking, so a student
 * would need far more than this in a week for a hidden one to cost a visible notice.
 */
const MY_NOTICES_FETCH_CAP = 200

interface BookingLink {
  status: string
  startTime: Date
  gracePeriodMinutes: number
}

/**
 * A "your booking starts soon" reminder is moot once the booking can no longer be
 * checked into: it is not `booked` any more (checked in, cancelled, released, a
 * no-show...), its grace period has ended (strictly before `now`, like the sweep and
 * the check-in), or the booking is gone (the link is cleared when it is deleted).
 * Read through Notice.bookingId, so it needs no column of its own.
 */
function isMootReminder(kind: NoticeKind, booking: BookingLink | null, now: Date): boolean {
  if (kind !== 'booking_reminder') return false
  if (!booking || booking.status !== 'booked') return true
  return booking.startTime.getTime() + booking.gracePeriodMinutes * MINUTE_MS < now.getTime()
}

/**
 * The student's own notices from the last REQUEST_OUTCOME_VISIBLE_DAYS, newest
 * first, at most MY_NOTICES_LIMIT, without the reminders that are now moot (they
 * are dropped BEFORE the limit, so one never takes the place of a notice the student
 * can see). Never the email outcome, who wrote it, or the booking it is about.
 */
export async function listMyNotices(userId: string, now = new Date()): Promise<NoticeDto[]> {
  const since = new Date(now.getTime() - REQUEST_OUTCOME_VISIBLE_DAYS * DAY_MS)
  const rows = await prisma.notice.findMany({
    where: { userId, createdAt: { gte: since } },
    // Same tiebreak as the fines lists, so a refetch never shuffles equal dates.
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: MY_NOTICES_FETCH_CAP,
    select: {
      id: true,
      kind: true,
      title: true,
      body: true,
      createdAt: true,
      booking: { select: { status: true, startTime: true, gracePeriodMinutes: true } },
    },
  })
  return rows
    .filter((row) => !isMootReminder(row.kind, row.booking, now))
    .slice(0, MY_NOTICES_LIMIT)
    .map(({ id, kind, title, body, createdAt }) => ({ id, kind, title, body, createdAt }))
}
