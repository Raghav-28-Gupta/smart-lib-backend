import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { startOfDay } from '../../src/services/adminMetrics'
import { resetDb } from '../helpers/db'

const ENDPOINTS = ['utilization', 'circulation', 'overdue', 'demand'].map((m) => `/admin/metrics/${m}`)
const DAY_MS = 24 * 60 * 60 * 1000

async function tokenFor(role: 'student' | 'admin') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
}

const at = (day: Date, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour)

describe('admin metrics access', () => {
  beforeEach(resetDb)

  it.each(ENDPOINTS)('%s refuses a request without a token (401)', async (path) => {
    const res = await request(app).get(path)
    expect(res.status).toBe(401)
  })

  it.each(ENDPOINTS)('%s refuses a student (403)', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${await tokenFor('student')}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin access required')
  })

  it.each(ENDPOINTS)('%s answers an admin (200)', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${await tokenFor('admin')}`)
    expect(res.status).toBe(200)
  })

  it('refuses an admin token once the account is demoted (403)', async () => {
    const token = await tokenFor('admin')
    const { sub } = jwt.decode(token) as { sub: string }
    await prisma.user.update({ where: { id: sub }, data: { role: 'student' } })
    const res = await request(app).get(ENDPOINTS[0]).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin access required')
  })

  it('refuses an admin token once the account is deleted (401)', async () => {
    const token = await tokenFor('admin')
    const { sub } = jwt.decode(token) as { sub: string }
    await prisma.user.delete({ where: { id: sub } })
    const res = await request(app).get(ENDPOINTS[0]).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('admin metrics values', () => {
  beforeEach(resetDb)

  it('computes all four metrics from the database', async () => {
    const token = await tokenFor('admin')
    const today = startOfDay(new Date())
    const now = Date.now()
    const student = await prisma.user.create({ data: { name: 'S', email: `s${Math.random()}@test.com`, passwordHash: 'x' } })

    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1', location: 'Silent Zone' } })
    await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: desk.id, startTime: at(today, 14), endTime: at(today, 15) },
    })
    await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: desk.id, startTime: at(today, 10), endTime: at(today, 11), status: 'cancelled' },
    })

    const book = await prisma.book.create({
      data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: 3 },
    })
    const copies = await Promise.all(
      [0, 1, 2].map(() => prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })),
    )
    // Borrowed this week, still out.
    await prisma.loan.create({
      data: { userId: student.id, bookCopyId: copies[0].id, borrowedAt: new Date(now - 2 * DAY_MS), dueAt: new Date(now + 12 * DAY_MS) },
    })
    // Returned this week.
    await prisma.loan.create({
      data: {
        userId: student.id, bookCopyId: copies[1].id, borrowedAt: new Date(now - 10 * DAY_MS),
        dueAt: new Date(now + 4 * DAY_MS), returnedAt: new Date(now - DAY_MS), status: 'returned',
      },
    })
    // Overdue for 3 days.
    await prisma.loan.create({
      data: { userId: student.id, bookCopyId: copies[2].id, borrowedAt: new Date(now - 17 * DAY_MS), dueAt: new Date(now - 3 * DAY_MS) },
    })

    const get = (metric: string) => request(app).get(`/admin/metrics/${metric}`).set('Authorization', `Bearer ${token}`)
    const [u, c, o, d] = await Promise.all(['utilization', 'circulation', 'overdue', 'demand'].map(get))

    // 1 of 11 open hours; the cancelled booking doesn't count.
    expect(u.body.today.percent).toBe(9)
    expect(u.body.days).toHaveLength(7)
    expect(u.body.days[6]).toMatchObject({ seatPercent: 9, roomPercent: 0 })
    expect(c.body).toEqual({ borrows: 1, returns: 1, topTitles: [{ bookId: book.id, title: 'Clean Code', borrows: 1 }] })
    expect(o.body).toEqual({ count: 1, countYesterday: 1 })
    expect(d.body).toEqual({ areas: [{ area: 'Silent Zone', percent: 1, busiestSlot: '2:00 PM' }] }) // 1 of 77 h
  })
})
