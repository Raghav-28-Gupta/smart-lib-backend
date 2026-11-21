// A librarian marking a fine paid racing another who waives or adjusts it, and two
// adjustments racing each other. Each must end with a coherent fine and a loser
// that is told what happened, never a server error, and never a fine whose amount
// went UP because a slower write landed over a faster one.
//
// Promise.all only hits the bad interleavings by luck, so each race runs for
// several rounds, and swaps which request is started first on every other round.
// The second describe pins the interleavings that matter deterministically with a
// row lock: the action's write waits on the lock, the competing change lands, and
// only then does the write run, as if the competitor had landed just before it.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const ROUNDS = 8
const FINE_CHANGED = { type: 'fine.changed', topics: ['fines'] }

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

const seedFine = (userId: string, amount = 150) => prisma.fine.create({ data: { userId, amount, reason: 'overdue' } })

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
// `amount` is what the librarian saw and collected; the payment only lands if the fine is still that amount.
const pay = (token: string, id: string, amount: number) =>
  request(app).post(`/admin/fines/${id}/paid`).set(auth(token)).send({ amount })
const adjust = (token: string, id: string, amount: number, reason: string) =>
  request(app).post(`/admin/fines/${id}/adjust`).set(auth(token)).send({ amount, reason })
const stored = (id: string) => prisma.fine.findUniqueOrThrow({ where: { id } })

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

describe('races on one fine', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('paid and adjust at once: exactly one wins and the loser gets a specific message', async () => {
    const { token: payerToken, user: payer } = await seedUser('admin')
    const { token: adjusterToken, user: adjuster } = await seedUser('admin')
    const { user: student } = await seedUser()
    const wins = { paid: 0, adjusted: 0 }

    // The payer collected ₹150, the amount on the screen when the adjust to ₹50
    // was sent: the payment must not land on the fine that was just lowered.
    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id)
      recorder = recordEvents()

      const [paid, adjusted] = await together(
        round,
        () => pay(payerToken, fine.id, 150),
        () => adjust(adjusterToken, fine.id, 50, 'Hardship'),
      )

      recorder.stop()
      expect([paid.status, adjusted.status].sort()).toEqual([200, 409])
      const after = await stored(fine.id)
      if (paid.status === 200) {
        wins.paid++
        // The payment landed first: the adjust is refused and wrote nothing.
        expect(adjusted.body.error).toBe('This fine is already paid.')
        expect(after).toMatchObject({ status: 'paid', amount: 150, originalAmount: null, adjustedById: null, adjustReason: null, paidRecordedById: payer.id })
        expect(after.paidAt).not.toBeNull()
      } else {
        wins.adjusted++
        // The adjust landed first: the payment, made against the old amount, is refused and recorded nothing.
        expect(paid.body.error).toBe('This fine was just changed to ₹50. Check it before marking it paid.')
        expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: adjuster.id, adjustReason: 'Hardship', paidAt: null, paidRecordedById: null })
      }
      // The winner announced itself once; the loser said nothing.
      expect(recorder.events).toEqual([FINE_CHANGED])
    }
    expect(wins.paid + wins.adjusted).toBe(ROUNDS)
  }, 90_000)

  it('paid and a waive at once: exactly one wins and the loser gets a specific message', async () => {
    const { token: payerToken, user: payer } = await seedUser('admin')
    const { token: waiverToken, user: waiver } = await seedUser('admin')
    const { user: student } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id)
      recorder = recordEvents()

      const [paid, waived] = await together(
        round,
        () => pay(payerToken, fine.id, 150),
        () => adjust(waiverToken, fine.id, 0, 'Library error'),
      )

      recorder.stop()
      expect([paid.status, waived.status].sort()).toEqual([200, 409])
      const after = await stored(fine.id)
      if (paid.status === 200) {
        expect(waived.body.error).toBe('This fine is already paid.')
        expect(after).toMatchObject({ status: 'paid', amount: 150, originalAmount: null, adjustedById: null, adjustReason: null, paidRecordedById: payer.id })
      } else {
        expect(paid.body.error).toBe('This fine was waived.')
        expect(after).toMatchObject({ status: 'waived', amount: 0, originalAmount: 150, adjustedById: waiver.id, adjustReason: 'Library error', paidAt: null, paidRecordedById: null })
      }
      expect(recorder.events).toEqual([FINE_CHANGED])
    }
  }, 90_000)

  it('two payments at once: exactly one is recorded and the other is told it is already paid', async () => {
    const { token: firstToken, user: first } = await seedUser('admin')
    const { token: secondToken, user: second } = await seedUser('admin')
    const { user: student } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id)
      recorder = recordEvents()

      const [one, two] = await together(
        round,
        () => pay(firstToken, fine.id, 150),
        () => pay(secondToken, fine.id, 150),
      )

      recorder.stop()
      expect([one.status, two.status].sort()).toEqual([200, 409])
      const loser = one.status === 409 ? one : two
      expect(loser.body.error).toBe('This fine is already paid.')
      // One payer on the record, the winner's.
      expect(await stored(fine.id)).toMatchObject({ status: 'paid', paidRecordedById: one.status === 200 ? first.id : second.id })
      expect(recorder.events).toEqual([FINE_CHANGED])
    }
  }, 90_000)

  it('two adjusts at once: one wins, the fine is never raised', async () => {
    const { token: firstToken, user: first } = await seedUser('admin')
    const { token: secondToken, user: second } = await seedUser('admin')
    const { user: student } = await seedUser()

    // Both ask for the same new amount, so whichever lands second is no longer lowering it.
    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id)
      recorder = recordEvents()

      const [one, two] = await together(
        round,
        () => adjust(firstToken, fine.id, 50, 'First reason'),
        () => adjust(secondToken, fine.id, 50, 'Second reason'),
      )

      recorder.stop()
      expect([one.status, two.status].sort()).toEqual([200, 400])
      const loser = one.status === 400 ? one : two
      expect(loser.body.error).toBe('The new amount must be lower than ₹50.')
      const winner = one.status === 200 ? { id: first.id, reason: 'First reason' } : { id: second.id, reason: 'Second reason' }
      // The row is the winner's alone: never a mix of the two writes.
      expect(await stored(fine.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: winner.id, adjustReason: winner.reason })
      expect(recorder.events).toEqual([FINE_CHANGED])
    }
  }, 90_000)

  it('two adjusts to different amounts at once: the lower amount always stands', async () => {
    const { token: lowerToken, user: lower } = await seedUser('admin')
    const { token: higherToken } = await seedUser('admin')
    const { user: student } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id)
      recorder = recordEvents()

      const [toFifty, toEighty] = await together(
        round,
        () => adjust(lowerToken, fine.id, 50, 'Lower'),
        () => adjust(higherToken, fine.id, 80, 'Higher'),
      )

      recorder.stop()
      // ₹50 is lower than both ₹150 and ₹80, so it can never be refused.
      expect(toFifty.status).toBe(200)
      if (toEighty.status === 200) {
        // ₹80 landed first and ₹50 then lowered it.
        expect(recorder.events).toEqual([FINE_CHANGED, FINE_CHANGED])
      } else {
        // ₹50 landed first, so ₹80 would have raised the fine.
        expect(toEighty.status).toBe(400)
        expect(toEighty.body.error).toBe('The new amount must be lower than ₹50.')
        expect(recorder.events).toEqual([FINE_CHANGED])
      }
      // Either way the fine ends at ₹50, with the original kept and the lower adjust as the latest.
      expect(await stored(fine.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: lower.id, adjustReason: 'Lower' })
    }
  }, 90_000)
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
  throw new Error('The action never blocked on the fine row')
}

/**
 * Locks the fine row, starts `action`, waits until its write is blocked on that
 * lock, lets `competitor` change the row in the locking transaction and commits.
 * The action's write then runs against the changed row, exactly as if the
 * competitor had landed just before it. An action that read the fine first and
 * wrote it blindly afterwards would be caught here: a plain read is not blocked
 * by the lock, so it would see the old row.
 */
async function writeBlockedThenCompete(
  fineId: string,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Fine" WHERE id = ${fineId} FOR UPDATE`
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

describe('a fine changed while a write on it was waiting', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('an adjust to ₹80 that waited for an adjust to ₹50 is refused and the fine stays at ₹50', async () => {
    const { token } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => adjust(token, fine.id, 80, 'Higher'),
      (tx) =>
        tx.fine.update({
          where: { id: fine.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Lower' },
        }),
    )

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('The new amount must be lower than ₹50.')
    expect(await stored(fine.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustReason: 'Lower' })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('an adjust that waited for a payment is refused and the fine stays paid at its amount', async () => {
    const { token } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => adjust(token, fine.id, 50, 'Too late'),
      (tx) => tx.fine.update({ where: { id: fine.id }, data: { status: 'paid', paidAt: new Date(), paidRecordedById: other.id } }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine is already paid.')
    expect(await stored(fine.id)).toMatchObject({ status: 'paid', amount: 150, originalAmount: null, adjustedById: null, adjustReason: null, paidRecordedById: other.id })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a payment that waited for a waive is refused and the fine stays waived', async () => {
    const { token } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => pay(token, fine.id, 150),
      (tx) =>
        tx.fine.update({
          where: { id: fine.id },
          data: { status: 'waived', amount: 0, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Library error' },
        }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine was waived.')
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', amount: 0, paidAt: null, paidRecordedById: null })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a payment that waited for another payment is refused and keeps the first payer', async () => {
    const { token } = await seedUser('admin')
    const { user: first } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id)
    const paidAt = new Date(Date.now() - 60_000)
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => pay(token, fine.id, 150),
      (tx) => tx.fine.update({ where: { id: fine.id }, data: { status: 'paid', paidAt, paidRecordedById: first.id } }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine is already paid.')
    expect(await stored(fine.id)).toMatchObject({ status: 'paid', paidAt, paidRecordedById: first.id })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a payment of ₹150 that waited for an adjust to ₹50 is refused and the fine stays adjusted at ₹50', async () => {
    const { token } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id)
    recorder = recordEvents()

    // The librarian collected ₹150 against the old amount. An adjusted fine can be
    // paid, but not by a payment that was made against what it used to be.
    const res = await writeBlockedThenCompete(
      fine.id,
      () => pay(token, fine.id, 150),
      (tx) =>
        tx.fine.update({
          where: { id: fine.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Hardship' },
        }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This fine was just changed to ₹50. Check it before marking it paid.')
    expect(await stored(fine.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, paidAt: null, paidRecordedById: null })
    expect(recorder.events).toEqual([])
  }, 60_000)
})
