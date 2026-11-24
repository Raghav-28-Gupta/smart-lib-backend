// A librarian marking a copy lost while the student who has it returns or renews
// it at the same moment. Each race must end with a coherent loan, the overdue days
// charged exactly once, and a loser that is told what happened, never a server
// error.
//
// Promise.all only hits the bad interleavings by luck, so each race runs for
// several rounds, and swaps which request is started first on every other round.
// The second describe pins the interleavings that matter deterministically with a
// row lock on the loan: the action's write waits on the lock, the competing change
// lands, and only then does the write run, as if the competitor had landed just
// before it.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const ROUNDS = 6
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const LOST_LOAN = 'This loan was closed because the copy was marked lost.'
const NO_LONGER_ON_LOAN = 'This copy is no longer on loan.'
const REPLACEMENT = 400
/** What three whole days past due come to. */
const OVERDUE = 30

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A copy of a new book out on loan to the student, three whole days past due. */
async function seedOverdueLoan(userId: string) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Dune', author: 'Frank Herbert', genre: 'Fiction' },
  })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
  const loan = await prisma.loan.create({
    data: {
      userId,
      bookCopyId: copy.id,
      borrowedAt: new Date(Date.now() - 20 * DAY_MS),
      dueAt: new Date(Date.now() - 3 * DAY_MS - HOUR_MS),
    },
  })
  return { copy, loan }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const markLost = (token: string, copyId: string, borrowerId: string) =>
  request(app).post(`/admin/copies/${copyId}/lost`).set(auth(token)).send({ replacementCharge: REPLACEMENT, borrowerId })
const returnLoan = (token: string, loanId: string) => request(app).post(`/loans/${loanId}/return`).set(auth(token))
const renewLoan = (token: string, loanId: string) => request(app).post(`/loans/${loanId}/renew`).set(auth(token))

const loanOf = (id: string) => prisma.loan.findUniqueOrThrow({ where: { id } })
const copyStatus = (id: string) => prisma.bookCopy.findUniqueOrThrow({ where: { id } }).then((c) => c.status)

/** The loan's fines as reason and amount, in reason order. */
async function finesOf(loanId: string) {
  const fines = await prisma.fine.findMany({ where: { relatedLoanId: loanId } })
  return fines.map((f) => ({ reason: f.reason, amount: f.amount })).sort((a, b) => a.reason.localeCompare(b.reason))
}

// A race needs both requests to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

describe('a copy marked lost while its student returns or renews it', () => {
  beforeEach(resetDb)

  it('lost and student return at once: exactly one wins, never both fines and a return', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()
    const wins = { lost: 0, returned: 0 }
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { copy, loan } = await seedOverdueLoan(student.id)

      const [lost, returned] = await together(
        round,
        () => markLost(admin, copy.id, student.id),
        () => returnLoan(studentToken, loan.id),
      )

      expect([lost.status, returned.status].sort()).toEqual([200, 409])
      const after = await loanOf(loan.id)
      if (lost.status === 200) {
        wins.lost++
        // The loss closed the loan first: the return is refused and wrote nothing.
        expect(returned.body).toEqual({ error: LOST_LOAN })
        expect(after).toMatchObject({ status: 'lost', returnedAt: null })
        expect(await copyStatus(copy.id)).toBe('lost')
        expect(await finesOf(loan.id)).toEqual([
          { reason: 'lost', amount: REPLACEMENT },
          { reason: 'overdue', amount: OVERDUE },
        ])
      } else {
        wins.returned++
        // The book came back first: nothing is lost and there is no replacement charge.
        expect(lost.body).toEqual({ error: NO_LONGER_ON_LOAN })
        expect(after).toMatchObject({ status: 'returned', lostAt: null })
        expect(await copyStatus(copy.id)).toBe('available')
        expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: OVERDUE }])
      }
    }
    expect(wins.lost + wins.returned).toBe(ROUNDS)
  }, 120_000)

  it('lost and student renew at once: exactly one wins', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()
    const wins = { lost: 0, renewed: 0 }
    await warmPool()

    // A renewal leaves the loan open and still the student's, so the loss always goes
    // ahead. What only one of them can win is the overdue days: the renewal charges
    // them if it lands first (and the loss then charges from the new due date: nothing),
    // the loss charges them if it lands first (and the renewal is refused). Never both.
    for (let round = 0; round < ROUNDS; round++) {
      const { copy, loan } = await seedOverdueLoan(student.id)

      const [lost, renewed] = await together(
        round,
        () => markLost(admin, copy.id, student.id),
        () => renewLoan(studentToken, loan.id),
      )

      expect(lost.status).toBe(200)
      const after = await loanOf(loan.id)
      expect(after.status).toBe('lost')
      expect(await copyStatus(copy.id)).toBe('lost')
      expect(await finesOf(loan.id)).toEqual([
        { reason: 'lost', amount: REPLACEMENT },
        { reason: 'overdue', amount: OVERDUE },
      ])
      if (renewed.status === 200) {
        wins.renewed++
        expect(after.renewedCount).toBe(1)
      } else {
        wins.lost++
        expect(renewed.status).toBe(409)
        expect(renewed.body).toEqual({ error: LOST_LOAN })
        expect(after.renewedCount).toBe(0)
        expect(after.dueAt).toEqual(loan.dueAt)
      }
    }
    expect(wins.lost + wins.renewed).toBe(ROUNDS)
  }, 120_000)
})

// --- Interleavings pinned with a row lock --------------------------------------

/** Polls until some other session is stuck waiting for a lock (the action under test, on the row the test holds). */
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
 * Locks the loan row, starts `action`, waits until its write is blocked on that
 * lock, lets `competitor` change the rows in the locking transaction and commits.
 * The action's write then runs against the changed rows, exactly as if the
 * competitor had landed just before it. An action that read the loan first and
 * wrote from that reading afterwards would be caught here: a plain read is not
 * blocked by the lock, so it would see the old row.
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

describe('a loan changed while a write on it was waiting', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  /** What a librarian marking the copy lost writes, done by the test instead. */
  async function loseInTx(tx: Prisma.TransactionClient, loan: { id: string; userId: string; bookCopyId: string }) {
    await tx.loan.update({ where: { id: loan.id }, data: { status: 'lost', lostAt: new Date() } })
    await tx.bookCopy.update({ where: { id: loan.bookCopyId }, data: { status: 'lost' } })
    await tx.fine.createMany({
      data: [
        { userId: loan.userId, relatedLoanId: loan.id, amount: OVERDUE, reason: 'overdue' },
        { userId: loan.userId, relatedLoanId: loan.id, amount: REPLACEMENT, reason: 'lost' },
      ],
    })
  }

  it('a return that waited for a loss is refused and writes no fine', async () => {
    const { token, user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(loan.id, () => returnLoan(token, loan.id), (tx) => loseInTx(tx, loan))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: LOST_LOAN })
    expect(await loanOf(loan.id)).toMatchObject({ status: 'lost', returnedAt: null })
    expect(await copyStatus(copy.id)).toBe('lost')
    // Only the loss's two fines: the return charged nothing.
    expect(await finesOf(loan.id)).toEqual([
      { reason: 'lost', amount: REPLACEMENT },
      { reason: 'overdue', amount: OVERDUE },
    ])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a renewal that waited for a loss is refused and writes no fine', async () => {
    const { token, user: student } = await seedUser()
    const { loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(loan.id, () => renewLoan(token, loan.id), (tx) => loseInTx(tx, loan))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: LOST_LOAN })
    expect(await loanOf(loan.id)).toMatchObject({ status: 'lost', renewedCount: 0, dueAt: loan.dueAt })
    expect(await finesOf(loan.id)).toEqual([
      { reason: 'lost', amount: REPLACEMENT },
      { reason: 'overdue', amount: OVERDUE },
    ])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a loss that waited for a renewal does not charge the overdue days again', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    const renewedDue = new Date(Date.now() + 14 * DAY_MS)

    // The loss reads the loan (not blocked), then waits to close it; the renewal lands
    // meanwhile and charges the three days. The loss must charge from the new due date.
    const res = await writeBlockedThenCompete(
      loan.id,
      () => markLost(admin, copy.id, student.id),
      async (tx) => {
        await tx.loan.update({ where: { id: loan.id }, data: { dueAt: renewedDue, renewedCount: 1 } })
        await tx.fine.create({ data: { userId: student.id, relatedLoanId: loan.id, amount: OVERDUE, reason: 'overdue' } })
      },
    )

    expect(res.status).toBe(200)
    expect(await loanOf(loan.id)).toMatchObject({ status: 'lost', renewedCount: 1, dueAt: renewedDue })
    expect(await copyStatus(copy.id)).toBe('lost')
    expect(await finesOf(loan.id)).toEqual([
      { reason: 'lost', amount: REPLACEMENT },
      { reason: 'overdue', amount: OVERDUE },
    ])
  }, 60_000)

  it('a loss that waited for a return is refused with no longer on loan and charges nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      loan.id,
      () => markLost(admin, copy.id, student.id),
      async (tx) => {
        await tx.loan.update({ where: { id: loan.id }, data: { status: 'returned', returnedAt: new Date() } })
        await tx.fine.create({ data: { userId: student.id, relatedLoanId: loan.id, amount: OVERDUE, reason: 'overdue' } })
        await tx.bookCopy.update({ where: { id: copy.id }, data: { status: 'available' } })
      },
    )

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: NO_LONGER_ON_LOAN })
    expect(await loanOf(loan.id)).toMatchObject({ status: 'returned', lostAt: null })
    expect(await copyStatus(copy.id)).toBe('available')
    expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: OVERDUE }])
    expect(recorder.events).toEqual([])
  }, 60_000)

  const damaged = { report: { category: 'damaged', note: 'Pages torn out' } }
  const reportsOn = (copyId: string) => prisma.issueReport.findMany({ where: { bookCopyId: copyId } })

  it('a return with a report that waited for a loss is refused and creates no report', async () => {
    const { token, user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      loan.id,
      () => request(app).post(`/loans/${loan.id}/return`).set(auth(token)).send(damaged),
      (tx) => loseInTx(tx, loan),
    )

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: LOST_LOAN })
    expect(await loanOf(loan.id)).toMatchObject({ status: 'lost', returnedAt: null })
    expect(await copyStatus(copy.id)).toBe('lost')
    // No report: the librarian's loss won the loan, and the student's report went with the refused return.
    expect(await prisma.issueReport.count()).toBe(0)
    expect(await finesOf(loan.id)).toEqual([
      { reason: 'lost', amount: REPLACEMENT },
      { reason: 'overdue', amount: OVERDUE },
    ])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a return with a report that waited for the same student\'s other return is refused and leaves the one report', async () => {
    const { token, user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    // What the winning return writes, done by the test: the loan, its fine, the report, the copy.
    const res = await writeBlockedThenCompete(
      loan.id,
      () => request(app).post(`/loans/${loan.id}/return`).set(auth(token)).send(damaged),
      async (tx) => {
        await tx.loan.update({ where: { id: loan.id }, data: { status: 'returned', returnedAt: new Date() } })
        await tx.fine.create({ data: { userId: student.id, relatedLoanId: loan.id, amount: OVERDUE, reason: 'overdue' } })
        await tx.issueReport.create({ data: { userId: student.id, bookCopyId: copy.id, category: 'other', note: 'The winner' } })
        await tx.bookCopy.update({ where: { id: copy.id }, data: { status: 'available' } })
      },
    )

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'This loan has already been returned.' })
    expect(await reportsOn(copy.id)).toEqual([expect.objectContaining({ note: 'The winner', category: 'other' })])
    expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: OVERDUE }])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a return whose report meets the same student\'s report committing at that moment still succeeds and keeps it', async () => {
    const { token, user: student } = await seedUser()
    const { copy, loan } = await seedOverdueLoan(student.id)
    recorder = recordEvents()

    // The competing report is written but not committed, so the return cannot see it and
    // goes on to write its own: that write waits on the unique key, and when the other
    // transaction commits it must be skipped, not refused. A violation would abort the
    // return's whole transaction.
    let pending: Promise<request.Response> | undefined
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.issueReport.create({ data: { userId: student.id, bookCopyId: copy.id, category: 'missing_pages', note: 'Landed first' } })
          pending = Promise.resolve(request(app).post(`/loans/${loan.id}/return`).set(auth(token)).send({ report: { category: 'damaged', note: 'Landed second' } }))
          await waitUntilAWriterIsBlocked()
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
    } finally {
      await pending
    }
    const res = await pending!

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: loan.id, status: 'returned' })
    expect(await loanOf(loan.id)).toMatchObject({ status: 'returned' })
    expect(await copyStatus(copy.id)).toBe('available')
    expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: OVERDUE }])
    expect(await reportsOn(copy.id)).toEqual([expect.objectContaining({ note: 'Landed first', category: 'missing_pages' })])
    // The return is announced; the report that was written by someone else is not this return's to announce.
    expect(recorder.events.map((e) => e.type)).toEqual(['loan.changed'])
  }, 60_000)
})

// --- A copy returned with a report -------------------------------------------------
// The report is written inside the return's transaction, after the loan was won, so
// whatever beats the return to the loan (a librarian's loss, the student's own other
// request) leaves no report behind, and a report the student already has open on the
// copy never turns the return into an error.

describe('a copy returned with a report while another change lands', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  const ALREADY_RETURNED = 'This loan has already been returned.'
  const typesPublished = (events: Array<{ type: string }>) => events.map((e) => e.type).sort()
  const returnWithReport = (token: string, loanId: string, note: string) =>
    request(app).post(`/loans/${loanId}/return`).set(auth(token)).send({ report: { category: 'damaged', note } })
  const reportsOn = (copyId: string) => prisma.issueReport.findMany({ where: { bookCopyId: copyId } })

  it('two simultaneous returns with a report create exactly one report and one 409', async () => {
    const { user: student, token } = await seedUser()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { copy, loan } = await seedOverdueLoan(student.id)
      recorder?.stop()
      recorder = recordEvents()

      const [first, second] = await together(
        round,
        () => returnWithReport(token, loan.id, 'First'),
        () => returnWithReport(token, loan.id, 'Second'),
      )

      expect([first.status, second.status].sort(), `round ${round}`).toEqual([200, 409])
      const [winner, loser] = first.status === 200 ? [first, second] : [second, first]
      expect(winner.body, `round ${round}`).toMatchObject({ id: loan.id, status: 'returned' })
      expect(loser.body, `round ${round}`).toEqual({ error: ALREADY_RETURNED })
      // One return, so one report (the winner's), one overdue charge, one announcement of each.
      const note = first.status === 200 ? 'First' : 'Second'
      expect(await reportsOn(copy.id), `round ${round}`).toEqual([expect.objectContaining({ userId: student.id, status: 'open', note })])
      expect(await finesOf(loan.id)).toEqual([{ reason: 'overdue', amount: OVERDUE }])
      expect(await copyStatus(copy.id)).toBe('available')
      expect(typesPublished(recorder.events), `round ${round}`).toEqual(['attention.changed', 'loan.changed'])
    }
  }, 120_000)
})
