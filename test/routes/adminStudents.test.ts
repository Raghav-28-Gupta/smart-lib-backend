import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { BookingStatus, LoanStatus, ResourceType } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LIMIT = 50

async function seedUser(
  role: 'student' | 'admin' = 'student',
  extra: { name?: string; email?: string; roll?: string | null; reliabilityScore?: number } = {},
) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@test.com`,
      passwordHash: 'x',
      role,
      roll: extra.roll === undefined ? null : extra.roll,
      reliabilityScore: extra.reliabilityScore,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

interface LoanSeed {
  title: string
  borrowedAt: Date
  dueAt: Date
  status?: LoanStatus
  returnedAt?: Date
  lostAt?: Date
}

async function seedLoan(userId: string, seed: LoanSeed) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: seed.title, author: 'Author', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: seed.status === 'lost' ? 'lost' : 'available' } })
  return prisma.loan.create({
    data: {
      userId,
      bookCopyId: copy.id,
      borrowedAt: seed.borrowedAt,
      dueAt: seed.dueAt,
      status: seed.status ?? 'active',
      returnedAt: seed.returnedAt,
      lostAt: seed.lostAt,
    },
  })
}

interface BookingSeed {
  name: string
  type?: ResourceType
  start: Date
  durationMs?: number
  status: BookingStatus
  gracePeriodMinutes?: number
  decidedAt?: Date
  decidedById?: string
}

/** A booking on a resource of its own, so no two seeded bookings can overlap on one. */
async function seedBooking(userId: string, seed: BookingSeed) {
  const resource = await prisma.resource.create({ data: { type: seed.type ?? 'seat', name: seed.name } })
  return prisma.resourceBooking.create({
    data: {
      userId,
      resourceId: resource.id,
      startTime: seed.start,
      endTime: new Date(seed.start.getTime() + (seed.durationMs ?? HOUR_MS)),
      status: seed.status,
      gracePeriodMinutes: seed.gracePeriodMinutes,
      decidedAt: seed.decidedAt,
      decidedById: seed.decidedById,
    },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const get = (token: string, id: string) => request(app).get(`/admin/students/${id}`).set(auth(token))
const adjust = (token: string, id: string, body: unknown) =>
  request(app).post(`/admin/students/${id}/reliability`).set(auth(token)).send(body as object)

interface StudentBody {
  id: string
  name: string
  email: string
  roll: string
  score: number
  tier: string
  history: { date: string; score: number; delta: number; reason: string; by: string | null }[]
  loans: { id: string; title: string; borrowedAt: string; dueAt: string; returnedAt: string | null; lostAt: string | null; status: string }[]
  bookings: { id: string; resource: string; startTime: string; endTime: string; status: string }[]
  fines: { id: string; kind: string; amount: number; status: string; date: string; reason: string; item: string }[]
}

describe('admin student record', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('is for admins only', async () => {
    const { token: student, user } = await seedUser()

    const anonymousGet = await request(app).get(`/admin/students/${user.id}`)
    const studentGet = await get(student, user.id)
    const anonymousPost = await request(app).post(`/admin/students/${user.id}/reliability`).send({ delta: 1, reason: 'x' })
    const studentPost = await adjust(student, user.id, { delta: 1, reason: 'x' })

    expect(anonymousGet.status).toBe(401)
    expect(studentGet.status).toBe(403)
    expect(anonymousPost.status).toBe(401)
    expect(studentPost.status).toBe(403)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
  })

  it("returns profile, tier, history with the librarian's name on manual entries, loans with derived status, bookings with derived status including requests, and fines with accruing rows", async () => {
    const { user: admin, token } = await seedUser('admin', { name: 'Meera Iyer' })
    const { user: student } = await seedUser('student', {
      name: 'Aditi Sharma',
      email: 'aditi@test.com',
      roll: '21CS042',
      reliabilityScore: 72,
    })
    const { user: other } = await seedUser('student', { name: 'Someone Else' })
    const now = Date.now()

    // History: an automatic entry, then a manual one (newer).
    const autoAt = new Date(now - 2 * DAY_MS)
    const manualAt = new Date(now - DAY_MS)
    await prisma.reliabilityScoreLog.create({
      data: { userId: student.id, score: 77, delta: 2, reason: 'On-time check-in for a resource booking', computedAt: autoAt },
    })
    await prisma.reliabilityScoreLog.create({
      data: { userId: student.id, score: 72, delta: -5, reason: 'Library adjustment: Left a seat unattended', computedAt: manualAt, adjustedById: admin.id },
    })
    await prisma.reliabilityScoreLog.create({ data: { userId: other.id, score: 90, delta: -10, reason: 'Not this student' } })

    // Loans: lost, returned, overdue and active, newest borrowed first.
    const activeLoan = await seedLoan(student.id, { title: 'Active Book', borrowedAt: new Date(now - DAY_MS), dueAt: new Date(now + 13 * DAY_MS) })
    const overdueLoan = await seedLoan(student.id, {
      title: 'Overdue Book',
      borrowedAt: new Date(now - 20 * DAY_MS),
      dueAt: new Date(now - 3 * DAY_MS - HOUR_MS),
    })
    const returnedLoan = await seedLoan(student.id, {
      title: 'Returned Book',
      borrowedAt: new Date(now - 30 * DAY_MS),
      dueAt: new Date(now - 16 * DAY_MS),
      status: 'returned',
      returnedAt: new Date(now - 17 * DAY_MS),
    })
    const lostLoan = await seedLoan(student.id, {
      title: 'Lost Book',
      borrowedAt: new Date(now - 40 * DAY_MS),
      dueAt: new Date(now - 26 * DAY_MS),
      status: 'lost',
      lostAt: new Date(now - 20 * DAY_MS),
    })
    await seedLoan(other.id, { title: 'Not Mine', borrowedAt: new Date(now), dueAt: new Date(now + DAY_MS) })

    // Bookings, newest start first. Withdrawn requests are not listed (as on the Bookings page).
    const requested = await seedBooking(student.id, { name: 'Group Room 1', type: 'room', start: new Date(now + DAY_MS), status: 'requested' })
    const booked = await seedBooking(student.id, { name: 'Desk 1', start: new Date(now + 2 * HOUR_MS), status: 'booked' })
    const released = await seedBooking(student.id, { name: 'Desk 2', start: new Date(now - HOUR_MS), status: 'booked', gracePeriodMinutes: 15 })
    const completed = await seedBooking(student.id, {
      name: 'Desk 3',
      start: new Date(now - 2 * HOUR_MS),
      durationMs: 90 * MINUTE_MS,
      status: 'checked_in',
    })
    const cancelled = await seedBooking(student.id, { name: 'Desk 4', start: new Date(now - DAY_MS), status: 'cancelled' })
    const declined = await seedBooking(student.id, {
      name: 'Group Room 2',
      type: 'room',
      start: new Date(now - 2 * DAY_MS),
      status: 'declined',
      decidedAt: new Date(now - 3 * DAY_MS),
      decidedById: admin.id,
    })
    const expired = await seedBooking(student.id, { name: 'Group Room 3', type: 'room', start: new Date(now - 3 * DAY_MS), status: 'expired' })
    await seedBooking(student.id, {
      name: 'Group Room 4',
      type: 'room',
      start: new Date(now - 4 * DAY_MS),
      status: 'cancelled',
      decidedAt: new Date(now - 5 * DAY_MS),
    })
    await seedBooking(other.id, { name: 'Desk 9', start: new Date(now + 3 * HOUR_MS), status: 'booked' })

    // Fines: one stored (on the returned loan) and the overdue loan's accruing row.
    const fineAt = new Date(now - 2 * DAY_MS)
    const fine = await prisma.fine.create({
      data: { userId: student.id, relatedLoanId: returnedLoan.id, amount: 20, reason: 'overdue', createdAt: fineAt },
    })
    await prisma.fine.create({ data: { userId: other.id, amount: 99, reason: 'overdue' } })

    const res = await get(token, student.id)

    expect(res.status).toBe(200)
    const body = res.body as StudentBody
    expect(body).toMatchObject({ id: student.id, name: 'Aditi Sharma', email: 'aditi@test.com', roll: '21CS042', score: 72, tier: 'Building back up' })
    expect(body.history).toEqual([
      { date: manualAt.toISOString(), score: 72, delta: -5, reason: 'Library adjustment: Left a seat unattended', by: 'Meera Iyer' },
      { date: autoAt.toISOString(), score: 77, delta: 2, reason: 'On-time check-in for a resource booking', by: null },
    ])
    expect(body.loans).toEqual([
      {
        id: activeLoan.id,
        title: 'Active Book',
        borrowedAt: activeLoan.borrowedAt.toISOString(),
        dueAt: activeLoan.dueAt.toISOString(),
        returnedAt: null,
        lostAt: null,
        status: 'active',
      },
      {
        id: overdueLoan.id,
        title: 'Overdue Book',
        borrowedAt: overdueLoan.borrowedAt.toISOString(),
        dueAt: overdueLoan.dueAt.toISOString(),
        returnedAt: null,
        lostAt: null,
        status: 'overdue',
      },
      {
        id: returnedLoan.id,
        title: 'Returned Book',
        borrowedAt: returnedLoan.borrowedAt.toISOString(),
        dueAt: returnedLoan.dueAt.toISOString(),
        returnedAt: returnedLoan.returnedAt!.toISOString(),
        lostAt: null,
        status: 'returned',
      },
      {
        id: lostLoan.id,
        title: 'Lost Book',
        borrowedAt: lostLoan.borrowedAt.toISOString(),
        dueAt: lostLoan.dueAt.toISOString(),
        returnedAt: null,
        lostAt: lostLoan.lostAt!.toISOString(),
        status: 'lost',
      },
    ])
    expect(body.bookings.map((b) => [b.id, b.resource, b.status])).toEqual([
      [requested.id, 'Group Room 1', 'requested'],
      [booked.id, 'Desk 1', 'booked'],
      [released.id, 'Desk 2', 'released'],
      [completed.id, 'Desk 3', 'completed'],
      [cancelled.id, 'Desk 4', 'cancelled'],
      [declined.id, 'Group Room 2', 'declined'],
      [expired.id, 'Group Room 3', 'expired'],
    ])
    expect(body.bookings[1]).toEqual({
      id: booked.id,
      resource: 'Desk 1',
      startTime: booked.startTime.toISOString(),
      endTime: booked.endTime.toISOString(),
      status: 'booked',
    })
    // Newest first: the stored fine (2 days ago) before the accruing row (dated at the loan's due date).
    expect(body.fines).toEqual([
      expect.objectContaining({ id: fine.id, kind: 'fine', amount: 20, status: 'outstanding', reason: 'overdue', item: 'Returned Book', date: fineAt.toISOString() }),
      expect.objectContaining({
        id: overdueLoan.id,
        kind: 'accruing',
        amount: 30,
        status: 'accruing',
        reason: 'overdue',
        item: 'Overdue Book',
        date: overdueLoan.dueAt.toISOString(),
        student: { id: student.id, name: 'Aditi Sharma', email: 'aditi@test.com' },
      }),
    ])
  })

  it('roll is Pending when null', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { roll: null })

    const res = await get(token, student.id)

    expect(res.status).toBe(200)
    expect(res.body.roll).toBe('Pending')
    expect(res.body).toMatchObject({ score: 100, tier: 'Good standing', history: [], loans: [], bookings: [], fines: [] })
  })

  it('caps each history at 50, newest first', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const count = LIMIT + 5
    const indexes = Array.from({ length: count }, (_, i) => i)

    // Index 0 is the newest of each kind, 54 the oldest.
    await prisma.reliabilityScoreLog.createMany({
      data: indexes.map((i) => ({ userId: student.id, score: 100, delta: 1, reason: `entry ${i}`, computedAt: new Date(now - i * MINUTE_MS) })),
    })
    const books = indexes.map((i) => ({ id: `book-${i}`, isbn: `isbn-cap-${i}`, title: `Book ${i}`, author: 'Author', totalCopies: 1 }))
    await prisma.book.createMany({ data: books })
    await prisma.bookCopy.createMany({ data: indexes.map((i) => ({ id: `copy-${i}`, bookId: `book-${i}`, status: 'available' as const })) })
    await prisma.loan.createMany({
      data: indexes.map((i) => ({
        id: `loan-${i}`,
        userId: student.id,
        bookCopyId: `copy-${i}`,
        borrowedAt: new Date(now - (i + 1) * DAY_MS),
        dueAt: new Date(now - (i + 1) * DAY_MS + 14 * DAY_MS),
        status: 'returned' as const,
        returnedAt: new Date(now - i * DAY_MS),
      })),
    })
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resourceBooking.createMany({
      data: indexes.map((i) => ({
        id: `booking-${i}`,
        userId: student.id,
        resourceId: resource.id,
        startTime: new Date(now - (i + 1) * DAY_MS),
        endTime: new Date(now - (i + 1) * DAY_MS + HOUR_MS),
        status: 'completed' as const,
      })),
    })
    await prisma.fine.createMany({
      data: indexes.map((i) => ({
        userId: student.id,
        amount: i + 1,
        reason: 'overdue' as const,
        status: 'paid' as const,
        createdAt: new Date(now - (i + 1) * DAY_MS),
      })),
    })

    const res = await get(token, student.id)

    expect(res.status).toBe(200)
    const body = res.body as StudentBody
    const first50 = indexes.slice(0, LIMIT)
    expect(body.history.map((h) => h.reason)).toEqual(first50.map((i) => `entry ${i}`))
    expect(body.loans.map((l) => l.title)).toEqual(first50.map((i) => `Book ${i}`))
    expect(body.bookings.map((b) => b.id)).toEqual(first50.map((i) => `booking-${i}`))
    expect(body.fines.map((f) => f.amount)).toEqual(first50.map((i) => i + 1))
  }, 30_000)

  it('an admin\'s id and an unknown id are 404 "Student not found"', async () => {
    const { token, user: admin } = await seedUser('admin')
    recorder = recordEvents()

    for (const id of [admin.id, 'no-such-student']) {
      const read = await get(token, id)
      const write = await adjust(token, id, { delta: 5, reason: 'Anything' })

      expect(read.status).toBe(404)
      expect(read.body).toEqual({ error: 'Student not found' })
      expect(write.status).toBe(404)
      expect(write.body).toEqual({ error: 'Student not found' })
    }
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).reliabilityScore).toBe(100)
    expect(recorder.events).toEqual([])
  })

  it('adjusts by +5 and logs "Library adjustment: <reason>" with the librarian', async () => {
    const { token, user: admin } = await seedUser('admin', { name: 'Meera Iyer' })
    const { user: student } = await seedUser('student', { reliabilityScore: 60 })

    const res = await adjust(token, student.id, { delta: 5, reason: '  Volunteered at the book sale  ' })

    expect(res.status).toBe(200)
    const body = res.body as StudentBody
    expect(body).toMatchObject({ id: student.id, score: 65, tier: 'Building back up' })
    expect(body.history).toEqual([
      { date: expect.any(String), score: 65, delta: 5, reason: 'Library adjustment: Volunteered at the book sale', by: 'Meera Iyer' },
    ])
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(65)
    const logs = await prisma.reliabilityScoreLog.findMany({ where: { userId: student.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      score: 65,
      delta: 5,
      reason: 'Library adjustment: Volunteered at the book sale',
      adjustedById: admin.id,
    })
  })

  it('a negative adjustment lowers the score and logs the drop', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 82 })

    const res = await adjust(token, student.id, { delta: -7, reason: 'Damaged a study room' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 75, tier: 'Building back up' })
    expect((res.body as StudentBody).history[0]).toMatchObject({ score: 75, delta: -7, reason: 'Library adjustment: Damaged a study room' })
  })

  it('clamps +10 at 95 to 100', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 95 })

    const res = await adjust(token, student.id, { delta: 10, reason: 'Goodwill' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 100, tier: 'Good standing' })
    // The log records the change that was applied, not the one asked for.
    expect((res.body as StudentBody).history[0]).toMatchObject({ score: 100, delta: 5 })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(100)
  })

  it('clamps -10 at 4 to 0', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 4 })

    const res = await adjust(token, student.id, { delta: -10, reason: 'Repeated abuse' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 0, tier: 'At risk' })
    expect((res.body as StudentBody).history[0]).toMatchObject({ score: 0, delta: -4 })
  })

  it('+1 at 100 is 409 "The score is already at 100." and logs nothing', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 100 })
    recorder = recordEvents()

    const res = await adjust(token, student.id, { delta: 1, reason: 'Nice' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'The score is already at 100.' })
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(100)
    expect(recorder.events).toEqual([])
  })

  it('-1 at 0 is 409 "The score is already at 0." and logs nothing', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 0 })
    recorder = recordEvents()

    const res = await adjust(token, student.id, { delta: -1, reason: 'Again' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'The score is already at 0.' })
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('delta 0, 11, -11, a fraction, or a blank reason is 400', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 60 })
    recorder = recordEvents()

    const bad: unknown[] = [
      { delta: 0, reason: 'Nothing' },
      { delta: 11, reason: 'Too much' },
      { delta: -11, reason: 'Too much' },
      { delta: 2.5, reason: 'A fraction' },
      { delta: '5', reason: 'A string' },
      { delta: 5, reason: '' },
      { delta: 5, reason: '   ' },
      { delta: 5, reason: 'x'.repeat(301) },
      { delta: 5 },
      { reason: 'No delta' },
      {},
    ]
    for (const body of bad) {
      const res = await adjust(token, student.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(60)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('accepts the limits: delta -10 and +10, and a reason of exactly 300 characters', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 50 })
    const reason = 'x'.repeat(300)

    const down = await adjust(token, student.id, { delta: -10, reason })
    const up = await adjust(token, student.id, { delta: 10, reason: 'Back up' })

    expect(down.status).toBe(200)
    expect(up.status).toBe(200)
    expect(up.body.score).toBe(50)
    expect((up.body as StudentBody).history.map((h) => h.delta)).toEqual([10, -10])
    expect((up.body as StudentBody).history[1].reason).toBe(`Library adjustment: ${reason}`)
  })

  it('publishes student.changed once', async () => {
    const { token } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 60 })
    recorder = recordEvents()

    const res = await adjust(token, student.id, { delta: 3, reason: 'Thanks' })

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'student.changed', topics: ['students'] }])
  })

  it('a librarian whose account is later deleted leaves the entry with no name', async () => {
    const { token, user: admin } = await seedUser('admin', { name: 'Leaving Librarian' })
    const { token: otherAdmin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { reliabilityScore: 60 })
    await adjust(token, student.id, { delta: 2, reason: 'Before leaving' })

    await prisma.user.delete({ where: { id: admin.id } })
    const res = await get(otherAdmin, student.id)

    expect(res.status).toBe(200)
    expect((res.body as StudentBody).history).toEqual([
      expect.objectContaining({ reason: 'Library adjustment: Before leaving', by: null }),
    ])
  })
})
