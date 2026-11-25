import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { sweepBookings } from '../../src/services/noShowService'
import { NO_SHOW_REASON_PREFIX } from '../../src/services/reliabilityService'
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

  it("the student's reliability card shows the library adjustment as the latest drop", async () => {
    const { user: student, token } = await seedUser(80)
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `librarian${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    const adminToken = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })

    const adjusted = await request(app)
      .post(`/admin/students/${student.id}/reliability`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: -6, reason: 'Left belongings at a seat all day' })
    expect(adjusted.status).toBe(200)

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 74, tier: 'Building back up', history: ['miss'] })
    expect(res.body.note).toContain(
      'Your reliability score recently dropped: Library adjustment: Left belongings at a seat all day.',
    )
    // Below Good standing, the way back is still spelled out (6 points at 2 per on-time booking).
    expect(res.body.note).toContain('Complete 3 more on-time bookings to return to Good standing.')
  })

  async function adjustAsLibrarian(studentId: string, delta: number, reason: string) {
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `librarian${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    const adminToken = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
    const adjusted = await request(app)
      .post(`/admin/students/${studentId}/reliability`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta, reason })
    expect(adjusted.status).toBe(200)
  }

  it('a library adjustment from 100 to 90 shows its reason without the recovery clause', async () => {
    const { user: student, token } = await seedUser(100)
    await adjustAsLibrarian(student.id, -10, 'Damaged a study room')

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ score: 90, tier: 'Good standing', history: ['miss'] })
    expect(res.body.note).toBe('Your reliability score recently dropped: Library adjustment: Damaged a study room.')
  })

  it('a check-in after the adjustment returns to the normal Good-standing note', async () => {
    const { user: student, token } = await seedUser(100)
    await adjustAsLibrarian(student.id, -10, 'Damaged a study room')
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const booking = await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: resource.id, startTime: new Date(Date.now() - 1000), endTime: new Date(Date.now() + 60 * 60 * 1000) },
    })
    const checkedIn = await request(app).post(`/bookings/${booking.id}/checkin`).set('Authorization', `Bearer ${token}`)
    expect(checkedIn.status).toBe(200)

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.body).toMatchObject({ score: 90 + RELIABILITY_ONTIME_BOOKING_BONUS, tier: 'Good standing', history: ['miss', 'ok'] })
    expect(res.body.note).toMatch(/^No missed bookings yet\./)
  })

  it('a later positive library adjustment also clears the drop note', async () => {
    const { user: student, token } = await seedUser(100)
    await adjustAsLibrarian(student.id, -10, 'Damaged a study room')
    await adjustAsLibrarian(student.id, 4, 'Helped at the library fair')

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.body).toMatchObject({ score: 94, history: ['miss', 'ok'] })
    expect(res.body.note).toMatch(/^No missed bookings yet\./)
  })

  it('an automatic miss at 80 or more still shows the normal Good-standing note', async () => {
    const { user, token } = await seedUser(85)
    await prisma.reliabilityScoreLog.create({
      data: { userId: user.id, score: 85, delta: -15, reason: 'Missed check-in window for Group Room 201' },
    })

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.body).toMatchObject({ score: 85, tier: 'Good standing', history: ['miss'] })
    expect(res.body.note).toMatch(/^No missed bookings yet\./)
  })

  it('a positive library adjustment shows as an on-time dot', async () => {
    const { user: student, token } = await seedUser(70)
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `librarian${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    const adminToken = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })

    await request(app)
      .post(`/admin/students/${student.id}/reliability`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: 4, reason: 'Helped at the library fair' })

    const res = await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)

    expect(res.body).toMatchObject({ score: 74, history: ['ok'] })
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

describe('a recorded no-show in the reliability history', { timeout: 60_000 }, () => {
  beforeEach(resetDb)

  const MINUTE_MS = 60 * 1000
  const history = async (token: string) => (await request(app).get('/profile/reliability').set('Authorization', `Bearer ${token}`)).body

  it('a student already at 0 who is swept shows the no-show as a miss, not as an ok dot and not as "No missed bookings yet"', async () => {
    const { user, token } = await seedUser(0)
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const now = new Date()
    const startTime = new Date(now.getTime() - 20 * MINUTE_MS)
    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: resource.id, startTime, endTime: new Date(startTime.getTime() + 60 * MINUTE_MS), status: 'booked' },
    })

    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })

    // The sweep still writes its row (the audit trail) with nothing taken: a delta of 0.
    const logs = await prisma.reliabilityScoreLog.findMany({ where: { userId: user.id } })
    expect(logs).toEqual([expect.objectContaining({ delta: 0, score: 0, reason: 'No-show: Desk 1' })])
    const body = await history(token)
    expect(body).toMatchObject({ score: 0, tier: 'At risk', ringFraction: 0, history: ['miss'] })
    expect(body.note).not.toMatch(/No missed bookings yet/)
    expect(body.note).toBe('Your reliability score recently dropped: No-show: Desk 1. Complete 40 more on-time bookings to return to Good standing.')
    expect(logs[0].reason).toBe(`${NO_SHOW_REASON_PREFIX}Desk 1`)
  })

  it('the prefix is exactly "No-show: ", and a row that starts with it is a miss however little it took', async () => {
    const { user, token } = await seedUser(30)
    const base = Date.now()
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 30, delta: 0, reason: 'No-show: Desk 3', computedAt: new Date(base) } })
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 32, delta: 2, reason: 'On-time check-in for a resource booking', computedAt: new Date(base + 1000) } })
    // A row with no delta that is not a no-show stays ok, as before.
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 32, delta: 0, reason: 'Library adjustment: Nothing to change', computedAt: new Date(base + 2000) } })

    expect((await history(token)).history).toEqual(['miss', 'ok', 'ok'])
    expect(NO_SHOW_REASON_PREFIX).toBe('No-show: ')
  })

  it('an overturned no-show: the original row stays a miss and the restore row follows as ok', async () => {
    const { user, token } = await seedUser(100)
    const base = Date.now()
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 90, delta: -10, reason: 'No-show: Desk 3', computedAt: new Date(base) } })
    // What an overturn writes: the colon comes right after "No-show", so it does not start with the no-show prefix.
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 100, delta: 10, reason: 'No-show overturned: Desk 3', computedAt: new Date(base + 1000) } })

    const body = await history(token)

    expect(body.history).toEqual(['miss', 'ok'])
    expect(body.note).toMatch(/^No missed bookings yet\./)
    expect('No-show overturned: Desk 3'.startsWith(NO_SHOW_REASON_PREFIX)).toBe(false)
  })

  it('a restore row is ok even with a zero delta (the score was already at 100)', async () => {
    const { user, token } = await seedUser(100)
    const base = Date.now()
    await prisma.reliabilityScoreLog.create({ data: { userId: user.id, score: 100, delta: 0, reason: 'No-show overturned: Desk 3', computedAt: new Date(base) } })

    expect((await history(token)).history).toEqual(['ok'])
  })
})
