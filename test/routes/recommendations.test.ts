import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedUser() {
  const user = await prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedBook(title: string) {
  return prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Author', totalCopies: 1 } })
}

async function seedLoan(userId: string, bookId: string, borrowedAt: Date) {
  const copy = await prisma.bookCopy.create({ data: { bookId, status: 'borrowed' } })
  await prisma.loan.create({
    data: { userId, bookCopyId: copy.id, borrowedAt, dueAt: new Date(borrowedAt.getTime() + 14 * 24 * 60 * 60 * 1000) },
  })
}

describe('GET /recommendations/me', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    return resetDb()
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/recommendations/me')
    expect(res.status).toBe(401)
  })

  it('returns an empty-but-valid shape when the library has no books', async () => {
    const { token } = await seedUser()
    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.sections).toEqual([])
    expect(typeof res.body.note).toBe('string')
  })

  it('falls back to an alphabetical list when no books have been borrowed recently', async () => {
    const { token } = await seedUser()
    await seedBook('Zebra Book')
    await seedBook('Aardvark Book')

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.body.sections).toHaveLength(1)
    expect(res.body.sections[0].title).toBe('Trending in the library')
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles).toEqual(['Aardvark Book', 'Zebra Book'])
  })

  it('ranks the most-borrowed-in-the-last-30-days book first', async () => {
    const { user, token } = await seedUser()
    const popular = await seedBook('Popular Book')
    const quiet = await seedBook('Quiet Book')
    const now = new Date()

    const { user: user2 } = await seedUser()
    await seedLoan(user.id, popular.id, now)
    await seedLoan(user2.id, popular.id, now)
    await seedLoan(user.id, quiet.id, now)

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles[0]).toBe('Popular Book')
  })

  it('ignores loans older than 30 days when ranking popularity', async () => {
    const { user, token } = await seedUser()
    const oldPopular = await seedBook('Old Popular Book')
    const recent = await seedBook('Recently Borrowed Book')

    await seedLoan(user.id, oldPopular.id, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000))
    await seedLoan(user.id, recent.id, new Date())

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles).toContain('Recently Borrowed Book')
    expect(titles).not.toContain('Old Popular Book')
  })

  it('builds a personalized section when the AI backend returns real results', async () => {
    const { token } = await seedUser()
    const book = await seedBook('AI Recommended Book')

    const aiClient = await import('../../src/lib/aiClient')
    vi.spyOn(aiClient, 'fetchRecommendations').mockResolvedValue([{ book_id: book.id, score: 0.9, method: 'hybrid' }])

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.body.sections[0].books[0].title).toBe('AI Recommended Book')
    expect(res.body.note).not.toMatch(/popular/i)
  })

  it('falls back gracefully when the AI backend is unreachable', async () => {
    const { token } = await seedUser()
    await seedBook('Fallback Book')

    const aiClient = await import('../../src/lib/aiClient')
    vi.spyOn(aiClient, 'fetchRecommendations').mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.sections[0].title).toBe('Trending in the library')
  })
})
