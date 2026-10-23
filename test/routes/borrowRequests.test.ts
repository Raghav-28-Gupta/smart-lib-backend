import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { BORROW_REQUEST_HOURS, JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

let userCounter = 0

async function seedUser() {
  userCounter += 1
  const user = await prisma.user.create({
    data: { name: `Student ${userCounter}`, email: `student${userCounter}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedBookWithCopies(availableCopies: number, totalCopies = availableCopies) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', genre: 'Software Eng.', totalCopies },
  })
  const borrowed = totalCopies - availableCopies
  await prisma.bookCopy.createMany({
    data: [
      ...Array.from({ length: availableCopies }, () => ({ bookId: book.id, status: 'available' as const })),
      ...Array.from({ length: Math.max(borrowed, 0) }, () => ({ bookId: book.id, status: 'borrowed' as const })),
    ],
  })
  return book
}

function ask(token: string, bookId: string) {
  return request(app).post('/borrow-requests').set('Authorization', `Bearer ${token}`).send({ bookId })
}

describe('POST /borrow-requests', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('creates a pending request that holds one copy for 24 hours', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 4)

    const res = await ask(token, book.id)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ bookId: book.id, bookTitle: 'Clean Code', status: 'pending', decidedAt: null, declineReason: null })
    expect(new Date(res.body.expiresAt).getTime() - new Date(res.body.requestedAt).getTime()).toBe(BORROW_REQUEST_HOURS * HOUR_MS)
    expect(await prisma.bookCopy.count({ where: { bookId: book.id, status: 'requested' } })).toBe(1)
    expect((await request(app).get(`/books/${book.id}`)).body.availableCopies).toBe(1)
  })

  it('refuses a title the student already has on loan', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 2)
    const borrowed = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id, status: 'borrowed' } })
    await prisma.loan.create({ data: { userId: user.id, bookCopyId: borrowed.id, dueAt: new Date(Date.now() + 5 * DAY_MS) } })

    const res = await ask(token, book.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('You already have this book borrowed.')
  })

  it('refuses a second pending request for the same title', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 2)
    await ask(token, book.id)

    const res = await ask(token, book.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe("You've already requested this book.")
  })

  it('two quick requests for the same title hold one copy', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(3, 3)

    const results = await Promise.all([ask(token, book.id), ask(token, book.id)])

    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(results.find((r) => r.status === 409)!.body.error).toBe("You've already requested this book.")
    expect(await prisma.borrowRequest.count({ where: { status: 'pending' } })).toBe(1)
    expect(await prisma.bookCopy.count({ where: { bookId: book.id, status: 'requested' } })).toBe(1)
  })

  it('says so when no copy is left', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 2)

    const res = await ask(token, book.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('No available copies right now.')
  })

  it('refuses copies held for waitlisted students', async () => {
    const { user: claimant } = await seedUser()
    const { token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    await prisma.reservation.create({
      data: { userId: claimant.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() + HOUR_MS) },
    })

    const res = await ask(token, book.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('All available copies are reserved for waitlisted students right now.')
  })

  it("turns the student's own waitlist claim into the request", async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    await prisma.reservation.create({
      data: { userId: user.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() + HOUR_MS) },
    })

    expect((await ask(token, book.id)).status).toBe(201)
    expect((await request(app).get('/reservations/me').set('Authorization', `Bearer ${token}`)).body).toHaveLength(0)
  })

  it('answers 404 for an unknown book and 401 without a token', async () => {
    const { token } = await seedUser()
    expect((await ask(token, 'no-such-book')).status).toBe(404)
    expect((await request(app).post('/borrow-requests').send({ bookId: 'x' })).status).toBe(401)
  })

  it('announces the request to the console, and nothing when one is refused', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    recorder = recordEvents()

    await ask(token, book.id)
    await ask(token, book.id)

    expect(recorder.events).toEqual([
      { type: 'request.created', topics: ['requests'], kind: 'borrow', summary: `${user.name} wants to borrow Clean Code` },
    ])
  })
})

describe('GET /borrow-requests/me', () => {
  beforeEach(resetDb)

  it('lists pending requests and answers from the last week, newest first', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    const book = await seedBookWithCopies(7, 7)
    const copies = await prisma.bookCopy.findMany({ where: { bookId: book.id } })
    const now = Date.now()
    const row = (
      i: number,
      userId: string,
      status: 'pending' | 'approved' | 'declined' | 'expired' | 'cancelled',
      requestedHoursAgo: number,
      decidedDaysAgo: number | null,
      declineReason: string | null = null,
    ) =>
      prisma.borrowRequest.create({
        data: {
          userId,
          bookId: book.id,
          bookCopyId: copies[i].id,
          status,
          requestedAt: new Date(now - requestedHoursAgo * HOUR_MS),
          expiresAt: new Date(now - requestedHoursAgo * HOUR_MS + BORROW_REQUEST_HOURS * HOUR_MS),
          decidedAt: decidedDaysAgo === null ? null : new Date(now - decidedDaysAgo * DAY_MS),
          declineReason,
        },
      })
    await row(0, user.id, 'declined', 30, 1, 'Reserved for a course')
    await row(1, user.id, 'pending', 1, null)
    await row(2, user.id, 'expired', 50, 1)
    await row(3, user.id, 'declined', 300, 8)
    await row(4, user.id, 'approved', 40, 1)
    await row(5, user.id, 'cancelled', 3, 0)
    await row(6, other.id, 'pending', 2, null)

    const res = await request(app).get('/borrow-requests/me').set('Authorization', `Bearer ${token}`)

    expect(res.body.map((r: { status: string }) => r.status)).toEqual(['pending', 'declined', 'expired'])
    expect(res.body[1].declineReason).toBe('Reserved for a course')
  })
})

describe('POST /borrow-requests/:id/cancel', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('withdraws a pending request and passes the copy to the next waiting student', async () => {
    const { token } = await seedUser()
    const { user: waiter } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const asked = await ask(token, book.id)
    await prisma.reservation.create({ data: { userId: waiter.id, bookId: book.id, status: 'waiting' } })
    recorder = recordEvents()

    const res = await request(app).post(`/borrow-requests/${asked.body.id}/cancel`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(await prisma.bookCopy.count({ where: { bookId: book.id, status: 'available' } })).toBe(1)
    expect((await prisma.reservation.findFirstOrThrow({ where: { userId: waiter.id } })).status).toBe('fulfilled')
    expect(recorder.events).toEqual([{ type: 'request.cancelled', topics: ['requests'], kind: 'borrow' }])
  })

  it("refuses another student's request, one no longer pending, and an unknown one", async () => {
    const { token } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const asked = await ask(token, book.id)
    const cancel = (as: string, id: string) =>
      request(app).post(`/borrow-requests/${id}/cancel`).set('Authorization', `Bearer ${as}`)

    const theirs = await cancel(otherToken, asked.body.id)
    expect([theirs.status, theirs.body.error]).toEqual([403, 'This request belongs to another user.'])
    await cancel(token, asked.body.id)
    const again = await cancel(token, asked.body.id)
    expect([again.status, again.body.error]).toEqual([409, 'This request is no longer pending.'])
    expect((await cancel(token, 'nope')).status).toBe(404)
  })
})
