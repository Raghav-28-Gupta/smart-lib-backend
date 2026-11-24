import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { sendEmail, setMailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { DEMO_EMAIL, runSeed, SEED_BOOK_IDS, SEED_RESOURCE_IDS, SEED_STUDENT_EMAILS } from '../../prisma/seedData'
import { resetDb } from '../helpers/db'

// sendEmail is wrapped, not replaced: it still behaves as it does, and a test can ask whether it was
// called at all. The mailer skips the demo and seed addresses before it reaches a transport, so a
// transport that is never called cannot by itself show that the seed tried to send nothing.
vi.mock('../../src/lib/mailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/mailer')>()
  return { ...actual, sendEmail: vi.fn(actual.sendEmail) }
})

// Each runSeed hashes a password and writes ~900 bookings through a remote
// database, so a test that seeds twice is slow.
const SLOW = 180_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

async function seedStudent(n = 1) {
  return prisma.user.findUniqueOrThrow({ where: { email: SEED_STUDENT_EMAILS[n - 1] } })
}

/** A librarian's account, and the token the console would send for it. */
async function librarian() {
  const user = await prisma.user.create({
    data: { name: 'Priya Menon', email: `librarian${Math.random()}@example.com`, passwordHash: 'x', role: 'admin' },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

function otherStudent(name = 'Other Student') {
  return prisma.user.create({ data: { name, email: `other${Math.random()}@example.com`, passwordHash: 'x' } })
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

/** A notice a librarian's action left for a student, optionally about a loan or fine. */
function noticeFor(userId: string, about: { loanId?: string; fineId?: string } = {}) {
  return prisma.notice.create({
    data: {
      userId,
      kind: 'dispute_outcome',
      title: 'Your fine was waived',
      body: 'The library waived this fine.',
      ...about,
    },
  })
}

/** A dispute on a fine, as POST /fines/:id/dispute leaves the rows: the marker on the fine and the open dispute. */
async function disputeFine(fineId: string, userId: string, resolved?: { resolvedById: string }) {
  await prisma.fine.update({ where: { id: fineId }, data: { disputedAt: resolved ? null : new Date() } })
  return prisma.fineDispute.create({
    data: {
      fineId,
      userId,
      reason: 'I returned it on time',
      ...(resolved ? { status: 'upheld', resolutionNote: 'The record is clear.', resolvedById: resolved.resolvedById, resolvedAt: new Date() } : {}),
    },
  })
}

/** A problem report as the app leaves it: on a copy (reported at return) or on a seat or room, open or closed by a librarian. */
function reportOn(userId: string, target: { bookCopyId: string } | { resourceId: string }, resolvedById?: string) {
  return prisma.issueReport.create({
    data: {
      userId,
      category: 'bookCopyId' in target ? 'damaged' : 'dirty',
      ...target,
      ...(resolvedById ? { status: 'dismissed', resolvedById, resolvedAt: new Date(), resolutionNote: 'No action was needed.' } : {}),
    },
  })
}

/**
 * The invariant behind the Disputed filter: a fine carries the marker only while a dispute row is
 * there to answer. (The reverse, a dispute with no fine, cannot exist: its foreign key is RESTRICT.)
 */
async function expectNoMarkerWithoutADispute() {
  expect(await prisma.fine.count({ where: { disputedAt: { not: null }, dispute: null } })).toBe(0)
}

beforeEach(resetDb)

describe('runSeed', () => {
  it('a fresh seed has two open disputes, an open copy report and an open resource report, and the Disputed filter and the queue have data', async () => {
    const before = Date.now()
    await runSeed(prisma)
    const after = Date.now()
    const { token } = await librarian()
    const asLibrarian = { Authorization: `Bearer ${token}` }
    const seedStudentIds = new Set(
      (await prisma.user.findMany({ where: { email: { in: [...SEED_STUDENT_EMAILS] } } })).map((u) => u.id),
    )
    // Opened hours before the seed ran, so the queue shows them as fresh.
    const recent = (at: Date) => {
      expect(at.getTime()).toBeLessThanOrEqual(after)
      expect(at.getTime()).toBeGreaterThan(before - 12 * HOUR_MS)
    }

    // Two open disputes, on the two newest fines (both outstanding), by the students who owe them.
    const disputes = await prisma.fineDispute.findMany({ include: { fine: true }, orderBy: { createdAt: 'asc' } })
    expect(disputes).toHaveLength(2)
    const newestFines = await prisma.fine.findMany({ orderBy: { createdAt: 'desc' }, take: 2 })
    expect(disputes.map((d) => d.fineId).sort()).toEqual(newestFines.map((f) => f.id).sort())
    for (const d of disputes) {
      expect(d).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
      expect(seedStudentIds.has(d.userId)).toBe(true)
      expect(d.userId).toBe(d.fine.userId)
      expect(d.reason.trim().length).toBeGreaterThan(0)
      expect(d.reason.length).toBeLessThanOrEqual(300)
      recent(d.createdAt)
      expect(d.createdAt.getTime()).toBeGreaterThan(d.fine.createdAt.getTime())
      // The fine carries the marker of an open dispute, from the moment the dispute was opened.
      expect(d.fine.status).toBe('pending')
      expect(d.fine.disputedAt?.getTime()).toBe(d.createdAt.getTime())
    }

    // An open copy report and an open resource report, by two different seed students, naming no librarian.
    const reports = await prisma.issueReport.findMany({ include: { bookCopy: true } })
    expect(reports).toHaveLength(2)
    const copyReport = reports.find((r) => r.bookCopyId)!
    const resourceReport = reports.find((r) => r.resourceId)!
    expect(copyReport).toMatchObject({ status: 'open', category: 'damaged', resourceId: null, resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(SEED_BOOK_IDS).toContain(copyReport.bookCopy!.bookId)
    // A copy a librarian can act on at once: it is on the shelf.
    expect(copyReport.bookCopy!.status).toBe('available')
    expect(resourceReport).toMatchObject({ status: 'open', category: 'not_working', bookCopyId: null, resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(SEED_RESOURCE_IDS).toContain(resourceReport.resourceId)
    for (const r of [copyReport, resourceReport]) {
      expect(seedStudentIds.has(r.userId)).toBe(true)
      expect(r.note!.trim().length).toBeGreaterThan(0)
      expect(r.note!.length).toBeLessThanOrEqual(300)
      recent(r.createdAt)
    }
    expect(copyReport.userId).not.toBe(resourceReport.userId)

    // The Disputed filter lists the two, each with its dispute, still open to waive or adjust.
    const filtered = await request(app).get('/admin/fines?status=disputed').set(asLibrarian)
    expect(filtered.status).toBe(200)
    expect(filtered.body.total).toBe(2)
    expect(filtered.body.fines.map((f: { id: string }) => f.id).sort()).toEqual(newestFines.map((f) => f.id).sort())
    for (const row of filtered.body.fines) {
      expect(row).toMatchObject({ kind: 'fine', status: 'disputed', reason: 'overdue', canSettle: true })
      expect(disputes.map((d) => d.id)).toContain(row.dispute.id)
    }

    // The queue shows the two disputes and the two reports (and the overdue loans the demo data already has).
    const queue = await request(app).get('/admin/attention').set(asLibrarian)
    expect(queue.status).toBe(200)
    expect(queue.body.counts).toMatchObject({ fine_dispute: 2, report: 2 })
    expect(queue.body.counts.overdue).toBeGreaterThanOrEqual(1)
    expect(queue.body.counts.all).toBe(queue.body.counts.overdue + 4)
    const items = queue.body.items as Array<{ id: string; kind: string; waitingSince: string }>
    expect(items.filter((i) => i.kind === 'fine_dispute').map((i) => i.id).sort()).toEqual(disputes.map((d) => d.id).sort())
    expect(items.filter((i) => i.kind === 'report').map((i) => i.id).sort()).toEqual(reports.map((r) => r.id).sort())
    const copyItem = items.find((i) => i.id === copyReport.id) as unknown as { report: { target: string; copy: { barcode: string } } }
    expect(copyItem.report).toMatchObject({ target: 'copy', copy: { barcode: copyReport.bookCopy!.barcode } })
    const resourceItem = items.find((i) => i.id === resourceReport.id) as unknown as { report: { target: string; resource: { id: string } } }
    expect(resourceItem.report).toMatchObject({ target: 'resource', resource: { id: resourceReport.resourceId } })

    // A seeded disputed fine behaves like a real one: Mark paid is refused.
    const paid = await request(app).post(`/admin/fines/${newestFines[0].id}/paid`).set(asLibrarian).send({ amount: newestFines[0].amount })
    expect(paid.status).toBe(409)
    expect(paid.body.error).toBe('This fine is being disputed. Resolve the dispute first.')
  }, SLOW)

  it('opens the two disputes on the two newest outstanding fines when more than two are outstanding', async () => {
    // The history depends on the date only through the weekday, and on a Thursday three fines stay outstanding.
    const thursday = new Date()
    thursday.setDate(thursday.getDate() - ((thursday.getDay() + 3) % 7))
    await runSeed(prisma, thursday)

    const outstanding = await prisma.fine.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } })
    expect(outstanding.length, 'the demo data leaves three fines outstanding on a Thursday').toBeGreaterThanOrEqual(3)
    const disputes = await prisma.fineDispute.findMany()
    expect(disputes.map((d) => d.fineId).sort()).toEqual(outstanding.slice(0, 2).map((f) => f.id).sort())
    // The older outstanding fines have no dispute and no marker.
    for (const fine of outstanding.slice(2)) expect(fine.disputedAt).toBeNull()
  }, SLOW)

  it('a second run succeeds', async () => {
    const first = await runSeed(prisma)
    const firstDisputes = await prisma.fineDispute.findMany({ select: { id: true } })
    const firstReports = await prisma.issueReport.findMany({ select: { id: true } })
    const second = await runSeed(prisma)
    expect(first).toMatchObject({ books: 12, resources: 7, users: 7, disputes: 2, reports: 2 })
    expect(second).toEqual(first)
    expect(await prisma.book.count()).toBe(12)
    expect(await prisma.resource.count()).toBe(7)
    expect(await prisma.user.count()).toBe(7)
    expect(await prisma.fine.count()).toBe(first.fines)
    // The first run's disputes and reports were replaced, not kept beside the new ones; there are still no notices.
    expect(await prisma.fineDispute.count()).toBe(2)
    expect(await prisma.issueReport.count()).toBe(2)
    expect(await prisma.fineDispute.count({ where: { id: { in: firstDisputes.map((d) => d.id) } } })).toBe(0)
    expect(await prisma.issueReport.count({ where: { id: { in: firstReports.map((r) => r.id) } } })).toBe(0)
    expect(await prisma.notice.count()).toBe(0)
    await expectNoMarkerWithoutADispute()
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
    await expectNoMarkerWithoutADispute()
  }, SLOW)

  it('a re-seed succeeds while a seed student has a notice, and deletes it', async () => {
    await runSeed(prisma)
    const student = await seedStudent()
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    // A notice the librarian's action left, on a loan of the student's own and one without any.
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const loan = await lateLoan(student.id, copy.id)
    const fine = await overdueFine(student.id, loan.id)
    const aboutLoan = await noticeFor(student.id, { loanId: loan.id, fineId: fine.id })
    const plain = await noticeFor(student.id)
    // The demo student's too: the account the live demo signs in with.
    const demoNotice = await noticeFor(demo.id)

    await runSeed(prisma)

    expect(await prisma.notice.count({ where: { id: { in: [aboutLoan.id, plain.id, demoNotice.id] } } })).toBe(0)
    // The seed accounts were recreated, so nothing of them is left behind.
    expect(await prisma.notice.count()).toBe(0)
    expect(await prisma.user.count()).toBe(7)
  }, SLOW)

  it("a notice for a non-seed student about a demo-book loan survives a re-seed with its loan link cleared", async () => {
    await runSeed(prisma)
    const other = await otherStudent()
    const copy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const loan = await lateLoan(other.id, copy.id)
    const fine = await overdueFine(other.id, loan.id)
    const notice = await noticeFor(other.id, { loanId: loan.id, fineId: fine.id })

    await runSeed(prisma)

    // The loan and fine went with the demo book, but the notice, already rendered, stays.
    expect(await prisma.loan.findUnique({ where: { id: loan.id } })).toBeNull()
    expect(await prisma.fine.findUnique({ where: { id: fine.id } })).toBeNull()
    const kept = await prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })
    expect(kept).toMatchObject({ userId: other.id, title: notice.title, body: notice.body, loanId: null, fineId: null })
  }, SLOW)

  it('a re-seed succeeds after a student disputed a seed fine and leaves no dispute without its fine', async () => {
    await runSeed(prisma)
    const librarian = await prisma.user.create({
      data: { name: 'Priya Menon', email: `librarian${Math.random()}@example.com`, passwordHash: 'x', role: 'admin' },
    })
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    const other = await otherStudent()

    // A seed student disputes one of the fines the seed itself wrote that the seed has not already disputed.
    const seeded = await prisma.fine.findFirstOrThrow({
      where: { status: { in: ['pending', 'adjusted'] }, dispute: null, user: { email: { in: [...SEED_STUDENT_EMAILS] } } },
    })
    const onSeedFine = await disputeFine(seeded.id, seeded.userId)
    // The demo student disputes a fine of their own that names no loan.
    const demoFine = await prisma.fine.create({ data: { userId: demo.id, amount: 30, reason: 'overdue' } })
    const onDemoStudentFine = await disputeFine(demoFine.id, demo.id)
    // Another student's fine on a demo book goes with the book: its dispute, open or resolved, must go first.
    const demoCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const demoLoan = await lateLoan(other.id, demoCopy.id)
    const onDemoBook = await overdueFine(other.id, demoLoan.id)
    const openOnDemoBook = await disputeFine(onDemoBook.id, other.id)
    const demoBookIds = Array.from({ length: 12 }, (_, i) => `b${i + 1}`)
    const resolvedCopy = await prisma.bookCopy.findFirstOrThrow({
      where: { bookId: { in: demoBookIds }, status: 'available', id: { not: demoCopy.id } },
    })
    const resolvedLoan = await lateLoan(other.id, resolvedCopy.id)
    const resolvedFine = await overdueFine(other.id, resolvedLoan.id)
    const resolvedOnDemoBook = await disputeFine(resolvedFine.id, other.id, { resolvedById: librarian.id })
    // Another student's dispute on a fine for a book a librarian added is not the seed's to touch.
    const book = await consoleBook()
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const keptLoan = await lateLoan(other.id, copy.id)
    const keptFine = await overdueFine(other.id, keptLoan.id)
    const kept = await disputeFine(keptFine.id, other.id)

    await runSeed(prisma)

    const gone = [onSeedFine.id, onDemoStudentFine.id, openOnDemoBook.id, resolvedOnDemoBook.id]
    expect(await prisma.fineDispute.count({ where: { id: { in: gone } } })).toBe(0)
    expect(await prisma.fine.count({ where: { id: { in: [seeded.id, demoFine.id, onDemoBook.id, resolvedFine.id] } } })).toBe(0)
    // The other student's dispute, on the librarian's book, stands with its fine and the fine's marker.
    expect(await prisma.fineDispute.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ fineId: keptFine.id, userId: other.id, status: 'open' })
    expect((await prisma.fine.findUniqueOrThrow({ where: { id: keptFine.id } })).disputedAt).not.toBeNull()
    // The one dispute that stays, and the two the new seed opened.
    expect(await prisma.fineDispute.count({ where: { userId: other.id } })).toBe(1)
    expect(await prisma.fineDispute.count()).toBe(3)
    await expectNoMarkerWithoutADispute()
    expect(await prisma.user.count({ where: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } })).toBe(7)
  }, SLOW)

  it('a re-seed succeeds after a student reported a seed copy and a seed resource', async () => {
    await runSeed(prisma)
    const librarian = await prisma.user.create({
      data: { name: 'Priya Menon', email: `librarian${Math.random()}@example.com`, passwordHash: 'x', role: 'admin' },
    })
    const student = await seedStudent()
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    const other = await otherStudent()
    const demoCopies = await prisma.bookCopy.findMany({ where: { bookId: { in: ['b1', 'b2'] } }, take: 3, orderBy: { barcode: 'asc' } })
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })
    const book = await consoleBook()
    const addedCopy = await prisma.bookCopy.create({ data: { bookId: book.id } })

    // A seed student reports a demo copy and a seed resource; the demo student's report was closed by a librarian.
    const seedCopyByStudent = await reportOn(student.id, { bookCopyId: demoCopies[0].id })
    const seedResourceByStudent = await reportOn(student.id, { resourceId: SEED_RESOURCE_IDS[0] })
    const seedResourceByDemo = await reportOn(demo.id, { resourceId: SEED_RESOURCE_IDS[4] }, librarian.id)
    // Another student's reports on demo copies and resources go with them, open or closed.
    const demoCopyByOther = await reportOn(other.id, { bookCopyId: demoCopies[1].id })
    const demoCopyClosed = await reportOn(other.id, { bookCopyId: demoCopies[2].id }, librarian.id)
    const seedResourceByOther = await reportOn(other.id, { resourceId: SEED_RESOURCE_IDS[2] })
    // A seed student's reports on a librarian's own copy and resource go with the student.
    const addedCopyByStudent = await reportOn(student.id, { bookCopyId: addedCopy.id })
    const deskByStudent = await reportOn(student.id, { resourceId: desk.id })
    // Another student's reports on a librarian's own copy and resource are not the seed's to touch.
    const addedCopyByOther = await reportOn(other.id, { bookCopyId: addedCopy.id })
    const deskByOther = await reportOn(other.id, { resourceId: desk.id })

    await runSeed(prisma)

    const gone = [seedCopyByStudent, seedResourceByStudent, seedResourceByDemo, demoCopyByOther, demoCopyClosed, seedResourceByOther, addedCopyByStudent, deskByStudent]
    expect(await prisma.issueReport.count({ where: { id: { in: gone.map((r) => r.id) } } })).toBe(0)
    // What stays is exactly the other student's two reports on the librarian's copy and desk, still open.
    const kept = await prisma.issueReport.findMany({ where: { userId: other.id } })
    expect(kept).toHaveLength(2)
    expect(kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: addedCopyByOther.id, userId: other.id, bookCopyId: addedCopy.id, resourceId: null, status: 'open' }),
        expect.objectContaining({ id: deskByOther.id, userId: other.id, bookCopyId: null, resourceId: desk.id, status: 'open' }),
      ]),
    )
    // Beside them, the two reports the new seed opened (a copy and a resource of the new demo data).
    expect(await prisma.issueReport.count()).toBe(4)
    // The librarian who closed two of them is an ordinary account and stays; the seed accounts were recreated.
    expect(await prisma.user.findUnique({ where: { id: librarian.id } })).not.toBeNull()
    expect(await prisma.user.count({ where: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } })).toBe(7)
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

  it('a librarian-made dispute and report on a non-seed book by a non-seed student survive a re-seed', async () => {
    await runSeed(prisma)
    const { user: librarianUser } = await librarian()
    const other = await otherStudent()
    // A book and a desk a librarian added; the student has a late loan and a fine on the book, and has reported both.
    const book = await consoleBook()
    const openCopy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const answeredCopy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const openFine = await overdueFine(other.id, (await lateLoan(other.id, openCopy.id)).id)
    const answeredFine = await overdueFine(other.id, (await lateLoan(other.id, answeredCopy.id)).id)
    const open = await disputeFine(openFine.id, other.id)
    const answered = await disputeFine(answeredFine.id, other.id, { resolvedById: librarianUser.id })
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })
    const copyReport = await reportOn(other.id, { bookCopyId: openCopy.id })
    const deskReport = await reportOn(other.id, { resourceId: desk.id }, librarianUser.id)
    const theirRows = async () => ({
      disputes: await prisma.fineDispute.findMany({ where: { userId: other.id }, orderBy: { id: 'asc' } }),
      fines: await prisma.fine.findMany({ where: { userId: other.id }, orderBy: { id: 'asc' } }),
      reports: await prisma.issueReport.findMany({ where: { userId: other.id }, orderBy: { id: 'asc' } }),
    })
    const before = await theirRows()
    expect(before.disputes.map((d) => d.id).sort()).toEqual([open.id, answered.id].sort())
    expect(before.reports.map((r) => r.id).sort()).toEqual([copyReport.id, deskReport.id].sort())

    await runSeed(prisma)

    // Every column of every one of their rows is as it was: status, the open dispute's marker, who answered, when.
    expect(await theirRows()).toEqual(before)
    expect((await prisma.fine.findUniqueOrThrow({ where: { id: openFine.id } })).disputedAt).not.toBeNull()
    expect((await prisma.fine.findUniqueOrThrow({ where: { id: answeredFine.id } })).disputedAt).toBeNull()
    expect(await prisma.user.findUnique({ where: { id: librarianUser.id } })).not.toBeNull()
    // Beside them stand the two disputes and two reports the new seed opened.
    expect(await prisma.fineDispute.count()).toBe(4)
    expect(await prisma.issueReport.count()).toBe(4)
    await expectNoMarkerWithoutADispute()
  }, SLOW)

  it("a dispute on another student's fine for a demo book is deleted with the fine, leaving none without a fine", async () => {
    await runSeed(prisma)
    const { user: librarianUser } = await librarian()
    const other = await otherStudent()
    const seededDisputes = await prisma.fineDispute.findMany({ select: { id: true } })
    expect(seededDisputes).toHaveLength(2)
    // Two of their fines on demo books, each disputed: one still open and one a librarian answered.
    const openCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const answeredCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b3', status: 'available' } })
    const openFine = await overdueFine(other.id, (await lateLoan(other.id, openCopy.id)).id)
    const answeredFine = await overdueFine(other.id, (await lateLoan(other.id, answeredCopy.id)).id)
    const open = await disputeFine(openFine.id, other.id)
    const answered = await disputeFine(answeredFine.id, other.id, { resolvedById: librarianUser.id })

    await runSeed(prisma)

    const gone = [open.id, answered.id, ...seededDisputes.map((d) => d.id)]
    expect(await prisma.fineDispute.count({ where: { id: { in: gone } } })).toBe(0)
    expect(await prisma.fine.count({ where: { id: { in: [openFine.id, answeredFine.id] } } })).toBe(0)
    // Only the new seed's own two are left, each on a fine that exists and carries the marker.
    const left = await prisma.fineDispute.findMany({ include: { fine: true } })
    expect(left).toHaveLength(2)
    for (const d of left) expect(d.fine.disputedAt).not.toBeNull()
    await expectNoMarkerWithoutADispute()
    // The student's account is not a seed account, so it stays.
    expect(await prisma.user.findUnique({ where: { id: other.id } })).not.toBeNull()
  }, SLOW)

  it("a notice for another student about a demo-book loan survives with null links; seed users' notices are deleted", async () => {
    await runSeed(prisma)
    const other = await otherStudent()
    const student = await seedStudent()
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    // Another student's loan and fine on a demo book, and on a book a librarian added.
    const demoCopy = await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b1', status: 'available' } })
    const demoLoan = await lateLoan(other.id, demoCopy.id)
    const demoFine = await overdueFine(other.id, demoLoan.id)
    const book = await consoleBook()
    const addedCopy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'borrowed' } })
    const addedLoan = await lateLoan(other.id, addedCopy.id)
    const addedFine = await overdueFine(other.id, addedLoan.id)
    const aboutDemoBook = await noticeFor(other.id, { loanId: demoLoan.id, fineId: demoFine.id })
    const aboutAddedBook = await noticeFor(other.id, { loanId: addedLoan.id, fineId: addedFine.id })
    const plain = await noticeFor(other.id)
    // The seed accounts' notices, on a loan and fine of their own and without any.
    const seedLoan = await lateLoan(student.id, (await prisma.bookCopy.findFirstOrThrow({ where: { bookId: 'b3', status: 'available' } })).id)
    const seedFine = await overdueFine(student.id, seedLoan.id)
    const seedNotices = [await noticeFor(student.id, { loanId: seedLoan.id, fineId: seedFine.id }), await noticeFor(student.id), await noticeFor(demo.id)]

    await runSeed(prisma)

    // The loan and fine went with the demo book, but the other student's notice, already rendered, stays with its links cleared.
    expect(await prisma.loan.findUnique({ where: { id: demoLoan.id } })).toBeNull()
    expect(await prisma.fine.findUnique({ where: { id: demoFine.id } })).toBeNull()
    expect(await prisma.notice.findUniqueOrThrow({ where: { id: aboutDemoBook.id } })).toMatchObject({
      userId: other.id, title: aboutDemoBook.title, body: aboutDemoBook.body, kind: aboutDemoBook.kind, loanId: null, fineId: null,
    })
    // A notice about a librarian's book keeps its links: that loan and fine stay.
    expect(await prisma.notice.findUniqueOrThrow({ where: { id: aboutAddedBook.id } })).toMatchObject({ loanId: addedLoan.id, fineId: addedFine.id })
    expect(await prisma.notice.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ userId: other.id, loanId: null, fineId: null })
    // The seed accounts' own are deleted, and the new seed writes none: only the three of the other student's remain.
    expect(await prisma.notice.count({ where: { id: { in: seedNotices.map((n) => n.id) } } })).toBe(0)
    expect(await prisma.notice.count({ where: { user: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } } })).toBe(0)
    expect(await prisma.notice.count()).toBe(3)
  }, SLOW)

  it('the seed sends no email', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    vi.mocked(sendEmail).mockClear()
    // With a transport injected the mailer counts as configured, so anything the seed tried to send would reach it.
    setMailTransport({ send })
    try {
      await runSeed(prisma)
      // A re-seed too: it deletes the seed accounts' rows and must not tell anyone about it.
      await runSeed(prisma)
    } finally {
      setMailTransport(null)
    }
    expect(send).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(await prisma.notice.count()).toBe(0)
  }, SLOW)
})
