// A librarian resolving a student's fine dispute: waiving or adjusting the fine with
// the dispute named, or upholding it. Covers the notice each outcome sends and its
// email, the refusals (and that a refusal writes, sends and publishes nothing), the
// live events, and the dates the new writes record. The interleavings are in
// test/services/disputeRaces.test.ts, the queue in test/routes/adminAttention.test.ts
// and the restore path in test/routes/adminCopies.test.ts.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { EmailStatus, FineStatus, Prisma } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { adjustFine } from '../../src/services/adminFineService'
import { closeDisputeOnFine, upholdDispute } from '../../src/services/disputeService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const JUST_DISPUTED = 'This fine was just disputed. Read the dispute before changing the fine.'
const RESOLVED = 'This dispute was already resolved.'
const BEING_DISPUTED = 'This fine is being disputed. Resolve the dispute first.'
const FINE_CHANGED = { type: 'fine.changed', topics: ['fines'] }
const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

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

interface FineSeed {
  userId: string
  amount?: number
  status?: FineStatus
  originalAmount?: number
  adjustReason?: string
  adjustedById?: string
  title?: string
}

/** A fine on a returned loan of a fresh book, so the console lists it with an item. */
async function seedFine({ userId, amount = 150, status = 'pending', originalAmount, adjustReason, adjustedById, title = 'Refactoring' }: FineSeed) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Someone', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  const dueAt = new Date(Date.now() - 10 * DAY_MS)
  const loan = await prisma.loan.create({
    data: { userId, bookCopyId: copy.id, dueAt, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), status: 'returned', returnedAt: new Date() },
  })
  return prisma.fine.create({
    data: { userId, relatedLoanId: loan.id, amount, reason: 'overdue', status, originalAmount, adjustReason, adjustedById },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const send = (req: request.Test, body?: unknown) => (body === undefined ? req : req.send(body as object))
const adjust = (token: string, fineId: string, body?: unknown) =>
  send(request(app).post(`/admin/fines/${fineId}/adjust`).set(auth(token)), body)
const uphold = (token: string, disputeId: string, body?: unknown) =>
  send(request(app).post(`/admin/disputes/${disputeId}/uphold`).set(auth(token)), body)
const pay = (token: string, fineId: string, amount: number) =>
  request(app).post(`/admin/fines/${fineId}/paid`).set(auth(token)).send({ amount })

/** The student disputes through the real route, so the rows are exactly what a dispute leaves. */
async function openDispute(studentToken: string, fineId: string, reason = 'I returned it on time'): Promise<string> {
  const res = await request(app).post(`/fines/${fineId}/dispute`).set(auth(studentToken)).send({ reason })
  expect(res.status).toBe(201)
  return res.body.id as string
}

const stored = (id: string) => prisma.fine.findUniqueOrThrow({ where: { id } })
const disputeOf = (id: string) => prisma.fineDispute.findUniqueOrThrow({ where: { id } })
const allNotices = () => prisma.notice.findMany({ orderBy: { createdAt: 'asc' } })

/** Injects a fake mail transport (cleared in afterEach); email is then configured, and nothing leaves the process. */
function fakeTransport(ok = true) {
  const sendMail = vi.fn<MailTransport['send']>(async () => ({ ok }))
  setMailTransport({ send: sendMail })
  return sendMail
}

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

describe('adjusting or waiving a disputed fine', () => {
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('adjusting a disputed fine with its dispute id closes it as adjusted (waived at 0), clears the marker, writes the notice with the reason, and the student sees both on /fines/me and /notices/me', async () => {
    const { token: admin, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student, token: studentToken } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const lowered = await seedFine({ userId: student.id, amount: 150, title: 'Refactoring' })
    const waived = await seedFine({ userId: student.id, amount: 80, title: 'Clean Code' })
    const loweredDispute = await openDispute(studentToken, lowered.id, 'I returned it on time')
    const waivedDispute = await openDispute(studentToken, waived.id, 'It was never mine')
    const before = Date.now()

    const lowerRes = await adjust(admin, lowered.id, { amount: 50, reason: 'Receipt shown', disputeId: loweredDispute })
    const waiveRes = await adjust(admin, waived.id, { amount: 0, reason: 'Library error', disputeId: waivedDispute })

    expect(lowerRes.status).toBe(200)
    expect(lowerRes.body).toMatchObject({
      id: lowered.id,
      status: 'adjusted',
      amount: 50,
      originalAmount: 150,
      note: 'Receipt shown',
      recordedBy: 'Priya Menon',
      dispute: null,
      canSettle: true,
    })
    expect(waiveRes.status).toBe(200)
    expect(waiveRes.body).toMatchObject({ id: waived.id, status: 'waived', amount: 0, originalAmount: 80, note: 'Library error', dispute: null, canSettle: false })

    // The disputes are closed: waived at 0, adjusted otherwise, the adjustment's reason as the note.
    const closedLowered = await disputeOf(loweredDispute)
    const closedWaived = await disputeOf(waivedDispute)
    expect(closedLowered).toMatchObject({ status: 'adjusted', resolutionNote: 'Receipt shown', resolvedById: librarian.id })
    expect(closedWaived).toMatchObject({ status: 'waived', resolutionNote: 'Library error', resolvedById: librarian.id })
    for (const closed of [closedLowered, closedWaived]) {
      expect(closed.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before)
      expect(closed.resolvedAt!.getTime()).toBeLessThanOrEqual(Date.now())
    }
    // The markers are cleared and the fines are what the adjustments made them.
    expect(await stored(lowered.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, disputedAt: null, adjustReason: 'Receipt shown' })
    expect(await stored(waived.id)).toMatchObject({ status: 'waived', amount: 0, originalAmount: 80, disputedAt: null })

    // One notice each, to the student, from the librarian, about the fine.
    const notices = await allNotices()
    expect(notices).toHaveLength(2)
    const forLowered = notices.find((n) => n.fineId === lowered.id)!
    const forWaived = notices.find((n) => n.fineId === waived.id)!
    expect(forLowered).toMatchObject({
      userId: student.id,
      kind: 'dispute_outcome',
      title: 'Your fine was reduced',
      body: 'The library reduced your fine for Refactoring to ₹50 (it was ₹150).\n\nNote from the library: Receipt shown',
      loanId: null,
      createdById: librarian.id,
    })
    expect(forWaived).toMatchObject({
      userId: student.id,
      kind: 'dispute_outcome',
      title: 'Your fine was waived',
      body: 'The library waived the ₹80 fine for Clean Code.\n\nNote from the library: Library error',
      createdById: librarian.id,
    })

    // The student sees the resolved dispute with the library's note, and the notice.
    const fines = await request(app).get('/fines/me').set(auth(studentToken))
    const mine = (id: string) => (fines.body.fines as Array<{ id: string }>).find((f) => f.id === id)
    expect(mine(lowered.id)).toMatchObject({ status: 'adjusted', amount: 50, dispute: { status: 'adjusted', note: 'Receipt shown' } })
    expect(mine(waived.id)).toMatchObject({ status: 'waived', amount: 0, dispute: { status: 'waived', note: 'Library error' } })
    const seen = await request(app).get('/notices/me').set(auth(studentToken))
    expect(seen.status).toBe(200)
    expect((seen.body as Array<{ title: string; body: string; kind: string }>).map((n) => [n.kind, n.title, n.body]).sort()).toEqual([
      ['dispute_outcome', 'Your fine was reduced', forLowered.body],
      ['dispute_outcome', 'Your fine was waived', forWaived.body],
    ])
  })

  it('adjusting a fine that was already lowered says what the student was disputing: reduced from, waived at, the amount just before', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    // Both fines were lowered from 150 to 100 before the student disputed them.
    const lower = { amount: 100, status: 'adjusted' as const, originalAmount: 150, adjustReason: 'Hardship', adjustedById: librarian.id }
    const reduced = await seedFine({ userId: student.id, title: 'Refactoring', ...lower })
    const waived = await seedFine({ userId: student.id, title: 'Clean Code', ...lower })
    const reducedDispute = await openDispute(studentToken, reduced.id)
    const waivedDispute = await openDispute(studentToken, waived.id)

    expect((await adjust(admin, reduced.id, { amount: 50, reason: 'Second look', disputeId: reducedDispute })).status).toBe(200)
    expect((await adjust(admin, waived.id, { amount: 0, reason: 'Second look', disputeId: waivedDispute })).status).toBe(200)

    const notices = await allNotices()
    expect(notices.find((n) => n.fineId === reduced.id)!.body).toBe(
      'The library reduced your fine for Refactoring to ₹50 (it was ₹100).\n\nNote from the library: Second look',
    )
    expect(notices.find((n) => n.fineId === waived.id)!.body).toBe(
      'The library waived the ₹100 fine for Clean Code.\n\nNote from the library: Second look',
    )
    // The fine keeps the first original amount, as every adjustment does.
    expect(await stored(reduced.id)).toMatchObject({ amount: 50, originalAmount: 150 })
  })

  it('adjusting without the dispute id is 409 "This fine was just disputed…" and changes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    const disputeId = await openDispute(studentToken, fine.id)
    const before = await stored(fine.id)
    const sendMail = fakeTransport()
    recorder = recordEvents()

    const lowered = await adjust(admin, fine.id, { amount: 50, reason: 'Hardship' })
    const waived = await adjust(admin, fine.id, { amount: 0, reason: 'Library error', disputeId: null })

    for (const res of [lowered, waived]) {
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(JUST_DISPUTED)
    }
    // Not a column moved, the dispute is still open, nothing was written, sent or published.
    expect(await stored(fine.id)).toEqual(before)
    expect(await disputeOf(disputeId)).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('adjusting with the id of a closed dispute is 409 "This dispute was already resolved."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const upheld = await seedFine({ userId: student.id, amount: 150 })
    const upheldDispute = await openDispute(studentToken, upheld.id)
    expect((await uphold(admin, upheldDispute)).status).toBe(200)
    // An undisputed fine, a request that names a dispute that is not its own, and a made-up id.
    const calm = await seedFine({ userId: student.id, amount: 90 })
    const other = await seedFine({ userId: student.id, amount: 70 })
    const otherDispute = await openDispute(studentToken, other.id)
    const beforeCalm = await stored(calm.id)
    const beforeOther = await stored(other.id)
    const beforeUpheld = await stored(upheld.id)
    const sendMail = fakeTransport()
    recorder = recordEvents()

    const closed = await adjust(admin, upheld.id, { amount: 50, reason: 'Too late', disputeId: upheldDispute })
    const notItsOwn = await adjust(admin, calm.id, { amount: 50, reason: 'Wrong id', disputeId: otherDispute })
    const unknown = await adjust(admin, calm.id, { amount: 50, reason: 'Made up', disputeId: 'no-such-dispute' })
    // The fine does have an open dispute, but it is not the one the request names.
    const wrongOne = await adjust(admin, other.id, { amount: 0, reason: 'Wrong id', disputeId: upheldDispute })

    for (const res of [closed, notItsOwn, unknown, wrongOne]) {
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(RESOLVED)
    }
    expect(await stored(upheld.id)).toEqual(beforeUpheld)
    expect(await stored(calm.id)).toEqual(beforeCalm)
    expect(await stored(other.id)).toEqual(beforeOther)
    expect(await disputeOf(otherDispute)).toMatchObject({ status: 'open' })
    expect(await prisma.notice.count()).toBe(1) // the uphold's, written before
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('an adjust of an undisputed fine still works with no disputeId, and sends no notice', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const plain = await seedFine({ userId: student.id, amount: 150 })
    const withNull = await seedFine({ userId: student.id, amount: 90 })
    // A fine whose dispute was already resolved is an ordinary fine again: no notice, nothing to close.
    const settled = await seedFine({ userId: student.id, amount: 60 })
    const settledDispute = await openDispute(studentToken, settled.id)
    expect((await uphold(admin, settledDispute)).status).toBe(200)
    const noticesBefore = await prisma.notice.count()
    const sendMail = fakeTransport()
    recorder = recordEvents()

    const a = await adjust(admin, plain.id, { amount: 50, reason: 'Hardship' })
    const b = await adjust(admin, withNull.id, { amount: 0, reason: 'Library error', disputeId: null })
    const c = await adjust(admin, settled.id, { amount: 20, reason: 'Goodwill' })

    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, dispute: null })
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ status: 'waived', amount: 0 })
    expect(c.status).toBe(200)
    expect(c.body).toMatchObject({ status: 'adjusted', amount: 20, originalAmount: 60 })
    expect(await prisma.notice.count()).toBe(noticesBefore)
    expect(await disputeOf(settledDispute)).toMatchObject({ status: 'upheld', resolutionNote: null })
    expect(sendMail).not.toHaveBeenCalled()
    // A fine nobody disputed announces a fine change only: nothing in the queue moved.
    expect(recorder.events).toEqual([FINE_CHANGED, FINE_CHANGED, FINE_CHANGED])
  })

  it('a disputeId that is not text is 400 and writes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id })
    const disputeId = await openDispute(studentToken, fine.id)
    const before = await stored(fine.id)
    recorder = recordEvents()

    for (const bad of [7, '', true, { id: disputeId }, [disputeId]]) {
      const res = await adjust(admin, fine.id, { amount: 50, reason: 'Hardship', disputeId: bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }

    expect(await stored(fine.id)).toEqual(before)
    expect(await disputeOf(disputeId)).toMatchObject({ status: 'open' })
    expect(await prisma.notice.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('an amount that is not lower is refused while disputed, and the dispute stays open with no notice', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    const disputeId = await openDispute(studentToken, fine.id)
    const before = await stored(fine.id)
    const sendMail = fakeTransport()
    recorder = recordEvents()

    const same = await adjust(admin, fine.id, { amount: 150, reason: 'No change', disputeId })
    const higher = await adjust(admin, fine.id, { amount: 200, reason: 'Higher', disputeId })

    for (const res of [same, higher]) {
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('The new amount must be lower than ₹150.')
    }
    expect(await stored(fine.id)).toEqual(before)
    expect(await disputeOf(disputeId)).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null })
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('an unknown fine, and an accruing row, are still 404 whatever dispute is named', async () => {
    const { token: admin } = await seedUser('admin')

    const unknown = await adjust(admin, 'no-such-fine', { amount: 0, reason: 'x', disputeId: 'no-such-dispute' })
    const plain = await adjust(admin, 'no-such-fine', { amount: 0, reason: 'x' })

    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Fine not found')
    expect(plain.status).toBe(404)
  })

  it('takes the date the caller passes as the sixth argument: the fine, the dispute and the uphold record it', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const lowered = await seedFine({ userId: student.id, amount: 150 })
    const kept = await seedFine({ userId: student.id, amount: 70 })
    const loweredDispute = await openDispute(studentToken, lowered.id)
    const keptDispute = await openDispute(studentToken, kept.id)
    const at = new Date(Date.now() - 3 * HOUR_MS)

    await adjustFine(lowered.id, librarian.id, 50, 'Hardship', loweredDispute, at)
    await upholdDispute(keptDispute, librarian.id, null, at)

    expect((await stored(lowered.id)).adjustedAt).toEqual(at)
    expect((await disputeOf(loweredDispute)).resolvedAt).toEqual(at)
    expect((await disputeOf(keptDispute)).resolvedAt).toEqual(at)
  })

  it('records the dates it is given when the database session is not on UTC', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const lowered = await seedFine({ userId: student.id, amount: 150 })
    const kept = await seedFine({ userId: student.id, amount: 70 })
    const loweredDispute = await openDispute(studentToken, lowered.id)
    const keptDispute = await openDispute(studentToken, kept.id)
    const at = new Date(Date.now() - 3 * HOUR_MS)

    // Every write the services make runs in a transaction whose session is on Kolkata time
    // (+5:30): a value that leaned on the session zone, a cast or the database's own clock,
    // would move by hours.
    type Work = (tx: Prisma.TransactionClient) => Promise<unknown>
    const realTransaction = prisma.$transaction.bind(prisma) as (fn: Work, options?: unknown) => Promise<unknown>
    vi.spyOn(prisma, '$transaction').mockImplementation(((fn: Work, options?: unknown) =>
      realTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return fn(tx)
      }, options)) as never)

    const dto = await adjustFine(lowered.id, librarian.id, 50, 'Hardship', loweredDispute, at)
    await upholdDispute(keptDispute, librarian.id, 'Checked', at)
    vi.restoreAllMocks()

    expect(dto.amount).toBe(50)
    expect((await stored(lowered.id)).adjustedAt).toEqual(at)
    expect((await disputeOf(loweredDispute)).resolvedAt).toEqual(at)
    expect((await disputeOf(keptDispute)).resolvedAt).toEqual(at)
  })
})

describe('the notice each outcome sends', () => {
  it("each outcome's notice text matches the spec (waived, reduced, stands)", async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { email: 'asha@example.org' })
    const sendMail = fakeTransport()
    const toWaive = await seedFine({ userId: student.id, amount: 80, title: 'Clean Code' })
    const toReduce = await seedFine({ userId: student.id, amount: 150, title: 'Refactoring' })
    const toUphold = await seedFine({ userId: student.id, amount: 60, title: 'Dune' })
    const toUpholdQuietly = await seedFine({ userId: student.id, amount: 40, title: 'Emma' })
    const ids = {
      waive: await openDispute(studentToken, toWaive.id),
      reduce: await openDispute(studentToken, toReduce.id),
      uphold: await openDispute(studentToken, toUphold.id),
      quiet: await openDispute(studentToken, toUpholdQuietly.id),
    }

    expect((await adjust(admin, toWaive.id, { amount: 0, reason: 'Library error', disputeId: ids.waive })).status).toBe(200)
    expect((await adjust(admin, toReduce.id, { amount: 50, reason: 'Receipt shown', disputeId: ids.reduce })).status).toBe(200)
    expect((await uphold(admin, ids.uphold, { note: '  The record shows it came back late.  ' })).status).toBe(200)
    expect((await uphold(admin, ids.quiet)).status).toBe(200)

    const notices = await allNotices()
    const noticeFor = (fineId: string) => notices.find((n) => n.fineId === fineId)!
    expect(noticeFor(toWaive.id)).toMatchObject({
      title: 'Your fine was waived',
      body: 'The library waived the ₹80 fine for Clean Code.\n\nNote from the library: Library error',
    })
    expect(noticeFor(toReduce.id)).toMatchObject({
      title: 'Your fine was reduced',
      body: 'The library reduced your fine for Refactoring to ₹50 (it was ₹150).\n\nNote from the library: Receipt shown',
    })
    expect(noticeFor(toUphold.id)).toMatchObject({
      title: 'Your fine stands',
      body: 'The library kept your ₹60 fine for Dune.\n\nNote from the library: The record shows it came back late.',
    })
    // No note, nothing after the sentence.
    expect(noticeFor(toUpholdQuietly.id)).toMatchObject({ title: 'Your fine stands', body: 'The library kept your ₹40 fine for Emma.' })
    for (const notice of notices) {
      expect(notice).toMatchObject({ kind: 'dispute_outcome', userId: student.id, createdById: librarian.id, loanId: null })
    }

    // The email is the same title and body, one per notice, to the student.
    expect(sendMail).toHaveBeenCalledTimes(4)
    for (const [message] of sendMail.mock.calls) {
      expect(message.to).toBe('asha@example.org')
      const notice = notices.find((n) => message.subject === `SmartLib: ${n.title}` && message.text.startsWith(n.body))
      expect(notice, message.subject).toBeDefined()
    }
  })

  it('a fine with no book or resource names no item rather than "for ."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const bare = await prisma.fine.create({ data: { userId: student.id, amount: 90, reason: 'overdue' } })
    const disputeId = await openDispute(studentToken, bare.id)

    expect((await uphold(admin, disputeId)).status).toBe(200)

    expect((await allNotices())[0].body).toBe('The library kept your ₹90 fine.')
  })

  it('closeDisputeOnFine with no previous amount reads "it was" from the fine\'s original amount, and answers null when no dispute is open', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    const calm = await seedFine({ userId: student.id, amount: 90 })
    const disputeId = await openDispute(studentToken, fine.id)
    const now = new Date()

    const [notice, none] = await prisma.$transaction(async (tx) => {
      // The fine as an adjustment to 50 leaves it, with the dispute still open.
      await tx.fine.update({ where: { id: fine.id }, data: { status: 'adjusted', amount: 50, originalAmount: 150, disputedAt: null } })
      return [
        await closeDisputeOnFine(tx, fine.id, 'adjusted', 'Receipt shown', librarian.id, now),
        await closeDisputeOnFine(tx, calm.id, 'adjusted', 'Nothing to close', librarian.id, now),
      ]
    })

    expect(notice).toMatchObject({ title: 'Your fine was reduced', fineId: fine.id })
    expect(notice!.body).toBe('The library reduced your fine for Refactoring to ₹50 (it was ₹150).\n\nNote from the library: Receipt shown')
    expect(none).toBeNull()
    expect(await disputeOf(disputeId)).toMatchObject({ status: 'adjusted', resolvedAt: now })
    expect(await prisma.notice.count()).toBe(1)
  })
})

describe('email for a dispute outcome', () => {
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a failing email transport records failed and the action stands', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { email: 'asha@example.org' })
    const adjusted = await seedFine({ userId: student.id, amount: 150 })
    const upheld = await seedFine({ userId: student.id, amount: 60 })
    const adjustedDispute = await openDispute(studentToken, adjusted.id)
    const upheldDispute = await openDispute(studentToken, upheld.id)

    // The provider refuses the first message and the transport throws on the second.
    setMailTransport({ send: async () => ({ ok: false }) })
    const lowered = await adjust(admin, adjusted.id, { amount: 50, reason: 'Hardship', disputeId: adjustedDispute })
    setMailTransport({
      send: async () => {
        throw new Error('network down')
      },
    })
    const kept = await uphold(admin, upheldDispute)

    expect(lowered.status).toBe(200)
    expect(kept.status).toBe(200)
    expect(kept.body).toEqual({ id: upheldDispute })
    // The actions stand: fine lowered, disputes closed, notices committed with the outcome recorded.
    expect(await stored(adjusted.id)).toMatchObject({ status: 'adjusted', amount: 50, disputedAt: null })
    expect(await disputeOf(adjustedDispute)).toMatchObject({ status: 'adjusted' })
    expect(await disputeOf(upheldDispute)).toMatchObject({ status: 'upheld' })
    const notices = await allNotices()
    expect(notices).toHaveLength(2)
    for (const notice of notices) {
      expect(notice.emailStatus).toBe('failed')
      expect(notice.emailedAt).not.toBeNull()
    }
  })

  it('sends one email per resolution, after the commit; a placeholder address or email not set up records skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { email: 'asha@example.org' })
    const { user: demo, token: demoToken } = await seedUser('student', { email: 'seed.student3@thapar.edu' })
    const real = await seedFine({ userId: student.id, amount: 150 })
    const placeholder = await seedFine({ userId: demo.id, amount: 150 })
    const quiet = await seedFine({ userId: student.id, amount: 30 })
    const realDispute = await openDispute(studentToken, real.id)
    const placeholderDispute = await openDispute(demoToken, placeholder.id)
    const quietDispute = await openDispute(studentToken, quiet.id)
    const seenAtSend: Array<{ notices: Array<{ emailStatus: string }>; dispute: string; events: number }> = []
    const events = recordEvents()
    recorder = events
    const sendMail = vi.fn<MailTransport['send']>(async () => {
      // Read on another connection: only committed rows are visible, the outcome not yet written.
      seenAtSend.push({
        notices: await prisma.notice.findMany(),
        dispute: (await disputeOf(realDispute)).status,
        events: events.events.length,
      })
      return { ok: true }
    })
    setMailTransport({ send: sendMail })

    expect((await adjust(admin, real.id, { amount: 50, reason: 'Hardship', disputeId: realDispute })).status).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(seenAtSend).toEqual([{ notices: [expect.objectContaining({ emailStatus: 'skipped' })], dispute: 'adjusted', events: 0 }])
    expect((await prisma.notice.findFirstOrThrow({ where: { fineId: real.id } })).emailStatus).toBe('sent')

    // Demo accounts never receive mail.
    expect((await uphold(admin, placeholderDispute)).status).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(1)
    const demoNotice = await prisma.notice.findFirstOrThrow({ where: { fineId: placeholder.id } })
    expect(demoNotice).toMatchObject({ emailStatus: 'skipped', emailedAt: null })

    // Email not set up: the notice is still written and the action still lands.
    setMailTransport(null)
    expect((await uphold(admin, quietDispute)).status).toBe(200)
    expect(await prisma.notice.findFirstOrThrow({ where: { fineId: quiet.id } })).toMatchObject({ emailStatus: 'skipped', emailedAt: null })
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('a refusal sends no email', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { email: 'asha@example.org' })
    const fine = await seedFine({ userId: student.id })
    const disputeId = await openDispute(studentToken, fine.id)
    const sendMail = fakeTransport()

    expect((await adjust(admin, fine.id, { amount: 50, reason: 'x' })).status).toBe(409) // not named
    expect((await adjust(admin, fine.id, { amount: 150, reason: 'x', disputeId })).status).toBe(400) // not lower
    expect((await uphold(admin, 'no-such-dispute')).status).toBe(404)
    expect((await uphold(admin, disputeId, { note: 'n'.repeat(301) })).status).toBe(400)

    expect(sendMail).not.toHaveBeenCalled()
    expect(await prisma.notice.count()).toBe(0)
  })

  it('events once, after the email outcome, none on a refusal', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { email: 'asha@example.org' })
    fakeTransport()
    const toAdjust = await seedFine({ userId: student.id, amount: 150 })
    const toUphold = await seedFine({ userId: student.id, amount: 60 })
    const adjustDispute = await openDispute(studentToken, toAdjust.id)
    const upholdDisputeId = await openDispute(studentToken, toUphold.id)
    const events = recordEvents()
    recorder = events
    // What the notice looks like in the database at the moment each event is published.
    const atPublish: Array<Promise<EmailStatus[]>> = []
    const stop = subscribe(() => {
      atPublish.push(prisma.notice.findMany({ orderBy: { createdAt: 'asc' } }).then((rows) => rows.map((n) => n.emailStatus)))
    })

    try {
      // Refusals first: nothing published.
      expect((await adjust(admin, toAdjust.id, { amount: 50, reason: 'x' })).status).toBe(409)
      expect((await adjust(admin, toAdjust.id, { amount: 50, reason: 'x', disputeId: 'nope' })).status).toBe(409)
      expect((await adjust(admin, toAdjust.id, { amount: 500, reason: 'x', disputeId: adjustDispute })).status).toBe(400)
      expect((await uphold(admin, 'no-such-dispute')).status).toBe(404)
      expect(events.events).toEqual([])

      expect((await adjust(admin, toAdjust.id, { amount: 50, reason: 'Hardship', disputeId: adjustDispute })).status).toBe(200)
      expect(events.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED])
      // Both were published after deliverNotice stored the outcome: the row already says sent.
      expect(await Promise.all(atPublish)).toEqual([['sent'], ['sent']])

      expect((await adjust(admin, toAdjust.id, { amount: 20, reason: 'x', disputeId: adjustDispute })).status).toBe(409) // resolved
      expect(events.events).toHaveLength(2)

      expect((await uphold(admin, upholdDisputeId)).status).toBe(200)
      expect(events.events).toEqual([FINE_CHANGED, ATTENTION_CHANGED, FINE_CHANGED, ATTENTION_CHANGED])
      expect((await uphold(admin, upholdDisputeId)).status).toBe(409)
      expect(events.events).toHaveLength(4)
      expect(await Promise.all(atPublish)).toEqual([['sent'], ['sent'], ['sent', 'sent'], ['sent', 'sent']])
    } finally {
      stop()
    }
  })
})

describe('POST /admin/disputes/:id/uphold', () => {
  it('is for admins only: 401 without a token and 403 for a student', async () => {
    const { token: student } = await seedUser()
    const { user: owner, token: ownerToken } = await seedUser()
    const fine = await seedFine({ userId: owner.id })
    const disputeId = await openDispute(ownerToken, fine.id)

    const anonymous = await request(app).post(`/admin/disputes/${disputeId}/uphold`).send({})
    const garbage = await request(app).post(`/admin/disputes/${disputeId}/uphold`).set('Authorization', 'Bearer not-a-token').send({})
    const asStudent = await uphold(student, disputeId, {})
    const asOwner = await uphold(ownerToken, disputeId, {})

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(asStudent.status).toBe(403)
    expect(asOwner.status).toBe(403) // the student whose dispute it is cannot uphold their own
    expect(await disputeOf(disputeId)).toMatchObject({ status: 'open' })
    expect(await prisma.notice.count()).toBe(0)
  })

  it('uphold closes the dispute, clears the marker, keeps the amount, and the fine can then be paid', async () => {
    const { token: admin, user: librarian } = await seedUser('admin', { name: 'Priya Menon' })
    const { user: student, token: studentToken } = await seedUser('student', { name: 'Asha Rao' })
    const fine = await seedFine({ userId: student.id, amount: 150, title: 'Refactoring' })
    const disputeId = await openDispute(studentToken, fine.id, 'I returned it on time')
    const before = await stored(fine.id)
    const at = Date.now()

    const res = await uphold(admin, disputeId, { note: 'The return desk log shows it came back late.' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: disputeId })
    const closed = await disputeOf(disputeId)
    expect(closed).toMatchObject({
      status: 'upheld',
      reason: 'I returned it on time',
      resolutionNote: 'The return desk log shows it came back late.',
      resolvedById: librarian.id,
    })
    expect(closed.resolvedAt!.getTime()).toBeGreaterThanOrEqual(at - 1000)
    expect(closed.resolvedAt!.getTime()).toBeLessThanOrEqual(Date.now())
    // The fine is exactly as it was, but for the marker.
    expect(await stored(fine.id)).toEqual({ ...before, disputedAt: null })
    // The console lists it by its own status again, with no dispute, and it is no longer in the queue.
    const listed = await request(app).get('/admin/fines').set(auth(admin))
    expect(listed.body.fines).toEqual([expect.objectContaining({ id: fine.id, status: 'outstanding', amount: 150, dispute: null, canSettle: true })])
    expect((await request(app).get('/admin/attention').set(auth(admin))).body.counts.fine_dispute).toBe(0)
    // The student sees it was upheld, with the note.
    const mine = await request(app).get('/fines/me').set(auth(studentToken))
    expect(mine.body.fines[0]).toMatchObject({ status: 'outstanding', amount: 150, dispute: { status: 'upheld', note: 'The return desk log shows it came back late.' } })
    expect((await request(app).get('/notices/me').set(auth(studentToken))).body).toEqual([
      expect.objectContaining({ kind: 'dispute_outcome', title: 'Your fine stands' }),
    ])

    // And it can be paid now.
    const paid = await pay(admin, fine.id, 150)
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'paid', amount: 150 })
  })

  it('an adjusted fine that is upheld stays adjusted at its amount, and the notice names that amount', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 50, status: 'adjusted', originalAmount: 150, adjustReason: 'Hardship', adjustedById: librarian.id })
    const disputeId = await openDispute(studentToken, fine.id)

    expect((await uphold(admin, disputeId)).status).toBe(200)

    expect(await stored(fine.id)).toMatchObject({ status: 'adjusted', amount: 50, originalAmount: 150, adjustReason: 'Hardship', disputedAt: null })
    expect((await allNotices())[0].body).toBe('The library kept your ₹50 fine for Refactoring.')
  })

  it('takes the note trimmed, at most 300 characters, blank meaning none, and a bare POST', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fines = await Promise.all([1, 2, 3, 4, 5].map(() => seedFine({ userId: student.id })))
    const [bare, blank, padded, longest, tooLong] = await Promise.all(fines.map((f) => openDispute(studentToken, f.id)))

    expect((await uphold(admin, bare)).status).toBe(200) // no body at all
    expect((await uphold(admin, blank, { note: '   ' })).status).toBe(200)
    expect((await uphold(admin, padded, { note: '  Checked twice \n' })).status).toBe(200)
    expect((await uphold(admin, longest, { note: ` ${'x'.repeat(300)} ` })).status).toBe(200)
    // Over the limit after trimming, or not text: 400, and the dispute stays open.
    expect((await uphold(admin, tooLong, { note: 'x'.repeat(301) })).status).toBe(400)
    expect((await uphold(admin, tooLong, { note: 12 })).status).toBe(400)
    expect((await uphold(admin, tooLong, { note: null })).status).toBe(400)

    expect((await disputeOf(bare)).resolutionNote).toBeNull()
    expect((await disputeOf(blank)).resolutionNote).toBeNull()
    expect((await disputeOf(padded)).resolutionNote).toBe('Checked twice')
    expect((await disputeOf(longest)).resolutionNote).toBe('x'.repeat(300))
    expect(await disputeOf(tooLong)).toMatchObject({ status: 'open', resolutionNote: null })
    const notices = await allNotices()
    expect(notices).toHaveLength(4)
    // A blank note adds nothing to the notice.
    expect(notices.filter((n) => !n.body.includes('Note from the library'))).toHaveLength(2)
  })

  it('a second uphold, or an uphold after an adjust closed it, is 409', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const twice = await seedFine({ userId: student.id, amount: 150 })
    const adjusted = await seedFine({ userId: student.id, amount: 150 })
    const twiceDispute = await openDispute(studentToken, twice.id)
    const adjustedDispute = await openDispute(studentToken, adjusted.id)
    expect((await uphold(admin, twiceDispute, { note: 'First' })).status).toBe(200)
    expect((await adjust(admin, adjusted.id, { amount: 50, reason: 'Hardship', disputeId: adjustedDispute })).status).toBe(200)
    const noticesBefore = await prisma.notice.count()
    const recorder = recordEvents()
    const sendMail = fakeTransport()

    const again = await uphold(admin, twiceDispute, { note: 'Second' })
    const afterAdjust = await uphold(admin, adjustedDispute, { note: 'Too late' })
    recorder.stop()

    for (const res of [again, afterAdjust]) {
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(RESOLVED)
    }
    // The first resolution stands unchanged, and the refusals wrote, sent and published nothing.
    expect(await disputeOf(twiceDispute)).toMatchObject({ status: 'upheld', resolutionNote: 'First' })
    expect(await disputeOf(adjustedDispute)).toMatchObject({ status: 'adjusted', resolutionNote: 'Hardship' })
    expect(await stored(adjusted.id)).toMatchObject({ status: 'adjusted', amount: 50 })
    expect(await prisma.notice.count()).toBe(noticesBefore)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('unknown dispute is 404 "Dispute not found"', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await seedFine({ userId: student.id })
    const recorder = recordEvents()

    const unknown = await uphold(admin, 'no-such-dispute', {})
    // A fine's id is not a dispute's.
    const aFine = await uphold(admin, fine.id, {})
    recorder.stop()

    for (const res of [unknown, aFine]) {
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Dispute not found')
    }
    expect(recorder.events).toEqual([])
  })

  it('a payment on a disputed fine is still refused until the dispute is upheld', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    const fine = await seedFine({ userId: student.id, amount: 150 })
    const disputeId = await openDispute(studentToken, fine.id)

    const refused = await pay(admin, fine.id, 150)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(BEING_DISPUTED)

    expect((await uphold(admin, disputeId)).status).toBe(200)
    expect((await pay(admin, fine.id, 150)).status).toBe(200)
  })
})
