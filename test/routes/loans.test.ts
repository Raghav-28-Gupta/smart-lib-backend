import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

let userCounter = 0

async function seedUser() {
  userCounter += 1
  const user = await prisma.user.create({
    data: { name: `User ${userCounter}`, email: `user${userCounter}@test.com`, passwordHash: 'x' },
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

async function addWaiters(bookId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const { user } = await seedUser()
    await prisma.reservation.create({ data: { userId: user.id, bookId, status: 'waiting' } })
  }
}

describe('POST /loans (borrow)', () => {
  beforeEach(resetDb)

  it('creates a loan and claims one available copy', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 4)

    const res = await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ bookId: book.id, frontendStatus: 'normal', canRenew: true, fineAmount: 0 })

    const bookRes = await request(app).get(`/books/${book.id}`)
    expect(bookRes.body.availableCopies).toBe(1)
  })

  it('returns 409 when no copies are available', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 2)
    const res = await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(409)
  })

  it('returns 409 if the user already has this book on loan', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 2)
    await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    const res = await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(409)
  })

  it('requires authentication', async () => {
    const book = await seedBookWithCopies(1, 1)
    const res = await request(app).post('/loans').send({ bookId: book.id })
    expect(res.status).toBe(401)
  })
})

describe('GET /loans/me', () => {
  beforeEach(resetDb)

  it('lists only the caller\'s active loans, not another user\'s', async () => {
    const { token, user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(2, 2)
    await request(app).post('/loans').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })

    const mine = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(mine.body).toHaveLength(1)
    expect(mine.body[0].userId).toBe(user.id)

    const theirs = await request(app).get('/loans/me').set('Authorization', `Bearer ${otherToken}`)
    expect(theirs.body).toHaveLength(0)
  })

  it('shows a live-computed fineAmount and overdue status for a still-active overdue loan', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    // 3 days overdue, never returned — dueAt in the past, still status 'active'.
    await prisma.loan.create({
      data: {
        userId: user.id,
        bookCopyId: copy.id,
        dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        status: 'active',
      },
    })

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].frontendStatus).toBe('overdue')
    expect(res.body[0].fineAmount).toBe(30) // 3 days * ₹10/day
    expect(res.body[0].canRenew).toBe(true)
  })

  it('blocks renewal and gives the exact singular waitlist reason when 1 person is waiting', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 1)

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].canRenew).toBe(false)
    expect(res.body[0].blockedReason).toBe('1 student is waiting for this title.')
  })

  it('pluralizes the waitlist reason for more than 1 person', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 2)

    const res = await request(app).get('/loans/me').set('Authorization', `Bearer ${token}`)
    expect(res.body[0].blockedReason).toBe('2 students are waiting for this title.')
  })
})

describe('POST /loans/:id/renew', () => {
  beforeEach(resetDb)

  it('extends the due date and increments renewedCount', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.renewedCount).toBe(1)
    expect(new Date(res.body.dueAt).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000)
  })

  it('settles an overdue fine into a Fine record and resets fineAmount to 0', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.fineAmount).toBe(0)
    expect(res.body.frontendStatus).toBe('normal')

    const fines = await prisma.fine.findMany({ where: { userId: user.id, reason: 'overdue' } })
    expect(fines).toHaveLength(1)
    expect(fines[0].amount).toBe(20) // 2 days * ₹10/day
  })

  it('is blocked by an active waitlist with a 409', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await addWaiters(book.id, 1)

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('is blocked once the renewal cap is reached', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: {
        userId: user.id, bookCopyId: copy.id,
        dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        renewedCount: 2, // MAX_RENEWALS
      },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the loan', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/renew`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /loans/:id/return', () => {
  beforeEach(resetDb)

  it('marks the loan returned and frees the copy', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)

    const bookRes = await request(app).get(`/books/${book.id}`)
    expect(bookRes.body.availableCopies).toBe(1)

    const dbLoan = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(dbLoan.status).toBe('returned')
    expect(dbLoan.returnedAt).not.toBeNull()
  })

  it('creates a Fine when returned overdue', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) },
    })

    await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    const fines = await prisma.fine.findMany({ where: { userId: user.id, reason: 'overdue' } })
    expect(fines).toHaveLength(1)
    expect(fines[0].amount).toBe(40) // 4 days * ₹10/day
  })

  it('returns 409 when the loan is already returned', async () => {
    const { user, token } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('returns 403 when the caller does not own the loan', async () => {
    const { user } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })

    const res = await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })
})
