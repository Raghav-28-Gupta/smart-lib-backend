import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { GRACE_PERIOD_MINUTES, JWT_SECRET, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import type { BookingStatus, Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { dayLabel, slotLabel } from '../../src/lib/timeLabels'
import { cancelBooking, checkInBooking } from '../../src/services/bookingService'
import { sweepBookings } from '../../src/services/noShowService'
import { bookingLockedThenCompete, waitUntilAWriterIsBlocked } from '../helpers/bookingLock'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

async function seedUser() {
  const user = await prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedResource(type: 'seat' | 'room' = 'seat', name = `Desk ${Math.random()}`) {
  return prisma.resource.create({ data: { type, name } })
}

function iso(y: number, m: number, d: number, h: number, min = 0) {
  return new Date(y, m - 1, d, h, min, 0).toISOString()
}

describe('POST /bookings', () => {
  beforeEach(resetDb)

  it('creates a booking for a free slot', async () => {
    const { token } = await seedUser()
    const resource = await seedResource()

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId: resource.id, startTime: iso(2027, 1, 10, 10), endTime: iso(2027, 1, 10, 11) })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ resourceId: resource.id, status: 'booked', frontendStatus: 'upcomingFar' })
  })

  it('returns 404 for a nonexistent resource', async () => {
    const { token } = await seedUser()
    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId: 'no-such-resource', startTime: iso(2027, 1, 10, 10), endTime: iso(2027, 1, 10, 11) })
    expect(res.status).toBe(404)
  })

  it('returns 400 when endTime is not after startTime', async () => {
    const { token } = await seedUser()
    const resource = await seedResource()
    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId: resource.id, startTime: iso(2027, 1, 10, 11), endTime: iso(2027, 1, 10, 10) })
    expect(res.status).toBe(400)
  })

  it('requires authentication', async () => {
    const resource = await seedResource()
    const res = await request(app)
      .post('/bookings')
      .send({ resourceId: resource.id, startTime: iso(2027, 1, 10, 10), endTime: iso(2027, 1, 10, 11) })
    expect(res.status).toBe(401)
  })

  it('returns 409 with alternatives when the slot is already taken', async () => {
    const { token: token1 } = await seedUser()
    const { token: token2 } = await seedUser()
    const resource = await seedResource('seat', 'Desk 1')
    const otherResource = await seedResource('seat', 'Desk 2')

    await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token1}`)
      .send({ resourceId: resource.id, startTime: iso(2027, 1, 10, 10), endTime: iso(2027, 1, 10, 11) })

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token2}`)
      .send({ resourceId: resource.id, startTime: iso(2027, 1, 10, 10), endTime: iso(2027, 1, 10, 11) })

    expect(res.status).toBe(409)
    const alternatives = res.body.details.alternatives as Array<{ resourceId: string; timeSlot: string }>
    expect(Array.isArray(alternatives)).toBe(true)
    expect(alternatives.length).toBeGreaterThan(0)

    const sameResourceAlt = alternatives.find((a) => a.resourceId === resource.id)
    expect(sameResourceAlt?.timeSlot).not.toBe('10:00 AM')

    const otherResourceAlt = alternatives.find((a) => a.resourceId === otherResource.id)
    expect(otherResourceAlt?.timeSlot).toBe('10:00 AM')
  })

  it('lets exactly one of many concurrent requests for the same slot succeed', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => seedUser()))
    const resource = await seedResource()

    const results = await Promise.all(
      users.map(({ token }) =>
        request(app)
          .post('/bookings')
          .set('Authorization', `Bearer ${token}`)
          .send({ resourceId: resource.id, startTime: iso(2027, 2, 1, 10), endTime: iso(2027, 2, 1, 11) }),
      ),
    )

    const created = results.filter((r) => r.status === 201)
    const conflicted = results.filter((r) => r.status === 409)
    expect(created).toHaveLength(1)
    expect(conflicted).toHaveLength(7)

    const bookingsInDb = await prisma.resourceBooking.count({ where: { resourceId: resource.id, status: { in: ['booked', 'checked_in'] } } })
    expect(bookingsInDb).toBe(1)
  })

  // Postgres can abort the losers of a simultaneous insert race with a
  // deadlock (40P01) instead of the exclusion violation (23P01), and the API
  // used to answer those with a 500. It needs warm connections to happen --
  // a cold pool staggers the requests -- so the race is run repeatedly: up to
  // 40 times, but no longer than 5 seconds once two rounds are done. A local
  // database (CI) manages all 40 in about a second; a remote one is slower
  // per round and can't reproduce the deadlock anyway, since its network
  // latency staggers the requests.
  it('answers every loser of repeated races with a 409, never an error', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => seedUser()))
    const started = Date.now()

    for (let round = 0; round < 40 && (round < 2 || Date.now() - started < 5_000); round++) {
      const resource = await seedResource()
      const results = await Promise.all(
        users.map(({ token }) =>
          request(app)
            .post('/bookings')
            .set('Authorization', `Bearer ${token}`)
            .send({ resourceId: resource.id, startTime: iso(2027, 3, 1, 10), endTime: iso(2027, 3, 1, 11) }),
        ),
      )
      const statuses = results.map((r) => r.status).sort()
      expect(statuses, `round ${round}`).toEqual([201, 409, 409, 409, 409, 409, 409, 409])
    }
  }, 60_000)
})

describe('POST /bookings/:id/checkin', () => {
  beforeEach(resetDb)

  it('succeeds inside the grace window', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.frontendStatus).toBe('checkedIn')
  })

  it('fails before the booking has started', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 60 * 60 * 1000), endTime: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('fails once the grace period has elapsed', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: new Date(Date.now() - (GRACE_PERIOD_MINUTES + 5) * 60 * 1000),
        endTime: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    const res = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the booking', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('returns 409 when already checked in', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })
    await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)

    const res = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })
})

describe('POST /bookings/:id/cancel', () => {
  beforeEach(resetDb)

  it('cancels a booked booking', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 60 * 60 * 1000), endTime: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
  })

  it('frees the slot for someone else to book', async () => {
    const { user, token } = await seedUser()
    const { token: otherToken } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 60 * 60 * 1000), endTime: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    })
    await request(app).post(`/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${token}`)

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ resourceId: resource.id, startTime: booking.startTime.toISOString(), endTime: booking.endTime.toISOString() })
    expect(res.status).toBe(201)
  })

  it('returns 409 when already checked in', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })
    await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)

    const res = await request(app).post(`/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the booking', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const resource = await seedResource()
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 60 * 60 * 1000), endTime: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /bookings/me', () => {
  beforeEach(resetDb)

  it('lists only the caller\'s bookings, excluding cancelled ones', async () => {
    const { user, token } = await seedUser()
    const { user: otherUser } = await seedUser()
    const resource = await seedResource()

    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 60 * 60 * 1000), endTime: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    })
    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 3 * 60 * 60 * 1000), endTime: new Date(Date.now() + 4 * 60 * 60 * 1000), status: 'cancelled' },
    })
    await prisma.resourceBooking.create({
      data: { userId: otherUser.id, resourceId: resource.id, startTime: new Date(Date.now() + 5 * 60 * 60 * 1000), endTime: new Date(Date.now() + 6 * 60 * 60 * 1000) },
    })

    const res = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].userId).toBe(user.id)
  })

  it('computes upcomingFar for a booking well in the future', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() + 5 * 60 * 60 * 1000), endTime: new Date(Date.now() + 6 * 60 * 60 * 1000) },
    })

    const res = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].frontendStatus).toBe('upcomingFar')
    expect(res.body[0].graceRemainingSeconds).toBe(0)
  })

  it('computes inWindow with a live-counting graceRemainingSeconds', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 60 * 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })

    const res = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].frontendStatus).toBe('inWindow')
    expect(res.body[0].graceRemainingSeconds).toBeGreaterThan(0)
    expect(res.body[0].graceRemainingSeconds).toBeLessThanOrEqual(GRACE_PERIOD_MINUTES * 60)
  })

  it('computes released once the grace period has elapsed without check-in', async () => {
    const { user, token } = await seedUser()
    const resource = await seedResource()
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: new Date(Date.now() - (GRACE_PERIOD_MINUTES + 5) * 60 * 1000),
        endTime: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    const res = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].frontendStatus).toBe('released')
    expect(res.body[0].status).toBe('booked') // raw DB status is untouched -- no scheduler in this phase
  })
})

describe('POST /bookings conflict alternatives, relative to now', () => {
  beforeEach(resetDb)
  afterEach(() => vi.useRealTimers())

  // Only Date is faked: Prisma, pg and supertest keep their real timers.
  function at(y: number, m: number, d: number, h: number, min = 0) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(y, m - 1, d, h, min, 0))
  }

  type Alt = { resourceId: string; timeSlot: string; startTime: string }

  it('never suggests a window that has already started', async () => {
    at(2027, 1, 10, 15, 30)
    const { token: holder } = await seedUser()
    const { token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    await seedResource('seat', 'Desk 2')
    await request(app).post('/bookings').set('Authorization', `Bearer ${holder}`)
      .send({ resourceId: desk.id, startTime: iso(2027, 1, 10, 16), endTime: iso(2027, 1, 10, 17) })

    const res = await request(app).post('/bookings').set('Authorization', `Bearer ${token}`)
      .send({ resourceId: desk.id, startTime: iso(2027, 1, 10, 16), endTime: iso(2027, 1, 10, 17) })

    expect(res.status).toBe(409)
    const alternatives = res.body.details.alternatives as Alt[]
    for (const alt of alternatives) {
      expect(new Date(alt.startTime).getTime()).toBeGreaterThan(Date.now())
    }
    // Same desk: 9 AM-3 PM are past and 4 PM is the requested hour, so 5 PM.
    expect(alternatives.find((a) => a.resourceId === desk.id)?.timeSlot).toBe('5:00 PM')
  })

  it('offers no other resource for a window that has already started', async () => {
    // 3:10 PM: the 3:00 slot can still be booked (its check-in window is
    // open), but suggesting it on another desk would hand over a booking
    // with only minutes left to check in.
    at(2027, 1, 10, 15, 10)
    const { user: holder } = await seedUser()
    const { token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    const other = await seedResource('seat', 'Desk 2')
    // Seeded directly: the current hour is already under way.
    await prisma.resourceBooking.create({
      data: { userId: holder.id, resourceId: desk.id, startTime: new Date(iso(2027, 1, 10, 15)), endTime: new Date(iso(2027, 1, 10, 16)) },
    })

    const res = await request(app).post('/bookings').set('Authorization', `Bearer ${token}`)
      .send({ resourceId: desk.id, startTime: iso(2027, 1, 10, 15), endTime: iso(2027, 1, 10, 16) })

    expect(res.status).toBe(409)
    const alternatives = res.body.details.alternatives as Alt[]
    expect(alternatives.some((a) => a.resourceId === other.id)).toBe(false)
    expect(alternatives.find((a) => a.resourceId === desk.id)?.timeSlot).toBe('4:00 PM')
  })
})

describe('POST /bookings for a slot that is already under way', () => {
  beforeEach(resetDb)
  afterEach(() => vi.useRealTimers())

  function at(y: number, m: number, d: number, h: number, min = 0) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(y, m - 1, d, h, min, 0))
  }

  it('refuses a booking whose check-in window has already closed', async () => {
    // 3:00 PM's window closed at 3:15; at 3:30 the booking could only ever be
    // released, never used.
    at(2027, 1, 10, 15, 30)
    const { token } = await seedUser()
    const desk = await seedResource()
    const res = await request(app).post('/bookings').set('Authorization', `Bearer ${token}`)
      .send({ resourceId: desk.id, startTime: iso(2027, 1, 10, 15), endTime: iso(2027, 1, 10, 16) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('That time slot has already passed. Pick a later one.')
    expect(await prisma.resourceBooking.count()).toBe(0)
  })

  it('still accepts the current slot while it can be checked into', async () => {
    at(2027, 1, 10, 15, 10)
    const { token } = await seedUser()
    const desk = await seedResource()
    const res = await request(app).post('/bookings').set('Authorization', `Bearer ${token}`)
      .send({ resourceId: desk.id, startTime: iso(2027, 1, 10, 15), endTime: iso(2027, 1, 10, 16) })
    expect(res.status).toBe(201)
    expect(res.body.frontendStatus).toBe('inWindow')
  })
})

describe('offline resources', () => {
  beforeEach(resetDb)

  function tomorrowAt(hour: number) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(hour, 0, 0, 0)
    return d
  }

  function book(token: string, resourceId: string, start: Date) {
    return request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId, startTime: start.toISOString(), endTime: new Date(start.getTime() + 3_600_000).toISOString() })
  }

  it('booking an offline resource answers 409 with the offline message and no alternatives', async () => {
    const { token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    await seedResource('seat', 'Desk 2')
    await prisma.resource.update({ where: { id: desk.id }, data: { status: 'offline', statusNote: 'Wobbly leg' } })

    const res = await book(token, desk.id, tomorrowAt(10))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'This resource is offline right now.' })
    expect(await prisma.resourceBooking.count()).toBe(0)
  })

  it('alternatives never suggest an offline resource', async () => {
    const { token: holder } = await seedUser()
    const { token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    const spare = await seedResource('seat', 'Desk 2')
    expect((await book(holder, desk.id, tomorrowAt(10))).status).toBe(201)
    await prisma.resource.update({ where: { id: spare.id }, data: { status: 'offline' } })

    const res = await book(token, desk.id, tomorrowAt(10))

    expect(res.status).toBe(409)
    const alternatives = res.body.details.alternatives as Array<{ resourceId: string }>
    expect(alternatives.some((a) => a.resourceId === spare.id)).toBe(false)
    // The same desk's other free hours are still offered.
    expect(alternatives.some((a) => a.resourceId === desk.id)).toBe(true)
  })

  it('a student can still check in to and cancel a booking on a resource that went offline', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    const current = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: desk.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })
    const later = await book(token, desk.id, tomorrowAt(10))
    expect(later.status).toBe(201)
    await prisma.resource.update({ where: { id: desk.id }, data: { status: 'offline' } })

    const listed = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
    expect(listed.body).toHaveLength(2)

    const checkedIn = await request(app).post(`/bookings/${current.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(checkedIn.status).toBe(200)
    expect(checkedIn.body.frontendStatus).toBe('checkedIn')

    const cancelled = await request(app).post(`/bookings/${later.body.id}/cancel`).set('Authorization', `Bearer ${token}`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')
  })
})

describe('room requests', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  function requestRoom(token: string, resourceId: string, hour = 14) {
    return request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId, startTime: iso(2027, 1, 10, hour), endTime: iso(2027, 1, 10, hour + 1) })
  }

  it('creates a room booking as a request that holds the slot until the grace period ends', async () => {
    const { token } = await seedUser()
    const room = await seedResource('room', 'Room 201')

    const res = await requestRoom(token, room.id)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: 'requested', frontendStatus: 'requested', declineReason: null })
    expect(new Date(res.body.expiresAt).getTime()).toBe(
      new Date(iso(2027, 1, 10, 14)).getTime() + GRACE_PERIOD_MINUTES * 60_000,
    )
  })

  it('refuses a second student the held slot, with alternatives', async () => {
    const { token: first } = await seedUser()
    const { token: second } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    await seedResource('room', 'Room 202')
    await requestRoom(first, room.id)

    const res = await requestRoom(second, room.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This resource is already booked for that time.')
    expect(res.body.details.alternatives.length).toBeGreaterThan(0)
  })

  it('publishes nothing when the booking is refused', async () => {
    const { token: first } = await seedUser()
    const { token: second } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    await requestRoom(first, room.id)
    recorder = recordEvents()

    await requestRoom(second, room.id)

    expect(recorder.events).toEqual([])
  })

  it('lets the student withdraw a request, which frees the slot', async () => {
    const { token: first } = await seedUser()
    const { token: second } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    const asked = await requestRoom(first, room.id)
    recorder = recordEvents()

    const res = await request(app).post(`/bookings/${asked.body.id}/cancel`).set('Authorization', `Bearer ${first}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(recorder.events).toEqual([{ type: 'request.cancelled', topics: ['requests'], kind: 'room' }])
    expect((await requestRoom(second, room.id)).status).toBe(201)
  })

  it('cannot check in to a room that is still a request', async () => {
    const { token } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    const asked = await requestRoom(token, room.id)

    const res = await request(app).post(`/bookings/${asked.body.id}/checkin`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This booking cannot be checked into.')
  })
})

describe('booking changes reach the console', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  function tomorrowAt(hour: number) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(hour, 0, 0, 0)
    return d
  }

  function book(token: string, resourceId: string, start: Date) {
    return request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ resourceId, startTime: start.toISOString(), endTime: new Date(start.getTime() + 3_600_000).toISOString() })
  }

  it('requesting a room publishes request.created and no booking.changed', async () => {
    const { user, token } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    recorder = recordEvents()

    const start = tomorrowAt(14)
    const end = new Date(start.getTime() + 3_600_000)
    const res = await book(token, room.id, start)

    expect(res.status).toBe(201)
    expect(recorder.events).toEqual([
      {
        type: 'request.created',
        topics: ['requests'],
        kind: 'room',
        summary: `${user.name} wants Room 201 · ${dayLabel(start)} · ${slotLabel(start, end)}`,
      },
    ])
  })

  it('a seat booking publishes booking.changed', async () => {
    const { token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    recorder = recordEvents()

    const res = await book(token, seat.id, tomorrowAt(9))

    expect(res.status).toBe(201)
    expect(recorder.events).toEqual([{ type: 'booking.changed', topics: ['bookings', 'metrics'] }])
  })

  it('a check-in publishes booking.changed', async () => {
    const { token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    const booked = await book(token, seat.id, new Date(Date.now() - 60_000))
    expect(booked.status).toBe(201)
    recorder = recordEvents()

    const res = await request(app).post(`/bookings/${booked.body.id}/checkin`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'booking.changed', topics: ['bookings', 'metrics'] }])
  })

  it('a student cancelling a booked seat publishes booking.changed', async () => {
    const { token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    const booked = await book(token, seat.id, tomorrowAt(9))
    expect(booked.status).toBe(201)
    recorder = recordEvents()

    const res = await request(app).post(`/bookings/${booked.body.id}/cancel`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'booking.changed', topics: ['bookings', 'metrics'] }])
  })
})

describe('GET /bookings/me with room requests', () => {
  beforeEach(resetDb)

  it('shows pending requests, and declined or expired ones for a week', async () => {
    const { user, token } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)
    const row = (hour: number, data: Partial<Prisma.ResourceBookingUncheckedCreateInput>) =>
      prisma.resourceBooking.create({
        data: {
          userId: user.id,
          resourceId: room.id,
          startTime: new Date(iso(2027, 1, 10, hour)),
          endTime: new Date(iso(2027, 1, 10, hour + 1)),
          ...data,
        },
      })
    await row(9, { status: 'requested' })
    await row(10, { status: 'declined', decidedAt: daysAgo(1), declineReason: 'Reserved for an event' })
    await row(11, { status: 'expired', decidedAt: daysAgo(2) })
    await row(12, { status: 'declined', decidedAt: daysAgo(8) })
    await row(13, { status: 'cancelled', decidedAt: daysAgo(1) })

    const res = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)

    expect(res.body.map((b: { frontendStatus: string }) => b.frontendStatus)).toEqual(['requested', 'declined', 'expired'])
    expect(res.body[0].expiresAt).not.toBeNull()
    expect(res.body[1].declineReason).toBe('Reserved for an event')
    expect(res.body[2].declineReason).toBeNull()
  })
})

describe('GET /bookings/me with library cancels and moves', () => {
  beforeEach(resetDb)

  const HOUR_MS = 60 * 60 * 1000
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * HOUR_MS)

  async function seedAdmin() {
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `librarian${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    const token = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
    return { admin, token }
  }

  // A booked seat the student has not reached yet: tomorrow, so the grace period is never in play.
  function seedBooking(userId: string, resourceId: string, data: Partial<Prisma.ResourceBookingUncheckedCreateInput> = {}) {
    const start = new Date(Date.now() + 24 * HOUR_MS)
    return prisma.resourceBooking.create({
      data: { userId, resourceId, startTime: start, endTime: new Date(start.getTime() + HOUR_MS), ...data },
    })
  }

  function myBookings(token: string) {
    return request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)
  }

  it('a library-cancelled booking is listed as cancelledByLibrary with its reason', async () => {
    const { user, token } = await seedUser()
    const { token: adminToken } = await seedAdmin()
    const seat = await seedResource('seat', 'Desk 1')
    const booking = await seedBooking(user.id, seat.id)
    const cancelled = await request(app)
      .post(`/admin/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'The desk is being repaired' })
    expect(cancelled.status).toBe(200)

    const res = await myBookings(token)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      id: booking.id,
      status: 'cancelled',
      frontendStatus: 'cancelledByLibrary',
      cancelReason: 'The desk is being repaired',
      graceRemainingSeconds: 0,
      movedFrom: null,
    })
  })

  it('it disappears after 7 days', async () => {
    const { admin } = await seedAdmin()
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    const booking = await seedBooking(user.id, seat.id, {
      status: 'cancelled',
      cancelledById: admin.id,
      cancelledAt: daysAgo(6),
      cancelReason: 'The desk is being repaired',
    })
    expect((await myBookings(token)).body.map((b: { id: string }) => b.id)).toEqual([booking.id])

    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { cancelledAt: daysAgo(8) } })

    expect((await myBookings(token)).body).toEqual([])
  })

  it('a cancel by the student is still not listed', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    const room = await seedResource('room', 'Room 201')
    const booking = await seedBooking(user.id, seat.id)
    const pending = await seedBooking(user.id, room.id, { status: 'requested' })

    const seatCancel = await request(app).post(`/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${token}`)
    const withdraw = await request(app).post(`/bookings/${pending.id}/cancel`).set('Authorization', `Bearer ${token}`)

    expect(seatCancel.status).toBe(200)
    expect(withdraw.status).toBe(200)
    expect((await myBookings(token)).body).toEqual([])
  })

  it('a moved booking shows the new resource name and movedFrom', async () => {
    const { user, token } = await seedUser()
    const { token: adminToken } = await seedAdmin()
    const oldDesk = await seedResource('seat', 'Desk 1')
    const newDesk = await seedResource('seat', 'Desk 2')
    const booking = await seedBooking(user.id, oldDesk.id)
    const moved = await request(app)
      .post(`/admin/bookings/${booking.id}/reassign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resourceId: newDesk.id })
    expect(moved.status).toBe(200)

    const res = await myBookings(token)

    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      id: booking.id,
      resourceId: newDesk.id,
      resourceName: 'Desk 2',
      movedFrom: 'Desk 1',
      frontendStatus: 'upcomingFar',
      cancelReason: null,
    })
  })

  it('movedFrom is null after 7 days', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 2')
    const booking = await seedBooking(user.id, seat.id, { movedFromName: 'Desk 1', movedAt: daysAgo(6) })
    expect((await myBookings(token)).body[0].movedFrom).toBe('Desk 1')

    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { movedAt: daysAgo(8) } })

    const res = await myBookings(token)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ resourceName: 'Desk 2', movedFrom: null })
  })

  it('an existing booking has null cancelReason and movedFrom', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    await seedBooking(user.id, seat.id)

    const res = await myBookings(token)

    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ frontendStatus: 'upcomingFar', cancelReason: null, movedFrom: null })
  })
})

describe('GET /bookings/me with problem-report flags', () => {
  beforeEach(resetDb)
  afterEach(() => vi.restoreAllMocks())

  const MINUTE_MS = 60 * 1000
  const HOUR_MS = 60 * MINUTE_MS
  const DAY_MS = 24 * HOUR_MS
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

  type Status = Prisma.ResourceBookingUncheckedCreateInput['status']
  type Row = { id: string; resourceId: string; canReport: boolean; reportOpen: boolean }

  /** A booking that starts `offsetMs` from now (negative: that long ago) and lasts an hour. */
  function seedBooking(userId: string, resourceId: string, offsetMs: number, status: Status = 'booked') {
    const startTime = new Date(Date.now() + offsetMs)
    return prisma.resourceBooking.create({
      data: { userId, resourceId, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status },
    })
  }

  function seedReport(userId: string, resourceId: string, status: 'open' | 'confirmed' | 'dismissed' = 'open') {
    return prisma.issueReport.create({ data: { userId, resourceId, category: 'dirty', status } })
  }

  function myBookings(token: string) {
    return request(app).get('/bookings/me').set(auth(token))
  }

  const flagsOf = (row: Row) => ({ canReport: row.canReport, reportOpen: row.reportOpen })

  it('shows canReport and reportOpen correctly and a student with no booking sees false', async () => {
    const { user, token } = await seedUser()
    const { user: other, token: otherToken } = await seedUser()
    const { token: loner } = await seedUser()
    const fresh = await seedResource('seat', 'Fresh')
    const reported = await seedResource('seat', 'Reported')
    const closed = await seedResource('seat', 'Closed')
    const agedOut = await seedResource('seat', 'Aged out')
    const reportedAgedOut = await seedResource('seat', 'Reported and aged out')
    const tooFar = await seedResource('seat', 'Too far ahead')
    await seedBooking(user.id, fresh.id, -HOUR_MS, 'checked_in')
    await seedBooking(user.id, reported.id, -2 * HOUR_MS, 'checked_in')
    await seedReport(user.id, reported.id)
    await seedBooking(user.id, closed.id, -2 * DAY_MS)
    await seedReport(user.id, closed.id, 'dismissed')
    await seedReport(user.id, closed.id, 'confirmed')
    await seedBooking(user.id, agedOut.id, -8 * DAY_MS, 'completed')
    await seedBooking(user.id, reportedAgedOut.id, -8 * DAY_MS, 'completed')
    await seedReport(user.id, reportedAgedOut.id)
    await seedBooking(user.id, tooFar.id, 25 * HOUR_MS)
    // Another student's open reports, on desks this student sits at, say nothing about this student's own.
    await seedBooking(other.id, fresh.id, -4 * HOUR_MS, 'checked_in')
    await seedBooking(other.id, agedOut.id, -3 * DAY_MS, 'completed')
    await seedReport(other.id, fresh.id)
    await seedReport(other.id, agedOut.id)

    const res = await myBookings(token)
    const byResource = new Map((res.body as Row[]).map((row) => [row.resourceId, flagsOf(row)]))

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(6)
    expect(byResource.get(fresh.id)).toEqual({ canReport: true, reportOpen: false })
    expect(byResource.get(reported.id)).toEqual({ canReport: false, reportOpen: true })
    // A closed report, however many, neither blocks the next one nor shows as open.
    expect(byResource.get(closed.id)).toEqual({ canReport: true, reportOpen: false })
    // Out of the window: nothing to report. An open report still shows, so the app can say it was sent.
    expect(byResource.get(agedOut.id)).toEqual({ canReport: false, reportOpen: false })
    expect(byResource.get(reportedAgedOut.id)).toEqual({ canReport: false, reportOpen: true })
    expect(byResource.get(tooFar.id)).toEqual({ canReport: false, reportOpen: false })
    // The other student sees their own flags.
    const theirs = new Map(((await myBookings(otherToken)).body as Row[]).map((row) => [row.resourceId, flagsOf(row)]))
    expect(theirs.size).toBe(2)
    expect(theirs.get(fresh.id)).toEqual({ canReport: false, reportOpen: true })
    expect(theirs.get(agedOut.id)).toEqual({ canReport: false, reportOpen: true })
    // A student with no booking has no rows, so no flag at all.
    expect((await myBookings(loner)).body).toEqual([])
  })

  it('a student whose own booking does not qualify sees false, whatever others booked or reported', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    await seedBooking(user.id, desk.id, -9 * DAY_MS, 'completed')
    await seedBooking(other.id, desk.id, -HOUR_MS, 'checked_in')
    await seedReport(other.id, desk.id)

    const res = await myBookings(token)

    expect(res.body).toHaveLength(1)
    expect(flagsOf(res.body[0])).toEqual({ canReport: false, reportOpen: false })
  })

  it("canReport is a booking's own: a request or a booking outside the window shows false next to one that qualifies; reportOpen is the resource's", async () => {
    const { user, token } = await seedUser()
    const room = await seedResource('room', 'Group Room 201')
    const pending = await seedBooking(user.id, room.id, 3 * HOUR_MS, 'requested')
    const past = await seedBooking(user.id, room.id, -2 * DAY_MS, 'completed')
    const later = await seedBooking(user.id, room.id, 3 * DAY_MS)
    const flagsById = async () => new Map(((await myBookings(token)).body as Row[]).map((row) => [row.id, flagsOf(row)]))

    const before = await flagsById()
    expect(before.get(pending.id)).toEqual({ canReport: false, reportOpen: false })
    expect(before.get(past.id)).toEqual({ canReport: true, reportOpen: false })
    expect(before.get(later.id)).toEqual({ canReport: false, reportOpen: false })

    await seedReport(user.id, room.id)

    // Every booking of the room now says a report is open, and none can send another.
    const after = await flagsById()
    for (const id of [pending.id, past.id, later.id]) expect(after.get(id)).toEqual({ canReport: false, reportOpen: true })
  })

  it('canReport is true exactly when POST /reports would accept, a minute either side of both limits', async () => {
    const { user, token } = await seedUser()
    // [what, start relative to now, status, whether it qualifies]
    const cases: Array<[string, number, Status, boolean]> = [
      ['started 6 days ago', -6 * DAY_MS, 'booked', true],
      ['a minute inside 7 days ago', -(7 * DAY_MS - MINUTE_MS), 'booked', true],
      ['a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'booked', false],
      ['starts in 23 hours', 23 * HOUR_MS, 'booked', true],
      ['a minute inside 24 hours ahead', 24 * HOUR_MS - MINUTE_MS, 'booked', true],
      ['a minute outside 24 hours ahead', 24 * HOUR_MS + MINUTE_MS, 'booked', false],
      ['completed yesterday', -DAY_MS, 'completed', true],
      ['checked in', -HOUR_MS, 'checked_in', true],
      ['a request', 2 * HOUR_MS, 'requested', false],
      // The sweep turns a booking never checked into into a no-show, and an overturned one is a
      // release: both still entitle, inside the same window as the rest.
      ['a no-show', -HOUR_MS, 'no_show', true],
      ['a release', -HOUR_MS, 'released', true],
      ['a no-show a minute inside 7 days ago', -(7 * DAY_MS - MINUTE_MS), 'no_show', true],
      ['a no-show a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'no_show', false],
      ['a release a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'released', false],
    ]
    const expectedOf = new Map<string, [string, boolean]>()
    for (const [what, offset, status, qualifies] of cases) {
      const resource = await seedResource('seat', what)
      await seedBooking(user.id, resource.id, offset, status)
      expectedOf.set(resource.id, [what, qualifies])
    }

    const rows = (await myBookings(token)).body as Row[]
    expect(rows).toHaveLength(cases.length)
    for (const row of rows) {
      const [what, qualifies] = expectedOf.get(row.resourceId)!
      expect(flagsOf(row), what).toEqual({ canReport: qualifies, reportOpen: false })
      const posted = await request(app).post('/reports').set(auth(token)).send({ resourceId: row.resourceId, category: 'dirty' })
      expect(posted.status, what).toBe(qualifies ? 201 : 403)
    }

    // What was accepted is now open and cannot be reported twice; the rest is as it was.
    for (const row of (await myBookings(token)).body as Row[]) {
      const [what, qualifies] = expectedOf.get(row.resourceId)!
      expect(flagsOf(row), what).toEqual({ canReport: false, reportOpen: qualifies })
    }
  })

  it('reads the flags with one lookup of open reports however many bookings are listed', async () => {
    const { user, token } = await seedUser()
    const spies = [
      vi.spyOn(prisma.issueReport, 'findMany'),
      vi.spyOn(prisma.issueReport, 'findFirst'),
      vi.spyOn(prisma.issueReport, 'findUnique'),
      vi.spyOn(prisma.issueReport, 'count'),
      vi.spyOn(prisma.resourceBooking, 'findMany'),
      vi.spyOn(prisma.resourceBooking, 'findFirst'),
      vi.spyOn(prisma.resourceBooking, 'count'),
    ]
    // How often each of those reads ran during the one request made by `read`.
    async function callsDuring(read: () => Promise<request.Response>) {
      spies.forEach((spy) => spy.mockClear())
      const res = await read()
      return { res, calls: spies.map((spy) => spy.mock.calls.length) }
    }
    let desks = 0
    async function addDesk() {
      const resource = await seedResource('seat', `Desk ${++desks}`)
      await seedBooking(user.id, resource.id, -HOUR_MS, 'checked_in')
      if (desks % 2 === 0) await seedReport(user.id, resource.id)
    }

    await addDesk()
    const one = await callsDuring(() => myBookings(token))
    for (let i = 0; i < 6; i++) await addDesk()
    const seven = await callsDuring(() => myBookings(token))

    expect(one.res.body).toHaveLength(1)
    expect(seven.res.body).toHaveLength(7)
    expect(seven.res.body.filter((row: Row) => row.reportOpen)).toHaveLength(3)
    // One read of the student's bookings and one of their open reports, whatever the list holds.
    expect(one.calls).toEqual([1, 0, 0, 0, 1, 0, 0])
    expect(seven.calls).toEqual(one.calls)
  })

  it('the answers to booking, checking in and cancelling carry the flags too', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    const otherDesk = await seedResource('seat', 'Desk 2')
    const soon = new Date(Date.now() + 2 * HOUR_MS)

    const created = await request(app)
      .post('/bookings')
      .set(auth(token))
      .send({ resourceId: desk.id, startTime: soon.toISOString(), endTime: new Date(soon.getTime() + HOUR_MS).toISOString() })
    const started = await seedBooking(user.id, otherDesk.id, -MINUTE_MS)
    const checkedIn = await request(app).post(`/bookings/${started.id}/checkin`).set(auth(token))
    const later = await seedBooking(user.id, desk.id, 5 * HOUR_MS)
    await seedReport(user.id, desk.id)
    const cancelled = await request(app).post(`/bookings/${later.id}/cancel`).set(auth(token))

    // A seat booked for later today starts within the next 24 hours, so it can be reported.
    expect(created.status).toBe(201)
    expect(flagsOf(created.body)).toEqual({ canReport: true, reportOpen: false })
    expect(checkedIn.status).toBe(200)
    expect(checkedIn.body).toMatchObject({ frontendStatus: 'checkedIn', canReport: true, reportOpen: false })
    // A cancelled booking never qualifies; the open report on its desk still shows.
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toMatchObject({ status: 'cancelled', canReport: false, reportOpen: true })
  })

  it('a booking row has exactly these keys: slice 6 added the two flags, slice 7 added noShow, nothing else changed', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')

    const [row] = (await myBookings(token)).body as Row[]

    expect(Object.keys(row).sort()).toEqual(
      [
        'id', 'userId', 'resourceId', 'resourceName', 'resourceType', 'startTime', 'endTime', 'status', 'frontendStatus',
        'graceRemainingSeconds', 'checkedInAt', 'expiresAt', 'declineReason', 'cancelReason', 'movedFrom',
        'canReport', 'reportOpen', 'noShow',
      ].sort(),
    )
  })
})

// --- Slice 7: a cancel after the grace period, and a check-in's no-show event --------------------

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

// A heavy test here is 25 to 30 round trips to a remote database (8 to 9 s on a slow day), so the
// two describes take a longer timeout than the file's 15 s default.
describe('POST /bookings/:id/cancel once the grace period has ended', { timeout: 60_000 }, () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  /** A one-hour booking on a seat of its own whose grace period ends `graceEndsInMs` from now (negative: it ended that long ago). */
  async function seatWithGraceEndingIn(userId: string, graceEndsInMs: number, status: BookingStatus = 'booked') {
    const seat = await seedResource()
    const startTime = new Date(Date.now() + graceEndsInMs - GRACE_PERIOD_MINUTES * MINUTE_MS)
    return prisma.resourceBooking.create({
      data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status },
    })
  }
  const cancel = (token: string, id: string) => request(app).post(`/bookings/${id}/cancel`).set('Authorization', `Bearer ${token}`)

  it('a cancel after the grace period is 409 and the booking is untouched', async () => {
    const { user, token } = await seedUser()
    const booking = await seatWithGraceEndingIn(user.id, -MINUTE_MS)
    recorder = recordEvents()

    const res = await cancel(token, booking.id)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'This booking has already been released.' })
    const after = await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })
    expect(after).toEqual(booking)
    expect(after.status).toBe('booked')
    expect(after.cancelledAt).toBeNull()
    // A refusal publishes nothing.
    expect(recorder.events).toEqual([])

    // It did not dodge the sweep: the next sweep records the no-show.
    expect(await sweepBookings(new Date())).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('no_show')
  })

  it('a cancel one minute before the grace period ends is allowed and records no no-show', async () => {
    const { user, token } = await seedUser()
    // Started 14 minutes ago: after the start, inside the grace period.
    const booking = await seatWithGraceEndingIn(user.id, MINUTE_MS)

    const res = await cancel(token, booking.id)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    // Costs nothing now, and nothing later: not even a sweep run well after the grace end finds it.
    expect(await sweepBookings(new Date(Date.now() + 30 * MINUTE_MS))).toEqual({ noShows: 0, reminders: 0, remaining: 0 })
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).reliabilityScore).toBe(100)
  })

  it('refuses only strictly after the grace end: exactly at it the cancel still works, a millisecond later it does not', async () => {
    const { user } = await seedUser()
    const atTheEnd = await seatWithGraceEndingIn(user.id, 5 * MINUTE_MS)
    // A second booking with the very same start, so the same grace end.
    const seat = await seedResource()
    const justAfter = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: seat.id, startTime: atTheEnd.startTime, endTime: atTheEnd.endTime, status: 'booked' },
    })
    const graceEnd = atTheEnd.startTime.getTime() + GRACE_PERIOD_MINUTES * MINUTE_MS

    // Only Date is faked: the clock cancelBooking reads stands still at the instant under test.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(graceEnd)
      expect((await cancelBooking(user.id, atTheEnd.id)).status).toBe('cancelled')

      vi.setSystemTime(graceEnd + 1)
      await expect(cancelBooking(user.id, justAfter.id)).rejects.toMatchObject({ status: 409, message: 'This booking has already been released.' })
    } finally {
      vi.useRealTimers()
    }
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: justAfter.id } })).status).toBe('booked')
  })

  it('a room request can still be withdrawn after its start: its own lapse rules apply, not this one', async () => {
    const { user, token } = await seedUser()
    const room = await seedResource('room', 'Room 201')
    const startTime = new Date(Date.now() - 20 * MINUTE_MS)
    const request_ = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: room.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'requested' },
    })

    const res = await cancel(token, request_.id)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
  })

  // The same words the rule above uses, and the librarian's cancel uses for the same case: whether the
  // student pressed Cancel a second before the sweep ran (a still-`booked` row past its grace) or a second
  // after (a stored `no_show`), the reason is the same one.
  it.each(['no_show', 'released'] as const)('a stored %s booking answers "already been released", and nothing changes', async (status) => {
    const { user, token } = await seedUser()
    const booking = await seatWithGraceEndingIn(user.id, -MINUTE_MS, status)

    const res = await cancel(token, booking.id)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'This booking has already been released.' })
    expect(await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(booking)
  })

  it.each(['cancelled', 'declined', 'expired', 'checked_in', 'completed'] as const)(
    'a %s booking keeps the generic refusal, and nothing changes',
    async (status) => {
      const { user, token } = await seedUser()
      const booking = await seatWithGraceEndingIn(user.id, -MINUTE_MS, status)

      const res = await cancel(token, booking.id)

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'This booking cannot be cancelled.' })
      expect(await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(booking)
    },
  )

  it('a cancel that loses its write to the sweep says "already been released", and the no-show stands', async () => {
    const { user } = await seedUser()
    // Inside the grace period when the student presses Cancel, so the rule above lets it through to its write.
    const booking = await seatWithGraceEndingIn(user.id, 5 * MINUTE_MS)

    // The sweep's committed result lands while the cancel's write waits on the booking row.
    const settled = await bookingLockedThenCompete(
      booking.id,
      () => cancelBooking(user.id, booking.id),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'no_show' } })
      },
    )

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: 'This booking has already been released.' })
    const after = await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })
    expect(after.status).toBe('no_show')
    expect(after.cancelledAt).toBeNull()
  })

  it.each([
    ['a librarian cancelled it', { status: 'cancelled', cancelledAt: new Date() }],
    ['the student checked in on another device', { status: 'checked_in', checkedInAt: new Date() }],
  ] as const)('a cancel that loses its write because %s keeps the generic refusal', async (_what, change) => {
    const { user } = await seedUser()
    const booking = await seatWithGraceEndingIn(user.id, 5 * MINUTE_MS)

    const settled = await bookingLockedThenCompete(
      booking.id,
      () => cancelBooking(user.id, booking.id),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: change })
      },
    )

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: 'This booking cannot be cancelled.' })
  })
})

describe('POST /bookings/:id/checkin and the no-show event', { timeout: 60_000 }, () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  /** A booking whose window opened `startedMsAgo` ago, on a seat of its own. */
  async function seatStartedAgo(userId: string, startedMsAgo: number, status: BookingStatus = 'booked') {
    const seat = await seedResource()
    const startTime = new Date(Date.now() - startedMsAgo)
    return prisma.resourceBooking.create({
      data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status },
    })
  }
  const checkIn = (token: string, id: string) => request(app).post(`/bookings/${id}/checkin`).set('Authorization', `Bearer ${token}`)
  const scoreOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } }).then((u) => u.reliabilityScore)

  it('check-in on a no_show booking is 409', async () => {
    const { user, token } = await seedUser()
    // One inside what would have been the window (so only the status can refuse it) and one after it.
    const inside = await seatStartedAgo(user.id, 1_000, 'no_show')
    const after = await seatStartedAgo(user.id, 20 * MINUTE_MS, 'no_show')
    const event = await prisma.noShowEvent.create({ data: { resourceBookingId: after.id, userId: user.id, actualNoShow: true, reliabilityDelta: -10 } })
    recorder = recordEvents()

    for (const booking of [inside, after]) {
      const res = await checkIn(token, booking.id)
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'This booking cannot be checked into.' })
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('no_show')
    }
    // No bonus, no log, nothing published, and the event still says what the sweep recorded.
    expect(await scoreOf(user.id)).toBe(100)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect(recorder.events).toEqual([])
    expect(await prisma.noShowEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event)
  })

  it('a check-in marks an existing NoShowEvent actualNoShow=false', async () => {
    const { user, token } = await seedUser()
    await prisma.user.update({ where: { id: user.id }, data: { reliabilityScore: 90 } })
    const { user: other } = await seedUser()
    const booking = await seatStartedAgo(user.id, 1_000)
    const scored = await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: user.id, predictedProbability: 0.31 } })
    // Another booking's event is none of this check-in's business.
    const otherBooking = await seatStartedAgo(other.id, 1_000)
    const otherEvent = await prisma.noShowEvent.create({ data: { resourceBookingId: otherBooking.id, userId: other.id, predictedProbability: 0.5 } })

    const res = await checkIn(token, booking.id)

    expect(res.status).toBe(200)
    expect(res.body.frontendStatus).toBe('checkedIn')
    const after = await prisma.noShowEvent.findUniqueOrThrow({ where: { id: scored.id } })
    expect(after.actualNoShow).toBe(false)
    // Only that flag changes: the score the model gave it stays, for the retraining.
    expect(after).toEqual({ ...scored, actualNoShow: false })
    expect(await prisma.noShowEvent.findUniqueOrThrow({ where: { id: otherEvent.id } })).toEqual(otherEvent)
    // ...and the on-time bonus is still paid, once.
    expect(await scoreOf(user.id)).toBe(90 + RELIABILITY_ONTIME_BOOKING_BONUS)
  })

  it('a check-in of a booking that was never scored makes no event', async () => {
    const { user, token } = await seedUser()
    const booking = await seatStartedAgo(user.id, 1_000)

    const res = await checkIn(token, booking.id)

    expect(res.status).toBe(200)
    expect(await prisma.noShowEvent.count()).toBe(0)
  })

  it('a refused check-in leaves the event alone', async () => {
    const { user, token } = await seedUser()
    const booking = await seatStartedAgo(user.id, 20 * MINUTE_MS) // booked, grace period over
    const event = await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: user.id, predictedProbability: 0.4 } })

    const res = await checkIn(token, booking.id)

    expect(res.status).toBe(409)
    expect(await prisma.noShowEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event)
  })

  it('a check-in that loses to the sweep leaves the event as the sweep wrote it', async () => {
    const { user } = await seedUser()
    const booking = await seatStartedAgo(user.id, 1_000)
    await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: user.id, predictedProbability: 0.4 } })

    // The sweep's committed result lands while the check-in's write waits on the booking row.
    const settled = await bookingLockedThenCompete(
      booking.id,
      () => checkInBooking(user.id, booking.id),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'no_show' } })
        await tx.noShowEvent.update({ where: { resourceBookingId: booking.id }, data: { actualNoShow: true, reliabilityDelta: -10 } })
      },
    )

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: 'This booking cannot be checked into.' })
    // The event is still the sweep's: the check-in wrote nothing, the flag was not flipped back.
    const event = await prisma.noShowEvent.findUniqueOrThrow({ where: { resourceBookingId: booking.id } })
    expect(event.actualNoShow).toBe(true)
    expect(event.reliabilityDelta).toBe(-10)
    expect(await scoreOf(user.id)).toBe(100)
  })

  it('takes the booking row, then the event row, then the student row: the sweep\'s lock order', async () => {
    const { user, token } = await seedUser()
    const booking = await seatStartedAgo(user.id, 1_000)
    await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: user.id, predictedProbability: 0.4 } })

    // Hold the STUDENT's row, so the check-in gets as far as its student-row lock and waits there.
    // By then it must already hold the other two: a competing sweep (booking, event, student) could
    // otherwise wait on it in a circle.
    let pending: PromiseLike<request.Response> | undefined
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`
        pending = checkIn(token, booking.id).then((res) => res)
        await waitUntilAWriterIsBlocked()
        await expect(prisma.$queryRaw`SELECT id FROM "ResourceBooking" WHERE id = ${booking.id} FOR UPDATE NOWAIT`).rejects.toThrow()
        await expect(prisma.$queryRaw`SELECT id FROM "NoShowEvent" WHERE "resourceBookingId" = ${booking.id} FOR UPDATE NOWAIT`).rejects.toThrow()
      },
      { timeout: 30_000, maxWait: 30_000 },
    ).finally(async () => {
      await pending
    })

    const res = await pending!
    expect(res.status).toBe(200)
    expect((await prisma.noShowEvent.findUniqueOrThrow({ where: { resourceBookingId: booking.id } })).actualNoShow).toBe(false)
  })
})

// --- Slice 7: the `noShow` key every booking response carries --------------------------------------
// (The dispute route itself is in test/routes/noShowDisputes.test.ts.)

describe('booking responses and the no-show state', { timeout: 60_000 }, () => {
  beforeEach(resetDb)
  afterEach(() => vi.restoreAllMocks())

  const DAY_MS = 24 * HOUR_MS
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

  type NoShowRow = {
    id: string
    resourceId: string
    status: string
    frontendStatus: string
    graceRemainingSeconds: number
    noShow: { canDispute: boolean; dispute: { status: string; note: string | null } | null } | null
  }

  /** A one-hour booking on a seat of its own whose check-in window closed `endedAgoMs` ago. */
  async function seatEndedAgo(userId: string, endedAgoMs: number, status: BookingStatus = 'no_show') {
    const seat = await seedResource()
    const startTime = new Date(Date.now() - endedAgoMs - GRACE_PERIOD_MINUTES * MINUTE_MS)
    return prisma.resourceBooking.create({
      data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status },
    })
  }

  function seedDispute(bookingId: string, userId: string, status: 'open' | 'overturned' | 'upheld', resolutionNote: string | null = null) {
    return prisma.noShowDispute.create({
      data: { bookingId, userId, reason: 'The scanner was down', status, resolutionNote, ...(status === 'open' ? {} : { resolvedAt: new Date() }) },
    })
  }

  const myBookings = (token: string) => request(app).get('/bookings/me').set(auth(token))
  const byResource = (rows: NoShowRow[]) => new Map(rows.map((row) => [row.resourceId, row]))

  it("GET /bookings/me shows noShow {canDispute, dispute} and keeps frontendStatus 'released'", async () => {
    const { user, token } = await seedUser()
    const fresh = await seatEndedAgo(user.id, HOUR_MS)
    const opened = await seatEndedAgo(user.id, HOUR_MS)
    const upheld = await seatEndedAgo(user.id, 2 * HOUR_MS)
    const late = await seatEndedAgo(user.id, 8 * DAY_MS)
    await seedDispute(opened.id, user.id, 'open')
    await seedDispute(upheld.id, user.id, 'upheld', 'The scanner log shows no tap')

    const res = await myBookings(token)

    expect(res.status).toBe(200)
    const rows = byResource(res.body)
    expect(rows.size).toBe(4)
    // Inside the 7 days with no dispute yet: the one state the Dispute button shows for.
    expect(rows.get(fresh.resourceId)!.noShow).toEqual({ canDispute: true, dispute: null })
    // A dispute under review, then one the library kept: canDispute is false, the note is null until there is one.
    expect(rows.get(opened.resourceId)!.noShow).toEqual({ canDispute: false, dispute: { status: 'open', note: null } })
    expect(rows.get(upheld.resourceId)!.noShow).toEqual({ canDispute: false, dispute: { status: 'upheld', note: 'The scanner log shows no tap' } })
    // Past the 7 days: nothing to dispute with, nothing disputed.
    expect(rows.get(late.resourceId)!.noShow).toEqual({ canDispute: false, dispute: null })
    // An older app decodes only the values it knows: a no-show is still 'released' to it, the stored status says no_show.
    for (const row of rows.values()) {
      expect(row).toMatchObject({ status: 'no_show', frontendStatus: 'released', graceRemainingSeconds: 0 })
    }
  })

  it('an overturned booking is released again and keeps saying what happened', async () => {
    const { user, token } = await seedUser()
    const overturned = await seatEndedAgo(user.id, 2 * HOUR_MS, 'released')
    const plain = await seatEndedAgo(user.id, 2 * HOUR_MS, 'released')
    await seedDispute(overturned.id, user.id, 'overturned', 'The scanner was down that morning')

    const rows = byResource((await myBookings(token)).body)

    expect(rows.get(overturned.resourceId)).toMatchObject({
      status: 'released',
      frontendStatus: 'released',
      noShow: { canDispute: false, dispute: { status: 'overturned', note: 'The scanner was down that morning' } },
    })
    // A release that never was a recorded no-show has nothing to say.
    expect(rows.get(plain.resourceId)).toMatchObject({ status: 'released', frontendStatus: 'released', noShow: null })
  })

  it('a booking that is not a no-show has noShow null', async () => {
    const { user, token } = await seedUser()
    const { user: librarian } = await seedUser()
    const now = Date.now()
    const hourFrom = (offsetMs: number) => ({ startTime: new Date(now + offsetMs), endTime: new Date(now + offsetMs + HOUR_MS) })
    const cases: Array<[string, Prisma.ResourceBookingUncheckedCreateWithoutResourceInput]> = [
      ['booked, window not open yet', { userId: user.id, status: 'booked', ...hourFrom(3 * HOUR_MS) }],
      ['booked, inside the window', { userId: user.id, status: 'booked', ...hourFrom(-5 * MINUTE_MS) }],
      ['booked, grace ended but not swept yet', { userId: user.id, status: 'booked', ...hourFrom(-2 * HOUR_MS) }],
      ['checked in', { userId: user.id, status: 'checked_in', ...hourFrom(-HOUR_MS), checkedInAt: new Date(now - HOUR_MS) }],
      ['completed', { userId: user.id, status: 'completed', ...hourFrom(-2 * DAY_MS) }],
      ['a room request', { userId: user.id, status: 'requested', ...hourFrom(5 * HOUR_MS) }],
      ['a declined request', { userId: user.id, status: 'declined', decidedAt: new Date(now), ...hourFrom(5 * HOUR_MS) }],
      ['an expired request', { userId: user.id, status: 'expired', decidedAt: new Date(now), ...hourFrom(-2 * HOUR_MS) }],
      ['cancelled by the library', { userId: user.id, status: 'cancelled', cancelledById: librarian.id, cancelledAt: new Date(now), ...hourFrom(5 * HOUR_MS) }],
      ['released, never a recorded no-show', { userId: user.id, status: 'released', ...hourFrom(-2 * DAY_MS) }],
    ]
    const expected = new Map<string, string>()
    for (const [what, data] of cases) {
      const resource = await seedResource('seat', what)
      await prisma.resourceBooking.create({ data: { ...data, resourceId: resource.id } })
      expected.set(resource.id, what)
    }

    const res = await myBookings(token)

    expect(res.body).toHaveLength(cases.length)
    for (const row of res.body as NoShowRow[]) {
      // The key is there and null: a booking that is not a no-show says so rather than leaving the key out.
      expect(row, expected.get(row.resourceId)).toHaveProperty('noShow', null)
    }
  })

  it('every booking-returning route carries the noShow key', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Desk 1')
    const room = await seedResource('room', 'Group Room 201')
    const otherSeat = await seedResource('seat', 'Desk 2')
    const soon = new Date(Date.now() + 2 * HOUR_MS)
    const book = (resourceId: string) =>
      request(app)
        .post('/bookings')
        .set(auth(token))
        .send({ resourceId, startTime: soon.toISOString(), endTime: new Date(soon.getTime() + HOUR_MS).toISOString() })

    const seatBooked = await book(seat.id)
    const roomRequested = await book(room.id)
    const started = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: otherSeat.id, startTime: new Date(Date.now() - MINUTE_MS), endTime: new Date(Date.now() + HOUR_MS) },
    })
    const checkedIn = await request(app).post(`/bookings/${started.id}/checkin`).set(auth(token))
    const cancelled = await request(app).post(`/bookings/${seatBooked.body.id}/cancel`).set(auth(token))
    const listed = await myBookings(token)

    expect(seatBooked.status).toBe(201)
    expect(roomRequested.status).toBe(201)
    expect(checkedIn.status).toBe(200)
    expect(cancelled.status).toBe(200)
    expect(listed.status).toBe(200)
    for (const [what, body] of [
      ['POST /bookings (a seat)', seatBooked.body],
      ['POST /bookings (a room request)', roomRequested.body],
      ['check-in', checkedIn.body],
      ['cancel', cancelled.body],
      ...(listed.body as unknown[]).map((row, i) => [`GET /bookings/me row ${i}`, row] as const),
    ] as Array<[string, object]>) {
      expect(body, what).toHaveProperty('noShow', null)
    }
    expect(listed.body.length).toBeGreaterThan(0)
  })

  it('loads the disputes with the bookings in one query however many are listed', async () => {
    const { user, token } = await seedUser()
    const spies = [
      vi.spyOn(prisma.noShowDispute, 'findMany'),
      vi.spyOn(prisma.noShowDispute, 'findFirst'),
      vi.spyOn(prisma.noShowDispute, 'findUnique'),
      vi.spyOn(prisma.noShowDispute, 'count'),
      vi.spyOn(prisma.resourceBooking, 'findMany'),
      vi.spyOn(prisma.resourceBooking, 'findFirst'),
      vi.spyOn(prisma.resourceBooking, 'count'),
    ]
    // How often each of those reads ran during the one request made by `read`.
    async function callsDuring(read: () => Promise<request.Response>) {
      spies.forEach((spy) => spy.mockClear())
      const res = await read()
      return { res, calls: spies.map((spy) => spy.mock.calls.length) }
    }
    const statuses = ['open', 'upheld', 'overturned'] as const
    let added = 0
    async function addDisputed() {
      const status = statuses[added++ % statuses.length]
      const booking = await seatEndedAgo(user.id, HOUR_MS, status === 'overturned' ? 'released' : 'no_show')
      await seedDispute(booking.id, user.id, status, status === 'open' ? null : `Note ${added}`)
    }

    await addDisputed()
    const one = await callsDuring(() => myBookings(token))
    for (let i = 0; i < 6; i++) await addDisputed()
    const seven = await callsDuring(() => myBookings(token))

    expect(one.res.body).toHaveLength(1)
    expect(seven.res.body).toHaveLength(7)
    // The disputes came with the bookings: every row carries its own, so none was read one at a time.
    const noShows = (seven.res.body as NoShowRow[]).map((row) => row.noShow?.dispute?.status).sort()
    expect(noShows).toEqual(['open', 'open', 'open', 'overturned', 'overturned', 'upheld', 'upheld'])
    // One read of the student's bookings (the disputes loaded with it) and none of the dispute table's own, whatever the list holds.
    expect(one.calls).toEqual([0, 0, 0, 0, 1, 0, 0])
    expect(seven.calls).toEqual(one.calls)
  })
})
