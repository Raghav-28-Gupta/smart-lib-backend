import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

const DAY_MS = 24 * 60 * 60 * 1000

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

const mine = (token: string) => request(app).get('/notices/me').set('Authorization', `Bearer ${token}`)

describe('GET /notices/me', () => {
  beforeEach(resetDb)

  it('401 without a token', async () => {
    const anonymous = await request(app).get('/notices/me')
    const garbage = await request(app).get('/notices/me').set('Authorization', 'Bearer not-a-token')

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
  })

  it('is an empty list for a student with no notices', async () => {
    const { token } = await seedUser()

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  // Newest first, last 7 days only, and no email outcome or other row's id in the answer.
  it('lists only the caller\'s notices', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    const librarian = (await seedUser('admin')).user
    const notice = (overrides: { userId?: string; title: string; createdAt: Date }) =>
      prisma.notice.create({
        data: {
          userId: overrides.userId ?? user.id,
          kind: 'dispute_outcome',
          body: `Body of ${overrides.title}`,
          createdById: librarian.id,
          emailStatus: 'sent',
          emailedAt: new Date(),
          ...overrides,
        },
      })
    const older = await notice({ title: 'Older', createdAt: new Date(Date.now() - 2 * DAY_MS) })
    const newer = await notice({ title: 'Newer', createdAt: new Date(Date.now() - 60 * 1000) })
    await notice({ title: 'Too old', createdAt: new Date(Date.now() - 8 * DAY_MS) })
    await notice({ title: 'Someone else', userId: other.id, createdAt: new Date(Date.now() - 60 * 1000) })

    const res = await mine(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { id: newer.id, kind: 'dispute_outcome', title: 'Newer', body: 'Body of Newer', createdAt: newer.createdAt.toISOString() },
      { id: older.id, kind: 'dispute_outcome', title: 'Older', body: 'Body of Older', createdAt: older.createdAt.toISOString() },
    ])

    // Another student's notices are theirs alone.
    const otherToken = jwt.sign({ sub: other.id, role: other.role }, JWT_SECRET, { expiresIn: '1h' })
    const theirs = await mine(otherToken)
    expect(theirs.body.map((n: { title: string }) => n.title)).toEqual(['Someone else'])
  })
})
