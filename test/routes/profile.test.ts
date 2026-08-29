import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedUser(reliabilityScore = 100) {
  const user = await prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x', reliabilityScore },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

describe('GET /profile/reliability', () => {
  beforeEach(resetDb)

  it('reports Good standing with an empty history for a fresh user', async () => {
    const { token } = await seedUser(100)
    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 100, tier: 'Good standing', ringFraction: 1, history: [] })
    expect(res.body.note).toMatch(/no missed/i)
  })

  it('reports a lower tier, ringFraction, and a recovery note for a degraded score', async () => {
    const { user, token } = await seedUser(50)
    await prisma.reliabilityScoreLog.create({
      data: { userId: user.id, score: 50, delta: -20, reason: 'Missed check-in window for Group Room 201' },
    })

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)
    expect(res.body).toMatchObject({ score: 50, tier: 'Building back up', ringFraction: 0.5 })
    expect(res.body.note).toContain('Missed check-in window for Group Room 201')
  })

  it('maps log entries to ok/miss in chronological order', async () => {
    const { user, token } = await seedUser(80)
    const base = Date.now()
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 82, delta: 2, reason: 'a', computedAt: new Date(base) } })
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 62, delta: -20, reason: 'b', computedAt: new Date(base + 1000) } })
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 64, delta: 2, reason: 'c', computedAt: new Date(base + 2000) } })

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)
    expect(res.body.history).toEqual(['ok', 'miss', 'ok'])
  })

  it('caps history to the most recent entries', async () => {
    const { user, token } = await seedUser(100)
    const base = Date.now()
    for (let i = 0; i < 10; i++) {
      await prisma.reliabilityScoreLog.create({
        data: { userId: user.id, score: 100, delta: 2, reason: `entry ${i}`, computedAt: new Date(base + i * 1000) },
      })
    }

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)
    expect(res.body.history.length).toBeLessThanOrEqual(8)
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/profile/reliability')
    expect(res.status).toBe(401)
  })
})

describe('reliability adjustment on booking check-in', () => {
  beforeEach(resetDb)

  it('bumps the score and logs an on-time check-in', async () => {
    const { user, token } = await seedUser(80)
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })

    await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(updated.reliabilityScore).toBe(80 + RELIABILITY_ONTIME_BOOKING_BONUS)

    const logs = await prisma.reliabilityScoreLog.findMany({ where: { userId: user.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0].delta).toBe(RELIABILITY_ONTIME_BOOKING_BONUS)

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)
    expect(res.body.history).toEqual(['ok'])
  })

  it('never pushes the score above 100', async () => {
    const { user, token } = await seedUser(99)
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const booking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })

    await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(updated.reliabilityScore).toBe(100)
  })
})
