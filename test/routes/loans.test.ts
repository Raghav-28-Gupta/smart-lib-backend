import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

let userCounter = 0

async function seedUser() {
  userCounter += 1
  const user = await prisma.user.create({
    data: { name: `User ${userCounter}`, email: `user${userCounter}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedBookWithCopies(availableCopies: number, totalCopies = availableCopies) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', genre: 'Software Eng.', totalCopies },
  })
  const borrowed = totalCopies - availableCopies
  await prisma.bookCopy.createMany({
    data: [
      ...Array.from({ length: availableCopies }, () => ({ bookId: book.id, status: 'available' as const })),
      ...Array.from({ length: Math.max(borrowed, 0) }, () => ({ bookId: book.id, status: 'borrowed' as const })),
    ],
  })
  return book
}

async function addWaiters(bookId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const { user } = await seedUser()
    await prisma.reservation.create({ data: { userId: user.id, bookId, status: 'waiting' } })
  }
}

describe('POST /loans', () => {
  beforeEach(resetDb)

  it('tells older app versions that borrowing needs approval now', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 2)

    const res = await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe("Borrowing now needs a librarian's approval. Update the SmartLib app to send a request.")
    expect(await prisma.loan.count()).toBe(0)
  })

  it('still validates the body, and requires authentication', async () => {
    const { token } = await seedUser()
    expect((await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({})).status).toBe(400)
    expect((await request(app).post('/loans').send({ bookId: 'b1' })).status).toBe(401)
  })
})

describe('GET /loans/me', () => {
  beforeEach(resetDb)

  it('lists only the caller\'s active loans, not another user\'s', async () => {
    const { token, user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(2, 2)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.loan.create({ data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) } })

    const mine = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(mine.body).toHaveLength(1)
    expect(mine.body[0].userId).toBe(user.id)

    const theirs = await request(app).get('/loans/me').set('Authorization', `Bearer ${otherToken}`)
    expect(theirs.body).toHaveLength(0)
  })

  it('shows a live-computed fineAmount and overdue status for a still-active overdue loan', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    // 3 days overdue, never returned — dueAt in the past, still status 'active'.
    await prisma.loan.create({
      data: {
        userId: user.id,
        bookCopyId: copy.id,
        dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        status: 'active',
      },
    })

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].frontendStatus).toBe('overdue')
    expect(res.body[0].fineAmount).toBe(30) // 3 days * ₹10/day
    expect(res.body[0].canRenew).toBe(true)
  })

  it('blocks renewal and gives the exact singular waitlist reason when 1 person is waiting', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 1)

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].canRenew).toBe(false)
    expect(res.body[0].blockedReason).toBe('1 student is waiting for this title.')
  })

  it('pluralizes the waitlist reason for more than 1 person', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 2)

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].blockedReason).toBe('2 students are waiting for this title.')
  })
})

describe('POST /loans/:id/renew', () => {
  beforeEach(resetDb)

  it('extends the due date and increments renewedCount', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.renewedCount).toBe(1)
    expect(new Date(res.body.dueAt).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000)
  })

  it('settles an overdue fine into a Fine record and resets fineAmount to 0', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.fineAmount).toBe(0)
    expect(res.body.frontendStatus).toBe('normal')

    const fines = await prisma.fine.findMany({ where: { userId: user.id, reason: 'overdue' } })
    expect(fines).toHaveLength(1)
    expect(fines[0].amount).toBe(20) // 2 days * ₹10/day
  })

  it('is blocked by an active waitlist with a 409', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 1)

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('is blocked once the renewal cap is reached', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: {
        userId: user.id, bookCopyId: copy.id,
        dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        renewedCount: 2, // MAX_RENEWALS
      },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the loan', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /loans/:id/return', () => {
  beforeEach(resetDb)

  it('marks the loan returned and frees the copy', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)

    const bookRes = await request(app).get(`/books/${book.id}`)
    expect(bookRes.body.availableCopies).toBe(1)

    const dbLoan = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(dbLoan.status).toBe('returned')
    expect(dbLoan.returnedAt).not.toBeNull()
  })

  it('creates a Fine when returned overdue', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) },
    })

    await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    const fines = await prisma.fine.findMany({ where: { userId: user.id, reason: 'overdue' } })
    expect(fines).toHaveLength(1)
    expect(fines[0].amount).toBe(40) // 4 days * ₹10/day
  })

  it('returns 409 when the loan is already returned', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the loan', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /loans/:id/return with a report', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
    vi.restoreAllMocks()
  })

  const DAY_MS = 24 * 60 * 60 * 1000
  const LOST_LOAN = 'This loan was closed because the copy was marked lost.'
  const LOAN_KEYS = ['blockedReason', 'bookId', 'borrowedAt', 'canRenew', 'dueAt', 'fineAmount', 'frontendStatus', 'id', 'renewedCount', 'returnedAt', 'status', 'userId']
  const damaged = { report: { category: 'damaged', note: 'The cover is torn' } }

  /** A student with a copy of a new book out on loan (the copy marked borrowed, as lending leaves it). */
  async function seedLoanOut(dueAt = new Date(Date.now() + 5 * DAY_MS)) {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
    const loan = await prisma.loan.create({ data: { userId: user.id, bookCopyId: copy.id, dueAt } })
    return { user, token, copy, loan }
  }

  const returnLoan = (token: string, loanId: string, body?: object) => {
    const req = request(app).post(`/loans/${loanId}/return`).set('Authorization', `Bearer ${token}`)
    return body === undefined ? req : req.send(body)
  }

  it('returning with a report creates one open report on that copy by that student, in the same transaction', async () => {
    const { user, token, copy, loan } = await seedLoanOut()

    const res = await returnLoan(token, loan.id, { report: { category: 'damaged', note: '  The cover is torn \n' } })

    expect(res.status).toBe(200)
    // The answer is the loan, as it always was: the report adds nothing to it.
    expect(Object.keys(res.body).sort()).toEqual(LOAN_KEYS)
    expect(res.body).toMatchObject({ id: loan.id, status: 'returned' })
    const reports = await prisma.issueReport.findMany()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      userId: user.id,
      bookCopyId: copy.id,
      resourceId: null,
      category: 'damaged',
      note: 'The cover is torn',
      status: 'open',
      resolutionNote: null,
      resolvedById: null,
      resolvedAt: null,
    })
    const returned = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(returned.status).toBe('returned')
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
    // Written by the return itself, with its clock: the report and the return are one moment.
    expect(reports[0].createdAt).toEqual(returned.returnedAt)
  })

  it('returning with no body behaves as before', async () => {
    const noBody = await seedLoanOut()
    const emptyBody = await seedLoanOut()
    recorder = recordEvents()

    const first = await returnLoan(noBody.token, noBody.loan.id)
    const second = await returnLoan(emptyBody.token, emptyBody.loan.id, {})

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(Object.keys(first.body).sort()).toEqual(LOAN_KEYS)
    expect(first.body).toMatchObject({ status: 'returned' })
    expect(second.body).toMatchObject({ status: 'returned' })
    expect(await prisma.issueReport.count()).toBe(0)
    // Each return announces the return and nothing about a report.
    expect(recorder.events).toEqual([
      { type: 'loan.changed', topics: ['metrics', 'catalogue'] },
      { type: 'loan.changed', topics: ['metrics', 'catalogue'] },
    ])
  })

  it('a return refused because the loan is already returned or lost creates no report', async () => {
    const returned = await seedLoanOut()
    expect((await returnLoan(returned.token, returned.loan.id)).status).toBe(200)
    const lost = await seedLoanOut()
    await prisma.loan.update({ where: { id: lost.loan.id }, data: { status: 'lost', lostAt: new Date() } })
    await prisma.bookCopy.update({ where: { id: lost.copy.id }, data: { status: 'lost' } })
    const theirs = await seedLoanOut()
    const { token: strangerToken } = await seedUser()
    recorder = recordEvents()

    const again = await returnLoan(returned.token, returned.loan.id, damaged)
    const lostRes = await returnLoan(lost.token, lost.loan.id, damaged)
    const notTheirs = await returnLoan(strangerToken, theirs.loan.id, damaged)
    const unknown = await returnLoan(returned.token, 'no-such-loan', damaged)
    const anonymous = await request(app).post(`/loans/${theirs.loan.id}/return`).send(damaged)

    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: 'This loan has already been returned.' })
    expect(lostRes.status).toBe(409)
    expect(lostRes.body).toEqual({ error: LOST_LOAN })
    expect(notTheirs.status).toBe(403)
    expect(unknown.status).toBe(404)
    expect(anonymous.status).toBe(401)
    // Nothing was written, nothing announced, and the loan someone else tried to return is still out.
    expect(await prisma.issueReport.count()).toBe(0)
    expect(recorder.events).toEqual([])
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: theirs.loan.id } })).status).toBe('active')
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: theirs.copy.id } })).status).toBe('borrowed')
  })

  type TransactionClient = Prisma.TransactionClient
  /** A client for the test's transaction that behaves as `tx` does, except that `replacements` stand in for some of its models. */
  const withModels = (tx: TransactionClient, replacements: Record<string, object>) =>
    new Proxy(tx, { get: (target, prop) => (typeof prop === 'string' && prop in replacements ? replacements[prop] : Reflect.get(target, prop)) })
  /** A model of `tx` that behaves as it does, except that `replacements` stand in for some of its methods. */
  const withMethods = (model: object, replacements: Record<string, (...args: never[]) => unknown>) =>
    new Proxy(model, { get: (target, prop) => (typeof prop === 'string' && prop in replacements ? replacements[prop] : Reflect.get(target, prop)) })
  /** Runs the next transactions for real, each on the client `wrap` makes of the real one. */
  function wrapTransactions(wrap: (tx: TransactionClient) => TransactionClient) {
    const real = prisma.$transaction.bind(prisma) as unknown as (fn: (tx: TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>
    vi.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: TransactionClient) => Promise<unknown>, options?: unknown) =>
      real((tx) => fn(wrap(tx)), options)) as never)
  }

  it('a failure after the loan update rolls the report back', async () => {
    const { token, copy, loan } = await seedLoanOut(new Date(Date.now() - 3 * DAY_MS - 60 * 60 * 1000))
    recorder = recordEvents()

    // A real failure inside the return's transaction: its copy update throws, after the
    // loan has been returned, the overdue fine written and the report inserted. What the
    // transaction held at that moment is read from inside it, so the test cannot pass
    // merely because the report was never written.
    let heldWhenItFailed: { loan: string; reports: number; fines: number } | undefined
    wrapTransactions((tx) =>
      withModels(tx, {
        bookCopy: withMethods(tx.bookCopy, {
          update: async () => {
            heldWhenItFailed = {
              loan: (await tx.loan.findUniqueOrThrow({ where: { id: loan.id } })).status,
              reports: await tx.issueReport.count({ where: { bookCopyId: copy.id } }),
              fines: await tx.fine.count({ where: { relatedLoanId: loan.id } }),
            }
            throw new Error('The copy update failed')
          },
        }),
      }),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await returnLoan(token, loan.id, damaged)
    vi.restoreAllMocks()

    expect(res.status).toBe(500)
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'The copy update failed' }))
    expect(heldWhenItFailed).toEqual({ loan: 'returned', reports: 1, fines: 1 })
    // All of it rolled back together: the loan is still out, the copy still borrowed, no report, no fine.
    expect(await prisma.issueReport.count()).toBe(0)
    expect(await prisma.fine.count()).toBe(0)
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ status: 'active', returnedAt: null })
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('borrowed')
    expect(recorder.events).toEqual([])

    // And nothing is left stuck: the same return, tried again, goes through with its report.
    const retry = await returnLoan(token, loan.id, damaged)
    expect(retry.status).toBe(200)
    expect(await prisma.issueReport.count({ where: { bookCopyId: copy.id, status: 'open' } })).toBe(1)
  })

  it('writes the report only after the loan update has won, and before the copy goes back on the shelf', async () => {
    const { token, loan } = await seedLoanOut()
    // Within the transaction a refusal rolls everything back, so the order is not visible
    // in the outcome; it is pinned here by watching the writes as the transaction makes them.
    const writes: string[] = []
    const watch = <M extends object>(name: string, model: M, method: string) =>
      withMethods(model, {
        [method]: (...args: never[]) => {
          writes.push(`${name}.${method}`)
          return (Reflect.get(model, method) as (...a: never[]) => unknown).apply(model, args)
        },
      })
    wrapTransactions((tx) =>
      withModels(tx, {
        loan: watch('loan', tx.loan, 'updateMany'),
        issueReport: watch('issueReport', tx.issueReport, 'createMany'),
        bookCopy: watch('bookCopy', tx.bookCopy, 'update'),
      }),
    )

    const res = await returnLoan(token, loan.id, damaged)
    vi.restoreAllMocks()

    expect(res.status).toBe(200)
    expect(writes).toEqual(['loan.updateMany', 'issueReport.createMany', 'bookCopy.update'])
  })
})

describe('a loan closed because its copy was marked lost', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => recorder?.stop())

  const LOST_LOAN = 'This loan was closed because the copy was marked lost.'
  const DAY_MS = 24 * 60 * 60 * 1000

  async function seedAdminToken() {
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `admin${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    return jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
  }

  /** A student with this book out three whole days past due, which a librarian then marks lost with a ₹400 charge. */
  async function seedLostLoan() {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 3 * DAY_MS - 60 * 60 * 1000) },
    })
    const res = await request(app)
      .post(`/admin/copies/${copy.id}/lost`)
      .set('Authorization', `Bearer ${await seedAdminToken()}`)
      .send({ replacementCharge: 400, borrowerId: user.id })
    expect(res.status).toBe(200)
    return { user, token, book, copy, loan }
  }

  it('the lost loan leaves /loans/me and its fines appear on /fines/me', async () => {
    const { user, token, loan } = await seedLostLoan()
    // Another book the student still has.
    const other = await seedBookWithCopies(1, 1)
    const otherCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: other.id } })
    const kept = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: otherCopy.id, dueAt: new Date(Date.now() + 5 * DAY_MS) },
    })

    const loans = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(loans.status).toBe(200)
    expect(loans.body.map((l: { id: string }) => l.id)).toEqual([kept.id])
    expect(loans.body.map((l: { id: string }) => l.id)).not.toContain(loan.id)

    const fines = await request(app).get('/fines/me').set('Authorization', `Bearer ${token}`)
    expect(fines.status).toBe(200)
    const listed = (fines.body.fines as Array<{ reason: string; item: string; amount: number; status: string }>)
      .map(({ reason, item, amount, status }) => ({ reason, item, amount, status }))
      .sort((a, b) => a.reason.localeCompare(b.reason))
    expect(listed).toEqual([
      { reason: 'lost', item: 'Clean Code', amount: 400, status: 'outstanding' },
      { reason: 'overdue', item: 'Clean Code', amount: 30, status: 'outstanding' },
    ])
    expect(fines.body.outstandingTotal).toBe(430)
  })

  it('returning or renewing a lost loan is 409 with the message', async () => {
    const { token, copy, loan } = await seedLostLoan()
    const finesBefore = await prisma.fine.count()
    recorder = recordEvents()

    const returned = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)
    const renewed = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)

    expect(returned.status).toBe(409)
    expect(returned.body).toEqual({ error: LOST_LOAN })
    expect(renewed.status).toBe(409)
    expect(renewed.body).toEqual({ error: LOST_LOAN })
    // Nothing moved: the loan stays closed as lost, the copy lost, no fine added, nothing announced.
    const after = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(after).toMatchObject({ status: 'lost', returnedAt: null, renewedCount: 0, dueAt: loan.dueAt })
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('lost')
    expect(await prisma.fine.count()).toBe(finesBefore)
    expect(recorder.events).toEqual([])
  })
})

describe('loan activity reaches the console', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => recorder?.stop())

  async function seedLoanDue(dueAt: Date) {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({ data: { userId: user.id, bookCopyId: copy.id, dueAt } })
    return { user, token, loan }
  }

  it('an on-time renewal publishes loan.changed on metrics and catalogue', async () => {
    const { token, loan } = await seedLoanDue(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    recorder = recordEvents()

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'loan.changed', topics: ['metrics', 'catalogue'] }])
  })

  it('returning an on-time loan publishes loan.changed on metrics and catalogue', async () => {
    const { token, loan } = await seedLoanDue(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    recorder = recordEvents()

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'loan.changed', topics: ['metrics', 'catalogue'] }])
  })

  it('a past-due return and a past-due renewal carry attention; an on-time one does not', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const cases = [
      { action: 'return', dueAt: new Date(Date.now() + 2 * DAY), attention: false },
      { action: 'renew', dueAt: new Date(Date.now() + 2 * DAY), attention: false },
      { action: 'return', dueAt: new Date(Date.now() - 3 * DAY), attention: true },
      { action: 'renew', dueAt: new Date(Date.now() - 3 * DAY), attention: true },
    ]
    for (const { action, dueAt, attention } of cases) {
      const { token, loan } = await seedLoanDue(dueAt)
      recorder = recordEvents()

      const res = await request(app).post(`/loans/${loan.id}/${action}`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(recorder.events).toHaveLength(1)
      expect(recorder.events[0].type).toBe('loan.changed')
      // A late return or renewal removes the loan's overdue item from the Needs attention queue.
      expect(recorder.events[0].topics.includes('attention'), `${action} due ${attention ? 'in the past' : 'ahead'}`).toBe(attention)
      recorder.stop()
    }
  })

  it('returning a past-due loan publishes loan.changed with fines and attention too and writes the fine', async () => {
    const { user, token, loan } = await seedLoanDue(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000))
    recorder = recordEvents()

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'loan.changed', topics: ['metrics', 'catalogue', 'fines', 'attention'] }])
    const fines = await prisma.fine.findMany({ where: { userId: user.id, relatedLoanId: loan.id } })
    expect(fines).toHaveLength(1)
    expect(fines[0].amount).toBe(40)
  })

  it('returning a loan under a day late still touches fines, though no fine is written', async () => {
    const { user, token, loan } = await seedLoanDue(new Date(Date.now() - 2 * 60 * 60 * 1000))
    recorder = recordEvents()

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'loan.changed', topics: ['metrics', 'catalogue', 'fines', 'attention'] }])
    expect(await prisma.fine.count({ where: { userId: user.id } })).toBe(0)
  })

  it('renewing a past-due loan publishes one loan.changed with fines and attention too', async () => {
    const { token, loan } = await seedLoanDue(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
    recorder = recordEvents()

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'loan.changed', topics: ['metrics', 'catalogue', 'fines', 'attention'] }])
  })

  it('a refused renewal publishes nothing and writes no fine', async () => {
    const { user, token, loan } = await seedLoanDue(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
    const { user: waiter } = await seedUser()
    const copy = await prisma.bookCopy.findUniqueOrThrow({ where: { id: loan.bookCopyId } })
    await prisma.reservation.create({ data: { userId: waiter.id, bookId: copy.bookId, status: 'waiting' } })
    recorder = recordEvents()

    const renewal = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)

    expect(renewal.status).toBe(409)
    expect(recorder.events).toEqual([])
    expect(await prisma.fine.count({ where: { userId: user.id } })).toBe(0)
  })
})
