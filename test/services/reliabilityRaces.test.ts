// A librarian's manual reliability adjustment landing at the same moment as an
// automatic change to the same student's score (an on-time check-in bonus, or
// another adjustment). Both must survive: the final score is the start plus every
// change, never the result of one of them overwriting the other.
//
// Promise.all only hits the bad interleavings by luck, so the first describe runs
// each race for several rounds, swapping which request starts first on every other
// round. The second pins the interleaving that matters deterministically with a row
// lock on the student: the action's first read waits on the lock, a competing change
// lands and commits, and only then does the action run, as if the competitor had
// landed just before it. An action that read the score without locking the row would
// read the old one and write over the competitor's change.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

const HOUR_MS = 60 * 60 * 1000
const START = 60
/** One adjustment per round, of both signs, none of which reaches the clamp from START. */
const DELTAS = [-5, 7, -9, 4, -3, 10]

async function seedUser(role: 'student' | 'admin' = 'student', reliabilityScore?: number) {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role, reliabilityScore },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A booking the student can check into now, on a resource of its own (no overlap with earlier rounds). */
async function seedCheckInBooking(userId: string) {
  const resource = await prisma.resource.create({ data: { type: 'seat', name: `Desk ${Math.random()}` } })
  return prisma.resourceBooking.create({
    data: { userId, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + HOUR_MS) },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const checkIn = (token: string, bookingId: string) => request(app).post(`/bookings/${bookingId}/checkin`).set(auth(token))
const adjust = (token: string, studentId: string, delta: number) =>
  request(app).post(`/admin/students/${studentId}/reliability`).set(auth(token)).send({ delta, reason: 'Race' })

const scoreOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } }).then((u) => u.reliabilityScore)
const logDeltas = (userId: string) =>
  prisma.reliabilityScoreLog.findMany({ where: { userId }, orderBy: { computedAt: 'asc' } }).then((logs) => logs.map((l) => l.delta).sort((a, b) => a - b))

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

describe('a manual adjustment and an automatic change to one score at once', () => {
  beforeEach(resetDb)

  it('a manual adjustment and an on-time check-in at once both land', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', START)
    await warmPool()

    for (const [round, delta] of DELTAS.entries()) {
      await prisma.user.update({ where: { id: student.id }, data: { reliabilityScore: START } })
      await prisma.reliabilityScoreLog.deleteMany({ where: { userId: student.id } })
      const booking = await seedCheckInBooking(student.id)

      const [adjusted, checkedIn] = await together(
        round,
        () => adjust(admin, student.id, delta),
        () => checkIn(studentToken, booking.id),
      )

      expect([adjusted.status, checkedIn.status], `round ${round}`).toEqual([200, 200])
      expect(await scoreOf(student.id), `round ${round}`).toBe(START + RELIABILITY_ONTIME_BOOKING_BONUS + delta)
      expect(await logDeltas(student.id), `round ${round}`).toEqual([delta, RELIABILITY_ONTIME_BOOKING_BONUS].sort((a, b) => a - b))
      // The response to the adjustment names the score its own change produced, which is
      // one of the two orders' results, never the starting score.
      expect([START + delta, START + RELIABILITY_ONTIME_BOOKING_BONUS + delta], `round ${round}`).toContain(adjusted.body.score)
    }
  }, 120_000)

  it('two manual adjustments at once both land', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', START)
    await warmPool()

    for (const [round, delta] of DELTAS.entries()) {
      await prisma.user.update({ where: { id: student.id }, data: { reliabilityScore: START } })
      await prisma.reliabilityScoreLog.deleteMany({ where: { userId: student.id } })
      const other = delta > 0 ? -3 : 3

      const [first, second] = await together(
        round,
        () => adjust(admin, student.id, delta),
        () => adjust(admin, student.id, other),
      )

      expect([first.status, second.status], `round ${round}`).toEqual([200, 200])
      expect(await scoreOf(student.id), `round ${round}`).toBe(START + delta + other)
      expect(await logDeltas(student.id), `round ${round}`).toEqual([delta, other].sort((a, b) => a - b))
    }
  }, 120_000)
})

// --- Interleavings pinned with a row lock --------------------------------------

/** Polls until some other session is stuck waiting for a lock (the action under test, on the row the test holds). */
async function waitUntilAnActionIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the student row')
}

/**
 * Locks the student row, starts `action`, waits until it is blocked on that lock,
 * lets `competitor` change the score in the locking transaction and commits. The
 * action then runs against the changed score, exactly as if the competitor had
 * landed just before it.
 */
async function blockedThenCompete(
  studentId: string,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${studentId} FOR UPDATE`
        pending = Promise.resolve(action())
        await waitUntilAnActionIsBlocked()
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

describe('a score changed while an adjustment on it was waiting', () => {
  beforeEach(resetDb)

  /** What another automatic change to the score writes, done by the test instead: the score drops to 50. */
  async function dropTo50(tx: Prisma.TransactionClient, studentId: string) {
    await tx.user.update({ where: { id: studentId }, data: { reliabilityScore: 50 } })
    await tx.reliabilityScoreLog.create({ data: { userId: studentId, score: 50, delta: -10, reason: 'Competing change' } })
  }

  it('a check-in that waited for another score change builds on it', async () => {
    const { user: student, token } = await seedUser('student', START)
    const booking = await seedCheckInBooking(student.id)

    const res = await blockedThenCompete(student.id, () => checkIn(token, booking.id), (tx) => dropTo50(tx, student.id))

    expect(res.status).toBe(200)
    // 50 (the competitor's score) plus the bonus, not START plus the bonus.
    expect(await scoreOf(student.id)).toBe(50 + RELIABILITY_ONTIME_BOOKING_BONUS)
    expect(await logDeltas(student.id)).toEqual([-10, RELIABILITY_ONTIME_BOOKING_BONUS])
    const newest = await prisma.reliabilityScoreLog.findFirstOrThrow({ where: { userId: student.id }, orderBy: { computedAt: 'desc' } })
    expect(newest).toMatchObject({ score: 50 + RELIABILITY_ONTIME_BOOKING_BONUS, delta: RELIABILITY_ONTIME_BOOKING_BONUS })
  }, 60_000)

  it('a manual adjustment that waited for another score change builds on it', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', START)

    const res = await blockedThenCompete(student.id, () => adjust(admin, student.id, 8), (tx) => dropTo50(tx, student.id))

    expect(res.status).toBe(200)
    expect(res.body.score).toBe(58)
    expect(await scoreOf(student.id)).toBe(58)
    expect(await logDeltas(student.id)).toEqual([-10, 8])
  }, 60_000)

  it('a manual adjustment that waited for a change to the ceiling is judged against the new score', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', 90)

    // The competitor lifts the score to 100 while the +5 waits: the adjustment would now
    // change nothing, so it is refused and logs nothing, instead of writing 95.
    const res = await blockedThenCompete(
      student.id,
      () => adjust(admin, student.id, 5),
      (tx) => tx.user.update({ where: { id: student.id }, data: { reliabilityScore: 100 } }),
    )

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'The score is already at 100.' })
    expect(await scoreOf(student.id)).toBe(100)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
  }, 60_000)
})
