// A fine's dispute racing the writes that can change the fine: a waive or a partial
// adjust that does not name it, an adjust that does, an uphold, a payment. All of them
// are decided on the fine row, so whichever commits first wins and the other is told why;
// a librarian can never close a dispute unseen, and a dispute is never closed twice.
//
// Each pair is pinned both ways with a held row lock (test/helpers/rowLock.ts: the action's
// write waits on the lock, the competitor lands, then the action runs against the changed
// row), and the pairs that matter also run free for several rounds, swapping which request
// starts first, because Promise.all alone only hits a bad interleaving by luck. The race
// between a dispute and a payment, and between two disputes, is pinned in
// test/routes/disputes.test.ts; pay against adjust is also in fineRaces.test.ts.
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'
import { writeBlockedThenCompete } from '../helpers/rowLock'

const DAY_MS = 24 * 60 * 60 * 1000
const ROUNDS = 8

const JUST_DISPUTED = 'This fine was just disputed. Read the dispute before changing the fine.'
const RESOLVED = 'This dispute was already resolved.'
const BEING_DISPUTED = 'This fine is being disputed. Resolve the dispute first.'
const PAID_OR_WAIVED = "This fine can't be disputed because it is already paid or waived."
const FINE_CHANGED = { type: 'fine.changed', topics: ['fines'] }
const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A fine on a returned loan of a fresh book, so the notices have an item to name. */
async function seedFine(userId: string, amount = 150) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Refactoring', author: 'Someone', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  const dueAt = new Date(Date.now() - 10 * DAY_MS)
  const loan = await prisma.loan.create({
    data: { userId, bookCopyId: copy.id, dueAt, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), status: 'returned', returnedAt: new Date() },
  })
  return prisma.fine.create({ data: { userId, relatedLoanId: loan.id, amount, reason: 'overdue' } })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const dispute = (token: string, fineId: string) =>
  request(app).post(`/fines/${fineId}/dispute`).set(auth(token)).send({ reason: 'Wrong' })
const adjust = (token: string, fineId: string, amount: number, reason: string, disputeId?: string) =>
  request(app).post(`/admin/fines/${fineId}/adjust`).set(auth(token)).send({ amount, reason, ...(disputeId ? { disputeId } : {}) })
const uphold = (token: string, disputeId: string) => request(app).post(`/admin/disputes/${disputeId}/uphold`).set(auth(token)).send({})
const pay = (token: string, fineId: string, amount: number) =>
  request(app).post(`/admin/fines/${fineId}/paid`).set(auth(token)).send({ amount })

const stored = (id: string) => prisma.fine.findUniqueOrThrow({ where: { id } })
const disputesOf = (fineId: string) => prisma.fineDispute.findMany({ where: { fineId } })
const noticesOf = (fineId: string) => prisma.notice.findMany({ where: { fineId } })

/** What a dispute that landed first leaves on the rows, written by the lock-holding competitor. */
async function openDisputeIn(tx: Prisma.TransactionClient, fineId: string, userId: string, id: string = randomUUID()) {
  await tx.fine.update({ where: { id: fineId }, data: { disputedAt: new Date() } })
  await tx.fineDispute.create({ data: { id, fineId, userId, reason: 'Disputed first' } })
  return id
}

/** The event types published so far, sorted: two requests at once may announce themselves in either order. */
const eventTypes = (r: ReturnType<typeof recordEvents>) => r.events.map((e) => e.type).sort()

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

// A race needs both requests to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

let savedAllowedDomains: string | undefined
let recorder: ReturnType<typeof recordEvents> | undefined

beforeEach(async () => {
  savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
  delete process.env.MAIL_ALLOWED_DOMAINS
  setMailTransport(null)
  await resetDb()
})

afterEach(() => {
  recorder?.stop()
  recorder = undefined
  setMailTransport(null)
  if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
  else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
  vi.restoreAllMocks()
})

describe('a dispute and a change to the fine it is about', () => {
  it('dispute then partial adjust without the id is refused; partial adjust then dispute is allowed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const disputedFirst = await seedFine(student.id, 150)
    const adjustedFirst = await seedFine(student.id, 150)
    recorder = recordEvents()

    // The dispute lands first: the adjust, waiting on the row, finds it disputed and is refused.
    const refused = await writeBlockedThenCompete(
      disputedFirst.id,
      () => adjust(admin, disputedFirst.id, 50, 'Hardship'),
      (tx) => openDisputeIn(tx, disputedFirst.id, student.id),
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(JUST_DISPUTED)
    const stillDisputed = await stored(disputedFirst.id)
    expect(stillDisputed).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, adjustedById: null })
    expect(stillDisputed.disputedAt).not.toBeNull()
    expect(await disputesOf(disputedFirst.id)).toEqual([expect.objectContaining({ status: 'open', resolutionNote: null })])
    expect(await noticesOf(disputedFirst.id)).toEqual([])
    expect(recorder.events).toEqual([])

    // The adjust lands first: the student may still dispute the now-lower fine (their one dispute).
    const allowed = await writeBlockedThenCompete(
      adjustedFirst.id,
      () => dispute(token, adjustedFirst.id),
      (tx) =>
        tx.fine.update({
          where: { id: adjustedFirst.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Hardship' },
        }),
    )
    expect(allowed.status).toBe(201)
    const lowered = await stored(adjustedFirst.id)
    expect(lowered).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150 })
    expect(lowered.disputedAt).not.toBeNull()
    expect(await disputesOf(adjustedFirst.id)).toEqual([expect.objectContaining({ status: 'open' })])
    expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
  }, 60_000)

  it('dispute then waive: a waive that did not name the dispute is refused, one that does lands and closes it', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const unnamed = await seedFine(student.id, 150)
    const named = await seedFine(student.id, 80)
    const namedDisputeId = randomUUID()
    recorder = recordEvents()

    const refused = await writeBlockedThenCompete(
      unnamed.id,
      () => adjust(admin, unnamed.id, 0, 'Library error'),
      (tx) => openDisputeIn(tx, unnamed.id, student.id),
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(JUST_DISPUTED)
    const kept = await stored(unnamed.id)
    expect(kept).toMatchObject({ status: 'pending', amount: 150 })
    expect(kept.disputedAt).not.toBeNull()
    expect(await disputesOf(unnamed.id)).toEqual([expect.objectContaining({ status: 'open' })])
    expect(await noticesOf(unnamed.id)).toEqual([])
    expect(recorder.events).toEqual([])

    // A librarian who named this dispute (they had read it) is not refused when it lands first:
    // the check reads the dispute under the row's lock, so it sees one that was just opened.
    const landed = await writeBlockedThenCompete(
      named.id,
      () => adjust(admin, named.id, 0, 'Library error', namedDisputeId),
      (tx) => openDisputeIn(tx, named.id, student.id, namedDisputeId),
    )
    expect(landed.status).toBe(200)
    expect(landed.body).toMatchObject({ status: 'waived', amount: 0, dispute: null })
    expect(await stored(named.id)).toMatchObject({ status: 'waived', amount: 0, disputedAt: null })
    expect(await disputesOf(named.id)).toEqual([
      expect.objectContaining({ id: namedDisputeId, status: 'waived', resolutionNote: 'Library error', resolvedById: librarian.id }),
    ])
    expect(await noticesOf(named.id)).toEqual([expect.objectContaining({ title: 'Your fine was waived' })])
    expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
  }, 60_000)

  it('a waive that waited for a dispute to be resolved by someone else is refused as resolved', async () => {
    const { token: admin, user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine(student.id, 150)
    const disputeId = randomUUID()
    // The console showed the dispute; a colleague upholds it before the waive reaches the server.
    await prisma.$transaction(async (tx) => {
      await openDisputeIn(tx, fine.id, student.id, disputeId)
    })
    recorder = recordEvents()

    const res = await writeBlockedThenCompete(
      fine.id,
      () => adjust(admin, fine.id, 0, 'Library error', disputeId),
      async (tx) => {
        await tx.fineDispute.update({ where: { id: disputeId }, data: { status: 'upheld', resolvedById: other.id, resolvedAt: new Date() } })
        await tx.fine.update({ where: { id: fine.id }, data: { disputedAt: null } })
      },
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe(RESOLVED)
    expect(await stored(fine.id)).toMatchObject({ status: 'pending', amount: 150, disputedAt: null })
    expect(await noticesOf(fine.id)).toEqual([])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a dispute and a waive sent at once: exactly one wins, and a dispute is never closed unread', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const wins = { waive: 0, dispute: 0 }
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id, 150)
      recorder = recordEvents()

      const [waived, disputed] = await together(
        round,
        () => adjust(admin, fine.id, 0, 'Library error'),
        () => dispute(token, fine.id),
      )

      recorder.stop()
      const after = await stored(fine.id)
      if (waived.status === 200) {
        wins.waive++
        // The waive landed first: a waived fine cannot be disputed, so no dispute exists at all.
        expect(disputed.status).toBe(409)
        expect(disputed.body.error).toBe(PAID_OR_WAIVED)
        expect(after).toMatchObject({ status: 'waived', amount: 0, adjustedById: librarian.id, disputedAt: null })
        expect(await disputesOf(fine.id)).toEqual([])
        expect(await noticesOf(fine.id)).toEqual([])
        expect(recorder.events).toEqual([FINE_CHANGED])
      } else {
        wins.dispute++
        // The dispute landed first: the waive did not name it, so it is refused and the dispute waits, open.
        expect(waived.status).toBe(409)
        expect(waived.body.error).toBe(JUST_DISPUTED)
        expect(disputed.status).toBe(201)
        expect(after).toMatchObject({ status: 'pending', amount: 150, adjustedById: null })
        expect(after.disputedAt).not.toBeNull()
        expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'open', resolutionNote: null })])
        expect(await noticesOf(fine.id)).toEqual([])
        expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
      }
    }
    expect(wins.waive + wins.dispute).toBe(ROUNDS)
  }, 120_000)

  it('a dispute and a partial adjust sent at once: the adjust never closes a dispute it did not name', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id, 150)
      recorder = recordEvents()

      const [adjusted, disputed] = await together(
        round,
        () => adjust(admin, fine.id, 50, 'Hardship'),
        () => dispute(token, fine.id),
      )

      recorder.stop()
      const after = await stored(fine.id)
      if (adjusted.status === 200) {
        // The adjust landed first and the student then disputed the lower fine: the dispute is open.
        expect(disputed.status).toBe(201)
        expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150 })
        expect(after.disputedAt).not.toBeNull()
        expect(eventTypes(recorder)).toEqual(['attention.changed', 'fine.changed', 'fine.changed'])
      } else {
        // The dispute landed first: the adjust is refused until the librarian has seen it.
        expect(adjusted.status).toBe(409)
        expect(adjusted.body.error).toBe(JUST_DISPUTED)
        expect(disputed.status).toBe(201)
        expect(after).toMatchObject({ status: 'pending', amount: 150, originalAmount: null })
        expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
      }
      // Either way exactly one dispute, still open, and nothing was sent to the student.
      expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'open', resolutionNote: null, resolvedAt: null })])
      expect(await noticesOf(fine.id)).toEqual([])
    }
  }, 120_000)
})

describe('restoring a copy while a dispute lands on its replacement fine', () => {
  it('a restore that waited for the dispute to open waives the fine and closes the dispute, so none is left open on a waived fine', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Dune', author: 'Someone', totalCopies: 1 } })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'lost' } })
    const loan = await prisma.loan.create({
      data: {
        userId: student.id,
        bookCopyId: copy.id,
        borrowedAt: new Date(Date.now() - 10 * DAY_MS),
        dueAt: new Date(Date.now() - 2 * DAY_MS),
        status: 'lost',
        lostAt: new Date(Date.now() - DAY_MS),
      },
    })
    const fine = await prisma.fine.create({ data: { userId: student.id, relatedLoanId: loan.id, amount: 400, reason: 'lost' } })
    recorder = recordEvents()

    // The student's dispute lands first; the restore, waiting on the fine, then waives it.
    const res = await writeBlockedThenCompete(
      fine.id,
      () => request(app).post(`/admin/copies/${copy.id}/restore`).set(auth(admin)).send({ waiveReplacementCharge: true }),
      (tx) => openDisputeIn(tx, fine.id, student.id),
    )

    expect(res.status).toBe(200)
    expect(res.body.replacementWaived).toBe(true)
    expect(await stored(fine.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 400, disputedAt: null })
    expect(await disputesOf(fine.id)).toEqual([
      expect.objectContaining({ status: 'waived', resolutionNote: 'Book returned after it was marked lost', resolvedById: librarian.id }),
    ])
    expect(await noticesOf(fine.id)).toEqual([
      expect.objectContaining({
        title: 'Your fine was waived',
        body: 'The library waived the ₹400 fine for Dune.\n\nNote from the library: Book returned after it was marked lost',
      }),
    ])
    expect(recorder.events).toEqual([{ type: 'catalogue.changed', topics: ['catalogue', 'fines', 'attention'] }])
  }, 60_000)
})

describe('pay versus adjust', () => {
  it('pay versus adjust keeps slice 5\'s rule', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: other } = await seedUser('admin')
    const { user: student } = await seedUser()
    const adjustFirst = await seedFine(student.id, 150)
    const payFirst = await seedFine(student.id, 150)
    recorder = recordEvents()

    // The adjust lands first: a payment of the old amount is refused and the fine stays at ₹50.
    const payRes = await writeBlockedThenCompete(
      adjustFirst.id,
      () => pay(admin, adjustFirst.id, 150),
      (tx) =>
        tx.fine.update({
          where: { id: adjustFirst.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Hardship' },
        }),
    )
    expect(payRes.status).toBe(409)
    expect(payRes.body.error).toBe('This fine was just changed to ₹50. Check it before marking it paid.')
    expect(await stored(adjustFirst.id)).toMatchObject({ status: 'adjusted', amount: 50, paidAt: null, paidRecordedById: null })

    // The payment lands first: the adjust is refused, writes nothing and sends nothing.
    const adjustRes = await writeBlockedThenCompete(
      payFirst.id,
      () => adjust(admin, payFirst.id, 50, 'Too late'),
      (tx) => tx.fine.update({ where: { id: payFirst.id }, data: { status: 'paid', paidAt: new Date(), paidRecordedById: other.id } }),
    )
    expect(adjustRes.status).toBe(409)
    expect(adjustRes.body.error).toBe('This fine is already paid.')
    expect(await stored(payFirst.id)).toMatchObject({ status: 'paid', amount: 150, originalAmount: null, adjustedById: null, adjustReason: null, paidRecordedById: other.id })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('pay and adjust sent at once: exactly one wins and the loser is told which', async () => {
    const { token: payer, user: payerUser } = await seedUser('admin')
    const { token: adjuster, user: adjusterUser } = await seedUser('admin')
    const { user: student } = await seedUser()
    await warmPool()

    for (let round = 0; round < ROUNDS / 2; round++) {
      const fine = await seedFine(student.id, 150)
      recorder = recordEvents()

      const [paid, adjusted] = await together(
        round,
        () => pay(payer, fine.id, 150),
        () => adjust(adjuster, fine.id, 50, 'Hardship'),
      )

      recorder.stop()
      expect([paid.status, adjusted.status].sort()).toEqual([200, 409])
      const after = await stored(fine.id)
      if (paid.status === 200) {
        expect(adjusted.body.error).toBe('This fine is already paid.')
        expect(after).toMatchObject({ status: 'paid', amount: 150, adjustedById: null, paidRecordedById: payerUser.id })
      } else {
        expect(paid.body.error).toBe('This fine was just changed to ₹50. Check it before marking it paid.')
        expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: adjusterUser.id, paidAt: null })
      }
      expect(recorder.events).toEqual([FINE_CHANGED])
    }
  }, 120_000)

})

describe('an uphold racing the writes that can also close the dispute', () => {
  function countingTransport() {
    const sendMail = vi.fn<MailTransport['send']>(async () => ({ ok: true }))
    setMailTransport({ send: sendMail })
    return sendMail
  }

  it('an uphold that waited for an adjust that closed the dispute, and an adjust that waited for an uphold, are both refused as resolved', async () => {
    const { token: admin, user: other } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const adjustedFirst = await seedFine(student.id, 150)
    const upheldFirst = await seedFine(student.id, 150)
    const adjustedDispute = (await dispute(token, adjustedFirst.id)).body.id as string
    const upheldDispute = (await dispute(token, upheldFirst.id)).body.id as string
    const sendMail = countingTransport()
    recorder = recordEvents()

    // The adjust lands first and closes the dispute: the uphold finds it resolved and writes no notice.
    const upholdRes = await writeBlockedThenCompete(
      adjustedFirst.id,
      () => uphold(admin, adjustedDispute),
      async (tx) => {
        await tx.fine.update({
          where: { id: adjustedFirst.id },
          data: { status: 'adjusted', amount: 50, originalAmount: 150, adjustedById: other.id, adjustedAt: new Date(), adjustReason: 'Hardship', disputedAt: null },
        })
        await tx.fineDispute.update({ where: { id: adjustedDispute }, data: { status: 'adjusted', resolvedById: other.id, resolvedAt: new Date(), resolutionNote: 'Hardship' } })
      },
    )
    expect(upholdRes.status).toBe(409)
    expect(upholdRes.body.error).toBe(RESOLVED)
    expect(await disputesOf(adjustedFirst.id)).toEqual([expect.objectContaining({ status: 'adjusted', resolutionNote: 'Hardship' })])
    expect(await noticesOf(adjustedFirst.id)).toEqual([])

    // The uphold lands first: the adjust that named the dispute finds it resolved and changes nothing.
    const adjustRes = await writeBlockedThenCompete(
      upheldFirst.id,
      () => adjust(admin, upheldFirst.id, 50, 'Too late', upheldDispute),
      async (tx) => {
        await tx.fineDispute.update({ where: { id: upheldDispute }, data: { status: 'upheld', resolvedById: other.id, resolvedAt: new Date() } })
        await tx.fine.update({ where: { id: upheldFirst.id }, data: { disputedAt: null } })
      },
    )
    expect(adjustRes.status).toBe(409)
    expect(adjustRes.body.error).toBe(RESOLVED)
    expect(await stored(upheldFirst.id)).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, adjustedById: null })
    expect(await noticesOf(upheldFirst.id)).toEqual([])
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('an uphold and an adjust that names the dispute, sent at once: one resolution, one notice, one email', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const sendMail = countingTransport()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const fine = await seedFine(student.id, 150)
      const disputeId = (await dispute(token, fine.id)).body.id as string
      sendMail.mockClear()
      recorder = recordEvents()

      const [upheld, adjusted] = await together(
        round,
        () => uphold(admin, disputeId),
        () => adjust(admin, fine.id, 50, 'Hardship', disputeId),
      )

      recorder.stop()
      expect([upheld.status, adjusted.status].sort()).toEqual([200, 409])
      const loser = upheld.status === 409 ? upheld : adjusted
      expect(loser.body.error).toBe(RESOLVED)
      const [notice] = await noticesOf(fine.id)
      expect(await noticesOf(fine.id)).toHaveLength(1)
      const after = await stored(fine.id)
      const [closed] = await disputesOf(fine.id)
      if (upheld.status === 200) {
        expect(closed.status).toBe('upheld')
        expect(after).toMatchObject({ status: 'pending', amount: 150, originalAmount: null, disputedAt: null })
        expect(notice.title).toBe('Your fine stands')
      } else {
        expect(closed.status).toBe('adjusted')
        expect(after).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, disputedAt: null })
        expect(notice.title).toBe('Your fine was reduced')
      }
      // The winner announced itself once and emailed once; the loser did neither.
      expect(recorder.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
      expect(sendMail).toHaveBeenCalledTimes(1)
      expect((await noticesOf(fine.id))[0].emailStatus).toBe('sent')
    }
  }, 150_000)

  it('two upholds sent at once: one resolution, one notice, one email, the other is told it was resolved', async () => {
    const { token: first } = await seedUser('admin')
    const { token: second } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    const sendMail = countingTransport()
    await warmPool()

    for (let round = 0; round < ROUNDS / 2; round++) {
      const fine = await seedFine(student.id, 150)
      const disputeId = (await dispute(token, fine.id)).body.id as string
      sendMail.mockClear()

      const [one, two] = await together(
        round,
        () => uphold(first, disputeId),
        () => uphold(second, disputeId),
      )

      expect([one.status, two.status].sort()).toEqual([200, 409])
      expect((one.status === 409 ? one : two).body.error).toBe(RESOLVED)
      expect(await noticesOf(fine.id)).toHaveLength(1)
      expect(sendMail).toHaveBeenCalledTimes(1)
      expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'upheld' })])
    }
  }, 120_000)

  it('an uphold and a payment sent at once: the payment is refused until the uphold has landed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token } = await seedUser()
    await warmPool()

    for (let round = 0; round < ROUNDS / 2; round++) {
      const fine = await seedFine(student.id, 150)
      const disputeId = (await dispute(token, fine.id)).body.id as string

      const [upheld, paid] = await together(
        round,
        () => uphold(admin, disputeId),
        () => pay(admin, fine.id, 150),
      )

      // The uphold always lands. The payment either came first and was refused as disputed
      // (the fine stays owed), or waited for the uphold and then recorded the payment.
      expect(upheld.status).toBe(200)
      const after = await stored(fine.id)
      expect(after.disputedAt).toBeNull()
      if (paid.status === 200) {
        expect(after).toMatchObject({ status: 'paid', amount: 150 })
      } else {
        expect(paid.status).toBe(409)
        expect(paid.body.error).toBe(BEING_DISPUTED)
        expect(after).toMatchObject({ status: 'pending', amount: 150, paidAt: null })
      }
      expect(await disputesOf(fine.id)).toEqual([expect.objectContaining({ status: 'upheld' })])
    }
  }, 120_000)
})
