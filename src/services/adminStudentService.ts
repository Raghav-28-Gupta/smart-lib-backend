// The librarian's view of one student: profile, reliability score and its log,
// and the student's loans, bookings and fines, each newest first and capped at
// HISTORY_LIMIT. Everything is derived at read time with the rules the rest of
// the console and the student app already use: the loan status from the stored
// status and due date, the booking status through adminBookingService's
// derivedStatusSql (the Bookings page's rules), the fines through
// adminFineService (stored fines plus the student's accruing rows), the tier
// through reliabilityService.tierFor (what /profile/reliability shows).
//
// A librarian can also adjust the score by hand, once per call, by -10 to +10.
// It goes through applyReliabilityDelta, which locks the student's row, so it
// never overwrites (or is overwritten by) a check-in bonus landing at the same
// moment. An adjustment the 0-100 clamp would leave unchanged is refused and
// rolled back, so nothing is logged for it.
import { Prisma } from '../generated/prisma/client'
import { publishStudentChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { derivedStatusSql, NOT_WITHDRAWN_REQUEST } from './adminBookingService'
import { listFinesForStudent, type AdminFineDto } from './adminFineService'
import { applyReliabilityDelta, tierFor } from './reliabilityService'

const HISTORY_LIMIT = 50

export interface AdminStudentDto {
  id: string
  name: string
  email: string
  /** 'Pending' when the account has none, as the student app shows it. */
  roll: string
  score: number
  tier: string
  history: { date: Date; score: number; delta: number; reason: string; by: string | null }[]
  loans: {
    id: string
    title: string
    borrowedAt: Date
    dueAt: Date
    returnedAt: Date | null
    lostAt: Date | null
    status: 'active' | 'overdue' | 'returned' | 'lost'
  }[]
  bookings: { id: string; resource: string; startTime: Date; endTime: Date; status: string }[]
  fines: AdminFineDto[]
}

type LoanStatus = AdminStudentDto['loans'][number]['status']

/** Lost and returned are as stored; of the open loans, one past its due date is overdue (as the student app's loan line says). */
function loanStatus(loan: { status: string; dueAt: Date }, now: Date): LoanStatus {
  if (loan.status === 'lost') return 'lost'
  if (loan.status === 'returned') return 'returned'
  return loan.dueAt < now ? 'overdue' : 'active'
}

async function findStudent(client: Prisma.TransactionClient | typeof prisma, id: string) {
  // Admin accounts have no student page, so an admin's id is as unknown as any other.
  const student = await client.user.findFirst({
    where: { id, role: 'student' },
    select: { id: true, name: true, email: true, roll: true, reliabilityScore: true },
  })
  if (!student) throw new NotFoundError('Student')
  return student
}

async function historyFor(userId: string): Promise<AdminStudentDto['history']> {
  const logs = await prisma.reliabilityScoreLog.findMany({
    where: { userId },
    orderBy: [{ computedAt: 'desc' }, { id: 'asc' }],
    take: HISTORY_LIMIT,
    include: { adjustedBy: { select: { name: true } } },
  })
  return logs.map((l) => ({ date: l.computedAt, score: l.score, delta: l.delta, reason: l.reason, by: l.adjustedBy?.name ?? null }))
}

async function loansFor(userId: string, now: Date): Promise<AdminStudentDto['loans']> {
  const loans = await prisma.loan.findMany({
    where: { userId },
    orderBy: [{ borrowedAt: 'desc' }, { id: 'asc' }],
    take: HISTORY_LIMIT,
    include: { bookCopy: { select: { book: { select: { title: true } } } } },
  })
  return loans.map((l) => ({
    id: l.id,
    title: l.bookCopy.book.title,
    borrowedAt: l.borrowedAt,
    dueAt: l.dueAt,
    returnedAt: l.returnedAt,
    lostAt: l.lostAt,
    status: loanStatus(l, now),
  }))
}

// Bookings the way the Bookings page shows them (same derived status), plus the
// room requests that page leaves out while they are pending, declined or expired.
// A request the student withdrew never became a booking and is left out, as there.
async function bookingsFor(userId: string, now: Date): Promise<AdminStudentDto['bookings']> {
  return prisma.$queryRaw<AdminStudentDto['bookings']>(Prisma.sql`
    SELECT b.id, r.name AS resource, b."startTime", b."endTime", ${derivedStatusSql(now)} AS status
    FROM "ResourceBooking" b
    JOIN "Resource" r ON r.id = b."resourceId"
    WHERE b."userId" = ${userId} AND ${NOT_WITHDRAWN_REQUEST}
    ORDER BY b."startTime" DESC, b.id
    LIMIT ${HISTORY_LIMIT}`)
}

export async function getStudent(id: string, now = new Date()): Promise<AdminStudentDto> {
  const student = await findStudent(prisma, id)

  const [history, loans, bookings, fines] = await Promise.all([
    historyFor(id),
    loansFor(id, now),
    bookingsFor(id, now),
    listFinesForStudent(id, HISTORY_LIMIT, now),
  ])

  return {
    id: student.id,
    name: student.name,
    email: student.email,
    roll: student.roll ?? 'Pending',
    score: student.reliabilityScore,
    tier: tierFor(student.reliabilityScore),
    history,
    loans,
    bookings,
    fines,
  }
}

/**
 * Moves a student's reliability score by `delta` (a whole number, -10 to 10, not
 * 0), clamped to 0-100, and logs it as "Library adjustment: <reason>" with the
 * librarian. 409 when the clamp would change nothing (already at 100 or 0): the
 * transaction is rolled back, so no log entry and no event.
 */
export async function adjustReliability(id: string, adminId: string, delta: number, reason: string): Promise<AdminStudentDto> {
  await prisma.$transaction(async (tx) => {
    await findStudent(tx, id)
    const { appliedDelta } = await applyReliabilityDelta(tx, id, delta, `Library adjustment: ${reason}`, adminId)
    if (appliedDelta === 0) throw new ConflictError(delta > 0 ? 'The score is already at 100.' : 'The score is already at 0.')
  })

  publishStudentChange()
  return getStudent(id)
}
