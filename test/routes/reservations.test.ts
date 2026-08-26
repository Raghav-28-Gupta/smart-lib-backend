import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { WAITLIST_CLAIM_HOURS, JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedUser() {
  const user = await prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedBookWithCopies(availableCopies: number, totalCopies = availableCopies) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Design Patterns', author: 'GoF', genre: 'Software Eng.', totalCopies },
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

describe('POST /reservations (join waitlist)', () => {
  beforeEach(resetDb)

  it('joins the waitlist and reports queue position 1 for the first joiner', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 1)

    const res = await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ bookId: book.id, status: 'waiting', queuePosition: 1 })
  })

  it('reports increasing queue positions for later joiners', async () => {
    const { token: t1 } = await seedUser()
    const { token: t2 } = await seedUser()
    const book = await seedBookWithCopies(0, 1)

    await request(app).post('/reservations').set('Authorization', `Bearer ${t1}`).send({ bookId: book.id })
    const res2 = await request(app).post('/reservations').set('Authorization', `Bearer ${t2}`).send({ bookId: book.id })
    expect(res2.body.queuePosition).toBe(2)
  })

  it('returns 409 when copies are actually available', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(2, 2)

    const res = await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(409)
  })

  it('returns 409 on a duplicate join', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 1)
    await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })

    const res = await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    expect(res.status).toBe(409)
  })

  it('requires authentication', async () => {
    const book = await seedBookWithCopies(0, 1)
    const res = await request(app).post('/reservations').send({ bookId: book.id })
    expect(res.status).toBe(401)
  })
})

describe('the return -> claim -> expiry -> cascade lifecycle', () => {
  beforeEach(resetDb)

  it('gives the first waiter a bounded claim when the book is returned', async () => {
    const { user: borrower, token: borrowerToken } = await seedUser()
    const { user: waiter, token: waiterToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: book.id } })
    const loan = await prisma.loan.create({
      data: { userId: borrower.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    })
    await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
    await request(app).post('/reservations').set('Authorization', `Bearer ${waiterToken}`).send({ bookId: book.id })

    await request(app).post(`/loans/${loan.id}/return`).set('Authorization', `Bearer ${borrowerToken}`)

    const res = await request(app).get('/reservations/me').set('Authorization', `Bearer ${waiterToken}`)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].status).toBe('fulfilled')
    expect(res.body[0].userId).toBe(waiter.id)
    const expiresAt = new Date(res.body[0].claimExpiresAt).getTime()
    expect(expiresAt).toBeGreaterThan(Date.now() + (WAITLIST_CLAIM_HOURS - 1) * 60 * 60 * 1000)
  })

  it('cascades an expired claim to the next waiter on lazy read', async () => {
    const { user: userA, token: tokenA } = await seedUser()
    const { user: userB, token: tokenB } = await seedUser()
    const book = await seedBookWithCopies(1, 1)

    await prisma.reservation.create({
      data: { userId: userA.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() - 1000) },
    })
    await prisma.reservation.create({
      data: { userId: userB.id, bookId: book.id, status: 'waiting', requestedAt: new Date(Date.now() + 1000) },
    })

    const resB = await request(app).get('/reservations/me').set('Authorization', `Bearer ${tokenB}`)
    expect(resB.body[0].status).toBe('fulfilled')

    const resA = await request(app).get('/reservations/me').set('Authorization', `Bearer ${tokenA}`)
    expect(resA.body).toHaveLength(0) // A's claim expired and isn't shown as live anymore

    const dbA = await prisma.reservation.findFirstOrThrow({ where: { userId: userA.id } })
    expect(dbA.status).toBe('expired')
  })
})

describe('borrowing while a claim is outstanding', () => {
  beforeEach(resetDb)

  it('blocks a non-claimant from borrowing the sole earmarked copy', async () => {
    const { user: claimant } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    await prisma.reservation.create({
      data: { userId: claimant.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() + 60_000) },
    })

    const res = await request(app).post('/loans').set('Authorization', `Bearer ${otherToken}`).send({ bookId: book.id })
    expect(res.status).toBe(409)
  })

  it('lets the claimant borrow and clears their consumed reservation', async () => {
    const { user: claimant, token: claimantToken } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    await prisma.reservation.create({
      data: { userId: claimant.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() + 60_000) },
    })

    const res = await request(app).post('/loans').set('Authorization', `Bearer ${claimantToken}`).send({ bookId: book.id })
    expect(res.status).toBe(201)

    const remaining = await request(app).get('/reservations/me').set('Authorization', `Bearer ${claimantToken}`)
    expect(remaining.body).toHaveLength(0)
  })
})

describe('DELETE /reservations/:id', () => {
  beforeEach(resetDb)

  it('cancels a waiting reservation', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 1)
    const joined = await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })

    const res = await request(app).delete(`/reservations/${joined.body.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
  })

  it('cancelling a fulfilled claim immediately cascades to the next waiter', async () => {
    const { user: userA, token: tokenA } = await seedUser()
    const { user: userB, token: tokenB } = await seedUser()
    const book = await seedBookWithCopies(1, 1)
    const claim = await prisma.reservation.create({
      data: { userId: userA.id, bookId: book.id, status: 'fulfilled', claimExpiresAt: new Date(Date.now() + 60_000) },
    })
    await prisma.reservation.create({
      data: { userId: userB.id, bookId: book.id, status: 'waiting', requestedAt: new Date(Date.now() + 1000) },
    })

    await request(app).delete(`/reservations/${claim.id}`).set('Authorization', `Bearer ${tokenA}`)

    const resB = await request(app).get('/reservations/me').set('Authorization', `Bearer ${tokenB}`)
    expect(resB.body[0].status).toBe('fulfilled')
  })

  it('returns 403 when the caller does not own the reservation', async () => {
    const { token: ownerToken } = await seedUser()
    const { token: otherToken } = await seedUser()
    const book = await seedBookWithCopies(0, 1)
    const joined = await request(app).post('/reservations').set('Authorization', `Bearer ${ownerToken}`).send({ bookId: book.id })

    const res = await request(app).delete(`/reservations/${joined.body.id}`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('returns 409 when the reservation is already cancelled', async () => {
    const { token } = await seedUser()
    const book = await seedBookWithCopies(0, 1)
    const joined = await request(app).post('/reservations').set('Authorization', `Bearer ${token}`).send({ bookId: book.id })
    await request(app).delete(`/reservations/${joined.body.id}`).set('Authorization', `Bearer ${token}`)

    const res = await request(app).delete(`/reservations/${joined.body.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })
})
