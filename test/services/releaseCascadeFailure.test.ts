import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { releaseBorrowRequest } from '../../src/services/requestHolds'
import { onBookReturned } from '../../src/services/reservationService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

// The waitlist cascade is the one step of a release that runs after its
// transaction has committed. Make it fail; every other export stays real.
vi.mock('../../src/services/reservationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/reservationService')>()
  return { ...actual, onBookReturned: vi.fn().mockRejectedValue(new Error('waitlist cascade down')) }
})

const HOUR_MS = 60 * 60 * 1000

/** A book whose only copy is held by a pending request. */
async function seedHeldRequest() {
  const user = await prisma.user.create({
    data: { name: 'Aditi Sharma', email: `aditi${Math.random()}@test.com`, passwordHash: 'x' },
  })
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: 1 },
  })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'requested' } })
  const held = await prisma.borrowRequest.create({
    data: { userId: user.id, bookId: book.id, bookCopyId: copy.id, expiresAt: new Date(Date.now() + HOUR_MS) },
  })
  return { book, copy, held }
}

describe('a failing waitlist cascade after a release', () => {
  beforeEach(resetDb)
  let logged: ReturnType<typeof vi.spyOn>
  let recorder: ReturnType<typeof recordEvents> | undefined
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(onBookReturned).mockClear()
  })
  afterEach(() => {
    logged.mockRestore()
    recorder?.stop()
    recorder = undefined
  })

  it('still releases the request: the release committed, so it logs the failure and answers true', async () => {
    const { book, copy, held } = await seedHeldRequest()

    const released = await releaseBorrowRequest(held, { status: 'declined', decidedAt: new Date() })

    expect(released).toBe(true)
    expect((await prisma.borrowRequest.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('declined')
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
    expect(onBookReturned).toHaveBeenCalledWith(book.id, expect.any(Date))
    expect(logged).toHaveBeenCalledWith('Waitlist cascade failed after releasing a request:', expect.any(Error))
  })

  it('does not fail a librarian decline that committed, and the console is still told', async () => {
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `librarian${Math.random()}@test.com`, passwordHash: 'x', role: 'admin' },
    })
    const token = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
    const { held } = await seedHeldRequest()
    recorder = recordEvents()

    const res = await request(app).post(`/admin/requests/borrow/${held.id}/decline`).set('Authorization', `Bearer ${token}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('declined')
    expect(recorder.events).toEqual([{ type: 'request.decided', topics: ['requests'], kind: 'borrow' }])
  })
})
