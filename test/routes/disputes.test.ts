// A student disputing a fine from the app: ownership and eligibility, the one
// dispute per fine, and the races between opening a dispute and a payment, a
// waive or another dispute. Marking a disputed fine paid and the console's lists
// are covered in test/routes/adminFines.test.ts; the student's own list in
// test/routes/fines.test.ts.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { FineStatus, Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'
import { writeBlockedThenCompete } from '../helpers/rowLock'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 8

const FINE_CHANGED = { type: 'fine.changed', topics: ['fines'] }
const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

const PAID_OR_WAIVED = "This fine can't be disputed because it is already paid or waived."
const ALREADY_DISPUTED = "You've already disputed this fine."
const BEING_DISPUTED = 'This fine is being disputed. Resolve the dispute first.'

async function seedUser(role: 'student' | 'admin' = 'student', name = `${role} ${Math.random()}`) {
  const user = await prisma.user.create({
    data: { name, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

interface FineSeed {
  userId: string
  amount?: number
  status?: FineStatus
  originalAmount?: number
  adjustReason?: string
  title?: string
}

/** A fine on a returned loan of a fresh book, so the console lists it with an item. */
async function seedFine({ userId, amount = 150, status = 'pending', originalAmount, adjustReason, title = 'Refactoring' }: FineSeed) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Someone', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  const dueAt = new Date(Date.now() - 10 * DAY_MS)
  const loan = await prisma.loan.create({
    data: { userId, bookCopyId: copy.id, dueAt, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), status: 'returned', returnedAt: new Date() },
  })
  return prisma.fine.create({
    data: { userId, relatedLoanId: loan.id, amount, reason: 'overdue', status, originalAmount, adjustReason },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const dispute = (token: string, fineId: string, body?: unknown) => {
  const req = request(app).post(`/fines/${fineId}/dispute`).set(auth(token))
  return body === undefined ? req : req.send(body as object)
}
const pay = (token: string, id: string, amount: number) =>
  request(app).post(`/admin/fines/${id}/paid`).set(auth(token)).send({ amount })
const stored = (id: string) => prisma.fine.findUniqueOrThrow({ where: { id } })
const disputesOf = (fineId: string) => prisma.fineDispute.findMany({ where: { fineId } })

/** What a dispute that landed first leaves on the rows, written by the lock-holding competitor. */
async function openDisputeIn(tx: Prisma.TransactionClient, fineId: string, userId: string) {
  await tx.fine.update({ where: { id: fineId }, data: { disputedAt: new Date() } })
  await tx.fineDispute.create({ data: { fineId, userId, reason: 'Disputed first' } })
}

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

describe('POST /fines/:id/dispute', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a student disputes their own outstanding fine (201) and it lists as disputed with the reason on /admin/fines and as dispute open on /fines/me', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token } = await seedUser('student', 'Asha Rao')
    const fine = await seedFine({ userId: student.id, amount: 150, title: 'Refactoring' })
    const before = Date.now()

    const res = await dispute(token, fine.id, { reason: 'I returned it on time' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: expect.any(String), status: 'open' })
    const [row] = await disputesOf(fine.id)
    expect(row).toMatchObject({
      id: res.body.id,
      fineId: fine.id,
      userId: student.id,
      reason: 'I returned it on time',
      status: 'open',
      resolutionNote: null,
      resolvedById: null,
      resolvedAt: null,
    })
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    // The fine itself says a dispute is open, and is otherwise untouched.
    const after = await stored(fine.id)
    expect(after).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, paidAt: null })
    expect(after.disputedAt).toEqual(row.createdAt)

    const listed = await request(app).get('/admin/fines').set(auth(admin))
    expect(listed.body.fines).toEqual([
      {
        id: fine.id,
        kind: 'fine',
        student: { id: student.id, name: 'Asha Rao', email: expect.any(String) },
        reason: 'overdue',
        item: 'Refactoring',
        amount: 150,
        originalAmount: 150,
        status: 'disputed',
        date: fine.createdAt.toISOString(),
        note: null,
        recordedBy: null,
        dispute: { id: res.body.id, reason: 'I returned it on time', createdAt: row.createdAt.toISOString() },
        canSettle: true,
      },
    ])
    const mine = await request(app).get('/fines/me').set(auth(token))
    expect(mine.body.fines).toEqual([
      expect.objectContaining({ id: fine.id, status: 'outstanding', amount: 150, dispute: { status: 'open', note: null } }),
    ])
    expect(mine.body.outstandingTotal).toBe(150)
  })

  it('an adjusted fine can be disputed', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const fine = await seedFine({
      userId: student.id,
      amount: 50,
      status: 'adjusted',
      originalAmount: 150,
      adjustReason: 'Hardship',
    })
    await prisma.fine.update({ where: { id: fine.id }, data: { adjustedById: librarian.id, adjustedAt: new Date() } })

    const res = await dispute(token, fine.id, { reason: 'Still too much' })

    expect(res.status).toBe(201)
    const after = await stored(fine.id)
    expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustReason: 'Hardship' })
    expect(after.disputedAt).not.toBeNull()
    expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'open', reason: 'Still too much', userId: student.id })])
  })

  it('the reason is trimmed, and exactly 300 characters is accepted', async () => {
    const { user: student, token } = await seedUser()
    const padded = await seedFine({ userId: student.id })
    const longest = await seedFine({ userId: student.id })

    const trimmed = await dispute(token, padded.id, { reason: '   Charged twice \n' })
    const limit = await dispute(token, longest.id, { reason: ` ${'x'.repeat(300)} ` })

    expect(trimmed.status).toBe(201)
    expect(limit.status).toBe(201)
    expect((await disputesOf(padded.id))[0].reason).toBe('Charged twice')
    expect((await disputesOf(longest.id))[0].reason).toBe('x'.repeat(300))
  })

  it("another student's fine and an unknown id are 404", async () => {
    const { token } = await seedUser()
    const { user: owner } = await seedUser()
    const theirs = await seedFine({ userId: owner.id })
    recorder = recordEvents()

    const other = await dispute(token, theirs.id, { reason: 'Not mine to dispute' })
    const unknown = await dispute(token, 'no-such-fine', { reason: 'Whatever' })

    expect(other.status).toBe(404)
    expect(other.body.error).toBe('Fine not found')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Fine not found')
    // The owner's fine is untouched: no marker, no dispute.
    expect((await stored(theirs.id)).disputedAt).toBeNull()
    expect(await prisma.fineDispute.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('a paid or waived fine is 409', async () => {
    const { user: student, token } = await seedUser()
    const paid = await seedFine({ userId: student.id, status: 'paid' })
    const waived = await seedFine({ userId: student.id, amount: 0, status: 'waived', originalAmount: 40, adjustReason: 'Library error' })
    recorder = recordEvents()

    const paidRes = await dispute(token, paid.id, { reason: 'Too late' })
    const waivedRes = await dispute(token, waived.id, { reason: 'Too late' })

    expect(paidRes.status).toBe(409)
    expect(paidRes.body.error).toBe(PAID_OR_WAIVED)
    expect(waivedRes.status).toBe(409)
    expect(waivedRes.body.error).toBe(PAID_OR_WAIVED)
    expect(await prisma.fineDispute.count()).toBe(0)
    expect((await stored(paid.id)).disputedAt).toBeNull()
    expect((await stored(waived.id)).disputedAt).toBeNull()
    expect(recorder.events).toEqual([])
  })

  it('a second dispute, open or resolved, is 409 "You\'ve already disputed this fine."', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const open = await seedFine({ userId: student.id })
    const upheld = await seedFine({ userId: student.id })
    const adjusted = await seedFine({ userId: student.id, amount: 20, status: 'adjusted', originalAmount: 60, adjustReason: 'Hardship' })
    // Resolved disputes leave the fine's marker cleared, so only the unique fineId can refuse a second one.
    const resolved = { resolvedById: librarian.id, resolvedAt: new Date(), resolutionNote: 'Checked' }
    await prisma.fineDispute.create({ data: { fineId: upheld.id, userId: student.id, reason: 'First go', status: 'upheld', ...resolved } })
    await prisma.fineDispute.create({ data: { fineId: adjusted.id, userId: student.id, reason: 'First go', status: 'adjusted', ...resolved } })
    expect((await dispute(token, open.id, { reason: 'First go' })).status).toBe(201)
    recorder = recordEvents()

    const again = await dispute(token, open.id, { reason: 'Second go' })
    const afterUpheld = await dispute(token, upheld.id, { reason: 'Second go' })
    const afterAdjusted = await dispute(token, adjusted.id, { reason: 'Second go' })

    for (const res of [again, afterUpheld, afterAdjusted]) {
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(ALREADY_DISPUTED)
    }
    // Still one dispute each, the first, unchanged; and the refused attempt left no marker behind on the resolved ones.
    expect(await disputesOf(open.id)).toEqual([expect.objectContaining({ reason: 'First go', status: 'open' })])
    expect(await disputesOf(upheld.id)).toEqual([expect.objectContaining({ reason: 'First go', status: 'upheld', resolutionNote: 'Checked' })])
    expect(await disputesOf(adjusted.id)).toEqual([expect.objectContaining({ reason: 'First go', status: 'adjusted' })])
    expect((await stored(upheld.id)).disputedAt).toBeNull()
    expect((await stored(adjusted.id)).disputedAt).toBeNull()
    expect((await stored(open.id)).disputedAt).not.toBeNull()
    expect(recorder.events).toEqual([])
  })

  it('reason blank, 301 characters or missing is 400', async () => {
    const { user: student, token } = await seedUser()
    const fine = await seedFine({ userId: student.id })
    const invalid: Array<[string, unknown]> = [
      ['no body', undefined],
      ['an empty body', {}],
      ['a blank reason', { reason: '   ' }],
      ['an empty reason', { reason: '' }],
      ['301 characters', { reason: 'x'.repeat(301) }],
      ['301 characters between spaces', { reason: ` ${'x'.repeat(301)} ` }],
      ['a number', { reason: 12 }],
      ['null', { reason: null }],
    ]
    recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await dispute(token, fine.id, body)
      expect(res.status, what).toBe(400)
    }

    expect((await stored(fine.id)).disputedAt).toBeNull()
    expect(await prisma.fineDispute.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('401 without a token', async () => {
    const { user: student } = await seedUser()
    const fine = await seedFine({ userId: student.id })

    const anonymous = await request(app).post(`/fines/${fine.id}/dispute`).send({ reason: 'Wrong' })
    const garbage = await request(app).post(`/fines/${fine.id}/dispute`).set('Authorization', 'Bearer not-a-token').send({ reason: 'Wrong' })

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(await prisma.fineDispute.count()).toBe(0)
  })

  it('publishes fine.changed and attention.changed once, none on a refusal', async () => {
    const { user: student, token } = await seedUser()
    const { user: owner } = await seedUser()
    const fine = await seedFine({ userId: student.id })
    const paid = await seedFine({ userId: student.id, status: 'paid' })
    const theirs = await seedFine({ userId: owner.id })
    recorder = recordEvents()

    await dispute(token, theirs.id, { reason: 'x' }) // 404
    await dispute(token, paid.id, { reason: 'x' }) // 409
    await dispute(token, fine.id, { reason: '' }) // 400
    await request(app).post(`/fines/${fine.id}/dispute`).send({ reason: 'x' }) // 401
    expect(recorder.events).toEqual([])

    expect((await dispute(token, fine.id, { reason: 'Wrong' })).status).toBe(201)
    expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])

    expect((await dispute(token, fine.id, { reason: 'Again' })).status).toBe(409) // already disputed
    expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
  })
})

describe('a dispute racing a payment, a waive or another dispute', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('dispute versus pay at once: exactly one wins', async () => {
    const { token: adminToken } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const disputedFirst = await seedFine({ userId: student.id, amount: 150 })
    const paidFirst = await seedFine({ userId: student.id, amount: 150 })
    recorder = recordEvents()

    // The dispute lands first: the payment, waiting on the row, finds it disputed and is refused.
    const payRes = await writeBlockedThenCompete(
      disputedFirst.id,
      () => pay(adminToken, disputedFirst.id, 150),
      (tx) => openDisputeIn(tx, disputedFirst.id, student.id),
    )
    expect(payRes.status).toBe(409)
    expect(payRes.body.error).toBe(BEING_DISPUTED)
    const stillOwed = await stored(disputedFirst.id)
    expect(stillOwed).toMatchObject({ status: 'pending', amount: 150, paidAt: null, paidRecordedById: null })
    expect(stillOwed.disputedAt).not.toBeNull()
    expect(await disputesOf(disputedFirst.id)).toHaveLength(1)

    // The payment lands first: the dispute, waiting on the row, finds it paid and is refused.
    const disputeRes = await writeBlockedThenCompete(
      paidFirst.id,
      () => dispute(token, paidFirst.id, { reason: 'Too late' }),
      (tx) => tx.fine.update({ where: { id: paidFirst.id }, data: { status: 'paid', paidAt: new Date(), paidRecordedById: other.id } }),
    )
    expect(disputeRes.status).toBe(409)
    expect(disputeRes.body.error).toBe(PAID_OR_WAIVED)
    expect(await stored(paidFirst.id)).toMatchObject({ status: 'paid', paidRecordedById: other.id, disputedAt: null })
    expect(await disputesOf(paidFirst.id)).toEqual([])
    // Neither refused request announced anything (the competitors wrote straight to the rows).
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('dispute versus a waive at once: exactly one wins', async () => {
    const { user: other } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    recorder = recordEvents()

    // The waive lands first: the dispute, waiting on the row, finds it waived and is refused,
    // so no dispute is opened on a fine that owes nothing. (The other order, a dispute that
    // lands first making a waive that does not name it refuse, and the free-running race,
    // are in test/services/disputeRaces.test.ts.)
    const res = await writeBlockedThenCompete(
      fine.id,
      () => dispute(token, fine.id, { reason: 'Too late' }),
      (tx) =>
        tx.fine.update({
          where: { id: fine.id },
          data: { status: 'waived', amount: 0, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Library error' },
        }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe(PAID_OR_WAIVED)
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', amount: 0, disputedAt: null })
    expect(await disputesOf(fine.id)).toEqual([])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a dispute that waited for a partial adjust still lands, on the lower fine', async () => {
    const { user: other } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    recorder = recordEvents()

    // A lowered fine is still owed and the student's one dispute is still unused.
    const res = await writeBlockedThenCompete(
      fine.id,
      () => dispute(token, fine.id, { reason: 'Still too high' }),
      (tx) =>
        tx.fine.update({
          where: { id: fine.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Hardship' },
        }),
    )

    expect(res.status).toBe(201)
    const after = await stored(fine.id)
    expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150 })
    expect(after.disputedAt).not.toBeNull()
    expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'open', reason: 'Still too high' })])
    expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
  }, 60_000)

  it('a dispute that waited for another dispute is refused, and the first stands alone', async () => {
    const { user: student, token } = await seedUser()
    const fine = await seedFine({ userId: student.id })
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => dispute(token, fine.id, { reason: 'Second' }),
      (tx) => openDisputeIn(tx, fine.id, student.id),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe(ALREADY_DISPUTED)
    expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ reason: 'Disputed first' })])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a dispute and a payment sent at once: one lands, the other is told why, the rows agree', async () => {
    const { token: adminToken, user: librarian } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const wins = { dispute: 0, pay: 0 }

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine({ userId: student.id, amount: 150 })
      recorder = recordEvents()

      const [paid, disputed] = await together(
        round,
        () => pay(adminToken, fine.id, 150),
        () => dispute(token, fine.id, { reason: 'Wrong' }),
      )

      recorder.stop()
      const after = await stored(fine.id)
      if (paid.status === 200) {
        wins.pay++
        expect(disputed.status).toBe(409)
        expect(disputed.body.error).toBe(PAID_OR_WAIVED)
        expect(after).toMatchObject({ status: 'paid', paidRecordedById: librarian.id, disputedAt: null })
        expect(await disputesOf(fine.id)).toEqual([])
        expect(recorder.events).toEqual([FINE_CHANGED])
      } else {
        wins.dispute++
        expect(paid.status).toBe(409)
        expect(paid.body.error).toBe(BEING_DISPUTED)
        expect(disputed.status).toBe(201)
        expect(after).toMatchObject({ status: 'pending', paidAt: null, paidRecordedById: null })
        expect(after.disputedAt).not.toBeNull()
        expect(await disputesOf(fine.id)).toHaveLength(1)
        expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
      }
    }
    expect(wins.dispute + wins.pay).toBe(ROUNDS)
  }, 90_000)

  it('two disputes sent at once: exactly one is created', async () => {
    const { user: student, token } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine({ userId: student.id })
      recorder = recordEvents()

      const [first, second] = await together(
        round,
        () => dispute(token, fine.id, { reason: 'First' }),
        () => dispute(token, fine.id, { reason: 'Second' }),
      )

      recorder.stop()
      expect([first.status, second.status].sort()).toEqual([201, 409])
      const loser = first.status === 409 ? first : second
      expect(loser.body.error).toBe(ALREADY_DISPUTED)
      const winner = first.status === 201 ? 'First' : 'Second'
      expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ reason: winner })])
      expect((await stored(fine.id)).disputedAt).not.toBeNull()
      expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
    }
  }, 90_000)
})
