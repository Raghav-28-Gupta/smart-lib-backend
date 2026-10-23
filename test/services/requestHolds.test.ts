import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { expireStaleRequests, startExpirySweep } from '../../src/services/requestHolds'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

async function seedUser() {
  const user = await prisma.user.create({ data: { name: `Student ${Math.random()}`, email: `s${Math.random()}@test.com`, passwordHash: 'x' } })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A book whose only copy is held by a pending request that lapses `expiresInMs` from now. */
async function heldBook(userId: string, expiresInMs: number) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Sapiens', author: 'Yuval Noah Harari', totalCopies: 1 },
  })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'requested' } })
  const now = Date.now()
  const held = await prisma.borrowRequest.create({
    data: {
      userId,
      bookId: book.id,
      bookCopyId: copy.id,
      requestedAt: new Date(now + expiresInMs - 24 * HOUR_MS),
      expiresAt: new Date(now + expiresInMs),
    },
  })
  return { book, copy, held }
}

/** A pending room request whose slot started `startedMsAgo` ago. */
async function roomRequest(userId: string, startedMsAgo: number) {
  const room = await prisma.resource.create({ data: { type: 'room', name: `Room ${Math.random()}` } })
  const start = new Date(Date.now() - startedMsAgo)
  return prisma.resourceBooking.create({
    data: { userId, resourceId: room.id, startTime: start, endTime: new Date(start.getTime() + HOUR_MS), status: 'requested' },
  })
}

describe('expireStaleRequests', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('lapses a borrow request after its 24 hours, freeing the copy for the waitlist', async () => {
    const { user } = await seedUser()
    const { user: waiter } = await seedUser()
    const { book, copy, held } = await heldBook(user.id, -MINUTE_MS)
    await prisma.reservation.create({ data: { userId: waiter.id, bookId: book.id, status: 'waiting' } })

    expect(await expireStaleRequests()).toBe(1)

    const after = await prisma.borrowRequest.findUniqueOrThrow({ where: { id: held.id } })
    expect(after.status).toBe('expired')
    expect(after.decidedAt).not.toBeNull()
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
    expect((await prisma.reservation.findFirstOrThrow({ where: { userId: waiter.id } })).status).toBe('fulfilled')
  })

  it('leaves a borrow request alone before its deadline', async () => {
    const { user } = await seedUser()
    const { held } = await heldBook(user.id, HOUR_MS)

    expect(await expireStaleRequests()).toBe(0)
    expect((await prisma.borrowRequest.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('pending')
  })

  it("lapses a room request once its slot's grace period has passed", async () => {
    const { user } = await seedUser()
    const stale = await roomRequest(user.id, 16 * MINUTE_MS)
    const fresh = await roomRequest(user.id, 14 * MINUTE_MS)

    expect(await expireStaleRequests()).toBe(1)

    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('expired')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('requested')
  })

  it('announces a sweep that lapsed something, once, and stays quiet otherwise', async () => {
    const { user } = await seedUser()
    await heldBook(user.id, -MINUTE_MS)
    await roomRequest(user.id, 20 * MINUTE_MS)
    recorder = recordEvents()

    await expireStaleRequests()
    await expireStaleRequests()

    expect(recorder.events).toEqual([{ type: 'request.expired', topics: ['requests'] }])
  })
})

describe('lapsing before the request paths', () => {
  beforeEach(resetDb)

  it("releases a lapsed hold before another student's request", async () => {
    const { user } = await seedUser()
    const { token } = await seedUser()
    const { book } = await heldBook(user.id, -MINUTE_MS)

    const res = await request(app).post('/borrow-requests').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })

    expect(res.status).toBe(201)
  })

  it('shows lapsed requests as expired in the student lists', async () => {
    const { user, token } = await seedUser()
    await heldBook(user.id, -MINUTE_MS)
    await roomRequest(user.id, 20 * MINUTE_MS)

    const borrows = await request(app).get('/borrow-requests/me').set('Authorization', `Bearer ${token}`)
    const bookings = await request(app).get('/bookings/me').set('Authorization', `Bearer ${token}`)

    expect(borrows.body.map((r: { status: string }) => r.status)).toEqual(['expired'])
    expect(bookings.body.map((b: { frontendStatus: string }) => b.frontendStatus)).toEqual(['expired'])
  })
})

describe('startExpirySweep', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs once at start and then every minute until stopped', () => {
    const sweep = vi.fn().mockResolvedValue(0)

    const stop = startExpirySweep(sweep)
    expect(sweep).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(sweep).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(180_000)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('logs a failed sweep instead of crashing the server', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const stop = startExpirySweep(vi.fn().mockRejectedValue(new Error('database asleep')))

    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Expiry sweep failed:', expect.any(Error)))
    stop()
  })
})
