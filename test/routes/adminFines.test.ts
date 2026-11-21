import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { FineReason, FineStatus, LoanStatus, Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { listFines, listFinesForStudent } from '../../src/services/adminFineService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

async function seedUser(role: 'student' | 'admin' = 'student', extra: { name?: string; email?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@test.com`,
      passwordHash: 'x',
      role,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

async function seedBook(title = 'Clean Code') {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Robert C. Martin', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  return { book, copy }
}

async function seedLoan(userId: string, copyId: string, dueAt: Date, extra: { status?: LoanStatus; returnedAt?: Date } = {}) {
  return prisma.loan.create({
    data: { userId, bookCopyId: copyId, dueAt, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), ...extra },
  })
}

interface FineSeed {
  userId: string
  amount?: number
  reason?: FineReason
  status?: FineStatus
  createdAt?: Date
  relatedLoanId?: string
  relatedBookingId?: string
  originalAmount?: number
  adjustedById?: string
  adjustReason?: string
  paidRecordedById?: string
}

function seedFine(seed: FineSeed) {
  const data: Prisma.FineUncheckedCreateInput = {
    userId: seed.userId,
    amount: seed.amount ?? 20,
    reason: seed.reason ?? 'overdue',
    status: seed.status ?? 'pending',
    createdAt: seed.createdAt,
    relatedLoanId: seed.relatedLoanId,
    relatedBookingId: seed.relatedBookingId,
    originalAmount: seed.originalAmount,
    adjustedById: seed.adjustedById,
    adjustReason: seed.adjustReason,
    paidRecordedById: seed.paidRecordedById,
  }
  return prisma.fine.create({ data })
}

// A student with a returned loan of a fresh book, ready to hang an overdue fine on.
async function seedFineOnLoan(userId: string, extra: Partial<FineSeed> = {}, title?: string) {
  const { copy } = await seedBook(title)
  const loan = await seedLoan(userId, copy.id, new Date(Date.now() - 10 * DAY_MS), { status: 'returned', returnedAt: new Date() })
  return seedFine({ userId, relatedLoanId: loan.id, ...extra })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const list = (token: string, query = '') => request(app).get(`/admin/fines${query}`).set(auth(token))

interface ListedFine {
  id: string
  kind: string
  student: { id: string; name: string; email: string }
  reason: string
  item: string
  amount: number
  originalAmount: number
  status: string
  date: string
  note: string | null
  recordedBy: string | null
  canSettle: boolean
}

const ids = (res: request.Response) => (res.body.fines as ListedFine[]).map((f) => f.id)

describe('admin fines list', () => {
  beforeEach(resetDb)
  afterEach(() => vi.restoreAllMocks())

  it('is for admins only', async () => {
    const { token: student } = await seedUser()

    const anonymous = await request(app).get('/admin/fines')
    const asStudent = await list(student)

    expect(anonymous.status).toBe(401)
    expect(asStudent.status).toBe(403)
  })

  it('lists stored fines with student, reason, item and amount', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const createdAt = new Date(Date.now() - 2 * DAY_MS)
    const fine = await seedFineOnLoan(student.id, { amount: 30, createdAt }, 'Refactoring')

    const res = await list(admin)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      fines: [
        {
          id: fine.id,
          kind: 'fine',
          student: { id: student.id, name: 'Asha Rao', email: 'asha@test.com' },
          reason: 'overdue',
          item: 'Refactoring',
          amount: 30,
          originalAmount: 30,
          status: 'outstanding',
          date: createdAt.toISOString(),
          note: null,
          recordedBy: null,
          canSettle: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    })
  })

  it('a pending fine is outstanding', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    await seedFineOnLoan(student.id, { status: 'pending' })

    const res = await list(admin)

    expect((res.body.fines as ListedFine[]).map((f) => f.status)).toEqual(['outstanding'])
  })

  it('an overdue loan still out is an accruing row whose amount equals that loan\'s fineAmount on /loans/me', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { name: 'Ben Carter', email: 'ben@test.com' })
    const { copy } = await seedBook('Clean Code')
    const dueAt = new Date(Date.now() - (3 * DAY_MS + 5 * HOUR_MS))
    const loan = await seedLoan(student.id, copy.id, dueAt)

    const mine = await request(app).get('/loans/me').set(auth(studentToken))
    const res = await list(admin)

    expect(mine.body.find((l: { id: string }) => l.id === loan.id).fineAmount).toBe(30)
    expect(res.body.fines).toEqual([
      {
        id: loan.id,
        kind: 'accruing',
        student: { id: student.id, name: 'Ben Carter', email: 'ben@test.com' },
        reason: 'overdue',
        item: 'Clean Code',
        amount: 30,
        originalAmount: 30,
        status: 'accruing',
        date: dueAt.toISOString(),
        note: null,
        recordedBy: null,
        canSettle: false,
      },
    ])
    expect(res.body.total).toBe(1)
  })

  it('a loan overdue by under a day is accruing at ₹0', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const loan = await seedLoan(student.id, copy.id, new Date(Date.now() - 5 * HOUR_MS))

    const res = await list(admin)

    expect((res.body.fines as ListedFine[]).map((f) => [f.id, f.status, f.amount])).toEqual([[loan.id, 'accruing', 0]])
  })

  it('a loan exactly at its due time is not listed', async () => {
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const now = new Date()
    const loan = await seedLoan(student.id, copy.id, now)
    const q = { page: 1, pageSize: 25 }

    const atDue = await listFines(q, now)
    const justAfter = await listFines(q, new Date(now.getTime() + 1))
    const justBefore = await listFines(q, new Date(now.getTime() - 1))

    expect(atDue.fines).toEqual([])
    expect(atDue.total).toBe(0)
    expect(justBefore.fines).toEqual([])
    expect(justAfter.fines.map((f) => [f.id, f.amount])).toEqual([[loan.id, 0]])
  })

  it('the accruing list agrees when the database session is not on UTC', async () => {
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const now = new Date()
    const exactlyDue = await seedLoan(student.id, copy.id, now)
    const notYetDue = await seedLoan(student.id, copy.id, new Date(now.getTime() + 5 * HOUR_MS))
    const justOver = await seedLoan(student.id, copy.id, new Date(now.getTime() - 1))
    const aDayOver = await seedLoan(student.id, copy.id, new Date(now.getTime() - DAY_MS))

    // Run every query the service makes inside a transaction whose session is on
    // Kolkata time (+5:30): a comparison that leans on the session zone moves by hours.
    // The transaction client shares the spied method, so the real one is kept
    // and called on it, or each query would open another transaction.
    const realQueryRaw = prisma.$queryRaw
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((sql: Prisma.Sql) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return realQueryRaw.call(tx, sql)
      })) as never)

    const result = await listFines({ page: 1, pageSize: 25 }, now)

    expect(result.fines.map((f) => [f.id, f.amount, f.date.getTime()])).toEqual([
      [justOver.id, 0, now.getTime() - 1],
      [aDayOver.id, 10, now.getTime() - DAY_MS],
    ])
    expect(result.total).toBe(2)
    expect(result.fines.map((f) => f.id)).not.toContain(exactlyDue.id)
    expect(result.fines.map((f) => f.id)).not.toContain(notYetDue.id)
  })

  it('a returned loan is not accruing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const dueAt = new Date(Date.now() - 5 * DAY_MS)
    await seedLoan(student.id, copy.id, dueAt, { status: 'returned', returnedAt: new Date(Date.now() - DAY_MS) })

    const res = await list(admin)

    expect(res.body).toEqual({ fines: [], total: 0, page: 1, pageSize: 25 })
  })

  it('the status filter works for each status, including accruing', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const accruing = await seedLoan(student.id, copy.id, new Date(Date.now() - 2 * DAY_MS - HOUR_MS))
    const outstanding = await seedFineOnLoan(student.id, { status: 'pending' })
    const adjusted = await seedFineOnLoan(student.id, { status: 'adjusted', amount: 10, originalAmount: 40, adjustedById: librarian.id, adjustReason: 'Hardship' })
    const paid = await seedFineOnLoan(student.id, { status: 'paid', paidRecordedById: librarian.id })
    const waived = await seedFineOnLoan(student.id, { status: 'waived', amount: 0, originalAmount: 50, adjustedById: librarian.id, adjustReason: 'Library error' })

    const byStatus = async (status: string) => {
      const res = await list(admin, `?status=${status}`)
      expect(res.status).toBe(200)
      return { ids: ids(res), total: res.body.total }
    }

    expect(await byStatus('accruing')).toEqual({ ids: [accruing.id], total: 1 })
    expect(await byStatus('outstanding')).toEqual({ ids: [outstanding.id], total: 1 })
    expect(await byStatus('adjusted')).toEqual({ ids: [adjusted.id], total: 1 })
    expect(await byStatus('paid')).toEqual({ ids: [paid.id], total: 1 })
    expect(await byStatus('waived')).toEqual({ ids: [waived.id], total: 1 })
    const all = await list(admin)
    expect(ids(all).sort()).toEqual([accruing.id, outstanding.id, adjusted.id, paid.id, waived.id].sort())
    expect(all.body.total).toBe(5)
    // The stored word for an unadjusted, unpaid fine is not a filter value.
    expect((await list(admin, '?status=pending')).status).toBe(400)
    expect((await list(admin, '?status=bogus')).status).toBe(400)
  })

  it('search matches student name and email, ignoring case', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao', email: 'asha.rao@test.com' })
    const { user: ben } = await seedUser('student', { name: 'Ben Carter', email: 'bcarter@mail.example' })
    const { user: dev } = await seedUser('student', { name: 'Dev Patel', email: 'dev@test.com' })
    const ashaFine = await seedFineOnLoan(asha.id)
    const { copy } = await seedBook('Quiet Book')
    const benLoan = await seedLoan(ben.id, copy.id, new Date(Date.now() - 2 * DAY_MS - HOUR_MS))
    const devFine = await seedFineOnLoan(dev.id)

    expect(ids(await list(admin, '?search=ASHA%20RAO'))).toEqual([ashaFine.id])
    // The accruing row is found by its student too.
    expect(ids(await list(admin, '?search=BCARTER@MAIL'))).toEqual([benLoan.id])
    // A substring match: "test.com" is in two emails.
    expect(ids(await list(admin, '?search=TEST.COM')).sort()).toEqual([ashaFine.id, devFine.id].sort())
    // The item is not searched, only the student.
    expect(ids(await list(admin, '?search=quiet'))).toEqual([])
    const none = await list(admin, '?search=nobody')
    expect(none.status).toBe(200)
    expect(none.body).toMatchObject({ fines: [], total: 0 })
  })

  it('search is trimmed and capped at 100 characters', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao' })
    const fine = await seedFineOnLoan(asha.id)

    expect(ids(await list(admin, '?search=%20%20asha%20%20'))).toEqual([fine.id])
    expect((await list(admin, `?search=${'a'.repeat(100)}`)).status).toBe(200)
    expect((await list(admin, `?search=${'a'.repeat(101)}`)).status).toBe(400)
    expect((await list(admin, `?search=%20${'a'.repeat(100)}%20`)).status).toBe(200)
  })

  it('search treats % and _ literally', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: percent } = await seedUser('student', { name: '50% Club', email: 'percent@test.com' })
    const { user: underscore } = await seedUser('student', { name: 'Lab_Tech', email: 'underscore@test.com' })
    const { user: plain } = await seedUser('student', { name: 'Labxtech Plain', email: 'plain@test.com' })
    const { user: slash } = await seedUser('student', { name: 'Back\\slash', email: 'slash@test.com' })
    const percentFine = await seedFineOnLoan(percent.id)
    const underscoreFine = await seedFineOnLoan(underscore.id)
    await seedFineOnLoan(plain.id)
    const slashFine = await seedFineOnLoan(slash.id)

    // A wildcard would match every row; literal text matches only the one that contains it.
    expect(ids(await list(admin, `?search=${encodeURIComponent('%')}`))).toEqual([percentFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('50%')}`))).toEqual([percentFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('_')}`))).toEqual([underscoreFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('lab_tech')}`))).toEqual([underscoreFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('\\')}`))).toEqual([slashFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('back\\slash')}`))).toEqual([slashFine.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('%\\')}`))).toEqual([])
  })

  it('a quote in the search is safe', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: obrien } = await seedUser('student', { name: "Fiona O'Brien", email: 'fiona@test.com' })
    const { user: other } = await seedUser('student', { name: 'Someone Else' })
    const fine = await seedFineOnLoan(obrien.id)
    await seedFineOnLoan(other.id)

    const quoted = await list(admin, `?search=${encodeURIComponent("o'brien")}`)
    const injection = await list(admin, `?search=${encodeURIComponent(`'; DROP TABLE "Fine"; --`)}`)
    const tautology = await list(admin, `?search=${encodeURIComponent("' OR '1'='1")}`)

    expect(quoted.status).toBe(200)
    expect(ids(quoted)).toEqual([fine.id])
    expect(injection.status).toBe(200)
    expect(injection.body.fines).toEqual([])
    expect(tautology.status).toBe(200)
    expect(tautology.body.fines).toEqual([])
    expect(await prisma.fine.count()).toBe(2)
  })

  it('a search of only spaces is ignored', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const first = await seedFineOnLoan(student.id, { createdAt: new Date(Date.now() - 2 * DAY_MS) })
    const second = await seedFineOnLoan(student.id, { createdAt: new Date(Date.now() - DAY_MS) })

    const spaces = await list(admin, '?search=%20%20%20')
    const empty = await list(admin, '?search=')

    expect(ids(spaces)).toEqual([second.id, first.id])
    expect(spaces.body.total).toBe(2)
    expect(ids(empty)).toEqual([second.id, first.id])
  })

  it('pages, and a page past the end returns no rows with the right total', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const now = Date.now()
    // Seven rows, four stored and three accruing, so a page can cross the UNION.
    const seeded: Array<{ id: string; at: number }> = []
    for (let i = 1; i <= 7; i++) {
      const at = now - i * (2 * DAY_MS)
      if (i % 2 === 1) {
        const fine = await seedFineOnLoan(student.id, { createdAt: new Date(at) })
        seeded.push({ id: fine.id, at })
      } else {
        const loan = await seedLoan(student.id, copy.id, new Date(at))
        seeded.push({ id: loan.id, at })
      }
    }
    const newestFirst = seeded.sort((a, b) => b.at - a.at).map((r) => r.id)

    const first = await list(admin, '?pageSize=3')
    const second = await list(admin, '?page=2&pageSize=3')
    const third = await list(admin, '?page=3&pageSize=3')
    const past = await list(admin, '?page=4&pageSize=3')
    const wayPast = await list(admin, '?page=50&pageSize=3')

    expect(ids(first)).toEqual(newestFirst.slice(0, 3))
    expect(first.body).toMatchObject({ total: 7, page: 1, pageSize: 3 })
    expect(ids(second)).toEqual(newestFirst.slice(3, 6))
    expect(second.body).toMatchObject({ total: 7, page: 2, pageSize: 3 })
    expect(ids(third)).toEqual(newestFirst.slice(6))
    expect(third.body.total).toBe(7)
    expect(past.status).toBe(200)
    expect(past.body).toEqual({ fines: [], total: 7, page: 4, pageSize: 3 })
    expect(wayPast.body).toEqual({ fines: [], total: 7, page: 50, pageSize: 3 })
  })

  it('a page past the end keeps the filtered total, and an empty first page has total 0', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao' })
    const { user: other } = await seedUser('student', { name: 'Ben Carter' })
    for (let i = 0; i < 4; i++) await seedFineOnLoan(student.id)
    await seedFineOnLoan(other.id)

    const filtered = await list(admin, '?search=asha&page=3&pageSize=2')
    const empty = await list(admin, '?search=nobody')

    expect(filtered.body).toEqual({ fines: [], total: 4, page: 3, pageSize: 2 })
    expect(empty.body).toEqual({ fines: [], total: 0, page: 1, pageSize: 25 })
  })

  it('rows with the same date page in a stable order, none repeated or skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const createdAt = new Date(Date.now() - DAY_MS)
    for (let i = 0; i < 5; i++) await seedFineOnLoan(student.id, { createdAt })

    const whole = ids(await list(admin, '?pageSize=100'))
    const paged = [
      ...ids(await list(admin, '?page=1&pageSize=2')),
      ...ids(await list(admin, '?page=2&pageSize=2')),
      ...ids(await list(admin, '?page=3&pageSize=2')),
    ]

    expect(whole).toHaveLength(5)
    expect(paged).toEqual(whole)
    expect(new Set(paged).size).toBe(5)
  })

  it('pageSize 101 is 400', async () => {
    const { token: admin } = await seedUser('admin')

    expect((await list(admin, '?pageSize=101')).status).toBe(400)
    expect((await list(admin, '?pageSize=100')).status).toBe(200)
    expect((await list(admin, '?pageSize=0')).status).toBe(400)
    expect((await list(admin, '?page=0')).status).toBe(400)
  })

  it('newest first, with accruing rows ordered by due date', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const now = Date.now()
    const oldFine = await seedFineOnLoan(student.id, { createdAt: new Date(now - 3 * DAY_MS) })
    const newFine = await seedFineOnLoan(student.id, { createdAt: new Date(now - DAY_MS) })
    const lateLoan = await seedLoan(student.id, copy.id, new Date(now - (4 * DAY_MS + HOUR_MS)))
    const recentLoan = await seedLoan(student.id, copy.id, new Date(now - (2 * DAY_MS + HOUR_MS)))

    const res = await list(admin)

    // A due date and a fine's created date are on one timeline.
    expect(ids(res)).toEqual([newFine.id, recentLoan.id, oldFine.id, lateLoan.id])
    expect((res.body.fines as ListedFine[]).map((f) => f.kind)).toEqual(['fine', 'accruing', 'fine', 'accruing'])
  })

  it('a no-show fine names its resource', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201', capacity: 6 } })
    const start = new Date(Date.now() - 3 * DAY_MS)
    const booking = await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: resource.id, startTime: start, endTime: new Date(start.getTime() + HOUR_MS), status: 'no_show' },
    })
    const fine = await seedFine({ userId: student.id, reason: 'no_show', amount: 50, relatedBookingId: booking.id })

    const res = await list(admin)

    expect((res.body.fines as ListedFine[]).map((f) => [f.id, f.reason, f.item, f.amount])).toEqual([[fine.id, 'no_show', 'Group Room 201', 50]])
  })

  it('a lost fine names its book', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { reason: 'lost', amount: 400 }, 'Design Patterns')

    const res = await list(admin)

    expect((res.body.fines as ListedFine[]).map((f) => [f.id, f.reason, f.item, f.amount])).toEqual([[fine.id, 'lost', 'Design Patterns', 400]])
  })

  it('an adjusted fine shows originalAmount, note and the librarian\'s name', async () => {
    const { token: admin, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student } = await seedUser()
    const adjusted = await seedFineOnLoan(student.id, {
      status: 'adjusted',
      amount: 20,
      originalAmount: 60,
      adjustedById: librarian.id,
      adjustReason: 'Book was returned to the wrong desk',
    })

    const res = await list(admin)

    expect(res.body.fines[0]).toMatchObject({
      id: adjusted.id,
      status: 'adjusted',
      amount: 20,
      originalAmount: 60,
      note: 'Book was returned to the wrong desk',
      recordedBy: 'Priya Menon',
    })
  })

  it('a waived fine shows the note and librarian, a paid one the librarian who recorded the payment', async () => {
    const { token: admin, user: priya } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: sam } = await seedUser('admin', { name: 'Sam Verma' })
    const { user: student } = await seedUser()
    const waived = await seedFineOnLoan(student.id, {
      status: 'waived',
      amount: 0,
      originalAmount: 40,
      adjustedById: priya.id,
      adjustReason: 'Library error',
    })
    // Adjusted by Priya, then paid at Sam's desk: the payment is Sam's, and the
    // note is for adjusted and waived fines only.
    const paid = await seedFineOnLoan(student.id, {
      status: 'paid',
      amount: 20,
      originalAmount: 60,
      adjustedById: priya.id,
      adjustReason: 'Hardship',
      paidRecordedById: sam.id,
    })
    const paidPlain = await seedFineOnLoan(student.id, { status: 'paid', paidRecordedById: priya.id })

    const res = await list(admin)

    const byId = new Map((res.body.fines as ListedFine[]).map((f) => [f.id, f]))
    expect(byId.get(waived.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 40, note: 'Library error', recordedBy: 'Priya Menon' })
    expect(byId.get(paid.id)).toMatchObject({ status: 'paid', amount: 20, originalAmount: 60, note: null, recordedBy: 'Sam Verma' })
    expect(byId.get(paidPlain.id)).toMatchObject({ status: 'paid', originalAmount: 20, note: null, recordedBy: 'Priya Menon' })
  })

  it('recordedBy is null when the librarian account was removed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: gone } = await seedUser('admin', { name: 'Former Librarian' })
    const { user: student } = await seedUser()
    const adjusted = await seedFineOnLoan(student.id, {
      status: 'adjusted',
      amount: 20,
      originalAmount: 60,
      adjustedById: gone.id,
      adjustReason: 'Hardship',
    })
    await prisma.user.delete({ where: { id: gone.id } })

    const res = await list(admin)

    expect(res.body.fines[0]).toMatchObject({ id: adjusted.id, note: 'Hardship', recordedBy: null })
  })

  it('canSettle only for outstanding and adjusted', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    await seedLoan(student.id, copy.id, new Date(Date.now() - 2 * DAY_MS - HOUR_MS))
    await seedFineOnLoan(student.id, { status: 'pending' })
    await seedFineOnLoan(student.id, { status: 'adjusted', amount: 10, originalAmount: 40, adjustedById: librarian.id, adjustReason: 'x' })
    await seedFineOnLoan(student.id, { status: 'paid' })
    await seedFineOnLoan(student.id, { status: 'waived', amount: 0, originalAmount: 40, adjustedById: librarian.id, adjustReason: 'x' })

    const res = await list(admin)

    const settle = Object.fromEntries((res.body.fines as ListedFine[]).map((f) => [f.status, f.canSettle]))
    expect(settle).toEqual({ accruing: false, outstanding: true, adjusted: true, paid: false, waived: false })
  })
})

describe('listFinesForStudent', () => {
  beforeEach(resetDb)

  it('returns only that student\'s rows, accruing ones included, newest first and capped at the limit', async () => {
    const { user: asha } = await seedUser('student', { name: 'Asha Rao' })
    const { user: ben } = await seedUser('student', { name: 'Ben Carter' })
    const { copy } = await seedBook('Clean Code')
    const now = new Date()
    const t = now.getTime()
    const newest = await seedFineOnLoan(asha.id, { createdAt: new Date(t - DAY_MS) })
    const accruing = await seedLoan(asha.id, copy.id, new Date(t - (2 * DAY_MS + HOUR_MS)))
    const oldest = await seedFineOnLoan(asha.id, { createdAt: new Date(t - 5 * DAY_MS) })
    await seedFineOnLoan(ben.id, { createdAt: new Date(t - 2 * HOUR_MS) })
    const { copy: benCopy } = await seedBook('Refactoring')
    await seedLoan(ben.id, benCopy.id, new Date(t - (3 * DAY_MS + HOUR_MS)))

    const all = await listFinesForStudent(asha.id, 50, now)
    const capped = await listFinesForStudent(asha.id, 2, now)
    const nobody = await listFinesForStudent('no-such-user', 50, now)

    expect(all.map((f) => [f.id, f.kind, f.student.name])).toEqual([
      [newest.id, 'fine', 'Asha Rao'],
      [accruing.id, 'accruing', 'Asha Rao'],
      [oldest.id, 'fine', 'Asha Rao'],
    ])
    expect(all[1]).toMatchObject({ status: 'accruing', amount: 20, item: 'Clean Code', date: new Date(t - (2 * DAY_MS + HOUR_MS)) })
    expect(capped.map((f) => f.id)).toEqual([newest.id, accruing.id])
    expect(nobody).toEqual([])
  })
})

// --- Mark paid, waive or adjust ------------------------------------------------------

const FINE_CHANGED = { type: 'fine.changed', topics: ['fines'] }
// The body is the amount the librarian saw and collected; the write refuses if the fine has moved off it.
const pay = (token: string, id: string, body?: unknown) => {
  const req = request(app).post(`/admin/fines/${id}/paid`).set(auth(token))
  return body === undefined ? req : req.send(body as object)
}
const adjust = (token: string, id: string, body?: unknown) => {
  const req = request(app).post(`/admin/fines/${id}/adjust`).set(auth(token))
  return body === undefined ? req : req.send(body as object)
}
const stored = (id: string) => prisma.fine.findUniqueOrThrow({ where: { id } })

describe('mark a fine paid and waive or adjust it: access', () => {
  beforeEach(resetDb)

  it('401/403 on both routes', async () => {
    const { token: student } = await seedUser()
    const { user: owner } = await seedUser()
    const fine = await seedFineOnLoan(owner.id, { amount: 150 })
    const payUrl = `/admin/fines/${fine.id}/paid`
    const adjustUrl = `/admin/fines/${fine.id}/adjust`
    const body = { amount: 50, reason: 'Hardship' }

    expect((await request(app).post(payUrl).send({ amount: 150 })).status).toBe(401)
    expect((await request(app).post(adjustUrl).send(body)).status).toBe(401)
    expect((await request(app).post(payUrl).set('Authorization', 'Bearer not-a-token').send({ amount: 150 })).status).toBe(401)
    expect((await pay(student, fine.id, { amount: 150 })).status).toBe(403)
    expect((await adjust(student, fine.id, body)).status).toBe(403)
    // None of those touched the fine.
    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, paidAt: null, adjustedAt: null })
  })
})

describe('mark a fine paid', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('marks an outstanding fine paid and records who and when', async () => {
    const { token, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const fine = await seedFineOnLoan(student.id, { amount: 150 }, 'Refactoring')
    const before = new Date()

    const res = await pay(token, fine.id, { amount: 150 })

    const after = new Date()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: fine.id,
      kind: 'fine',
      student: { id: student.id, name: 'Asha Rao', email: 'asha@test.com' },
      reason: 'overdue',
      item: 'Refactoring',
      amount: 150,
      originalAmount: 150,
      status: 'paid',
      date: fine.createdAt.toISOString(),
      note: null,
      recordedBy: 'Priya Menon',
      canSettle: false,
    })
    const row = await stored(fine.id)
    expect(row).toMatchObject({ status: 'paid', paidRecordedById: librarian.id, amount: 150, originalAmount: null, adjustedById: null })
    expect(row.paidAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(row.paidAt!.getTime()).toBeLessThanOrEqual(after.getTime())
    // What the console would list for it is exactly what the write returned.
    const listed = await list(token, '?status=paid')
    expect(listed.body.fines).toEqual([res.body])
  })

  it('marks an adjusted fine paid', async () => {
    const { user: priya } = await seedUser('admin', { name: 'Priya Menon' })
    const { token: samToken, user: sam } = await seedUser('admin', { name: 'Sam Verma' })
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, {
      status: 'adjusted',
      amount: 50,
      originalAmount: 150,
      adjustedById: priya.id,
      adjustReason: 'Hardship',
    })

    const res = await pay(samToken, fine.id, { amount: 50 })

    expect(res.status).toBe(200)
    // Paid at the lowered amount; the payment is Sam's and the adjustment's note is not shown on a paid fine.
    expect(res.body).toMatchObject({ status: 'paid', amount: 50, originalAmount: 150, note: null, recordedBy: 'Sam Verma', canSettle: false })
    expect(await stored(fine.id)).toMatchObject({
      status: 'paid',
      amount: 50,
      originalAmount: 150,
      adjustedById: priya.id,
      adjustReason: 'Hardship',
      paidRecordedById: sam.id,
    })
  })

  it('paying a paid fine is 409 "This fine is already paid."', async () => {
    const { user: first } = await seedUser('admin', { name: 'Priya Menon' })
    const { token: secondToken } = await seedUser('admin', { name: 'Sam Verma' })
    const { user: student } = await seedUser()
    const paidAt = new Date(Date.now() - DAY_MS)
    const fine = await seedFineOnLoan(student.id, { status: 'paid', paidRecordedById: first.id })
    await prisma.fine.update({ where: { id: fine.id }, data: { paidAt } })

    const res = await pay(secondToken, fine.id, { amount: 20 })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine is already paid.')
    // The first payment's record is untouched.
    expect(await stored(fine.id)).toMatchObject({ status: 'paid', paidRecordedById: first.id, paidAt })
  })

  it('paying a waived fine is 409 "This fine was waived."', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, {
      status: 'waived',
      amount: 0,
      originalAmount: 40,
      adjustedById: librarian.id,
      adjustReason: 'Library error',
    })

    const res = await pay(token, fine.id, { amount: 0 })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine was waived.')
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', paidAt: null, paidRecordedById: null })
  })

  it('paying with the amount shown succeeds', async () => {
    const { token: priyaToken } = await seedUser('admin')
    const { token: samToken, user: sam } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    // The console shows ₹150; after a librarian lowers it the console shows ₹50, and paying that works.
    const adjusted = await adjust(priyaToken, fine.id, { amount: 50, reason: 'Hardship' })
    const res = await pay(samToken, fine.id, { amount: adjusted.body.amount })

    expect(adjusted.body.amount).toBe(50)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'paid', amount: 50, originalAmount: 150 })
    expect(await stored(fine.id)).toMatchObject({ status: 'paid', amount: 50, paidRecordedById: sam.id })
  })

  it('paying with a stale amount after a partial adjust is 409 with the changed message and the fine stays adjusted', async () => {
    const { token: priyaToken, user: priya } = await seedUser('admin')
    const { token: samToken } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })
    await adjust(priyaToken, fine.id, { amount: 50, reason: 'Hardship' })
    recorder = recordEvents()

    // Sam's console still shows ₹150 and he collected ₹150.
    const res = await pay(samToken, fine.id, { amount: 150 })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine was just changed to ₹50. Check it before marking it paid.')
    expect(await stored(fine.id)).toMatchObject({
      status: 'adjusted',
      amount: 50,
      originalAmount: 150,
      adjustedById: priya.id,
      paidAt: null,
      paidRecordedById: null,
    })
    expect(recorder.events).toEqual([])
  })

  it('a lower amount than the fine has is just as stale', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    const lower = await pay(token, fine.id, { amount: 149 })
    const zero = await pay(token, fine.id, { amount: 0 })

    expect(lower.status).toBe(409)
    expect(lower.body.error).toBe('This fine was just changed to ₹150. Check it before marking it paid.')
    expect(zero.status).toBe(409)
    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, paidAt: null })
  })

  it('a paid or waived fine says so even when the amount sent is stale', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const paid = await seedFineOnLoan(student.id, { status: 'paid', amount: 20, originalAmount: 60, paidRecordedById: librarian.id })
    const waived = await seedFineOnLoan(student.id, { status: 'waived', amount: 0, originalAmount: 40, adjustedById: librarian.id, adjustReason: 'x' })

    const paidRes = await pay(token, paid.id, { amount: 60 })
    const waivedRes = await pay(token, waived.id, { amount: 40 })

    expect(paidRes.status).toBe(409)
    expect(paidRes.body.error).toBe('This fine is already paid.')
    expect(waivedRes.status).toBe(409)
    expect(waivedRes.body.error).toBe('This fine was waived.')
  })

  it('paying without an amount, or with a negative, fractional or text amount, is 400', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })
    const invalid: Array<[string, unknown]> = [
      ['no body', undefined],
      ['an empty body', {}],
      ['a negative amount', { amount: -1 }],
      ['a fractional amount', { amount: 149.5 }],
      ['an amount as text', { amount: '150' }],
      ['a null amount', { amount: null }],
    ]
    recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await pay(token, fine.id, body)
      expect(res.status, what).toBe(400)
    }

    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, paidAt: null, paidRecordedById: null })
    expect(recorder.events).toEqual([])
  })

  it("an accruing row's id answers 404", async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const loan = await seedLoan(student.id, copy.id, new Date(Date.now() - 3 * DAY_MS - HOUR_MS))
    // The row is on the list, with the loan's id...
    expect(ids(await list(token))).toEqual([loan.id])

    const byLoanId = await pay(token, loan.id, { amount: 30 })
    const unknown = await pay(token, 'no-such-fine', { amount: 30 })

    // ...but that is not a fine id.
    expect(byLoanId.status).toBe(404)
    expect(byLoanId.body.error).toBe('Fine not found')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Fine not found')
  })

  it('each success publishes fine.changed once, refusals publish nothing', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 90 })
    const waived = await seedFineOnLoan(student.id, { status: 'waived', amount: 0, originalAmount: 10, adjustedById: librarian.id, adjustReason: 'x' })
    recorder = recordEvents()

    await pay(studentToken, fine.id, { amount: 90 }) // 403
    await pay(token, 'no-such-fine', { amount: 90 }) // 404
    await pay(token, waived.id, { amount: 0 }) // 409
    await pay(token, fine.id, { amount: 80 }) // 409, the fine is ₹90
    await pay(token, fine.id) // 400, no amount
    expect(recorder.events).toEqual([])

    expect((await pay(token, fine.id, { amount: 90 })).status).toBe(200)
    expect(recorder.events).toEqual([FINE_CHANGED])

    expect((await pay(token, fine.id, { amount: 90 })).status).toBe(409) // already paid
    expect(recorder.events).toEqual([FINE_CHANGED])
  })
})

describe('waive or adjust a fine', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('adjust to a lower amount sets adjusted, keeps originalAmount, note and librarian', async () => {
    const { token, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const fine = await seedFineOnLoan(student.id, { amount: 150 }, 'Refactoring')
    const before = new Date()

    // Spaces around the reason are not kept.
    const res = await adjust(token, fine.id, { amount: 50, reason: '  Hardship  ' })

    const after = new Date()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: fine.id,
      kind: 'fine',
      student: { id: student.id, name: 'Asha Rao', email: 'asha@test.com' },
      reason: 'overdue',
      item: 'Refactoring',
      amount: 50,
      originalAmount: 150,
      status: 'adjusted',
      date: fine.createdAt.toISOString(),
      note: 'Hardship',
      recordedBy: 'Priya Menon',
      canSettle: true,
    })
    const row = await stored(fine.id)
    expect(row).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: librarian.id, adjustReason: 'Hardship', paidAt: null })
    expect(row.adjustedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(row.adjustedAt!.getTime()).toBeLessThanOrEqual(after.getTime())
    const listed = await list(token, '?status=adjusted')
    expect(listed.body.fines).toEqual([res.body])
  })

  it('adjust to 0 waives', async () => {
    const { token, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    const res = await adjust(token, fine.id, { amount: 0, reason: 'Library error' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'waived', amount: 0, originalAmount: 150, note: 'Library error', recordedBy: 'Priya Menon', canSettle: false })
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 150, adjustedById: librarian.id, adjustReason: 'Library error' })
  })

  it('a second adjust keeps the first originalAmount', async () => {
    const { token: firstToken, user: first } = await seedUser('admin', { name: 'Priya Menon' })
    const { token: secondToken, user: second } = await seedUser('admin', { name: 'Sam Verma' })
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    const one = await adjust(firstToken, fine.id, { amount: 100, reason: 'First reason' })
    const afterFirst = await stored(fine.id)
    const two = await adjust(secondToken, fine.id, { amount: 40, reason: 'Second reason' })

    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ status: 'adjusted', amount: 100, originalAmount: 150 })
    expect(two.status).toBe(200)
    // The original is the amount before the FIRST adjustment; the note and librarian are the latest.
    expect(two.body).toMatchObject({ status: 'adjusted', amount: 40, originalAmount: 150, note: 'Second reason', recordedBy: 'Sam Verma' })
    const row = await stored(fine.id)
    expect(row).toMatchObject({ amount: 40, originalAmount: 150, adjustedById: second.id, adjustReason: 'Second reason' })
    expect(afterFirst.adjustedById).toBe(first.id)
    expect(row.adjustedAt!.getTime()).toBeGreaterThanOrEqual(afterFirst.adjustedAt!.getTime())
  })

  it('an adjusted fine can be waived', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    await adjust(token, fine.id, { amount: 60, reason: 'Hardship' })
    const res = await adjust(token, fine.id, { amount: 0, reason: 'Waived after talking to the student' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'waived', amount: 0, originalAmount: 150, note: 'Waived after talking to the student' })
  })

  it('adjust to the same or a higher amount is 400 "The new amount must be lower than ₹150."', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })

    // The last two are far past a 32-bit integer: a 400, never a database overflow (a 500).
    for (const amount of [150, 151, 1_000_000, 10_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const res = await adjust(token, fine.id, { amount, reason: 'Hardship' })
      expect(res.status, `amount ${amount}`).toBe(400)
      expect(res.body.error, `amount ${amount}`).toBe('The new amount must be lower than ₹150.')
    }
    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, adjustedAt: null, adjustedById: null, adjustReason: null })

    // Once lowered, the bar is the new amount.
    await adjust(token, fine.id, { amount: 100, reason: 'Hardship' })
    const same = await adjust(token, fine.id, { amount: 100, reason: 'Again' })
    const higher = await adjust(token, fine.id, { amount: 120, reason: 'Again' })
    expect(same.status).toBe(400)
    expect(same.body.error).toBe('The new amount must be lower than ₹100.')
    expect(higher.status).toBe(400)
    expect(higher.body.error).toBe('The new amount must be lower than ₹100.')
    expect(await stored(fine.id)).toMatchObject({ amount: 100, originalAmount: 150, adjustReason: 'Hardship' })
  })

  it('adjust without a reason, with a blank reason, a 301-character reason, a negative or a fractional amount is 400', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })
    const invalid: Array<[string, unknown]> = [
      ['no reason', { amount: 50 }],
      ['an empty reason', { amount: 50, reason: '' }],
      ['a blank reason', { amount: 50, reason: '   ' }],
      ['a 301-character reason', { amount: 50, reason: 'a'.repeat(301) }],
      ['a reason that is not text', { amount: 50, reason: 7 }],
      ['a negative amount', { amount: -1, reason: 'Hardship' }],
      ['a fractional amount', { amount: 49.5, reason: 'Hardship' }],
      ['an amount as text', { amount: '50', reason: 'Hardship' }],
      ['no amount', { reason: 'Hardship' }],
      ['no body', undefined],
    ]
    recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await adjust(token, fine.id, body)
      expect(res.status, what).toBe(400)
    }

    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, adjustedById: null, adjustReason: null })
    expect(recorder.events).toEqual([])
  })

  it('a reason of exactly 300 characters is accepted, spaces around it do not count', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })
    const reason = 'a'.repeat(300)

    const res = await adjust(token, fine.id, { amount: 50, reason: `  ${reason}  ` })

    expect(res.status).toBe(200)
    expect(res.body.note).toBe(reason)
  })

  it('adjusting a paid fine is 409 "This fine is already paid."', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { status: 'paid', amount: 150, paidRecordedById: librarian.id })

    const res = await adjust(token, fine.id, { amount: 50, reason: 'Too late' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine is already paid.')
    expect(await stored(fine.id)).toMatchObject({ status: 'paid', amount: 150, originalAmount: null, adjustedById: null })
  })

  it('adjusting a waived fine is 409 "This fine was waived."', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { status: 'waived', amount: 0, originalAmount: 40, adjustedById: librarian.id, adjustReason: 'Library error' })

    const res = await adjust(token, fine.id, { amount: 0, reason: 'Again' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine was waived.')
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 40, adjustReason: 'Library error' })
  })

  it("an accruing row's id answers 404", async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy } = await seedBook()
    const loan = await seedLoan(student.id, copy.id, new Date(Date.now() - 3 * DAY_MS - HOUR_MS))
    expect(ids(await list(token))).toEqual([loan.id])

    const byLoanId = await adjust(token, loan.id, { amount: 0, reason: 'Waive it' })
    const unknown = await adjust(token, 'no-such-fine', { amount: 0, reason: 'Waive it' })

    expect(byLoanId.status).toBe(404)
    expect(byLoanId.body.error).toBe('Fine not found')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Fine not found')
  })

  it('each success publishes fine.changed once, refusals publish nothing', async () => {
    const { token, user: librarian } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()
    const fine = await seedFineOnLoan(student.id, { amount: 150 })
    const paid = await seedFineOnLoan(student.id, { status: 'paid', amount: 20, paidRecordedById: librarian.id })
    recorder = recordEvents()

    await adjust(studentToken, fine.id, { amount: 50, reason: 'x' }) // 403
    await adjust(token, 'no-such-fine', { amount: 50, reason: 'x' }) // 404
    await adjust(token, fine.id, { amount: 150, reason: 'x' }) // 400, not lower
    await adjust(token, fine.id, { amount: 50 }) // 400, no reason
    await adjust(token, paid.id, { amount: 5, reason: 'x' }) // 409
    expect(recorder.events).toEqual([])

    expect((await adjust(token, fine.id, { amount: 50, reason: 'Hardship' })).status).toBe(200)
    expect(recorder.events).toEqual([FINE_CHANGED])
    expect((await adjust(token, fine.id, { amount: 0, reason: 'Waive' })).status).toBe(200)
    expect(recorder.events).toEqual([FINE_CHANGED, FINE_CHANGED])
    expect((await adjust(token, fine.id, { amount: 0, reason: 'Again' })).status).toBe(409) // waived
    expect(recorder.events).toEqual([FINE_CHANGED, FINE_CHANGED])
  })
})
