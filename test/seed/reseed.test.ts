import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { runSeed, SEED_RESOURCE_IDS, SEED_STUDENT_EMAILS } from '../../prisma/seedData'
import { resetDb } from '../helpers/db'

// Each runSeed hashes a password and writes ~900 bookings through a remote
// database, so a test that seeds twice is slow.
const SLOW = 180_000
const DAY_MS = 24 * 60 * 60 * 1000

async function seedStudent(n = 1) {
  return prisma.user.findUniqueOrThrow({ where: { email: SEED_STUDENT_EMAILS[n - 1] } })
}

function otherStudent(name = 'Other Student') {
  return prisma.user.create({ data: { name, email: `other${Math.random()}@test.com`, passwordHash: 'x' } })
}

/** A book a librarian added through the console: not one of the demo books. */
function consoleBook(title = 'Console Book') {
  return prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Some Author' } })
}

function lateLoan(userId: string, bookCopyId: string, status: 'active' | 'lost' = 'active') {
  const now = Date.now()
  return prisma.loan.create({
    data: {
      userId,
      bookCopyId,
      borrowedAt: new Date(now - 20 * DAY_MS),
      dueAt: new Date(now - 6 * DAY_MS),
      status,
      lostAt: status === 'lost' ? new Date(now - DAY_MS) : null,
    },
  })
}

function overdueFine(userId: string, relatedLoanId: string) {
  return prisma.fine.create({ data: { userId, relatedLoanId, amount: 60, reason: 'overdue' } })
}

beforeEach(resetDb)

describe('runSeed', () => {
  it('a second run succeeds', async () => {
    const first = await runSeed(prisma)
    const second = await runSeed(prisma)
    expect(first).toMatchObject({ books: 12, resources: 7, users: 7 })
    expect(second).toEqual(first)
    expect(await prisma.book.count()).toBe(12)
    expect(await prisma.resource.count()).toBe(7)
    expect(await prisma.user.count()).toBe(7)
    expect(await prisma.fine.count()).toBe(first.fines)
  }, SLOW)

  it(
    "after a console-added book with a copy, a seed student's open loan and a fine on it, a re-seed succeeds, keeps the added book and its copy (now available), and removes the seed student's loan and fine",
    async () => {
      await runSeed(prisma)
      const student = await seedStudent()
      const book = await consoleBook()
      const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
      const loan = await lateLoan(student.id, copy.id)
      const fine = await overdueFine(student.id, loan.id)

      await runSeed(prisma)

      expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull()
      // The added copy stays, no longer borrowed by someone who has just been reset.
      expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
      expect(await prisma.loan.findUnique({ where: { id: loan.id } })).toBeNull()
      expect(await prisma.fine.findUnique({ where: { id: fine.id } })).toBeNull()
    },
    SLOW,
  )

  it("a seed student's pending request holding a copy of an added book is removed and the copy is released", async () => {
    await runSeed(prisma)
    const student = await seedStudent()
    const book = await consoleBook()
    const held = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'requested' } })
    const maintenance = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'maintenance' } })
    const request = await prisma.borrowRequest.create({
      data: { userId: student.id, bookId: book.id, bookCopyId: held.id, expiresAt: new Date(Date.now() + DAY_MS) },
    })
    // The student is also on the added book's waitlist.
    const waiting = await prisma.reservation.create({ data: { userId: student.id, bookId: book.id } })

    await runSeed(prisma)

    expect(await prisma.borrowRequest.findUnique({ where: { id: request.id } })).toBeNull()
    expect(await prisma.reservation.findUnique({ where: { id: waiting.id } })).toBeNull()
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('available')
    // A copy nobody held for the student is left as the librarian set it.
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: maintenance.id } })).status).toBe('maintenance')
  }, SLOW)

  it("a seed student's lost loan on an added book goes with its fines, and the lost copy stays lost", async () => {
    await runSeed(prisma)
    const student = await seedStudent()
    const book = await consoleBook()
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'lost' } })
    const loan = await lateLoan(student.id, copy.id, 'lost')
    const overdue = await overdueFine(student.id, loan.id)
    const replacement = await prisma.fine.create({
      data: { userId: student.id, relatedLoanId: loan.id, amount: 400, reason: 'lost' },
    })

    await runSeed(prisma)

    expect(await prisma.loan.findUnique({ where: { id: loan.id } })).toBeNull()
    expect(await prisma.fine.count({ where: { id: { in: [overdue.id, replacement.id] } } })).toBe(0)
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('lost')
  }, SLOW)

  it("another student's loan and fine on an added book are left alone", async () => {
    await runSeed(prisma)
    const other = await otherStudent()
    const book = await consoleBook()
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const loan = await lateLoan(other.id, copy.id)
    const fine = await overdueFine(other.id, loan.id)
    const request = await prisma.borrowRequest.create({
      data: {
        userId: other.id, bookId: book.id, bookCopyId: copy.id, status: 'approved', loanId: loan.id,
        expiresAt: new Date(Date.now() + DAY_MS),
      },
    })

    await runSeed(prisma)

    expect(await prisma.loan.findUnique({ where: { id: loan.id } })).not.toBeNull()
    expect(await prisma.fine.findUnique({ where: { id: fine.id } })).not.toBeNull()
    expect(await prisma.borrowRequest.findUnique({ where: { id: request.id } })).not.toBeNull()
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('borrowed')
  }, SLOW)

  it('another student\'s loan and fine on a demo book are removed with the demo book, and no fine is left without its loan', async () => {
    await runSeed(prisma)
    const other = await otherStudent()
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const loan = await lateLoan(other.id, copy.id)
    const fine = await overdueFine(other.id, loan.id)
    // Their other rows on demo books go too: a borrow request, a waitlist place, a cached recommendation.
    const requestedCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b3', status: 'available' } })
    const request = await prisma.borrowRequest.create({
      data: { userId: other.id, bookId: 'b3', bookCopyId: requestedCopy.id, expiresAt: new Date(Date.now() + DAY_MS) },
    })
    const waiting = await prisma.reservation.create({ data: { userId: other.id, bookId: 'b2' } })
    const recommended = await prisma.recommendationCache.create({
      data: { userId: other.id, bookId: 'b4', score: 0.9, method: 'hybrid' },
    })

    await runSeed(prisma)

    expect(await prisma.loan.findUnique({ where: { id: loan.id } })).toBeNull()
    expect(await prisma.fine.findUnique({ where: { id: fine.id } })).toBeNull()
    expect(await prisma.borrowRequest.findUnique({ where: { id: request.id } })).toBeNull()
    expect(await prisma.reservation.findUnique({ where: { id: waiting.id } })).toBeNull()
    expect(await prisma.recommendationCache.findUnique({ where: { id: recommended.id } })).toBeNull()
    // The student's account is not a seed account, so it stays.
    expect(await prisma.user.findUnique({ where: { id: other.id } })).not.toBeNull()
    const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Fine" f
      WHERE f."relatedLoanId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l.id = f."relatedLoanId")`
    expect(Number(orphans[0].n)).toBe(0)
  }, SLOW)

  it('a copy a librarian added to a demo book is removed', async () => {
    await runSeed(prisma)
    const added = await prisma.bookCopy.create({ data: { bookId: 'b1' } })
    expect(await prisma.bookCopy.count({ where: { bookId: 'b1' } })).toBe(5)

    await runSeed(prisma)

    expect(await prisma.bookCopy.findUnique({ where: { id: added.id } })).toBeNull()
    // b1 is back to its four demo copies.
    expect(await prisma.bookCopy.count({ where: { bookId: 'b1' } })).toBe(4)
  }, SLOW)

  it('a seed student\'s booking on an added resource, with its no-show record and fine, is removed with the resource kept', async () => {
    await runSeed(prisma)
    const student = await seedStudent()
    const other = await otherStudent()
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })
    const at = (hour: number) => new Date(Date.now() - 3 * DAY_MS + hour * 60 * 60 * 1000)
    const missed = await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: desk.id, startTime: at(1), endTime: at(2), status: 'no_show' },
    })
    await prisma.noShowEvent.create({ data: { resourceBookingId: missed.id, userId: student.id, predictedProbability: 0.4 } })
    const noShowFine = await prisma.fine.create({
      data: { userId: student.id, relatedBookingId: missed.id, amount: 50, reason: 'no_show' },
    })
    // Another student's booking of a seed resource goes with it, along with its no-show record and fine.
    const otherMissed = await prisma.resourceBooking.create({
      data: { userId: other.id, resourceId: SEED_RESOURCE_IDS[2], startTime: at(5), endTime: at(6), status: 'no_show' },
    })
    await prisma.noShowEvent.create({ data: { resourceBookingId: otherMissed.id, userId: other.id, predictedProbability: 0.7 } })
    const otherNoShowFine = await prisma.fine.create({
      data: { userId: other.id, relatedBookingId: otherMissed.id, amount: 50, reason: 'no_show' },
    })

    await runSeed(prisma)

    expect(await prisma.resource.findUnique({ where: { id: desk.id } })).not.toBeNull()
    expect(await prisma.resourceBooking.count({ where: { id: { in: [missed.id, otherMissed.id] } } })).toBe(0)
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(await prisma.fine.count({ where: { id: { in: [noShowFine.id, otherNoShowFine.id] } } })).toBe(0)
  }, SLOW)

  it('every seeded copy has a barcode', async () => {
    await runSeed(prisma)
    const copies = await prisma.bookCopy.findMany({ select: { barcode: true } })
    // The demo books' copies: 4+3+5+3+6+2+3+4+2+3+2+3.
    expect(copies).toHaveLength(40)
    for (const copy of copies) expect(copy.barcode).toMatch(/^SL-\d{5,}$/)
    expect(new Set(copies.map((c) => c.barcode)).size).toBe(copies.length)
  }, SLOW)

  it('seeds the history\'s fines for the seed students only, naming no librarian', async () => {
    const summary = await runSeed(prisma)
    const fines = await prisma.fine.findMany({ include: { relatedLoan: true } })
    expect(fines).toHaveLength(summary.fines)
    expect(fines.length).toBeGreaterThan(0)

    const seedStudentIds = new Set((await prisma.user.findMany({ where: { email: { in: [...SEED_STUDENT_EMAILS] } } })).map((u) => u.id))
    for (const f of fines) {
      expect(seedStudentIds.has(f.userId)).toBe(true)
      expect(f.reason).toBe('overdue')
      expect(f.relatedLoan?.id).toMatch(/^hist-loan-\d+$/)
      expect(f.relatedLoan?.userId).toBe(f.userId)
      expect([f.adjustedById, f.paidRecordedById]).toEqual([null, null])
      if (f.status === 'adjusted') {
        expect(f.originalAmount).toBeGreaterThan(f.amount)
        expect([f.adjustReason, f.adjustedAt]).not.toContain(null)
      }
      if (f.status === 'waived') {
        expect(f.amount).toBe(0)
        expect(f.originalAmount).toBeGreaterThan(0)
        expect(f.adjustReason).not.toBeNull()
      }
      if (f.status === 'paid') expect(f.paidAt).not.toBeNull()
    }
    // The demo student's account gets no fines.
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: 'aditi.sharma@thapar.edu' } })
    expect(await prisma.fine.count({ where: { userId: demo.id } })).toBe(0)
  }, SLOW)
})
