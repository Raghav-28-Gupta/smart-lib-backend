import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { EmailStatus, FineReason, FineStatus, IssueCategory, LoanStatus, NoticeKind, Prisma, ReportStatus } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { listAttention } from '../../src/services/adminAttentionService'
import { returnLoan } from '../../src/services/loanService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 4

const NO_LONGER_OVERDUE = 'This loan is no longer overdue.'
const ALREADY_ESCALATED = 'This loan was already escalated.'
const REMINDER_TITLE = 'Overdue book reminder'
const ESCALATION_TITLE = 'Formal overdue notice'

async function seedUser(role: 'student' | 'admin' = 'student', extra: { name?: string; email?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@example.com`,
      passwordHash: 'x',
      role,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

async function seedBook(title = 'Clean Code') {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Robert C. Martin', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
  return { book, copy }
}

async function seedLoan(userId: string, copyId: string, dueAt: Date, extra: { status?: LoanStatus; returnedAt?: Date; lostAt?: Date } = {}) {
  return prisma.loan.create({
    data: { userId, bookCopyId: copyId, dueAt, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), ...extra },
  })
}

/** An active loan of a new book, `overdueBy` ms past due (default 3 days 5 hours: three whole days, ₹30). */
async function seedOverdueLoan(userId: string, opts: { title?: string; overdueBy?: number } = {}) {
  const { copy } = await seedBook(opts.title)
  const dueAt = new Date(Date.now() - (opts.overdueBy ?? 3 * DAY_MS + 5 * HOUR_MS))
  const loan = await seedLoan(userId, copy.id, dueAt)
  return { copy, loan, dueAt }
}

/** A notice written the way an earlier action left it, with the time the test says. */
function seedNotice(o: {
  userId: string
  loanId: string
  kind: NoticeKind
  at: Date
  emailStatus?: EmailStatus
  createdById?: string
}) {
  const emailStatus = o.emailStatus ?? 'sent'
  return prisma.notice.create({
    data: {
      userId: o.userId,
      loanId: o.loanId,
      kind: o.kind,
      title: o.kind === 'overdue_escalation' ? ESCALATION_TITLE : REMINDER_TITLE,
      body: 'An earlier notice.',
      createdAt: o.at,
      createdById: o.createdById,
      emailStatus,
      emailedAt: emailStatus === 'skipped' ? null : o.at,
    },
  })
}

interface FineSeed {
  amount?: number
  status?: FineStatus
  originalAmount?: number
  reason?: FineReason
  title?: string
  adjustedById?: string
  adjustReason?: string
}

/** A stored fine on a returned loan of a new book, so it has an item (the book's title). */
async function seedFineOnLoan(userId: string, f: FineSeed = {}) {
  const { copy } = await seedBook(f.title ?? 'Refactoring')
  const dueAt = new Date(Date.now() - 10 * DAY_MS)
  const loan = await seedLoan(userId, copy.id, dueAt, { status: 'returned', returnedAt: new Date() })
  return prisma.fine.create({
    data: {
      userId,
      relatedLoanId: loan.id,
      amount: f.amount ?? 150,
      reason: f.reason ?? 'overdue',
      status: f.status ?? 'pending',
      originalAmount: f.originalAmount,
      adjustedById: f.adjustedById,
      adjustReason: f.adjustReason,
    },
  })
}

/** Opens a dispute the way POST /fines/:id/dispute leaves the rows (the marker on the fine, and the dispute), at the time the test says. */
async function openDispute(fineId: string, userId: string, reason = 'I returned it on time', createdAt = new Date()) {
  await prisma.fine.update({ where: { id: fineId }, data: { disputedAt: createdAt } })
  return prisma.fineDispute.create({ data: { fineId, userId, reason, createdAt } })
}

interface ReportSeed {
  /** The report's id, when the test needs to choose it (the database makes one otherwise). */
  id?: string
  category?: IssueCategory
  note?: string | null
  status?: ReportStatus
  createdAt?: Date
}

/** A report of the only copy of a new book, the way a student's return leaves it, filed at the time the test says. */
async function seedCopyReport(userId: string, title: string, o: ReportSeed = {}) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Someone', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  const report = await prisma.issueReport.create({
    data: { id: o.id, userId, bookCopyId: copy.id, category: o.category ?? 'damaged', note: o.note ?? null, status: o.status, createdAt: o.createdAt },
  })
  return { copy, report }
}

/** A report of a new seat or room, filed at the time the test says. */
async function seedResourceReport(userId: string, name: string, o: ReportSeed = {}) {
  const resource = await prisma.resource.create({ data: { type: 'seat', name } })
  const report = await prisma.issueReport.create({
    data: { id: o.id, userId, resourceId: resource.id, category: o.category ?? 'not_working', note: o.note ?? null, status: o.status, createdAt: o.createdAt },
  })
  return { resource, report }
}

/** Injects a fake mail transport (cleared in afterEach); email is then configured, and nothing leaves the process. */
function fakeTransport(ok = true) {
  const send = vi.fn<MailTransport['send']>(async () => ({ ok }))
  setMailTransport({ send })
  return send
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const queue = (token: string, query = '') => request(app).get(`/admin/attention${query}`).set(auth(token))
const remind = (token: string, loanId: string) => request(app).post(`/admin/loans/${loanId}/remind`).set(auth(token))
const escalate = (token: string, loanId: string, body?: object) => {
  const req = request(app).post(`/admin/loans/${loanId}/escalate`).set(auth(token))
  return body === undefined ? req : req.send(body)
}

// The student app's Fines page shows a date as "20 Nov 2026": day, abbreviated month, year, in the
// server's local time. Spelled out here from its own month table, not through the production formatter.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dueLabel = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
const reminderBody = (title: string, dueAt: Date, days: number, amount: number) =>
  `Your copy of ${title} was due on ${dueLabel(dueAt)} and is ${days} ${days === 1 ? 'day' : 'days'} overdue. ` +
  `The fine is ₹${amount} so far and grows by ₹10 a day. Please return it to the library.`
const escalationBody = (title: string, days: number, amount: number) =>
  `${title} is now ${days} ${days === 1 ? 'day' : 'days'} overdue (₹${amount} so far). The library needs it back now.`

const noticesOf = (loanId: string) => prisma.notice.findMany({ where: { loanId }, orderBy: { createdAt: 'asc' } })

// A race needs both requests to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

// A developer's .env may set an allowed-domains list; these tests use their own addresses.
let savedAllowedDomains: string | undefined

beforeEach(async () => {
  savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
  delete process.env.MAIL_ALLOWED_DOMAINS
  setMailTransport(null)
  await resetDb()
})

afterEach(() => {
  setMailTransport(null)
  if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
  else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
  vi.restoreAllMocks()
})

describe('GET /admin/attention', () => {
  it('is for admins only', async () => {
    const { token: student } = await seedUser()
    const routes = [
      ['get', '/admin/attention'],
      ['post', '/admin/loans/some-loan/remind'],
      ['post', '/admin/loans/some-loan/escalate'],
    ] as const

    for (const [method, path] of routes) {
      const anonymous = await request(app)[method](path)
      const asStudent = await request(app)[method](path).set(auth(student))
      expect(anonymous.status, `${method} ${path} without a token`).toBe(401)
      expect(asStudent.status, `${method} ${path} as a student`).toBe(403)
    }
  })

  it('lists an active loan a day overdue and not one 23 hours overdue', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Ben Carter', email: 'ben@example.org' })
    const { loan, dueAt } = await seedOverdueLoan(student.id, { title: 'Refactoring', overdueBy: DAY_MS + 5000 })
    await seedOverdueLoan(student.id, { title: 'Almost Late', overdueBy: 23 * HOUR_MS })

    const res = await queue(admin)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [
        {
          id: loan.id,
          kind: 'overdue',
          student: { id: student.id, name: 'Ben Carter', email: 'ben@example.org' },
          waitingSince: dueAt.toISOString(),
          overdue: {
            loanId: loan.id,
            title: 'Refactoring',
            dueAt: dueAt.toISOString(),
            daysOverdue: 1,
            amount: 10,
            escalated: false,
            lastNotice: null,
          },
        },
      ],
      counts: { all: 1, overdue: 1, fine_dispute: 0, report: 0 },
      emailEnabled: false,
    })
  })

  it("the amount equals that loan's fineAmount on /loans/me", async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const { loan } = await seedOverdueLoan(student.id)

    const mine = await request(app).get('/loans/me').set(auth(studentToken))
    const res = await queue(admin)

    const myLine = mine.body.find((l: { id: string }) => l.id === loan.id)
    expect(myLine.fineAmount).toBe(30)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].overdue.amount).toBe(myLine.fineAmount)
    expect(res.body.items[0].overdue.daysOverdue).toBe(3)
  })

  it('a returned, lost or on-time loan is not listed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const overdue = await seedOverdueLoan(student.id)
    const pastDue = new Date(Date.now() - 4 * DAY_MS)
    const returned = await seedBook()
    await seedLoan(student.id, returned.copy.id, pastDue, { status: 'returned', returnedAt: new Date() })
    const lost = await seedBook()
    await seedLoan(student.id, lost.copy.id, pastDue, { status: 'lost', lostAt: new Date() })
    const onTime = await seedBook()
    await seedLoan(student.id, onTime.copy.id, new Date(Date.now() + 2 * HOUR_MS))

    const res = await queue(admin)

    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([overdue.loan.id])
    expect(res.body.counts).toEqual({ all: 1, overdue: 1, fine_dispute: 0, report: 0 })
  })

  it('oldest due first, and the kind filter and counts', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const middle = await seedOverdueLoan(student.id, { overdueBy: 5 * DAY_MS })
    const oldest = await seedOverdueLoan(student.id, { overdueBy: 9 * DAY_MS })
    const newest = await seedOverdueLoan(student.id, { overdueBy: 2 * DAY_MS })
    const order = [oldest.loan.id, middle.loan.id, newest.loan.id]
    const counts = { all: 3, overdue: 3, fine_dispute: 0, report: 0 }
    const ids = (res: request.Response) => (res.body.items as Array<{ id: string }>).map((i) => i.id)

    const all = await queue(admin)
    const overdue = await queue(admin, '?kind=overdue')
    const disputes = await queue(admin, '?kind=fine_dispute')
    const reports = await queue(admin, '?kind=report')
    const unknown = await queue(admin, '?kind=other')

    expect(ids(all)).toEqual(order)
    expect(all.body.counts).toEqual(counts)
    expect(ids(overdue)).toEqual(order)
    // No dispute or report exists here; the counts still describe the whole queue, whatever the filter.
    expect(ids(disputes)).toEqual([])
    expect(disputes.body.counts).toEqual(counts)
    expect(ids(reports)).toEqual([])
    expect(reports.body.counts).toEqual(counts)
    expect(unknown.status).toBe(400)
  })

  it('lastNotice is the newest overdue notice, and no other kind of notice counts', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { loan } = await seedOverdueLoan(student.id)
    const reminderAt = new Date(Date.now() - 2 * DAY_MS)
    const escalationAt = new Date(Date.now() - 3 * HOUR_MS)
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_reminder', at: reminderAt, emailStatus: 'failed' })
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_escalation', at: escalationAt, emailStatus: 'skipped' })
    // Newer than both, and attached to the loan, but not an overdue follow-up.
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'report_outcome', at: new Date(Date.now() - HOUR_MS) })

    const res = await queue(admin)

    expect(res.body.items[0].overdue.lastNotice).toEqual({ kind: 'escalation', at: escalationAt.toISOString(), emailStatus: 'skipped' })
    expect(res.body.items[0].overdue.escalated).toBe(true)
  })

  it('emailEnabled is true only when email is configured', async () => {
    const { token: admin } = await seedUser('admin')
    const savedKey = process.env.BREVO_API_KEY
    const savedFrom = process.env.MAIL_FROM
    try {
      // Under NODE_ENV=test a key in the environment never counts: only an injected transport does.
      process.env.BREVO_API_KEY = 'not-a-real-key'
      process.env.MAIL_FROM = 'library@example.org'
      expect((await queue(admin)).body.emailEnabled).toBe(false)

      fakeTransport()
      expect((await queue(admin)).body.emailEnabled).toBe(true)

      setMailTransport(null)
      expect((await queue(admin)).body.emailEnabled).toBe(false)
    } finally {
      if (savedKey === undefined) delete process.env.BREVO_API_KEY
      else process.env.BREVO_API_KEY = savedKey
      if (savedFrom === undefined) delete process.env.MAIL_FROM
      else process.env.MAIL_FROM = savedFrom
    }
  })

  // One query per kind of item (overdue loans, fine disputes, problem reports), so the cost does not
  // grow with the number of items: no per-row reads of a notice, a student, a book, a fine or a resource.
  it('reads the whole queue in one query per kind however many items are in it', async () => {
    const { user: student } = await seedUser()
    for (let i = 0; i < 5; i++) {
      const { loan } = await seedOverdueLoan(student.id, { overdueBy: (i + 2) * DAY_MS })
      await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_reminder', at: new Date(Date.now() - i * HOUR_MS) })
      if (i % 2 === 0) await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_escalation', at: new Date(Date.now() - HOUR_MS) })
      const fine = await seedFineOnLoan(student.id, { title: `Disputed ${i}` })
      await openDispute(fine.id, student.id, `Reason ${i}`, new Date(Date.now() - i * HOUR_MS))
      await seedCopyReport(student.id, `Reported ${i}`, { createdAt: new Date(Date.now() - i * HOUR_MS) })
      await seedResourceReport(student.id, `Desk ${i}`, { createdAt: new Date(Date.now() - i * HOUR_MS) })
    }
    const queryRaw = vi.spyOn(prisma, '$queryRaw')
    const others = [
      vi.spyOn(prisma, '$queryRawUnsafe'),
      vi.spyOn(prisma.loan, 'findMany'),
      vi.spyOn(prisma.notice, 'findMany'),
      vi.spyOn(prisma.notice, 'findFirst'),
      vi.spyOn(prisma.notice, 'count'),
      vi.spyOn(prisma.user, 'findMany'),
      vi.spyOn(prisma.book, 'findMany'),
      vi.spyOn(prisma.bookCopy, 'findMany'),
      vi.spyOn(prisma.resource, 'findMany'),
      vi.spyOn(prisma.fine, 'findMany'),
      vi.spyOn(prisma.fine, 'findUnique'),
      vi.spyOn(prisma.fineDispute, 'findMany'),
      vi.spyOn(prisma.fineDispute, 'findUnique'),
      vi.spyOn(prisma.issueReport, 'findMany'),
      vi.spyOn(prisma.issueReport, 'findUnique'),
    ]

    const result = await listAttention({}, new Date())

    expect(result.items).toHaveLength(20)
    expect(result.items.filter((i) => i.kind === 'overdue' && i.overdue.escalated)).toHaveLength(3)
    expect(result.items.filter((i) => i.kind === 'fine_dispute')).toHaveLength(5)
    expect(result.items.filter((i) => i.kind === 'report')).toHaveLength(10)
    expect(queryRaw).toHaveBeenCalledTimes(3)
    for (const spy of others) expect(spy).not.toHaveBeenCalled()
  })

  it('counts whole days by the same rule when the database session is not on UTC', async () => {
    const { user: student } = await seedUser()
    // Due dates are set against one pinned `now`, so the boundary is exact.
    const now = new Date()
    const dueAtOf = async (dueAt: Date) => (await seedLoan(student.id, (await seedBook()).copy.id, dueAt)).id
    const aDayOver = await dueAtOf(new Date(now.getTime() - DAY_MS))
    const threeDaysOver = await dueAtOf(new Date(now.getTime() - (3 * DAY_MS + 5 * HOUR_MS)))
    const justUnder = await dueAtOf(new Date(now.getTime() - (DAY_MS - 1)))
    const notYetDue = await dueAtOf(new Date(now.getTime() + 5 * HOUR_MS))

    // Every query the service makes runs inside a transaction whose session is on Kolkata
    // time (+5:30): a comparison that leans on the session zone moves by hours. The
    // transaction client shares the spied method, so the real one is called on it.
    const realQueryRaw = prisma.$queryRaw
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((sql: Prisma.Sql) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return realQueryRaw.call(tx, sql)
      })) as never)

    const result = await listAttention({}, now)

    // Exactly a day over is listed; a millisecond short of a day and a loan not yet due are not.
    expect(result.items.flatMap((i) => (i.kind === 'overdue' ? [[i.id, i.overdue.daysOverdue, i.overdue.amount]] : []))).toEqual([
      [threeDaysOver, 3, 30],
      [aDayOver, 1, 10],
    ])
    expect(result.items.map((i) => i.id)).not.toContain(justUnder)
    expect(result.items.map((i) => i.id)).not.toContain(notYetDue)
    expect(result.counts.overdue).toBe(2)
  })
})

describe('GET /admin/attention: fine disputes', () => {
  it("the queue lists open disputes oldest first with the student's words, and counts and the kind filter", async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const { user: ben } = await seedUser('student', { name: 'Ben Carter', email: 'ben@example.org' })
    const t = Date.now()
    // Waiting times, oldest first: a loan due 9 days ago, a dispute opened 5 days ago, a loan due 3 days
    // and 5 hours ago, a dispute opened 2 hours ago. The two kinds are ordered together.
    const oldestLoan = await seedOverdueLoan(ben.id, { title: 'Dune', overdueBy: 9 * DAY_MS })
    const middleLoan = await seedOverdueLoan(ben.id, { title: 'Emma' })
    const olderFine = await seedFineOnLoan(asha.id, { amount: 150, title: 'Refactoring' })
    const newerFine = await seedFineOnLoan(ben.id, {
      amount: 50,
      status: 'adjusted',
      originalAmount: 150,
      title: 'Clean Code',
      adjustedById: librarian.id,
      adjustReason: 'Hardship',
    })
    const olderOpenedAt = new Date(t - 5 * DAY_MS)
    const newerOpenedAt = new Date(t - 2 * HOUR_MS)
    const older = await openDispute(olderFine.id, asha.id, 'I returned it on time', olderOpenedAt)
    const newer = await openDispute(newerFine.id, ben.id, 'Still too much for a late fee', newerOpenedAt)
    const ids = (res: request.Response) => (res.body.items as Array<{ id: string }>).map((i) => i.id)
    const counts = { all: 4, overdue: 2, fine_dispute: 2, report: 0 }

    const all = await queue(admin)
    const disputes = await queue(admin, '?kind=fine_dispute')
    const overdue = await queue(admin, '?kind=overdue')

    expect(all.status).toBe(200)
    expect(ids(all)).toEqual([oldestLoan.loan.id, older.id, middleLoan.loan.id, newer.id])
    expect(all.body.counts).toEqual(counts)
    expect(ids(disputes)).toEqual([older.id, newer.id])
    expect(disputes.body.counts).toEqual(counts)
    expect(ids(overdue)).toEqual([oldestLoan.loan.id, middleLoan.loan.id])
    expect(overdue.body.counts).toEqual(counts)
    // The dispute items, in full: the student's own words, the fine as it stands, its stored status word.
    expect(disputes.body.items).toEqual([
      {
        id: older.id,
        kind: 'fine_dispute',
        student: { id: asha.id, name: 'Asha Rao', email: 'asha@example.org' },
        waitingSince: olderOpenedAt.toISOString(),
        dispute: {
          disputeId: older.id,
          studentReason: 'I returned it on time',
          fine: { id: olderFine.id, item: 'Refactoring', reason: 'overdue', amount: 150, originalAmount: 150, status: 'outstanding' },
        },
      },
      {
        id: newer.id,
        kind: 'fine_dispute',
        student: { id: ben.id, name: 'Ben Carter', email: 'ben@example.org' },
        waitingSince: newerOpenedAt.toISOString(),
        dispute: {
          disputeId: newer.id,
          studentReason: 'Still too much for a late fee',
          fine: { id: newerFine.id, item: 'Clean Code', reason: 'overdue', amount: 50, originalAmount: 150, status: 'adjusted' },
        },
      },
    ])
  })

  it('a dispute on its own is counted and listed, and never as "disputed"', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id)
    const dispute = await openDispute(fine.id, student.id)

    const res = await queue(admin)

    expect(res.body.counts).toEqual({ all: 1, overdue: 0, fine_dispute: 1, report: 0 })
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].dispute.disputeId).toBe(dispute.id)
    expect(res.body.items[0].dispute.fine.status).toBe('outstanding')
    // The Fines page lists the same fine as disputed; the queue says what the fine itself is.
    const listed = await request(app).get('/admin/fines').set(auth(admin))
    expect(listed.body.fines[0].status).toBe('disputed')
  })

  it('a resolved dispute leaves the queue, whether it was waived, adjusted or upheld', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fines = [await seedFineOnLoan(student.id), await seedFineOnLoan(student.id), await seedFineOnLoan(student.id)]
    const disputeIds: string[] = []
    for (const fine of fines) {
      const res = await request(app).post(`/fines/${fine.id}/dispute`).set(auth(studentToken)).send({ reason: 'Wrong' })
      expect(res.status).toBe(201)
      disputeIds.push(res.body.id)
    }
    const count = async () => (await queue(admin)).body.counts.fine_dispute

    expect(await count()).toBe(3)
    const adjust = (fineId: string, amount: number, disputeId: string) =>
      request(app).post(`/admin/fines/${fineId}/adjust`).set(auth(admin)).send({ amount, reason: 'Checked', disputeId })
    expect((await adjust(fines[0].id, 50, disputeIds[0])).status).toBe(200)
    expect(await count()).toBe(2)
    expect((await adjust(fines[1].id, 0, disputeIds[1])).status).toBe(200)
    expect(await count()).toBe(1)
    expect((await request(app).post(`/admin/disputes/${disputeIds[2]}/uphold`).set(auth(admin)).send({})).status).toBe(200)
    expect(await count()).toBe(0)
    expect((await queue(admin)).body.items).toEqual([])
    expect((await queue(admin)).body.counts.all).toBe(0)
  })

  it("an item's label and reason are the ones the Fines page shows: a book, a resource and a lost book", async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const overdue = await seedFineOnLoan(student.id, { amount: 30, title: 'Design Patterns' })
    const lostBook = await seedFineOnLoan(student.id, { amount: 400, reason: 'lost', title: 'Dune' })
    const resource = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201', capacity: 6 } })
    const start = new Date(Date.now() - 3 * DAY_MS)
    const booking = await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: resource.id, startTime: start, endTime: new Date(start.getTime() + HOUR_MS), status: 'no_show' },
    })
    const noShow = await prisma.fine.create({ data: { userId: student.id, amount: 50, reason: 'no_show', relatedBookingId: booking.id } })
    // A fine with no book or resource lists with an empty item on both pages.
    const bare = await prisma.fine.create({ data: { userId: student.id, amount: 20, reason: 'overdue' } })
    for (const fine of [overdue, lostBook, noShow, bare]) await openDispute(fine.id, student.id)

    const res = await queue(admin)
    const listed = await request(app).get('/admin/fines').set(auth(admin))

    expect(res.body.items).toHaveLength(4)
    for (const item of res.body.items as Array<{ dispute: { fine: { id: string; item: string; reason: string; amount: number } } }>) {
      const row = (listed.body.fines as Array<{ id: string; item: string; reason: string; amount: number }>).find((f) => f.id === item.dispute.fine.id)!
      expect(item.dispute.fine.item, item.dispute.fine.id).toBe(row.item)
      expect(item.dispute.fine.reason, item.dispute.fine.id).toBe(row.reason)
      expect(item.dispute.fine.amount, item.dispute.fine.id).toBe(row.amount)
    }
    const byFine = (id: string) => (res.body.items as Array<{ dispute: { fine: { id: string; item: string; reason: string } } }>).find((i) => i.dispute.fine.id === id)!.dispute.fine
    expect(byFine(overdue.id)).toMatchObject({ item: 'Design Patterns', reason: 'overdue' })
    expect(byFine(lostBook.id)).toMatchObject({ item: 'Dune', reason: 'lost' })
    expect(byFine(noShow.id)).toMatchObject({ item: 'Group Room 201', reason: 'no_show' })
    expect(byFine(bare.id)).toMatchObject({ item: '', reason: 'overdue' })
  })

  it('reads a dispute\'s waiting time as the moment it was opened when the database session is not on UTC', async () => {
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id)
    const openedAt = new Date(Date.now() - 5 * HOUR_MS)
    const dispute = await openDispute(fine.id, student.id, 'Wrong', openedAt)

    // Every query the service makes runs inside a transaction whose session is on Kolkata
    // time (+5:30): a date that leaned on the session zone would move by hours.
    const realQueryRaw = prisma.$queryRaw
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((sql: Prisma.Sql) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return realQueryRaw.call(tx, sql)
      })) as never)

    const result = await listAttention({}, new Date())

    expect(result.items.map((i) => [i.id, i.waitingSince.getTime()])).toEqual([[dispute.id, openedAt.getTime()]])
    expect(result.counts.fine_dispute).toBe(1)
  })
})

describe('GET /admin/attention: problem reports', () => {
  it('the queue lists reports oldest first with the target, category and note, and the counts and filter', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const { user: ben } = await seedUser('student', { name: 'Ben Carter', email: 'ben@example.org' })
    const t = Date.now()
    // Waiting times, oldest first: a copy report 6 days ago, a loan due 5 days ago, a seat report 3 days ago,
    // a dispute opened 2 days ago, a copy report an hour ago. The three kinds are ordered together.
    const copyOlder = await seedCopyReport(ben.id, 'Dune', { category: 'missing_pages', createdAt: new Date(t - 6 * DAY_MS) })
    const overdue = await seedOverdueLoan(ben.id, { title: 'Emma', overdueBy: 5 * DAY_MS })
    const seat = await seedResourceReport(asha.id, 'Reading Room A · Desk 12', {
      category: 'not_working',
      note: 'The lamp is dead',
      createdAt: new Date(t - 3 * DAY_MS),
    })
    const fine = await seedFineOnLoan(asha.id, { title: 'Refactoring' })
    const dispute = await openDispute(fine.id, asha.id, 'I returned it on time', new Date(t - 2 * DAY_MS))
    const copyNewer = await seedCopyReport(asha.id, 'Clean Code', { category: 'other', note: 'Pages are wet', createdAt: new Date(t - HOUR_MS) })
    // Settled reports never appear, however old.
    await seedCopyReport(ben.id, 'Confirmed Book', { status: 'confirmed', createdAt: new Date(t - 9 * DAY_MS) })
    await seedResourceReport(ben.id, 'Dismissed Desk', { status: 'dismissed', createdAt: new Date(t - 8 * DAY_MS) })
    const ids = (res: request.Response) => (res.body.items as Array<{ id: string }>).map((i) => i.id)
    const counts = { all: 5, overdue: 1, fine_dispute: 1, report: 3 }

    const all = await queue(admin)
    const reports = await queue(admin, '?kind=report')
    const overdueOnly = await queue(admin, '?kind=overdue')
    const disputes = await queue(admin, '?kind=fine_dispute')

    expect(all.status).toBe(200)
    expect(ids(all)).toEqual([copyOlder.report.id, overdue.loan.id, seat.report.id, dispute.id, copyNewer.report.id])
    expect(all.body.counts).toEqual(counts)
    // The filter changes the list and never the counts.
    expect(ids(reports)).toEqual([copyOlder.report.id, seat.report.id, copyNewer.report.id])
    expect(reports.body.counts).toEqual(counts)
    expect(ids(overdueOnly)).toEqual([overdue.loan.id])
    expect(overdueOnly.body.counts).toEqual(counts)
    expect(ids(disputes)).toEqual([dispute.id])
    expect(disputes.body.counts).toEqual(counts)

    // The report items, in full. A copy report names the copy and its book, a resource report the resource.
    expect(reports.body.items).toEqual([
      {
        id: copyOlder.report.id,
        kind: 'report',
        student: { id: ben.id, name: 'Ben Carter', email: 'ben@example.org' },
        waitingSince: new Date(t - 6 * DAY_MS).toISOString(),
        report: {
          reportId: copyOlder.report.id,
          target: 'copy',
          category: 'missing_pages',
          note: null,
          copy: { id: copyOlder.copy.id, barcode: copyOlder.copy.barcode, title: 'Dune' },
        },
      },
      {
        id: seat.report.id,
        kind: 'report',
        student: { id: asha.id, name: 'Asha Rao', email: 'asha@example.org' },
        waitingSince: new Date(t - 3 * DAY_MS).toISOString(),
        report: {
          reportId: seat.report.id,
          target: 'resource',
          category: 'not_working',
          note: 'The lamp is dead',
          resource: { id: seat.resource.id, name: 'Reading Room A · Desk 12' },
        },
      },
      {
        id: copyNewer.report.id,
        kind: 'report',
        student: { id: asha.id, name: 'Asha Rao', email: 'asha@example.org' },
        waitingSince: new Date(t - HOUR_MS).toISOString(),
        report: {
          reportId: copyNewer.report.id,
          target: 'copy',
          category: 'other',
          note: 'Pages are wet',
          copy: { id: copyNewer.copy.id, barcode: copyNewer.copy.barcode, title: 'Clean Code' },
        },
      },
    ])
    // Neither target key is there for the other kind of report.
    expect(Object.keys(reports.body.items[0].report).sort()).toEqual(['category', 'copy', 'note', 'reportId', 'target'])
    expect(Object.keys(reports.body.items[1].report).sort()).toEqual(['category', 'note', 'reportId', 'resource', 'target'])
  })

  it('every report item\'s id is the report\'s own id (the console confirms and dismisses with item.id)', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const t = Date.now()
    const copy = await seedCopyReport(student.id, 'Dune', { createdAt: new Date(t - 2 * DAY_MS) })
    const resource = await seedResourceReport(student.id, 'Desk 1', { createdAt: new Date(t - DAY_MS) })

    const res = await queue(admin, '?kind=report')

    const items = res.body.items as Array<{ id: string; report: { reportId: string; copy?: { id: string }; resource?: { id: string } } }>
    expect(items).toHaveLength(2)
    // The report row's own id, and not the copy's, the resource's or the student's: both kinds, so a mix-up cannot pass.
    expect(items[0].id).toBe(copy.report.id)
    expect(items[0].report.reportId).toBe(copy.report.id)
    expect(items[0].id).not.toBe(copy.copy.id)
    expect(items[1].id).toBe(resource.report.id)
    expect(items[1].report.reportId).toBe(resource.report.id)
    expect(items[1].id).not.toBe(resource.resource.id)
    // And it is the id the confirm and dismiss routes take.
    const dismissed = await request(app).post(`/admin/reports/${items[0].id}/dismiss`).set(auth(admin))
    const confirmed = await request(app).post(`/admin/reports/${items[1].id}/confirm`).set(auth(admin))
    expect([dismissed.status, confirmed.status]).toEqual([200, 200])
    expect((await queue(admin)).body.items).toEqual([])
  })

  it('a settled report leaves the queue and its count: confirmed or dismissed, the counts are the open ones', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const confirmed = await seedCopyReport(student.id, 'Dune')
    const dismissed = await seedResourceReport(student.id, 'Desk 1')
    const open = await seedCopyReport(student.id, 'Emma')

    expect((await queue(admin)).body.counts).toEqual({ all: 3, overdue: 0, fine_dispute: 0, report: 3 })
    expect((await request(app).post(`/admin/reports/${confirmed.report.id}/confirm`).set(auth(admin)).send({ outcome: 'maintenance' })).status).toBe(200)
    expect((await queue(admin)).body.counts).toEqual({ all: 2, overdue: 0, fine_dispute: 0, report: 2 })
    expect((await request(app).post(`/admin/reports/${dismissed.report.id}/dismiss`).set(auth(admin))).status).toBe(200)

    const res = await queue(admin, '?kind=report')
    expect(res.body.counts).toEqual({ all: 1, overdue: 0, fine_dispute: 0, report: 1 })
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([open.report.id])
  })

  it("reads a report's waiting time as the moment it was filed when the database session is not on UTC", async () => {
    const { user: student } = await seedUser()
    const filedAt = new Date(Date.now() - 5 * HOUR_MS)
    const copy = await seedCopyReport(student.id, 'Dune', { createdAt: filedAt })
    const seat = await seedResourceReport(student.id, 'Desk 1', { createdAt: new Date(filedAt.getTime() + HOUR_MS) })

    // Every query the service makes runs inside a transaction whose session is on Kolkata
    // time (+5:30): a date that leaned on the session zone would move by hours.
    const realQueryRaw = prisma.$queryRaw
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((sql: Prisma.Sql) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return realQueryRaw.call(tx, sql)
      })) as never)

    const result = await listAttention({}, new Date())

    expect(result.items.map((i) => [i.id, i.waitingSince.getTime()])).toEqual([
      [copy.report.id, filedAt.getTime()],
      [seat.report.id, filedAt.getTime() + HOUR_MS],
    ])
    expect(result.counts.report).toBe(2)
  })

  it('reports filed at the same moment keep a stable order', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const at = new Date(Date.now() - DAY_MS)
    // Filed in the opposite order to their ids, so a list left in the order the database happens to return
    // (the order they were written in) differs from the one the tie-break gives.
    await seedCopyReport(student.id, 'Dune', { createdAt: at, id: 'report-c' })
    await seedResourceReport(student.id, 'Desk 1', { createdAt: at, id: 'report-b' })
    await seedCopyReport(student.id, 'Emma', { createdAt: at, id: 'report-a' })

    const first = (await queue(admin, '?kind=report')).body.items.map((i: { id: string }) => i.id)
    const second = (await queue(admin, '?kind=report')).body.items.map((i: { id: string }) => i.id)

    expect(first).toEqual(['report-a', 'report-b', 'report-c'])
    expect(second).toEqual(first)
  })
})

describe('POST /admin/loans/:id/remind', () => {
  it('remind creates a notice, sends one email after commit, records sent, and the item shows it as lastNotice', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const { loan, dueAt } = await seedOverdueLoan(student.id, { title: 'Clean Code' })
    const recorder = recordEvents()
    const seenAtSend: Array<{ notices: Array<{ emailStatus: string }>; events: number }> = []
    const send = vi.fn<MailTransport['send']>(async () => {
      // Read on another connection: only a committed notice is visible, with the outcome not yet written.
      seenAtSend.push({ notices: await prisma.notice.findMany(), events: recorder.events.length })
      return { ok: true }
    })
    setMailTransport({ send })

    let res: request.Response
    try {
      res = await remind(admin, loan.id)
    } finally {
      recorder.stop()
    }

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    const [message] = send.mock.calls[0]
    expect(message.to).toBe('asha@example.org')
    expect(message.subject).toBe(`SmartLib: ${REMINDER_TITLE}`)
    expect(message.text.startsWith(reminderBody('Clean Code', dueAt, 3, 30))).toBe(true)
    expect(seenAtSend).toHaveLength(1)
    expect(seenAtSend[0].notices.map((n) => n.emailStatus)).toEqual(['skipped'])
    expect(seenAtSend[0].events).toBe(0)

    const [notice, ...rest] = await noticesOf(loan.id)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({
      userId: student.id,
      kind: 'overdue_reminder',
      title: REMINDER_TITLE,
      body: reminderBody('Clean Code', dueAt, 3, 30),
      loanId: loan.id,
      createdById: librarian.id,
      emailStatus: 'sent',
    })
    expect(notice.emailedAt).not.toBeNull()
    expect(res.body).toEqual({
      id: loan.id,
      kind: 'overdue',
      student: { id: student.id, name: 'Asha Rao', email: 'asha@example.org' },
      waitingSince: dueAt.toISOString(),
      overdue: {
        loanId: loan.id,
        title: 'Clean Code',
        dueAt: dueAt.toISOString(),
        daysOverdue: 3,
        amount: 30,
        escalated: false,
        lastNotice: { kind: 'reminder', at: notice.createdAt.toISOString(), emailStatus: 'sent' },
      },
    })
  })

  it('writes the due date the way the student app does: "3 Sep 2025", no comma, "Sep" not "Sept"', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { email: 'asha@example.org' })
    const send = fakeTransport()
    // Local noon on 3 September of last year (always long past due), so the local day is the same
    // in any time zone. The year comes from the clock; the month and day are chosen to catch
    // "Sept" and a leading zero.
    const year = new Date().getFullYear() - 1
    const { copy } = await seedBook('Dune')
    const loan = await seedLoan(student.id, copy.id, new Date(year, 8, 3, 12))

    const res = await remind(admin, loan.id)

    expect(res.status).toBe(200)
    const prefix = `Your copy of Dune was due on 3 Sep ${year} and is `
    expect((await noticesOf(loan.id))[0].body.startsWith(prefix)).toBe(true)
    // The email carries the same text.
    expect(send.mock.calls[0][0].text.startsWith(prefix)).toBe(true)
  })

  it('accepts a request with no body at all, and one with an unrelated body', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const first = await seedOverdueLoan(student.id)
    const second = await seedOverdueLoan(student.id)

    const bare = await remind(admin, first.loan.id)
    const withBody = await remind(admin, second.loan.id).send({ anything: true })

    expect(bare.status).toBe(200)
    expect(withBody.status).toBe(200)
  })

  it('remind records failed (and succeeds) when the transport fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const refused = await seedOverdueLoan(student.id)
    const thrown = await seedOverdueLoan(student.id)

    // The provider answers not ok.
    const send = fakeTransport(false)
    const notOk = await remind(admin, refused.loan.id)
    expect(notOk.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(notOk.body.overdue.lastNotice.emailStatus).toBe('failed')
    const [refusedNotice] = await noticesOf(refused.loan.id)
    expect(refusedNotice.emailStatus).toBe('failed')
    expect(refusedNotice.emailedAt).not.toBeNull()

    // The transport itself throws.
    setMailTransport({
      send: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const broken = await remind(admin, thrown.loan.id)
    expect(broken.status).toBe(200)
    expect(broken.body.overdue.lastNotice).toMatchObject({ kind: 'reminder', emailStatus: 'failed' })
    expect((await noticesOf(thrown.loan.id)).map((n) => n.emailStatus)).toEqual(['failed'])
  })

  it('a placeholder-address student gets skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { email: 'seed.student12@thapar.edu' })
    const { loan } = await seedOverdueLoan(student.id)
    const send = fakeTransport()

    const res = await remind(admin, loan.id)

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
    expect(res.body.overdue.lastNotice.emailStatus).toBe('skipped')
    const [notice] = await noticesOf(loan.id)
    expect(notice).toMatchObject({ kind: 'overdue_reminder', emailStatus: 'skipped', emailedAt: null })
  })

  it('with email not set up the reminder still reaches the student in the app and records skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { loan } = await seedOverdueLoan(student.id)

    const res = await remind(admin, loan.id)

    expect(res.status).toBe(200)
    expect(res.body.overdue.lastNotice).toMatchObject({ kind: 'reminder', emailStatus: 'skipped' })
    expect((await noticesOf(loan.id)).map((n) => n.emailStatus)).toEqual(['skipped'])
  })

  it('a second reminder within 24 hours is 409 with the hours', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    const recorder = recordEvents()
    const { loan } = await seedOverdueLoan(student.id)
    const other = await seedOverdueLoan(student.id)
    // Another loan's reminder, and this loan's reminders of the wrong kind, do not count.
    await seedNotice({ userId: student.id, loanId: other.loan.id, kind: 'overdue_reminder', at: new Date(Date.now() - HOUR_MS) })
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_escalation', at: new Date(Date.now() - HOUR_MS) })
    const sent = await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_reminder', at: new Date(Date.now() - 5 * HOUR_MS) })

    const fiveHours = await remind(admin, loan.id)
    expect(fiveHours.status).toBe(409)
    expect(fiveHours.body).toEqual({ error: 'A reminder was sent 5 hours ago.' })

    // Whole hours, rounded down: 23 hours 59 minutes is still 23 hours, and refused.
    await prisma.notice.update({ where: { id: sent.id }, data: { createdAt: new Date(Date.now() - (24 * HOUR_MS - 60_000)) } })
    const justUnder = await remind(admin, loan.id)
    expect(justUnder.status).toBe(409)
    expect(justUnder.body).toEqual({ error: 'A reminder was sent 23 hours ago.' })

    // Under two hours the wording still reads properly.
    await prisma.notice.update({ where: { id: sent.id }, data: { createdAt: new Date(Date.now() - (HOUR_MS + 60_000)) } })
    expect((await remind(admin, loan.id)).body).toEqual({ error: 'A reminder was sent 1 hour ago.' })
    await prisma.notice.update({ where: { id: sent.id }, data: { createdAt: new Date(Date.now() - 60_000) } })
    expect((await remind(admin, loan.id)).body).toEqual({ error: 'A reminder was sent less than an hour ago.' })

    // Nothing was written, emailed or published by any refusal.
    recorder.stop()
    expect((await noticesOf(loan.id)).map((n) => n.kind).sort()).toEqual(['overdue_escalation', 'overdue_reminder'])
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('after 24 hours it is allowed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    const { loan } = await seedOverdueLoan(student.id)
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_reminder', at: new Date(Date.now() - (24 * HOUR_MS + 60_000)) })

    const res = await remind(admin, loan.id)

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await noticesOf(loan.id)).toHaveLength(2)
    // The newest reminder is the one shown.
    expect(Date.parse(res.body.overdue.lastNotice.at)).toBeGreaterThan(Date.now() - HOUR_MS)

    // And now the 24 hours run from this reminder.
    const again = await remind(admin, loan.id)
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('A reminder was sent less than an hour ago.')
    expect(await noticesOf(loan.id)).toHaveLength(2)
  })

  it('two simultaneous reminds: one notice, one email, one 409', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { loan } = await seedOverdueLoan(student.id)

      // On odd rounds the second request is started first, so each order gets hit.
      const requests = [() => remind(admin, loan.id), () => remind(admin, loan.id)]
      if (round % 2 === 1) requests.reverse()
      const results = await Promise.all(requests.map((start) => start()))

      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409])
      const refused = results.find((r) => r.status === 409)!
      expect(refused.body.error).toBe('A reminder was sent less than an hour ago.')
      expect(await noticesOf(loan.id), `round ${round}`).toHaveLength(1)
      expect(send, `round ${round}`).toHaveBeenCalledTimes(round + 1)
    }
  }, 120_000)
})

describe('POST /admin/loans/:id/escalate', () => {
  it('escalate once, then 409', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const send = fakeTransport()
    const { loan, dueAt } = await seedOverdueLoan(student.id, { title: 'Clean Code' })
    const recorder = recordEvents()

    const first = await escalate(admin, loan.id, { note: 'Please bring it to the desk.' })
    const second = await escalate(admin, loan.id, { note: 'Second try.' })
    recorder.stop()

    expect(first.status).toBe(200)
    const body = `${escalationBody('Clean Code', 3, 30)}\n\nNote from the library: Please bring it to the desk.`
    const [notice, ...rest] = await noticesOf(loan.id)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({
      userId: student.id,
      kind: 'overdue_escalation',
      title: ESCALATION_TITLE,
      body,
      loanId: loan.id,
      createdById: librarian.id,
      emailStatus: 'sent',
    })
    expect(first.body).toEqual({
      id: loan.id,
      kind: 'overdue',
      student: { id: student.id, name: 'Asha Rao', email: 'asha@example.org' },
      waitingSince: dueAt.toISOString(),
      overdue: {
        loanId: loan.id,
        title: 'Clean Code',
        dueAt: dueAt.toISOString(),
        daysOverdue: 3,
        amount: 30,
        escalated: true,
        lastNotice: { kind: 'escalation', at: notice.createdAt.toISOString(), emailStatus: 'sent' },
      },
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].subject).toBe(`SmartLib: ${ESCALATION_TITLE}`)
    expect(send.mock.calls[0][0].text.startsWith(body)).toBe(true)

    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: ALREADY_ESCALATED })
    // The refusal wrote and sent nothing, and published nothing: one event, for the first.
    expect(send).toHaveBeenCalledTimes(1)
    expect(recorder.events).toHaveLength(1)
    // An escalation changes no amount.
    expect((await queue(admin)).body.items[0].overdue.amount).toBe(30)
  })

  it('takes the note trimmed, at most 300 characters, and a blank note means none', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    const spaced = await seedOverdueLoan(student.id, { title: 'Dune' })
    const blank = await seedOverdueLoan(student.id, { title: 'Dune' })
    const bare = await seedOverdueLoan(student.id, { title: 'Dune' })
    const longest = await seedOverdueLoan(student.id, { title: 'Dune' })
    const tooLong = await seedOverdueLoan(student.id, { title: 'Dune' })
    const base = escalationBody('Dune', 3, 30)
    const bodyOf = async (loanId: string) => (await noticesOf(loanId))[0].body

    expect((await escalate(admin, spaced.loan.id, { note: '  Bring it Friday.  ' })).status).toBe(200)
    expect(await bodyOf(spaced.loan.id)).toBe(`${base}\n\nNote from the library: Bring it Friday.`)

    expect((await escalate(admin, blank.loan.id, { note: '   ' })).status).toBe(200)
    expect(await bodyOf(blank.loan.id)).toBe(base)

    // No body at all, and an empty object, are both "no note".
    expect((await escalate(admin, bare.loan.id)).status).toBe(200)
    expect(await bodyOf(bare.loan.id)).toBe(base)

    // 300 characters is the most; the limit counts the trimmed text.
    const max = 'x'.repeat(300)
    expect((await escalate(admin, longest.loan.id, { note: ` ${max} ` })).status).toBe(200)
    expect(await bodyOf(longest.loan.id)).toBe(`${base}\n\nNote from the library: ${max}`)

    const sentBefore = send.mock.calls.length
    const refused = await escalate(admin, tooLong.loan.id, { note: 'x'.repeat(301) })
    expect(refused.status).toBe(400)
    expect(await noticesOf(tooLong.loan.id)).toEqual([])
    expect(send).toHaveBeenCalledTimes(sentBefore)

    // A note that is not text is refused too.
    expect((await escalate(admin, tooLong.loan.id, { note: 5 })).status).toBe(400)
    expect(await noticesOf(tooLong.loan.id)).toEqual([])
  })

  it('names one day as "1 day" in both notices', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const escalated = await seedOverdueLoan(student.id, { title: 'Dune', overdueBy: DAY_MS + 5000 })
    const reminded = await seedOverdueLoan(student.id, { title: 'Emma', overdueBy: DAY_MS + 5000 })

    expect((await escalate(admin, escalated.loan.id)).status).toBe(200)
    expect((await remind(admin, reminded.loan.id)).status).toBe(200)

    expect((await noticesOf(escalated.loan.id))[0].body).toBe(escalationBody('Dune', 1, 10))
    expect((await noticesOf(reminded.loan.id))[0].body).toBe(reminderBody('Emma', reminded.dueAt, 1, 10))
  })

  it('a reminder after an escalation is allowed (when none was sent in the last 24 hours) and the item stays escalated: true with the reminder as lastNotice', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const { loan } = await seedOverdueLoan(student.id)
    // Escalated two hours ago, and no reminder has ever been sent.
    await seedNotice({ userId: student.id, loanId: loan.id, kind: 'overdue_escalation', at: new Date(Date.now() - 2 * HOUR_MS) })

    const reminded = await remind(admin, loan.id)

    expect(reminded.status).toBe(200)
    expect(reminded.body.overdue.escalated).toBe(true)
    expect(reminded.body.overdue.lastNotice).toMatchObject({ kind: 'reminder', emailStatus: 'sent' })
    const listed = await queue(admin)
    expect(listed.body.items[0].overdue.escalated).toBe(true)
    expect(listed.body.items[0].overdue.lastNotice.kind).toBe('reminder')

    // Still escalated, so it cannot be escalated again; and the new reminder holds off the next for 24 hours.
    const again = await escalate(admin, loan.id)
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: ALREADY_ESCALATED })
    expect((await remind(admin, loan.id)).status).toBe(409)
  })

  it('an escalation is allowed straight after a reminder', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { loan } = await seedOverdueLoan(student.id)

    expect((await remind(admin, loan.id)).status).toBe(200)
    const res = await escalate(admin, loan.id)

    expect(res.status).toBe(200)
    expect(res.body.overdue).toMatchObject({ escalated: true, lastNotice: { kind: 'escalation' } })
  })

  it('two simultaneous escalations: one notice, one email, one 409', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { loan } = await seedOverdueLoan(student.id)
      const requests = [() => escalate(admin, loan.id), () => escalate(admin, loan.id)]
      if (round % 2 === 1) requests.reverse()
      const results = await Promise.all(requests.map((start) => start()))

      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409])
      expect(results.find((r) => r.status === 409)!.body, `round ${round}`).toEqual({ error: ALREADY_ESCALATED })
      expect(await noticesOf(loan.id), `round ${round}`).toHaveLength(1)
      expect(send, `round ${round}`).toHaveBeenCalledTimes(round + 1)
    }
  }, 120_000)
})

// --- Refusals shared by remind and escalate ----------------------------------

const actions = {
  remind: (token: string, loanId: string) => remind(token, loanId),
  escalate: (token: string, loanId: string) => escalate(token, loanId),
}

/** Polls until some other session is stuck waiting for a lock (the action under test, on the loan row the test holds). */
async function waitUntilAWriterIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the loan row')
}

/**
 * Locks the loan row, starts `action`, waits until it is blocked on that lock, lets
 * `competitor` change the rows in the locking transaction and commits. The action
 * then runs against the changed rows, exactly as if the competitor had landed just
 * before it. An action that read the loan before locking it would be caught here: a
 * plain read is not blocked by the lock, so it would see the old row.
 */
async function writeBlockedThenCompete(
  loanId: string,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId} FOR UPDATE`
        pending = Promise.resolve(action())
        await waitUntilAWriterIsBlocked()
        await competitor(tx)
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
  } finally {
    // Never leave the request running into the next test, even when the setup failed.
    await pending
  }
  return pending!
}

describe('remind and escalate refuse a loan that is no longer overdue', () => {
  it('both refuse a loan returned, renewed or lost a moment earlier with 409 "This loan is no longer overdue."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    const recorder = recordEvents()

    type Change = (tx: Prisma.TransactionClient, loan: { id: string; bookCopyId: string }) => Promise<unknown>
    // What a return, a renewal and a librarian's loss each write, done by the test instead.
    const competitors: Record<string, Change> = {
      returned: async (tx, l) => {
        await tx.loan.update({ where: { id: l.id }, data: { status: 'returned', returnedAt: new Date() } })
        await tx.fine.create({ data: { userId: student.id, relatedLoanId: l.id, amount: 30, reason: 'overdue' } })
        await tx.bookCopy.update({ where: { id: l.bookCopyId }, data: { status: 'available' } })
      },
      renewed: async (tx, l) => {
        await tx.loan.update({ where: { id: l.id }, data: { dueAt: new Date(Date.now() + 14 * DAY_MS), renewedCount: 1 } })
        await tx.fine.create({ data: { userId: student.id, relatedLoanId: l.id, amount: 30, reason: 'overdue' } })
      },
      lost: async (tx, l) => {
        await tx.loan.update({ where: { id: l.id }, data: { status: 'lost', lostAt: new Date() } })
        await tx.bookCopy.update({ where: { id: l.bookCopyId }, data: { status: 'lost' } })
      },
    }

    for (const [action, act] of Object.entries(actions)) {
      for (const [change, compete] of Object.entries(competitors)) {
        const { loan } = await seedOverdueLoan(student.id)

        const res = await writeBlockedThenCompete(loan.id, () => act(admin, loan.id), (tx) => compete(tx, loan))

        const label = `${action} after the loan was ${change}`
        expect(res.status, label).toBe(409)
        expect(res.body, label).toEqual({ error: NO_LONGER_OVERDUE })
        expect(await noticesOf(loan.id), label).toEqual([])
      }
    }
    recorder.stop()
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 180_000)

  it('a loan that is already returned or lost, or only hours overdue, is refused the same way', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const send = fakeTransport()
    const recorder = recordEvents()
    const pastDue = new Date(Date.now() - 4 * DAY_MS)
    const returned = await seedLoan(student.id, (await seedBook()).copy.id, pastDue, { status: 'returned', returnedAt: new Date() })
    const lost = await seedLoan(student.id, (await seedBook()).copy.id, pastDue, { status: 'lost', lostAt: new Date() })
    const hoursLate = await seedLoan(student.id, (await seedBook()).copy.id, new Date(Date.now() - 23 * HOUR_MS))
    const notDue = await seedLoan(student.id, (await seedBook()).copy.id, new Date(Date.now() + HOUR_MS))

    for (const [name, loan] of Object.entries({ returned, lost, hoursLate, notDue })) {
      for (const [action, act] of Object.entries(actions)) {
        const res = await act(admin, loan.id)
        expect(res.status, `${action} on ${name}`).toBe(409)
        expect(res.body, `${action} on ${name}`).toEqual({ error: NO_LONGER_OVERDUE })
      }
    }

    recorder.stop()
    expect(await prisma.notice.count()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('unknown loan is 404', async () => {
    const { token: admin } = await seedUser('admin')
    const send = fakeTransport()
    const recorder = recordEvents()

    for (const [action, act] of Object.entries(actions)) {
      const res = await act(admin, 'no-such-loan')
      expect(res.status, action).toBe(404)
      expect(res.body, action).toEqual({ error: 'Loan not found' })
    }

    recorder.stop()
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })
})

describe('the live event', () => {
  it('the event is published once after the email outcome, and none on a refusal', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const reminded = await seedOverdueLoan(student.id)
    const escalated = await seedOverdueLoan(student.id)
    const recorder = recordEvents()
    // What the notice looks like in the database at the moment each event is published.
    const atPublish: Array<Promise<EmailStatus[]>> = []
    const stop = subscribe(() => {
      atPublish.push(prisma.notice.findMany({ orderBy: { createdAt: 'asc' } }).then((rows) => rows.map((n) => n.emailStatus)))
    })

    try {
      expect((await remind(admin, reminded.loan.id)).status).toBe(200)
      expect(recorder.events).toEqual([{ type: 'attention.changed', topics: ['attention'] }])
      // Published after deliverNotice stored the outcome: the row already says sent.
      expect(await Promise.all(atPublish)).toEqual([['sent']])

      // Refusals publish nothing: a second reminder, an unknown loan, a loan that is not overdue.
      expect((await remind(admin, reminded.loan.id)).status).toBe(409)
      expect((await remind(admin, 'no-such-loan')).status).toBe(404)
      expect((await escalate(admin, 'no-such-loan')).status).toBe(404)
      expect(recorder.events).toHaveLength(1)

      expect((await escalate(admin, escalated.loan.id)).status).toBe(200)
      expect(recorder.events).toHaveLength(2)
      expect((await escalate(admin, escalated.loan.id)).status).toBe(409)
      expect(recorder.events).toHaveLength(2)
      expect(recorder.events[1]).toEqual({ type: 'attention.changed', topics: ['attention'] })
    } finally {
      stop()
      recorder.stop()
    }
  })
})

// --- The loan closes while the email is being sent ---------------------------

describe('remind and escalate when the student returns the book while the email is being sent', () => {
  // The notice is committed before the email is attempted, which can take up to 5 seconds: a
  // student at the desk can return the book in that window. The reminder went out, so the
  // librarian is told so (never "no longer overdue", which every other 409 here uses for "nothing happened").
  it.each([
    { action: 'remind', kind: 'reminder', title: REMINDER_TITLE, noticeKind: 'overdue_reminder', escalated: false },
    { action: 'escalate', kind: 'escalation', title: ESCALATION_TITLE, noticeKind: 'overdue_escalation', escalated: true },
  ] as const)(
    '$action answers the item for the notice that went out, publishes once and records the email outcome',
    async ({ action, kind, title, noticeKind, escalated }) => {
      const { token: admin, user: librarian } = await seedUser('admin')
      const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
      const { loan, dueAt } = await seedOverdueLoan(student.id, { title: 'Clean Code' })
      const recorder = recordEvents()
      const send = vi.fn<MailTransport['send']>(async () => {
        // The student returns the book (the real return: loan closed, fine stored, copy shelved) while the email is in flight.
        await returnLoan(student.id, loan.id)
        return { ok: true }
      })
      setMailTransport({ send })

      let res: request.Response
      try {
        res = await actions[action](admin, loan.id)
      } finally {
        recorder.stop()
      }

      // The loan really was closed during the send.
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('returned')
      expect(send).toHaveBeenCalledTimes(1)

      // The notice stands, emailed and recorded as sent.
      const [notice, ...rest] = await noticesOf(loan.id)
      expect(rest).toEqual([])
      expect(notice).toMatchObject({ userId: student.id, kind: noticeKind, title, createdById: librarian.id, emailStatus: 'sent' })
      expect(notice.emailedAt).not.toBeNull()

      // The answer is the success answer for the notice that went out: the item as it stood when it was written.
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        id: loan.id,
        kind: 'overdue',
        student: { id: student.id, name: 'Asha Rao', email: 'asha@example.org' },
        waitingSince: dueAt.toISOString(),
        overdue: {
          loanId: loan.id,
          title: 'Clean Code',
          dueAt: dueAt.toISOString(),
          daysOverdue: 3,
          amount: 30,
          escalated,
          lastNotice: { kind, at: notice.createdAt.toISOString(), emailStatus: 'sent' },
        },
      })

      // The return announced itself; the action announced the queue once, after the outcome was stored.
      expect(recorder.events).toEqual([
        { type: 'loan.changed', topics: ['metrics', 'catalogue', 'fines', 'attention'] },
        { type: 'attention.changed', topics: ['attention'] },
      ])
    },
    60_000,
  )

  it('the item carries the email outcome that deliverNotice returned when the send failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { email: 'asha@example.org' })
    const { loan } = await seedOverdueLoan(student.id)
    setMailTransport({
      send: async () => {
        await returnLoan(student.id, loan.id)
        return { ok: false }
      },
    })

    const res = await remind(admin, loan.id)

    expect(res.status).toBe(200)
    expect(res.body.overdue.lastNotice).toMatchObject({ kind: 'reminder', emailStatus: 'failed' })
    expect((await noticesOf(loan.id)).map((n) => n.emailStatus)).toEqual(['failed'])
  }, 60_000)
})
