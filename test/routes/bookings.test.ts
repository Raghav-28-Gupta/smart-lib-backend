import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { GRACE_PERIOD_MINUTES, JWT_SECRET } from '../../src/config/constants'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { dayLabel, slotLabel } from '../../src/lib/timeLabels'
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
      ['a no-show', -HOUR_MS, 'no_show', false],
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

  it('the only change to a booking row is the two new keys', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource('seat', 'Desk 1')
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')

    const [row] = (await myBookings(token)).body as Row[]

    expect(Object.keys(row).sort()).toEqual(
      [
        'id', 'userId', 'resourceId', 'resourceName', 'resourceType', 'startTime', 'endTime', 'status', 'frontendStatus',
        'graceRemainingSeconds', 'checkedInAt', 'expiresAt', 'declineReason', 'cancelReason', 'movedFrom',
        'canReport', 'reportOpen',
      ].sort(),
    )
  })
})
