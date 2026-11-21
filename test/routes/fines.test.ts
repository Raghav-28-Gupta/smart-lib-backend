import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { FineReason, FineStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

async function seedUser(role: 'student' | 'admin' = 'student', name = `${role} ${Math.random()}`) {
  const user = await prisma.user.create({
    data: { name, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

async function seedLoan(userId: string, title: string, dueAt: Date, status: 'active' | 'returned' = 'returned') {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Someone', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
  return prisma.loan.create({
    data: {
      userId,
      bookCopyId: copy.id,
      dueAt,
      borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS),
      status,
      returnedAt: status === 'returned' ? new Date() : undefined,
    },
  })
}

interface FineSeed {
  userId: string
  amount: number
  status?: FineStatus
  reason?: FineReason
  createdAt?: Date
  relatedLoanId?: string
  relatedBookingId?: string
  originalAmount?: number
  adjustReason?: string
}

const seedFine = (seed: FineSeed) =>
  prisma.fine.create({ data: { reason: 'overdue', status: 'pending', ...seed } })

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const mine = (token: string) => request(app).get('/fines/me').set(auth(token))

describe('GET /fines/me', () => {
  beforeEach(resetDb)

  it('401 without a token', async () => {
    const anonymous = await request(app).get('/fines/me')
    const garbage = await request(app).get('/fines/me').set('Authorization', 'Bearer not-a-token')

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
  })

  it('has nothing to show a student with no fines', async () => {
    const { token } = await seedUser()

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ fines: [], outstandingTotal: 0 })
  })

  it('lists only my fines, newest first, with item, reason, status and note', async () => {
    const { user: asha, token } = await seedUser('student', 'Asha Rao')
    const { user: ben } = await seedUser('student', 'Ben Carter')
    const t = Date.now()

    const overdueLoan = await seedLoan(asha.id, 'Refactoring', new Date(t - 10 * DAY_MS))
    const overdue = await seedFine({ userId: asha.id, amount: 30, relatedLoanId: overdueLoan.id, createdAt: new Date(t - 3 * DAY_MS) })

    const resource = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201', capacity: 6 } })
    const slot = new Date(t - 2 * DAY_MS)
    const booking = await prisma.resourceBooking.create({
      data: { userId: asha.id, resourceId: resource.id, startTime: slot, endTime: new Date(slot.getTime() + HOUR_MS), status: 'no_show' },
    })
    const noShow = await seedFine({
      userId: asha.id,
      amount: 20,
      reason: 'no_show',
      status: 'adjusted',
      originalAmount: 50,
      adjustReason: 'First offence',
      relatedBookingId: booking.id,
      createdAt: new Date(t - DAY_MS),
    })

    const lostLoan = await seedLoan(asha.id, 'Design Patterns', new Date(t - 20 * DAY_MS))
    const lost = await seedFine({
      userId: asha.id,
      amount: 0,
      reason: 'lost',
      status: 'waived',
      originalAmount: 400,
      adjustReason: 'Library error',
      relatedLoanId: lostLoan.id,
      createdAt: new Date(t - 5 * DAY_MS),
    })

    // Adjusted, then paid: shown as paid, still with the library's note that explains the lower amount.
    const paidLoan = await seedLoan(asha.id, 'Clean Code', new Date(t - 30 * DAY_MS))
    const paid = await seedFine({
      userId: asha.id,
      amount: 40,
      status: 'paid',
      originalAmount: 60,
      adjustReason: 'Hardship',
      relatedLoanId: paidLoan.id,
      createdAt: new Date(t - 7 * DAY_MS),
    })

    // A fine that names neither a loan nor a booking has an empty item.
    const bare = await seedFine({ userId: asha.id, amount: 10, createdAt: new Date(t - 9 * DAY_MS) })

    // Not mine, and not stored: neither is listed.
    await seedFine({ userId: ben.id, amount: 99, createdAt: new Date(t - HOUR_MS) })
    await seedLoan(asha.id, 'Still Out', new Date(t - 4 * DAY_MS), 'active')

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      fines: [
        {
          id: noShow.id,
          reason: 'no_show',
          item: 'Group Room 201',
          amount: 20,
          originalAmount: 50,
          status: 'adjusted',
          date: noShow.createdAt.toISOString(),
          note: 'First offence',
        },
        {
          id: overdue.id,
          reason: 'overdue',
          item: 'Refactoring',
          amount: 30,
          originalAmount: 30,
          status: 'outstanding',
          date: overdue.createdAt.toISOString(),
          note: null,
        },
        {
          id: lost.id,
          reason: 'lost',
          item: 'Design Patterns',
          amount: 0,
          originalAmount: 400,
          status: 'waived',
          date: lost.createdAt.toISOString(),
          note: 'Library error',
        },
        {
          id: paid.id,
          reason: 'overdue',
          item: 'Clean Code',
          amount: 40,
          originalAmount: 60,
          status: 'paid',
          date: paid.createdAt.toISOString(),
          note: 'Hardship',
        },
        {
          id: bare.id,
          reason: 'overdue',
          item: '',
          amount: 10,
          originalAmount: 10,
          status: 'outstanding',
          date: bare.createdAt.toISOString(),
          note: null,
        },
      ],
      // Outstanding 30 + 10 and adjusted 20; the paid, waived and still-out loan add nothing.
      outstandingTotal: 60,
    })
  })

  it('a fine adjusted and then paid keeps its note on /fines/me', async () => {
    const { user: student, token } = await seedUser('student', 'Asha Rao')
    const { token: priyaToken } = await seedUser('admin', 'Priya Menon')
    const { token: samToken } = await seedUser('admin', 'Sam Verma')
    const t = Date.now()
    const adjusted = await seedFine({ userId: student.id, amount: 150, createdAt: new Date(t - DAY_MS) })
    const plain = await seedFine({ userId: student.id, amount: 30, createdAt: new Date(t - 2 * DAY_MS) })

    // Through the librarian's own routes, as it happens in the library.
    const lowered = await request(app).post(`/admin/fines/${adjusted.id}/adjust`).set(auth(priyaToken)).send({ amount: 40, reason: 'Hardship' })
    const paidAdjusted = await request(app).post(`/admin/fines/${adjusted.id}/paid`).set(auth(samToken)).send({ amount: 40 })
    const paidPlain = await request(app).post(`/admin/fines/${plain.id}/paid`).set(auth(samToken)).send({ amount: 30 })

    const res = await mine(token)

    expect([lowered.status, paidAdjusted.status, paidPlain.status]).toEqual([200, 200, 200])
    // The student still sees why it is ₹40, was ₹150; a fine that was never adjusted has no note.
    expect(res.body.fines).toEqual([
      expect.objectContaining({ id: adjusted.id, status: 'paid', amount: 40, originalAmount: 150, note: 'Hardship' }),
      expect.objectContaining({ id: plain.id, status: 'paid', amount: 30, originalAmount: 30, note: null }),
    ])
    expect(res.body.outstandingTotal).toBe(0)
  })

  it('outstandingTotal counts outstanding and adjusted, not paid or waived', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    const t = Date.now()
    await seedFine({ userId: user.id, amount: 30, status: 'pending', createdAt: new Date(t - 1 * DAY_MS) })
    await seedFine({ userId: user.id, amount: 20, status: 'pending', createdAt: new Date(t - 2 * DAY_MS) })
    await seedFine({ userId: user.id, amount: 15, status: 'adjusted', originalAmount: 40, adjustReason: 'Hardship', createdAt: new Date(t - 3 * DAY_MS) })
    await seedFine({ userId: user.id, amount: 100, status: 'paid', createdAt: new Date(t - 4 * DAY_MS) })
    await seedFine({ userId: user.id, amount: 0, status: 'waived', originalAmount: 60, adjustReason: 'Library error', createdAt: new Date(t - 5 * DAY_MS) })
    await seedFine({ userId: other.id, amount: 500, status: 'pending' })
    // A loan that is overdue and still out is shown on the loan, not here.
    await seedLoan(user.id, 'Still Out', new Date(t - 6 * DAY_MS), 'active')

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect(res.body.outstandingTotal).toBe(65)
    expect((res.body.fines as Array<{ status: string }>).map((f) => f.status)).toEqual(['outstanding', 'outstanding', 'adjusted', 'paid', 'waived'])
  })

  it('amounts are plain numbers', async () => {
    const { user, token } = await seedUser()
    await seedFine({ userId: user.id, amount: 30, status: 'adjusted', originalAmount: 80, adjustReason: 'Hardship' })

    const res = await mine(token)

    expect(typeof res.body.outstandingTotal).toBe('number')
    expect(typeof res.body.fines[0].amount).toBe('number')
    expect(typeof res.body.fines[0].originalAmount).toBe('number')
  })

  it('caps the list at 50 but totals all', async () => {
    const { user, token } = await seedUser()
    const t = Date.now()
    // 55 fines of ₹10, one a minute apart, the newest first in the list: the five oldest fall off it.
    const fines = await Promise.all(
      Array.from({ length: 55 }, (_, i) => seedFine({ userId: user.id, amount: 10, createdAt: new Date(t - (i + 1) * 60_000) })),
    )
    const newest50 = fines.slice(0, 50).map((f) => f.id)

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect((res.body.fines as Array<{ id: string }>).map((f) => f.id)).toEqual(newest50)
    // The total is over all 55, not the 50 shown.
    expect(res.body.outstandingTotal).toBe(550)
  })
})
