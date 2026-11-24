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
    data: { name: 'Aditi Sharma', email: `aditi${Math.random()}@example.com`, passwordHash: 'x' },
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
      data: { name: 'Librarian', email: `librarian${Math.random()}@example.com`, passwordHash: 'x', role: 'admin' },
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

describe('a failing waitlist cascade after a student return', () => {
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

  /** A student with a copy of a new book out on loan, the copy marked borrowed as lending leaves it. */
  async function seedLoanOut() {
    const user = await prisma.user.create({
      data: { name: 'Aditi Sharma', email: `aditi${Math.random()}@example.com`, passwordHash: 'x' },
    })
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
    const book = await prisma.book.create({
      data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: 1 },
    })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const loan = await prisma.loan.create({ data: { userId: user.id, bookCopyId: copy.id, dueAt: new Date(Date.now() + 5 * 24 * HOUR_MS) } })
    return { user, token, book, copy, loan }
  }

  const returnLoan = (token: string, loanId: string, body?: object) => {
    const req = request(app).post(`/loans/${loanId}/return`).set('Authorization', `Bearer ${token}`)
    return body === undefined ? req : req.send(body)
  }

  it('still announces the committed return and its report once, and the answer stays what it was (a 500)', async () => {
    const { book, copy, loan, token, user } = await seedLoanOut()
    recorder = recordEvents()

    const res = await returnLoan(token, loan.id, { report: { category: 'damaged', note: 'The cover is torn' } })

    // The cascade failed after the commit, as before: the answer is unchanged...
    expect(res.status).toBe(500)
    expect(onBookReturned).toHaveBeenCalledWith(book.id, expect.any(Date))
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'waitlist cascade down' }))
    // ...the return and its report did commit...
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('returned')
    expect(await prisma.issueReport.findMany({ where: { bookCopyId: copy.id, userId: user.id, status: 'open' } })).toHaveLength(1)
    // ...so the console hears of both, once each.
    expect(recorder.events).toEqual([
      { type: 'loan.changed', topics: ['metrics', 'catalogue'] },
      { type: 'attention.changed', topics: ['attention'] },
    ])
  })

  it('announces nothing for the queue when the return wrote no report', async () => {
    const bare = await seedLoanOut()
    const duplicate = await seedLoanOut()
    // The student already has an open report on this copy: the new one is dropped, none is written.
    await prisma.issueReport.create({ data: { userId: duplicate.user.id, bookCopyId: duplicate.copy.id, category: 'dirty' } })
    recorder = recordEvents()

    const noReport = await returnLoan(bare.token, bare.loan.id)
    const droppedReport = await returnLoan(duplicate.token, duplicate.loan.id, { report: { category: 'damaged', note: 'Torn' } })

    expect(noReport.status).toBe(500)
    expect(droppedReport.status).toBe(500)
    expect(await prisma.issueReport.count({ where: { bookCopyId: duplicate.copy.id } })).toBe(1)
    expect(recorder.events).toEqual([
      { type: 'loan.changed', topics: ['metrics', 'catalogue'] },
      { type: 'loan.changed', topics: ['metrics', 'catalogue'] },
    ])
  })
})
