import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { GRACE_PERIOD_MINUTES, JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

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
