// A librarian's cancel or reassign racing a student, and two reassigns racing
// each other. Every one of these must end with exactly one winner and a loser
// that is told what happened, never two successes and never a server error.
//
// Promise.all only hits the bad interleavings by luck, so each race runs for
// several rounds. The second describe pins the interleavings that matter
// deterministically with a row lock: the action reads the booking as booked,
// the competing change lands, and only then does the action's own write run.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const ROUNDS = 6
const BOOKING_CHANGED = { type: 'booking.changed', topics: ['bookings', 'metrics'] }

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

let seatCounter = 0
const seedSeat = () => prisma.resource.create({ data: { type: 'seat', name: `Desk ${++seatCounter}`, capacity: 1 } })

/** Started five minutes ago with a 15-minute grace period: a student can check in right now. */
async function seedInWindowBooking(userId: string) {
  const start = Date.now() - 5 * MINUTE_MS
  const seat = await seedSeat()
  return prisma.resourceBooking.create({
    data: { userId, resourceId: seat.id, startTime: new Date(start), endTime: new Date(start + HOUR_MS), status: 'booked' },
  })
}

/** An hour from now, so every booking made with the same offset overlaps the others. */
async function seedUpcomingBooking(userId: string) {
  const start = Date.now() + HOUR_MS
  const seat = await seedSeat()
  return prisma.resourceBooking.create({
    data: { userId, resourceId: seat.id, startTime: new Date(start), endTime: new Date(start + HOUR_MS), status: 'booked' },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const libraryCancel = (token: string, id: string) => request(app).post(`/admin/bookings/${id}/cancel`).set(auth(token)).send({ reason: 'Closed' })
const libraryReassign = (token: string, id: string, resourceId: string) =>
  request(app).post(`/admin/bookings/${id}/reassign`).set(auth(token)).send({ resourceId })
const studentCheckIn = (token: string, id: string) => request(app).post(`/bookings/${id}/checkin`).set(auth(token))
const studentCancel = (token: string, id: string) => request(app).post(`/bookings/${id}/cancel`).set(auth(token))
const stored = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } })

describe('races on one booking', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a librarian cancel and a student check-in at once: exactly one succeeds', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()
    await prisma.user.update({ where: { id: student.id }, data: { reliabilityScore: 50 } })
    const wins = { cancel: 0, checkIn: 0 }

    for (let round = 0; round < ROUNDS; round++) {
      const booking = await seedInWindowBooking(student.id)
      recorder = recordEvents()

      const [cancelled, checkedIn] = await Promise.all([libraryCancel(admin, booking.id), studentCheckIn(studentToken, booking.id)])

      recorder.stop()
      expect([cancelled.status, checkedIn.status].sort()).toEqual([200, 409])
      const after = await stored(booking.id)
      if (cancelled.status === 200) {
        wins.cancel++
        expect(checkedIn.body.error).toBe('This booking cannot be checked into.')
        expect(after).toMatchObject({ status: 'cancelled', cancelledById: librarian.id, checkedInAt: null })
      } else {
        wins.checkIn++
        expect(cancelled.body.error).toBe('The student already checked in.')
        expect(after).toMatchObject({ status: 'checked_in', cancelledById: null, cancelReason: null })
        expect(after.checkedInAt).not.toBeNull()
      }
      // The winner announced itself once; the loser said nothing.
      expect(recorder.events).toEqual([BOOKING_CHANGED])
    }

    // Only a real check-in moved the score: no bonus for a booking the library cancelled.
    expect(await prisma.reliabilityScoreLog.count({ where: { userId: student.id } })).toBe(wins.checkIn)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(50 + RELIABILITY_ONTIME_BOOKING_BONUS * wins.checkIn)
  }, 90_000)

  it('a librarian cancel and a student cancel at once: exactly one wins and the loser sees the specific message', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { token: studentToken, user: student } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const booking = await seedUpcomingBooking(student.id)
      recorder = recordEvents()

      const [byLibrary, byStudent] = await Promise.all([libraryCancel(admin, booking.id), studentCancel(studentToken, booking.id)])

      recorder.stop()
      expect([byLibrary.status, byStudent.status].sort()).toEqual([200, 409])
      const after = await stored(booking.id)
      expect(after.status).toBe('cancelled')
      if (byLibrary.status === 200) {
        expect(byStudent.body.error).toBe('This booking cannot be cancelled.')
        expect(after).toMatchObject({ cancelledById: librarian.id, cancelReason: 'Closed' })
        expect(after.cancelledAt).not.toBeNull()
      } else {
        expect(byLibrary.body.error).toBe('The student already cancelled this booking.')
        // A student's own cancel leaves who, when and why empty; the librarian's lost attempt wrote nothing.
        expect(after).toMatchObject({ cancelledById: null, cancelReason: null, cancelledAt: null })
      }
      expect(recorder.events).toEqual([BOOKING_CHANGED])
    }
  }, 90_000)

  it('two reassigns of different bookings to one target: exactly one succeeds', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser()
    const { user: ben } = await seedUser()

    for (let round = 0; round < ROUNDS; round++) {
      const target = await seedSeat()
      const first = await seedUpcomingBooking(asha.id)
      const second = await seedUpcomingBooking(ben.id)
      const sources = new Map([
        [first.id, first.resourceId],
        [second.id, second.resourceId],
      ])
      recorder = recordEvents()

      const responses = await Promise.all([libraryReassign(admin, first.id, target.id), libraryReassign(admin, second.id, target.id)])

      recorder.stop()
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
      expect(responses.find((r) => r.status === 409)!.body.error).toBe('That resource is taken at this time.')
      const after = await Promise.all([stored(first.id), stored(second.id)])
      const moved = after.filter((b) => b.resourceId === target.id)
      const stayed = after.filter((b) => b.resourceId !== target.id)
      expect(moved).toHaveLength(1)
      expect(stayed).toHaveLength(1)
      expect(moved[0].movedFromName).not.toBeNull()
      expect(moved[0].movedAt).not.toBeNull()
      // The loser is exactly as it was.
      expect(stayed[0]).toMatchObject({ resourceId: sources.get(stayed[0].id), status: 'booked', movedFromName: null, movedAt: null })
      expect(await prisma.resourceBooking.count({ where: { resourceId: target.id, status: { in: ['requested', 'booked', 'checked_in'] } } })).toBe(1)
      expect(recorder.events).toEqual([BOOKING_CHANGED])
    }
  }, 90_000)

  it('five reassigns of different bookings to one target: exactly one succeeds and every loser is told it is taken', async () => {
    const { token: admin } = await seedUser('admin')
    const students = await Promise.all(Array.from({ length: 5 }, () => seedUser()))

    for (let round = 0; round < 3; round++) {
      const target = await seedSeat()
      const bookings = []
      for (const { user } of students) bookings.push(await seedUpcomingBooking(user.id))

      const responses = await Promise.all(bookings.map((b) => libraryReassign(admin, b.id, target.id)))

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409])
      for (const loser of responses.filter((r) => r.status === 409)) expect(loser.body.error).toBe('That resource is taken at this time.')
      expect(await prisma.resourceBooking.count({ where: { resourceId: target.id } })).toBe(1)
    }
  }, 90_000)
})

// --- Interleavings pinned with a row lock --------------------------------------

/** Polls until some other session is stuck waiting for a lock (the action under test, on the held row). */
async function waitUntilAWriterIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the booking row')
}

/**
 * Locks the booking row, starts `action` (which reads the row as booked, then
 * blocks on its own write), waits until it is blocked, lets `competitor` change
 * the row in the locking transaction and commits. The action's write then runs
 * against the changed row, exactly as if the competitor had landed in the gap
 * between the action's read and its write.
 */
async function readThenCompete(
  bookingId: string,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ResourceBooking" WHERE id = ${bookingId} FOR UPDATE`
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

describe('a booking changed between the action reading it and writing it', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a student check-in that read the booking before a librarian cancel landed cannot overwrite the cancel', async () => {
    const { user: librarian } = await seedUser('admin')
    const { token, user: student } = await seedUser()
    const booking = await seedInWindowBooking(student.id)
    recorder = recordEvents()

    const res = await readThenCompete(
      booking.id,
      () => studentCheckIn(token, booking.id),
      (tx) =>
        tx.resourceBooking.update({
          where: { id: booking.id },
          data: { status: 'cancelled', cancelledById: librarian.id, cancelledAt: new Date(), cancelReason: 'Closed' },
        }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This booking cannot be checked into.')
    expect(await stored(booking.id)).toMatchObject({ status: 'cancelled', cancelledById: librarian.id, checkedInAt: null })
    // The refused check-in earned no bonus and announced nothing.
    expect(await prisma.reliabilityScoreLog.count({ where: { userId: student.id } })).toBe(0)
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a librarian cancel that read the booking before the student checked in cannot overwrite the check-in', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedInWindowBooking(student.id)
    recorder = recordEvents()

    const res = await readThenCompete(
      booking.id,
      () => libraryCancel(admin, booking.id),
      (tx) => tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'checked_in', checkedInAt: new Date() } }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The student already checked in.')
    expect(await stored(booking.id)).toMatchObject({ status: 'checked_in', cancelledById: null, cancelReason: null, cancelledAt: null })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it("a librarian cancel that read the booking before the student cancelled leaves the student's cancel as it was", async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedUpcomingBooking(student.id)
    recorder = recordEvents()

    const res = await readThenCompete(
      booking.id,
      () => libraryCancel(admin, booking.id),
      (tx) => tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'cancelled' } }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The student already cancelled this booking.')
    expect(await stored(booking.id)).toMatchObject({ status: 'cancelled', cancelledById: null, cancelReason: null, cancelledAt: null })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a reassign that read the booking before the student checked in cannot move the checked-in booking', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedInWindowBooking(student.id)
    const target = await seedSeat()
    recorder = recordEvents()

    const res = await readThenCompete(
      booking.id,
      () => libraryReassign(admin, booking.id, target.id),
      (tx) => tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'checked_in', checkedInAt: new Date() } }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The student already checked in.')
    expect(await stored(booking.id)).toMatchObject({ resourceId: booking.resourceId, status: 'checked_in', movedFromName: null, movedAt: null })
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a reassign that read the booking before another reassign moved it refuses instead of recording a stale movedFromName', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedUpcomingBooking(student.id)
    const ours = await seedSeat()
    const theirs = await seedSeat()
    recorder = recordEvents()

    const res = await readThenCompete(
      booking.id,
      () => libraryReassign(admin, booking.id, ours.id),
      (tx) =>
        tx.resourceBooking.update({
          where: { id: booking.id },
          data: { resourceId: theirs.id, movedFromName: 'Their source', movedAt: new Date() },
        }),
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This booking was just moved.')
    // The other librarian's move stands; ours wrote nothing.
    expect(await stored(booking.id)).toMatchObject({ resourceId: theirs.id, status: 'booked', movedFromName: 'Their source' })
    expect(recorder.events).toEqual([])
  }, 60_000)
})
