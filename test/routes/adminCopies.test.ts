import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { CopyStatus, Prisma } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { restoreCopy } from '../../src/services/adminCopyService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const NOW_ON_LOAN = 'This copy is now on loan.'
const ON_LOAN = 'This copy is on loan.'
const ALREADY_IN_MAINTENANCE = 'This copy is already in maintenance.'
const ALREADY_LOST = 'This copy is already lost.'
const ALREADY_AVAILABLE = 'This copy is already available.'
const HELD = 'This copy is held for a borrow request.'
const WAITLIST = 'This copy is set aside for a student on the waitlist.'
const NO_LONGER_ON_LOAN = 'This copy is no longer on loan.'
const BORROWER_CHANGED = "This copy's borrower has changed. Check it before marking it lost."
const CHARGE_REQUIRED = 'Enter a replacement charge for the copy on loan.'
const BORROWER_REQUIRED = 'Name the borrower of the copy on loan.'
const RETURNED_AFTER_LOST = 'Book returned after it was marked lost'
/** Three whole days past due, so ₹30 owed so far. */
const THREE_DAYS_LATE = -(3 * DAY_MS + HOUR_MS)

async function seedUser(role: 'student' | 'admin' = 'student', name = `${role} ${Math.random()}`) {
  const user = await prisma.user.create({
    data: { name, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

function seedBook(title: string) {
  return prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title, author: 'Some Author', genre: 'Fiction' },
  })
}

// One at a time, so the database hands out barcodes in the order the copies are made.
function seedCopy(bookId: string, status: CopyStatus = 'available') {
  return prisma.bookCopy.create({ data: { bookId, status } })
}

// A copy out on loan to the student, borrowed three weeks ago and due `dueInMs` from now (negative: past due).
async function seedOnLoan(bookId: string, userId: string, dueInMs: number) {
  const copy = await seedCopy(bookId, 'borrowed')
  const loan = await prisma.loan.create({
    data: { userId, bookCopyId: copy.id, borrowedAt: new Date(Date.now() - 21 * DAY_MS), dueAt: new Date(Date.now() + dueInMs) },
  })
  return { copy, loan }
}

// A student waiting for this title, with a claim that runs out `claimEndsInMs` from now.
function seedClaim(userId: string, bookId: string, claimEndsInMs: number) {
  return prisma.reservation.create({
    data: {
      userId,
      bookId,
      status: 'fulfilled',
      requestedAt: new Date(Date.now() - 2 * DAY_MS),
      claimExpiresAt: new Date(Date.now() + claimEndsInMs),
    },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const maintenance = (token: string, copyId: string) => request(app).post(`/admin/copies/${copyId}/maintenance`).set(auth(token))
const lost = (token: string, copyId: string, body: object = {}) =>
  request(app).post(`/admin/copies/${copyId}/lost`).set(auth(token)).send(body)
const restore = (token: string, copyId: string, body: object = {}) =>
  request(app).post(`/admin/copies/${copyId}/restore`).set(auth(token)).send(body)
const payFine = (token: string, fineId: string, amount: number) =>
  request(app).post(`/admin/fines/${fineId}/paid`).set(auth(token)).send({ amount })
const adjustFine = (token: string, fineId: string, amount: number, reason: string) =>
  request(app).post(`/admin/fines/${fineId}/adjust`).set(auth(token)).send({ amount, reason })

function withToken(req: request.Test, token?: string): request.Test {
  return token ? req.set(auth(token)) : req
}

interface ListedCopy {
  id: string
  barcode: string
  status: string
  borrower: { id: string; name: string } | null
  dueAt: string | null
  owedReplacement: { fineId: string; amount: number; student: { id: string; name: string } } | null
}

interface ListedBook {
  id: string
  totalCopies: number
  availableCopies: number
  copies: ListedCopy[]
}

// A race needs both requests to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

const statusOf = (copyId: string) => prisma.bookCopy.findUniqueOrThrow({ where: { id: copyId } }).then((c) => c.status)
const copyIn = (book: ListedBook, copyId: string) => book.copies.find((c) => c.id === copyId)!

async function studentView(bookId: string) {
  const res = await request(app).get(`/books/${bookId}`)
  expect(res.status).toBe(200)
  return res.body as { totalCopies: number; availableCopies: number }
}

/** The book as the librarian's Catalogue lists it now. */
async function listedBook(token: string, bookId: string): Promise<ListedBook> {
  const res = await request(app).get('/admin/books').set(auth(token)).query({ pageSize: 100 })
  expect(res.status).toBe(200)
  return (res.body.books as ListedBook[]).find((b) => b.id === bookId)!
}

const loanOf = (id: string) => prisma.loan.findUniqueOrThrow({ where: { id } })
const lostFineOf = (loanId: string) => prisma.fine.findFirstOrThrow({ where: { relatedLoanId: loanId, reason: 'lost' } })

/** The loan's fines as reason, amount, status and owner, in reason order. */
async function finesOf(loanId: string) {
  const fines = await prisma.fine.findMany({ where: { relatedLoanId: loanId } })
  return fines
    .map((f) => ({ reason: f.reason, amount: f.amount, status: f.status, userId: f.userId }))
    .sort((a, b) => a.reason.localeCompare(b.reason))
}

describe('admin copy actions', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
    vi.restoreAllMocks()
  })

  it('is for admins only on all three routes', async () => {
    const { token: student } = await seedUser()
    const book = await seedBook('Dune')
    const copy = await seedCopy(book.id)
    const calls: Array<(token?: string) => request.Test> = [
      (token) => withToken(request(app).post(`/admin/copies/${copy.id}/maintenance`), token),
      (token) => withToken(request(app).post(`/admin/copies/${copy.id}/lost`), token).send({}),
      (token) => withToken(request(app).post(`/admin/copies/${copy.id}/restore`), token).send({}),
    ]

    for (const call of calls) {
      expect((await call()).status).toBe(401)
      expect((await call(student)).status).toBe(403)
    }
    expect(await statusOf(copy.id)).toBe('available')
  })

  it('an unknown copy is 404 Copy not found on all three routes', async () => {
    const { token: admin } = await seedUser('admin')
    recorder = recordEvents()

    for (const res of [
      await maintenance(admin, 'no-such-copy'),
      await lost(admin, 'no-such-copy'),
      await restore(admin, 'no-such-copy'),
    ]) {
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Copy not found' })
    }
    expect(recorder.events).toEqual([])
  })

  describe('maintenance', () => {
    it('takes an available copy out of service and answers the book as the console lists it', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const first = await seedCopy(book.id)
      const second = await seedCopy(book.id)

      const res = await maintenance(admin, first.id)

      expect(res.status).toBe(200)
      const body = res.body as ListedBook
      expect(body.id).toBe(book.id)
      expect(copyIn(body, first.id).status).toBe('maintenance')
      expect(copyIn(body, second.id).status).toBe('available')
      expect(body.availableCopies).toBe(1)
      expect(body.totalCopies).toBe(2)
      expect(await statusOf(first.id)).toBe('maintenance')
    })

    it('refuses a copy that is on loan, in maintenance, lost or held, with the message for its status', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const onLoan = await seedCopy(book.id, 'borrowed')
      await prisma.loan.create({ data: { userId: student.id, bookCopyId: onLoan.id, dueAt: new Date(Date.now() + DAY_MS) } })
      const inMaintenance = await seedCopy(book.id, 'maintenance')
      const gone = await seedCopy(book.id, 'lost')
      const held = await seedCopy(book.id, 'requested')

      const cases: Array<[string, CopyStatus, string]> = [
        [onLoan.id, 'borrowed', NOW_ON_LOAN],
        [inMaintenance.id, 'maintenance', ALREADY_IN_MAINTENANCE],
        [gone.id, 'lost', ALREADY_LOST],
        [held.id, 'requested', HELD],
      ]
      for (const [copyId, status, message] of cases) {
        const res = await maintenance(admin, copyId)
        expect(res.status, message).toBe(409)
        expect(res.body, message).toEqual({ error: message })
        expect(await statusOf(copyId)).toBe(status)
      }
    })

    it('refuses a borrowed copy that has no loan too: it is out, so it is not on the shelf', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'borrowed')

      const res = await maintenance(admin, copy.id)

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: NOW_ON_LOAN })
      expect(await statusOf(copy.id)).toBe('borrowed')
    })
  })

  describe('lost from the shelf', () => {
    it('marks an available copy and a copy in maintenance lost', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const onShelf = await seedCopy(book.id)
      const inMaintenance = await seedCopy(book.id, 'maintenance')

      const first = await lost(admin, onShelf.id)
      expect(first.status).toBe(200)
      expect(copyIn(first.body as ListedBook, onShelf.id).status).toBe('lost')
      expect(await statusOf(onShelf.id)).toBe('lost')

      const second = await lost(admin, inMaintenance.id, { replacementCharge: 300 })
      expect(second.status).toBe(200)
      expect(copyIn(second.body as ListedBook, inMaintenance.id).status).toBe('lost')
      expect(await statusOf(inMaintenance.id)).toBe('lost')
      // From the shelf there is nobody to charge, whatever the body says.
      expect(await prisma.fine.count()).toBe(0)
    })

    it('refuses a copy that is already lost or held, with the message for its status', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const gone = await seedCopy(book.id, 'lost')
      const held = await seedCopy(book.id, 'requested')

      const alreadyLost = await lost(admin, gone.id)
      expect(alreadyLost.status).toBe(409)
      expect(alreadyLost.body).toEqual({ error: ALREADY_LOST })

      const isHeld = await lost(admin, held.id)
      expect(isHeld.status).toBe(409)
      expect(isHeld.body).toEqual({ error: HELD })

      expect(await statusOf(gone.id)).toBe('lost')
      expect(await statusOf(held.id)).toBe('requested')
    })

    it('a borrowed copy with no loan can be marked lost, with no fines', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'borrowed')

      const res = await lost(admin, copy.id)

      expect(res.status).toBe(200)
      expect(copyIn(res.body as ListedBook, copy.id).status).toBe('lost')
      expect(await statusOf(copy.id)).toBe('lost')
      expect(await prisma.fine.count()).toBe(0)
    })

    it('accepts a replacement charge of 0 and 10000 and an empty body, and rejects anything else', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id)

      for (const body of [
        { replacementCharge: -1 },
        { replacementCharge: 10001 },
        { replacementCharge: 1.5 },
        { replacementCharge: '5' },
        { replacementCharge: 100, borrowerId: '' },
        { replacementCharge: 100, borrowerId: 5 },
      ]) {
        expect((await lost(admin, copy.id, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(await statusOf(copy.id)).toBe('available')

      const none = await seedCopy(book.id)
      const edge = await seedCopy(book.id)
      const bare = await seedCopy(book.id)
      expect((await lost(admin, none.id, { replacementCharge: 0 })).status).toBe(200)
      expect((await lost(admin, edge.id, { replacementCharge: 10000 })).status).toBe(200)
      expect((await request(app).post(`/admin/copies/${bare.id}/lost`).set(auth(admin))).status).toBe(200)
    })
  })

  describe('lost while on loan', () => {
    it('losing an on-loan copy closes the loan, writes an overdue fine and a lost fine, and marks the copy lost', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      await seedCopy(book.id)
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)
      const before = Date.now()

      const res = await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })

      expect(res.status).toBe(200)
      const body = res.body as ListedBook
      expect(copyIn(body, copy.id)).toMatchObject({ status: 'lost', borrower: null, dueAt: null })
      // Gone from what students count; the shelf copy is untouched.
      expect(body.totalCopies).toBe(1)
      expect(body.availableCopies).toBe(1)
      expect(await statusOf(copy.id)).toBe('lost')

      // The loan is closed as lost: not returned.
      const closed = await loanOf(loan.id)
      expect(closed.status).toBe('lost')
      expect(closed.returnedAt).toBeNull()
      expect(closed.lostAt!.getTime()).toBeGreaterThanOrEqual(before)
      expect(closed.lostAt!.getTime()).toBeLessThanOrEqual(Date.now())

      // The three days so far, and the replacement, both the borrower's and both for this loan.
      expect(await finesOf(loan.id)).toEqual([
        { reason: 'lost', amount: 400, status: 'pending', userId: student.id },
        { reason: 'overdue', amount: 30, status: 'pending', userId: student.id },
      ])
    })

    it('a replacement charge of 0 writes no lost fine', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)

      const res = await lost(admin, copy.id, { replacementCharge: 0, borrowerId: student.id })

      expect(res.status).toBe(200)
      expect(copyIn(res.body as ListedBook, copy.id)).toMatchObject({ status: 'lost', owedReplacement: null })
      expect((await loanOf(loan.id)).status).toBe('lost')
      expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: 30, status: 'pending', userId: student.id }])
    })

    it('an on-time loan writes no overdue fine', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      // Past due by less than a day: nothing owed yet, as on a late return.
      const { copy: late, loan: lateLoan } = await seedOnLoan(book.id, student.id, -2 * HOUR_MS)
      const { copy: early, loan: earlyLoan } = await seedOnLoan(book.id, student.id, 5 * DAY_MS)

      expect((await lost(admin, late.id, { replacementCharge: 250, borrowerId: student.id })).status).toBe(200)
      expect((await lost(admin, early.id, { replacementCharge: 250, borrowerId: student.id })).status).toBe(200)

      for (const loan of [lateLoan, earlyLoan]) {
        expect((await loanOf(loan.id)).status).toBe('lost')
        expect(await finesOf(loan.id)).toEqual([{ reason: 'lost', amount: 250, status: 'pending', userId: student.id }])
      }
    })

    it('a missing replacement charge, with the borrower named, is 400 with the message', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)
      recorder = recordEvents()

      const res = await lost(admin, copy.id, { borrowerId: student.id })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: CHARGE_REQUIRED })
      expect(await statusOf(copy.id)).toBe('borrowed')
      expect((await loanOf(loan.id)).status).toBe('active')
      expect(await prisma.fine.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })

    it('an empty body for a copy that went out on loan since the shelf view is 409 now on loan, not a dead-end 400', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      // The shelf dialog (no charge or borrower field) was opened on an available copy; a student has taken it since.
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)
      recorder = recordEvents()

      const res = await lost(admin, copy.id, {})

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: NOW_ON_LOAN })
      expect(await statusOf(copy.id)).toBe('borrowed')
      expect((await loanOf(loan.id)).status).toBe('active')
      expect(await prisma.fine.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })

    it('a missing borrowerId for an on-loan copy is 400', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)
      recorder = recordEvents()

      const res = await lost(admin, copy.id, { replacementCharge: 300 })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: BORROWER_REQUIRED })
      expect(await statusOf(copy.id)).toBe('borrowed')
      expect((await loanOf(loan.id)).status).toBe('active')
      expect(await prisma.fine.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })

    it("losing an on-loan copy with another student's id is 409 with the borrower-changed message and changes nothing", async () => {
      const { token: admin } = await seedUser('admin')
      const { user: seen } = await seedUser('student', 'Asha Rao')
      const { user: holder } = await seedUser('student', 'Ravi Kumar')
      const book = await seedBook('Dune')
      // The librarian's dialog showed Asha; Ravi has the copy now.
      const { copy, loan } = await seedOnLoan(book.id, holder.id, THREE_DAYS_LATE)
      recorder = recordEvents()

      const res = await lost(admin, copy.id, { replacementCharge: 400, borrowerId: seen.id })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: BORROWER_CHANGED })
      expect(await statusOf(copy.id)).toBe('borrowed')
      expect((await loanOf(loan.id)).status).toBe('active')
      expect(await prisma.fine.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })

    it('a copy returned since the librarian looked is 409 no longer on loan and stays on the shelf', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id)
      await prisma.loan.create({
        data: { userId: student.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - DAY_MS), status: 'returned', returnedAt: new Date() },
      })
      recorder = recordEvents()

      const res = await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: NO_LONGER_ON_LOAN })
      expect(await statusOf(copy.id)).toBe('available')
      expect(await prisma.fine.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })

    it('owedReplacement is set on the lost copy and cleared once the fine is paid', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy, loan } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)

      const res = await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })

      expect(res.status).toBe(200)
      const fine = await lostFineOf(loan.id)
      const owed = { fineId: fine.id, amount: 400, student: { id: student.id, name: 'Asha Rao' } }
      expect(copyIn(res.body as ListedBook, copy.id).owedReplacement).toEqual(owed)
      expect(copyIn(await listedBook(admin, book.id), copy.id).owedReplacement).toEqual(owed)

      // Lowered, it is still owed, at the new amount.
      expect((await adjustFine(admin, fine.id, 300, 'Partly found')).status).toBe(200)
      expect(copyIn(await listedBook(admin, book.id), copy.id).owedReplacement).toEqual({ ...owed, amount: 300 })

      // Paid, nothing is owed.
      expect((await payFine(admin, fine.id, 300)).status).toBe(200)
      expect(copyIn(await listedBook(admin, book.id), copy.id).owedReplacement).toBeNull()
    })

    it('the Dashboard stops counting the loan as overdue once its copy is lost, and never as a return', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy } = await seedOnLoan(book.id, student.id, THREE_DAYS_LATE)
      const metric = async (name: 'overdue' | 'circulation') =>
        (await request(app).get(`/admin/metrics/${name}`).set(auth(admin))).body
      expect(await metric('overdue')).toEqual({ count: 1, countYesterday: 1 })

      expect((await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })).status).toBe(200)

      // Still overdue 24 hours ago, before it was lost.
      expect(await metric('overdue')).toEqual({ count: 0, countYesterday: 1 })
      expect((await metric('circulation')).returns).toBe(0)
    })
  })

  describe('restoring a copy lost on loan', () => {
    async function lostOnLoan(adminToken: string, studentId: string, replacementCharge = 400) {
      const book = await seedBook('Dune')
      const { copy, loan } = await seedOnLoan(book.id, studentId, THREE_DAYS_LATE)
      expect((await lost(adminToken, copy.id, { replacementCharge, borrowerId: studentId })).status).toBe(200)
      return { book, copy, loan }
    }

    it('restore with waive waives the owed replacement fine and records the reason', async () => {
      const { token: admin, user: librarian } = await seedUser('admin')
      const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
      const { copy, loan } = await lostOnLoan(admin, student.id)
      const before = Date.now()

      const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

      expect(res.status).toBe(200)
      expect(res.body.replacementWaived).toBe(true)
      expect(copyIn(res.body.book as ListedBook, copy.id)).toMatchObject({ status: 'available', owedReplacement: null })
      expect(await statusOf(copy.id)).toBe('available')

      const waived = await lostFineOf(loan.id)
      expect(waived).toMatchObject({
        status: 'waived',
        amount: 0,
        originalAmount: 400,
        adjustedById: librarian.id,
        adjustReason: RETURNED_AFTER_LOST,
        paidAt: null,
      })
      expect(waived.adjustedAt!.getTime()).toBeGreaterThanOrEqual(before)
      expect(waived.adjustedAt!.getTime()).toBeLessThanOrEqual(Date.now())

      // The loan stays closed as lost, and its overdue fine stands.
      expect((await loanOf(loan.id)).status).toBe('lost')
      expect((await finesOf(loan.id)).find((f) => f.reason === 'overdue')).toMatchObject({ amount: 30, status: 'pending' })

      // The student sees the waive and why.
      const mine = await request(app).get('/fines/me').set(auth(studentToken))
      expect(mine.body.fines.find((f: { reason: string }) => f.reason === 'lost')).toMatchObject({
        status: 'waived',
        amount: 0,
        originalAmount: 400,
        note: RETURNED_AFTER_LOST,
      })
      expect(mine.body.outstandingTotal).toBe(30)
    })

    it('restore with waive of a lowered replacement fine keeps its original amount', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const { copy, loan } = await lostOnLoan(admin, student.id)
      expect((await adjustFine(admin, (await lostFineOf(loan.id)).id, 300, 'Partly found')).status).toBe(200)

      const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

      expect(res.status).toBe(200)
      expect(res.body.replacementWaived).toBe(true)
      expect(await lostFineOf(loan.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 400, adjustReason: RETURNED_AFTER_LOST })
    })

    it('restore without waive leaves it owed', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const { copy, loan } = await lostOnLoan(admin, student.id)

      const res = await restore(admin, copy.id, { waiveReplacementCharge: false })

      expect(res.status).toBe(200)
      expect(res.body.replacementWaived).toBe(false)
      expect(await statusOf(copy.id)).toBe('available')
      expect(await lostFineOf(loan.id)).toMatchObject({ status: 'pending', amount: 400, originalAmount: null, adjustedById: null, adjustReason: null })
      expect((await loanOf(loan.id)).status).toBe('lost')
    })

    it('restore with waive when the fine was paid restores the copy and answers replacementWaived false', async () => {
      const { token: admin, user: librarian } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const { copy, loan } = await lostOnLoan(admin, student.id)
      expect((await payFine(admin, (await lostFineOf(loan.id)).id, 400)).status).toBe(200)
      recorder = recordEvents()

      const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

      expect(res.status).toBe(200)
      expect(res.body.replacementWaived).toBe(false)
      expect(await statusOf(copy.id)).toBe('available')
      // Not refunded: the payment stands as it was recorded.
      expect(await lostFineOf(loan.id)).toMatchObject({ status: 'paid', amount: 400, paidRecordedById: librarian.id, adjustReason: null })
      expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue'] }])
    })

    it('a copy lost, restored, lent to another student and lost again offers only the second fine', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: first } = await seedUser('student', 'First Reader')
      const { user: second } = await seedUser('student', 'Second Reader')
      const { book, copy, loan: firstLoan } = await lostOnLoan(admin, first.id)
      // Found, and the first reader is still charged.
      expect((await restore(admin, copy.id)).status).toBe(200)

      // Lent to the second reader, who loses it too.
      await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
      const secondLoan = await prisma.loan.create({
        data: { userId: second.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * DAY_MS) },
      })
      const res = await lost(admin, copy.id, { replacementCharge: 500, borrowerId: second.id })
      expect(res.status).toBe(200)

      const secondFine = await lostFineOf(secondLoan.id)
      expect(copyIn(res.body as ListedBook, copy.id).owedReplacement).toEqual({
        fineId: secondFine.id,
        amount: 500,
        student: { id: second.id, name: 'Second Reader' },
      })

      // Once the second fine is paid nothing is offered, though the first reader still owes for the first loss.
      expect((await payFine(admin, secondFine.id, 500)).status).toBe(200)
      expect(copyIn(await listedBook(admin, book.id), copy.id).owedReplacement).toBeNull()

      const restored = await restore(admin, copy.id, { waiveReplacementCharge: true })
      expect(restored.status).toBe(200)
      expect(restored.body.replacementWaived).toBe(false)
      expect(await lostFineOf(firstLoan.id)).toMatchObject({ status: 'pending', amount: 400 })
    })

    // Closing the loan removes its overdue item from the Needs attention queue, so that topic moves too.
    it('marking a copy lost while on loan publishes catalogue.changed on catalogue, fines, metrics and attention', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy } = await seedOnLoan(book.id, student.id, 5 * DAY_MS)
      recorder = recordEvents()

      expect((await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })).status).toBe(200)

      expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue', 'fines', 'metrics', 'attention'] }])
    })

    it('restoring a lost copy with the replacement charge waived publishes catalogue.changed on catalogue and fines', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const { copy } = await seedOnLoan(book.id, student.id, 5 * DAY_MS)
      expect((await lost(admin, copy.id, { replacementCharge: 400, borrowerId: student.id })).status).toBe(200)
      recorder = recordEvents()

      expect((await restore(admin, copy.id, { waiveReplacementCharge: true })).status).toBe(200)

      expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue', 'fines'] }])
    })

    // A student may dispute the replacement fine. Waiving it on restore waives it for good, so the
    // open dispute is closed too (as waived, with the restore's reason as the note) and the student
    // is told, exactly as when a librarian waives the fine on the Fines page.
    describe('with a dispute on the replacement fine', () => {
      let savedAllowedDomains: string | undefined
      beforeEach(() => {
        savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
        delete process.env.MAIL_ALLOWED_DOMAINS
        setMailTransport(null)
      })
      afterEach(() => {
        setMailTransport(null)
        if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
        else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
      })

      /** Injects a fake mail transport; email is then configured and nothing leaves the process. */
      function fakeTransport(ok = true) {
        const sendMail = vi.fn<MailTransport['send']>(async () => ({ ok }))
        setMailTransport({ send: sendMail })
        return sendMail
      }

      /** The student disputes through the real route, so the rows are exactly what a dispute leaves. */
      async function disputeFine(studentToken: string, fineId: string, reason = 'I never lost it') {
        const res = await request(app).post(`/fines/${fineId}/dispute`).set(auth(studentToken)).send({ reason })
        expect(res.status).toBe(201)
        return res.body.id as string
      }
      const disputeOf = (id: string) => prisma.fineDispute.findUniqueOrThrow({ where: { id } })

      it('restoring a copy with the replacement waived closes a dispute on that fine as waived and sends the notice', async () => {
        const { token: admin, user: librarian } = await seedUser('admin', 'Priya Menon')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const replacement = await lostFineOf(loan.id)
        const disputeId = await disputeFine(studentToken, replacement.id)
        // The overdue fine of the same loan is disputed too; the restore does not touch that one.
        const overdue = await prisma.fine.findFirstOrThrow({ where: { relatedLoanId: loan.id, reason: 'overdue' } })
        const overdueDispute = await disputeFine(studentToken, overdue.id, 'It was returned late by the desk')
        const sendMail = fakeTransport()
        const before = Date.now()

        const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

        expect(res.status).toBe(200)
        expect(res.body.replacementWaived).toBe(true)
        expect(res.body).toEqual({ book: expect.any(Object), replacementWaived: true })
        // The fine is waived with the marker cleared, and its dispute is closed with the restore's reason.
        expect(await lostFineOf(loan.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 400, disputedAt: null, adjustReason: RETURNED_AFTER_LOST })
        const closed = await disputeOf(disputeId)
        expect(closed).toMatchObject({ status: 'waived', resolutionNote: RETURNED_AFTER_LOST, resolvedById: librarian.id })
        expect(closed.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before)
        expect(closed.resolvedAt!.getTime()).toBeLessThanOrEqual(Date.now())
        // The dispute on the overdue fine, which was not waived, is still open.
        expect(await disputeOf(overdueDispute)).toMatchObject({ status: 'open', resolutionNote: null })
        expect((await prisma.fine.findUniqueOrThrow({ where: { id: overdue.id } })).disputedAt).not.toBeNull()

        // The student is told, and sent the same text by email, once.
        const notices = await prisma.notice.findMany({ where: { kind: 'dispute_outcome' } })
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({
          userId: student.id,
          fineId: replacement.id,
          createdById: librarian.id,
          title: 'Your fine was waived',
          body: `The library waived the ₹400 fine for Dune.\n\nNote from the library: ${RETURNED_AFTER_LOST}`,
          emailStatus: 'sent',
        })
        expect(sendMail).toHaveBeenCalledTimes(1)
        expect(sendMail.mock.calls[0][0].subject).toBe('SmartLib: Your fine was waived')
        expect(sendMail.mock.calls[0][0].text.startsWith(notices[0].body)).toBe(true)
        const mine = await request(app).get('/fines/me').set(auth(studentToken))
        expect(mine.body.fines.find((f: { id: string }) => f.id === replacement.id)).toMatchObject({
          status: 'waived',
          dispute: { status: 'waived', note: RETURNED_AFTER_LOST },
        })
      })

      it('a lowered replacement fine that was disputed is waived at what the student saw', async () => {
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const replacement = await lostFineOf(loan.id)
        expect((await adjustFine(admin, replacement.id, 300, 'Partly found')).status).toBe(200)
        const disputeId = await disputeFine(studentToken, replacement.id)

        expect((await restore(admin, copy.id, { waiveReplacementCharge: true })).body.replacementWaived).toBe(true)

        expect(await disputeOf(disputeId)).toMatchObject({ status: 'waived', resolutionNote: RETURNED_AFTER_LOST })
        expect((await prisma.notice.findFirstOrThrow({ where: { fineId: replacement.id } })).body).toBe(
          `The library waived the ₹300 fine for Dune.\n\nNote from the library: ${RETURNED_AFTER_LOST}`,
        )
      })

      it('a restore that does not waive leaves the dispute open, sends nothing and moves only the catalogue', async () => {
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const replacement = await lostFineOf(loan.id)
        const disputeId = await disputeFine(studentToken, replacement.id)
        const sendMail = fakeTransport()
        recorder = recordEvents()

        const res = await restore(admin, copy.id, { waiveReplacementCharge: false })

        expect(res.status).toBe(200)
        expect(res.body.replacementWaived).toBe(false)
        expect(await disputeOf(disputeId)).toMatchObject({ status: 'open', resolutionNote: null, resolvedAt: null })
        expect(await lostFineOf(loan.id)).toMatchObject({ status: 'pending', amount: 400 })
        expect((await lostFineOf(loan.id)).disputedAt).not.toBeNull()
        expect(await prisma.notice.count()).toBe(0)
        expect(sendMail).not.toHaveBeenCalled()
        expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue'] }])
      })

      it('a restore that waives a fine nobody disputed sends no notice and keeps slice 5\'s topics', async () => {
        const { token: admin } = await seedUser('admin')
        const { user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const sendMail = fakeTransport()
        recorder = recordEvents()

        const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

        expect(res.body.replacementWaived).toBe(true)
        expect(await lostFineOf(loan.id)).toMatchObject({ status: 'waived', disputedAt: null })
        expect(await prisma.notice.count()).toBe(0)
        expect(sendMail).not.toHaveBeenCalled()
        expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue', 'fines'] }])
      })

      it('a restore that closes a dispute publishes catalogue.changed once, on catalogue, fines and attention, after the email outcome', async () => {
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        await disputeFine(studentToken, (await lostFineOf(loan.id)).id)
        fakeTransport()
        recorder = recordEvents()
        // What the notice looks like in the database at the moment the event is published.
        const atPublish: Array<Promise<string[]>> = []
        const stop = subscribe(() => {
          atPublish.push(prisma.notice.findMany().then((rows) => rows.map((n) => n.emailStatus)))
        })

        try {
          expect((await restore(admin, copy.id, { waiveReplacementCharge: true })).status).toBe(200)
        } finally {
          stop()
        }

        expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue', 'fines', 'attention'] }])
        expect(await Promise.all(atPublish)).toEqual([['sent']])
      })

      it('a failing email transport records failed and the restore stands', async () => {
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const disputeId = await disputeFine(studentToken, (await lostFineOf(loan.id)).id)
        setMailTransport({ send: async () => ({ ok: false }) })

        const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

        expect(res.status).toBe(200)
        expect(res.body.replacementWaived).toBe(true)
        expect(await statusOf(copy.id)).toBe('available')
        expect(await disputeOf(disputeId)).toMatchObject({ status: 'waived' })
        const notice = await prisma.notice.findFirstOrThrow({ where: { kind: 'dispute_outcome' } })
        expect(notice.emailStatus).toBe('failed')
        expect(notice.emailedAt).not.toBeNull()
      })

      it('a restore refused by the copy\'s status closes no dispute and sends nothing', async () => {
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const disputeId = await disputeFine(studentToken, (await lostFineOf(loan.id)).id)
        expect((await restore(admin, copy.id)).status).toBe(200) // the copy is back, the fine still owed
        const sendMail = fakeTransport()
        recorder = recordEvents()

        // The copy is available now, so a second restore is refused and nothing is waived.
        const res = await restore(admin, copy.id, { waiveReplacementCharge: true })

        expect(res.status).toBe(409)
        expect(res.body.error).toBe(ALREADY_AVAILABLE)
        expect(await disputeOf(disputeId)).toMatchObject({ status: 'open' })
        expect(await prisma.notice.count()).toBe(0)
        expect(sendMail).not.toHaveBeenCalled()
        expect(recorder.events).toEqual([])
      })

      it('records the date it is given when the database session is not on UTC', async () => {
        const { user: librarian } = await seedUser('admin')
        const { token: admin } = await seedUser('admin')
        const { token: studentToken, user: student } = await seedUser('student', 'Asha Rao')
        const { copy, loan } = await lostOnLoan(admin, student.id)
        const replacement = await lostFineOf(loan.id)
        const disputeId = await disputeFine(studentToken, replacement.id)
        const at = new Date(Date.now() - 3 * HOUR_MS)

        // Every write the restore makes runs in a transaction whose session is on Kolkata time (+5:30).
        type Work = (tx: Prisma.TransactionClient) => Promise<unknown>
        const realTransaction = prisma.$transaction.bind(prisma) as (fn: Work, options?: unknown) => Promise<unknown>
        vi.spyOn(prisma, '$transaction').mockImplementation(((fn: Work, options?: unknown) =>
          realTransaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
            return fn(tx)
          }, options)) as never)
        try {
          const result = await restoreCopy(copy.id, librarian.id, true, at)
          expect(result.replacementWaived).toBe(true)
        } finally {
          vi.restoreAllMocks()
        }

        expect((await lostFineOf(loan.id)).adjustedAt).toEqual(at)
        expect((await disputeOf(disputeId)).resolvedAt).toEqual(at)
      })
    })
  })

  describe('restore', () => {
    it('brings a copy in maintenance and a lost copy back to available', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const inMaintenance = await seedCopy(book.id, 'maintenance')
      const gone = await seedCopy(book.id, 'lost')

      const first = await restore(admin, inMaintenance.id)
      expect(first.status).toBe(200)
      expect(copyIn((first.body as { book: ListedBook }).book, inMaintenance.id).status).toBe('available')
      expect(await statusOf(inMaintenance.id)).toBe('available')

      const second = await restore(admin, gone.id, { waiveReplacementCharge: true })
      expect(second.status).toBe(200)
      expect(copyIn((second.body as { book: ListedBook }).book, gone.id).status).toBe('available')
      expect(await statusOf(gone.id)).toBe('available')
    })

    it('answers the book and says no replacement charge was waived', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'lost')

      const res = await restore(admin, copy.id)

      expect(res.status).toBe(200)
      expect(res.body.replacementWaived).toBe(false)
      expect(res.body.book.id).toBe(book.id)
      expect(res.body.book.availableCopies).toBe(1)
    })

    it('refuses a copy that is available, on loan or held, with the message for its status', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: student } = await seedUser('student', 'Asha Rao')
      const book = await seedBook('Dune')
      const onShelf = await seedCopy(book.id)
      const onLoan = await seedCopy(book.id, 'borrowed')
      await prisma.loan.create({ data: { userId: student.id, bookCopyId: onLoan.id, dueAt: new Date(Date.now() + DAY_MS) } })
      const held = await seedCopy(book.id, 'requested')

      const cases: Array<[string, CopyStatus, string]> = [
        [onShelf.id, 'available', ALREADY_AVAILABLE],
        [onLoan.id, 'borrowed', ON_LOAN],
        [held.id, 'requested', HELD],
      ]
      for (const [copyId, status, message] of cases) {
        const res = await restore(admin, copyId)
        expect(res.status, message).toBe(409)
        expect(res.body, message).toEqual({ error: message })
        expect(await statusOf(copyId)).toBe(status)
      }
    })

    it('rejects a waiveReplacementCharge that is not a boolean', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'lost')

      for (const body of [{ waiveReplacementCharge: 'yes' }, { waiveReplacementCharge: 1 }]) {
        expect((await restore(admin, copy.id, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(await statusOf(copy.id)).toBe('lost')
    })

    it('restoring a copy of a waitlisted title gives the first waiting student a claim', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: first } = await seedUser('student', 'First in line')
      const { user: second } = await seedUser('student', 'Second in line')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'maintenance')
      const firstWait = await prisma.reservation.create({
        data: { userId: first.id, bookId: book.id, requestedAt: new Date(Date.now() - 2 * HOUR_MS) },
      })
      const secondWait = await prisma.reservation.create({
        data: { userId: second.id, bookId: book.id, requestedAt: new Date(Date.now() - HOUR_MS) },
      })
      const before = Date.now()

      const res = await restore(admin, copy.id)

      expect(res.status).toBe(200)
      const claimed = await prisma.reservation.findUniqueOrThrow({ where: { id: firstWait.id } })
      expect(claimed.status).toBe('fulfilled')
      expect(claimed.claimExpiresAt!.getTime()).toBeGreaterThan(before)
      // One copy, one claim: the second student keeps waiting.
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: secondWait.id } })).status).toBe('waiting')
    })
  })

  describe('the waitlist', () => {
    it('maintenance on the copy a live claim needs is refused with the waitlist message, and allowed when another copy is free', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: waiting } = await seedUser('student', 'Waiting')
      const book = await seedBook('Dune')
      const only = await seedCopy(book.id)
      const claim = await seedClaim(waiting.id, book.id, HOUR_MS)
      recorder = recordEvents()

      const refused = await maintenance(admin, only.id)

      expect(refused.status).toBe(409)
      expect(refused.body).toEqual({ error: WAITLIST })
      // The refusal rolled the update back, and the claim is untouched.
      expect(await statusOf(only.id)).toBe('available')
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('fulfilled')
      expect(recorder.events).toEqual([])

      // A second copy is free for the claim: one of the two can go.
      const spare = await seedCopy(book.id)
      const allowed = await maintenance(admin, spare.id)
      expect(allowed.status).toBe(200)
      expect(await statusOf(spare.id)).toBe('maintenance')

      // But not the last one.
      const last = await maintenance(admin, only.id)
      expect(last.status).toBe(409)
      expect(last.body).toEqual({ error: WAITLIST })
      expect(await statusOf(only.id)).toBe('available')
    })

    it('marking the copy a live claim needs lost is refused the same way', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: waiting } = await seedUser('student', 'Waiting')
      const book = await seedBook('Dune')
      const only = await seedCopy(book.id)
      await seedClaim(waiting.id, book.id, HOUR_MS)

      const res = await lost(admin, only.id)

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: WAITLIST })
      expect(await statusOf(only.id)).toBe('available')
    })

    it('a stale claim does not block, and is expired by the action', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: waiting } = await seedUser('student', 'Waiting')
      const book = await seedBook('Dune')
      const only = await seedCopy(book.id)
      const stale = await seedClaim(waiting.id, book.id, -HOUR_MS)

      const res = await maintenance(admin, only.id)

      expect(res.status).toBe(200)
      expect(await statusOf(only.id)).toBe('maintenance')
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('expired')
    })

    it('a copy that is not on the shelf can leave service whatever the claims, and a waiting student is no claim', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: claimant } = await seedUser('student', 'Claimant')
      const { user: waiter } = await seedUser('student', 'Waiter')
      const book = await seedBook('Dune')
      const inMaintenance = await seedCopy(book.id, 'maintenance')
      const noLoan = await seedCopy(book.id, 'borrowed')
      const shelf = await seedCopy(book.id)
      // The shelf copy is needed by the one live claim; the waiter has no claim yet.
      await seedClaim(claimant.id, book.id, HOUR_MS)
      await prisma.reservation.create({ data: { userId: waiter.id, bookId: book.id } })

      // Neither of these copies was counted as available, so neither can take a claim's copy.
      expect((await lost(admin, inMaintenance.id)).status).toBe(200)
      expect((await lost(admin, noLoan.id)).status).toBe(200)
      expect(await statusOf(shelf.id)).toBe('available')

      const res = await maintenance(admin, shelf.id)
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: WAITLIST })
    })

    it('two librarians taking different copies of which only one can go: one wins, the other is told the waitlist message', async () => {
      const { token: admin } = await seedUser('admin')
      const { token: other } = await seedUser('admin')
      const { user: waiting } = await seedUser('student', 'Waiting')
      const book = await seedBook('Dune')
      const first = await seedCopy(book.id)
      const second = await seedCopy(book.id)
      await seedClaim(waiting.id, book.id, HOUR_MS)
      await warmPool()

      const results = await Promise.all([maintenance(admin, first.id), lost(other, second.id)])

      expect(results.map((r) => r.status).sort()).toEqual([200, 409])
      const loser = results.find((r) => r.status === 409)!
      expect(loser.body).toEqual({ error: WAITLIST })
      // The claim still has a copy.
      expect(await prisma.bookCopy.count({ where: { bookId: book.id, status: 'available' } })).toBe(1)
    })
  })

  it('the student-visible available and total counts after maintenance, lost and restore', async () => {
    const { token: admin } = await seedUser('admin')
    const book = await seedBook('Dune')
    const copies = [await seedCopy(book.id), await seedCopy(book.id), await seedCopy(book.id)]
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 3, availableCopies: 3 })

    // Maintenance: still the library's copy, no longer on the shelf.
    expect((await maintenance(admin, copies[0].id)).status).toBe(200)
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 3, availableCopies: 2 })

    // Lost from the shelf: gone from the total as well.
    expect((await lost(admin, copies[1].id)).status).toBe(200)
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 2, availableCopies: 1 })

    // Lost from maintenance: the total drops, availability does not move.
    expect((await lost(admin, copies[0].id)).status).toBe(200)
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 1, availableCopies: 1 })

    // Restored: back in both.
    expect((await restore(admin, copies[0].id)).status).toBe(200)
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 2, availableCopies: 2 })
    expect((await restore(admin, copies[1].id)).status).toBe(200)
    expect(await studentView(book.id)).toMatchObject({ totalCopies: 3, availableCopies: 3 })
  })

  describe('two librarians at once', () => {
    it('marking one copy: one wins, the other gets the specific 409', async () => {
      const { token: admin } = await seedUser('admin')
      const { token: other } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id)
      recorder = recordEvents()
      await warmPool()

      const results = await Promise.all([maintenance(admin, copy.id), maintenance(other, copy.id)])

      expect(results.map((r) => r.status).sort()).toEqual([200, 409])
      const loser = results.find((r) => r.status === 409)!
      expect(loser.body).toEqual({ error: ALREADY_IN_MAINTENANCE })
      expect(await statusOf(copy.id)).toBe('maintenance')
      expect(recorder.events).toHaveLength(1)
    })

    it('marking one copy lost: one wins, the other gets the specific 409', async () => {
      const { token: admin } = await seedUser('admin')
      const { token: other } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id)
      await warmPool()

      const results = await Promise.all([lost(admin, copy.id), lost(other, copy.id)])

      expect(results.map((r) => r.status).sort()).toEqual([200, 409])
      expect(results.find((r) => r.status === 409)!.body).toEqual({ error: ALREADY_LOST })
      expect(await statusOf(copy.id)).toBe('lost')
    })

    it('restoring one copy: one wins, the other gets the specific 409', async () => {
      const { token: admin } = await seedUser('admin')
      const { token: other } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id, 'lost')
      await warmPool()

      const results = await Promise.all([restore(admin, copy.id), restore(other, copy.id)])

      expect(results.map((r) => r.status).sort()).toEqual([200, 409])
      expect(results.find((r) => r.status === 409)!.body).toEqual({ error: ALREADY_AVAILABLE })
      expect(await statusOf(copy.id)).toBe('available')
    })

    it('a copy a student took while the librarian looked is answered as on loan', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const copy = await seedCopy(book.id)
      // The librarian's page said available; by the time they act, the copy is out.
      await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
      await prisma.loan.create({
        data: { userId: (await seedUser()).user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + DAY_MS) },
      })

      const res = await maintenance(admin, copy.id)

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: NOW_ON_LOAN })
    })
  })

  it('events: once per success, none on refusals', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const { user: waiting } = await seedUser('student', 'Waiting')
    const book = await seedBook('Dune')
    const shelf = await seedCopy(book.id)
    const onLoanCopy = await seedCopy(book.id, 'borrowed')
    const { user: borrower } = await seedUser()
    await prisma.loan.create({
      data: { userId: borrower.id, bookCopyId: onLoanCopy.id, dueAt: new Date(Date.now() + DAY_MS) },
    })
    const held = await seedCopy(book.id, 'requested')
    const waitlisted = await seedBook('Waitlisted')
    const needed = await seedCopy(waitlisted.id)
    await seedClaim(waiting.id, waitlisted.id, HOUR_MS)
    const changed = { type: 'catalogue.changed', topics: ['catalogue'] }
    recorder = recordEvents()

    expect((await maintenance(admin, shelf.id)).status).toBe(200)
    expect(recorder.events).toEqual([changed])

    expect((await lost(admin, shelf.id)).status).toBe(200)
    expect(recorder.events).toEqual([changed, changed])

    // The waitlist hand-off that follows a restore is part of the same single event.
    expect((await restore(admin, shelf.id)).status).toBe(200)
    expect(recorder.events).toEqual([changed, changed, changed])

    // Refusals: every status that does not allow the action, a copy on loan with neither charge nor
    // borrower (a stale shelf view: 409) or with someone else as the borrower, a copy a live claim needs,
    // a bad body, an unknown copy, no token, a student. The shelf copy is available again, so a restore
    // is refused.
    const before = recorder.events.length
    const refusals = [
      await maintenance(admin, onLoanCopy.id),
      await maintenance(admin, held.id),
      await lost(admin, held.id),
      await lost(admin, onLoanCopy.id),
      await lost(admin, onLoanCopy.id, { replacementCharge: 100, borrowerId: waiting.id }),
      await restore(admin, held.id),
      await restore(admin, onLoanCopy.id),
      await restore(admin, shelf.id),
      await maintenance(admin, needed.id),
      await lost(admin, needed.id),
      await lost(admin, shelf.id, { replacementCharge: -1 }),
      await maintenance(admin, 'no-such-copy'),
      await request(app).post(`/admin/copies/${shelf.id}/maintenance`),
      await maintenance(student, shelf.id),
    ]
    expect(refusals.map((r) => r.status)).toEqual([409, 409, 409, 409, 409, 409, 409, 409, 409, 409, 400, 404, 401, 403])
    expect(recorder.events).toHaveLength(before)
    expect(await statusOf(onLoanCopy.id)).toBe('borrowed')
    expect(await prisma.loan.count({ where: { userId: borrower.id, status: 'active' } })).toBe(1)
  })
})
