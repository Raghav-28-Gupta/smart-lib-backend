import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedBook(overrides: Partial<{
  isbn: string
  title: string
  author: string
  genre: string
  totalCopies: number
  availableCopies: number
  waitlistCount: number
}> = {}) {
  const {
    isbn = `isbn-${Math.random()}`,
    title = 'Introduction to Algorithms',
    author = 'Cormen, Leiserson, Rivest & Stein',
    genre = 'Algorithms',
    totalCopies = 4,
    availableCopies = 1,
    waitlistCount = 0,
  } = overrides

  const book = await prisma.book.create({
    data: { isbn, title, author, genre, description: 'A book about things.', totalCopies },
  })

  // availableCopies is computed by counting BookCopy rows with status
  // 'available', not stored — create the copy rows that produce the count
  // this test wants, split available/borrowed.
  const borrowedCopies = totalCopies - availableCopies
  await prisma.bookCopy.createMany({
    data: [
      ...Array.from({ length: availableCopies }, () => ({ bookId: book.id, status: 'available' as const })),
      ...Array.from({ length: Math.max(borrowedCopies, 0) }, () => ({ bookId: book.id, status: 'borrowed' as const })),
    ],
  })

  // waitlistCount is likewise computed from waiting Reservation rows — each
  // needs its own user due to the (userId, bookId) not being unique but a
  // real waitlist implies distinct people.
  for (let i = 0; i < waitlistCount; i++) {
    const user = await prisma.user.create({
      data: { name: `Waiter ${i}`, email: `waiter-${i}-${book.id}@test.com`, passwordHash: 'x' },
    })
    await prisma.reservation.create({ data: { userId: user.id, bookId: book.id, status: 'waiting' } })
  }

  return book
}

describe('GET /books/search', () => {
  beforeEach(resetDb)

  it('returns all books with computed availableCopies and waitlistCount', async () => {
    await seedBook({ title: 'Clean Code', author: 'Robert C. Martin', genre: 'Software Eng.', totalCopies: 4, availableCopies: 2 })
    await seedBook({ title: 'Operating System Concepts', author: 'Silberschatz', genre: 'Operating Systems', totalCopies: 3, availableCopies: 0, waitlistCount: 2 })

    const res = await request(app).get('/books/search')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)

    const cleanCode = res.body.find((b: { title: string }) => b.title === 'Clean Code')
    expect(cleanCode).toMatchObject({ totalCopies: 4, availableCopies: 2, waitlistCount: 0 })

    const osConcepts = res.body.find((b: { title: string }) => b.title === 'Operating System Concepts')
    expect(osConcepts).toMatchObject({ totalCopies: 3, availableCopies: 0, waitlistCount: 2 })
  })

  it('filters by query across title and author, case-insensitively', async () => {
    await seedBook({ title: 'Clean Code', author: 'Robert C. Martin' })
    await seedBook({ title: 'Design Patterns', author: 'Gamma, Helm, Johnson & Vlissides' })

    const res = await request(app).get('/books/search').query({ q: 'clean' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].title).toBe('Clean Code')
  })

  it('matches the query against author too', async () => {
    await seedBook({ title: 'Clean Code', author: 'Robert C. Martin' })
    await seedBook({ title: 'Design Patterns', author: 'Gamma, Helm, Johnson & Vlissides' })

    const res = await request(app).get('/books/search').query({ q: 'martin' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].title).toBe('Clean Code')
  })

  it('filters by exact genre', async () => {
    await seedBook({ title: 'Clean Code', genre: 'Software Eng.' })
    await seedBook({ title: 'The Midnight Library', genre: 'Fiction' })

    const res = await request(app).get('/books/search').query({ genre: 'Fiction' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].title).toBe('The Midnight Library')
  })

  it('treats genre=All as no filter', async () => {
    await seedBook({ title: 'Clean Code', genre: 'Software Eng.' })
    await seedBook({ title: 'The Midnight Library', genre: 'Fiction' })

    const res = await request(app).get('/books/search').query({ genre: 'All' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
  })

  it('returns an empty array when nothing matches', async () => {
    await seedBook({ title: 'Clean Code' })
    const res = await request(app).get('/books/search').query({ q: 'nonexistent title' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('GET /books/:id', () => {
  beforeEach(resetDb)

  it('returns a single book with computed fields', async () => {
    const book = await seedBook({ title: 'Atomic Habits', totalCopies: 3, availableCopies: 2 })
    const res = await request(app).get(`/books/${book.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: book.id, title: 'Atomic Habits', totalCopies: 3, availableCopies: 2, waitlistCount: 0 })
  })

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/books/does-not-exist')
    expect(res.status).toBe(404)
  })
})

// A copy earmarked for a waitlisted student's claim is still 'available' on
// the shelf, but nobody else can borrow it. Without this count, clients show
// a Borrow button the server will refuse, and hide Join Waitlist.
describe('heldCopies', () => {
  beforeEach(resetDb)

  async function claimFor(bookId: string, claimExpiresAt: Date) {
    const claimant = await prisma.user.create({
      data: { name: 'Claimant', email: `claimant-${Math.random()}@test.com`, passwordHash: 'x' },
    })
    await prisma.reservation.create({ data: { userId: claimant.id, bookId, status: 'fulfilled', claimExpiresAt } })
  }

  it('counts copies held for a live claim', async () => {
    const book = await seedBook({ totalCopies: 2, availableCopies: 1 })
    await claimFor(book.id, new Date(Date.now() + 60_000))

    const res = await request(app).get(`/books/${book.id}`)
    expect(res.body).toMatchObject({ availableCopies: 1, heldCopies: 1 })
  })

  it('does not count a claim that has run out', async () => {
    const book = await seedBook({ totalCopies: 2, availableCopies: 1 })
    await claimFor(book.id, new Date(Date.now() - 1000))

    const res = await request(app).get(`/books/${book.id}`)
    expect(res.body.heldCopies).toBe(0)
  })

  it('is reported by search too, and is 0 when nothing is held', async () => {
    const held = await seedBook({ title: 'Clean Code', totalCopies: 1, availableCopies: 1 })
    await seedBook({ title: 'Design Patterns', totalCopies: 1, availableCopies: 1 })
    await claimFor(held.id, new Date(Date.now() + 60_000))

    const res = await request(app).get('/books/search')
    const byTitle = Object.fromEntries(res.body.map((b: { title: string; heldCopies: number }) => [b.title, b.heldCopies]))
    expect(byTitle).toEqual({ 'Clean Code': 1, 'Design Patterns': 0 })
  })
})
