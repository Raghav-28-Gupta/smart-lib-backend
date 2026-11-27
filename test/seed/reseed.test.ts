import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { sendEmail, setMailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { noShowDisputeDeadline, noShowInfo } from '../../src/services/bookingService'
import { sweepBookings } from '../../src/services/noShowService'
import { seedSeats } from '../../prisma/seatLayout'
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

// The four desks the demo has always had: their place in the layout and their scripted "taken today" slots.
const KEPT_DESKS = [
  { id: 's1', location: 'Reading Room A', desk: 12, taken: ['11:00 AM', '12:00 PM'] },
  { id: 's2', location: 'Reading Room A', desk: 14, taken: ['9:00 AM', '10:00 AM', '3:00 PM', '4:00 PM'] },
  { id: 's3', location: 'Silent Zone', desk: 3, taken: [] },
  { id: 's4', location: 'Silent Zone', desk: 7, taken: ['1:00 PM', '2:00 PM', '6:00 PM'] },
]

/** A day as the availability endpoint takes it: YYYY-MM-DD, local. */
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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

    // The queue shows the two fine disputes, the two no-show disputes and the two reports (and the overdue loans the demo data already has).
    const queue = await request(app).get('/admin/attention').set(asLibrarian)
    expect(queue.status).toBe(200)
    expect(queue.body.counts).toMatchObject({ fine_dispute: 2, no_show_dispute: 2, report: 2 })
    expect(queue.body.counts.overdue).toBeGreaterThanOrEqual(1)
    expect(queue.body.counts.all).toBe(queue.body.counts.overdue + 6)
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
    // The history depends on the date only through the weekday, and on a Friday four fines stay outstanding.
    const friday = new Date()
    friday.setDate(friday.getDate() - ((friday.getDay() + 2) % 7))
    await runSeed(prisma, friday)

    const outstanding = await prisma.fine.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } })
    expect(outstanding.length, 'the demo data leaves more than two fines outstanding on a Friday').toBeGreaterThanOrEqual(3)
    const disputes = await prisma.fineDispute.findMany()
    expect(disputes.map((d) => d.fineId).sort()).toEqual(outstanding.slice(0, 2).map((f) => f.id).sort())
    // The older outstanding fines have no dispute and no marker.
    for (const fine of outstanding.slice(2)) expect(fine.disputedAt).toBeNull()
  }, SLOW)

  it('a second run succeeds and replaces the seeded disputes', async () => {
    // One clock for both runs: the "taken" slots' final states depend on the time of day, which moves between two real runs.
    const today = new Date()
    const first = await runSeed(prisma, today)
    const firstDisputes = await prisma.fineDispute.findMany({ select: { id: true } })
    const firstNoShowDisputes = await prisma.noShowDispute.findMany({ select: { id: true } })
    const firstReports = await prisma.issueReport.findMany({ select: { id: true } })
    const second = await runSeed(prisma, today)
    expect(first).toMatchObject({ books: 12, resources: 131, users: 82, disputes: 2, noShowDisputes: 2, reports: 2 })
    expect(first.noShows).toBeGreaterThan(0)
    expect(second).toEqual(first)
    // The no-show disputes are replaced, not kept beside the new ones, and the no-shows are not counted twice.
    expect(await prisma.noShowDispute.count()).toBe(2)
    expect(await prisma.noShowDispute.count({ where: { id: { in: firstNoShowDisputes.map((d) => d.id) } } })).toBe(0)
    expect(await prisma.resourceBooking.count({ where: { status: 'no_show' } })).toBe(first.noShows)
    expect(await prisma.noShowEvent.count()).toBe(first.noShows)
    expect(await prisma.book.count()).toBe(12)
    expect(await prisma.resource.count()).toBe(131)
    expect(await prisma.user.count()).toBe(82)
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
    expect(await prisma.user.count()).toBe(82)
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
    expect(await prisma.user.count({ where: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } })).toBe(82)
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
    expect(await prisma.user.count({ where: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } })).toBe(82)
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

    const summary = await runSeed(prisma)

    expect(await prisma.resource.findUnique({ where: { id: desk.id } })).not.toBeNull()
    expect(await prisma.resourceBooking.count({ where: { id: { in: [missed.id, otherMissed.id] } } })).toBe(0)
    // Their two records went; what is left is the new seed's own, one per no-show it wrote.
    expect(await prisma.noShowEvent.count()).toBe(summary.noShows)
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

  it("a re-seed deletes seed students' no-show disputes and a librarian-made dispute on a non-seed booking survives", async () => {
    await runSeed(prisma)
    const { user: librarianUser } = await librarian()
    const student = await seedStudent(2)
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    const other = await otherStudent()
    // A desk a librarian added: not one of the demo resources.
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })

    // A missed booking, hours ago on a day within the last week, and the student's dispute of it (open, or answered).
    let n = 0
    const missed = async (userId: string, resourceId: string) => {
      const startTime = new Date(Date.now() - (2 + n++) * DAY_MS)
      return prisma.resourceBooking.create({
        data: { userId, resourceId, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'no_show' },
      })
    }
    const dispute = (bookingId: string, userId: string, resolvedById?: string) =>
      prisma.noShowDispute.create({
        data: {
          bookingId,
          userId,
          reason: 'I was at the desk the whole time.',
          ...(resolvedById ? { status: 'upheld', resolutionNote: 'The desk log shows nobody checked in.', resolvedById, resolvedAt: new Date() } : {}),
        },
      })

    // Go with the seed accounts: a seed student's dispute on a demo resource and one on the librarian's desk
    // (open and answered), and the demo student's.
    const seedOnSeedResource = await missed(student.id, SEED_RESOURCE_IDS[0])
    const seedOnDesk = await missed(student.id, desk.id)
    const seedOnDeskAnswered = await missed(student.id, desk.id)
    const demoOnDesk = await missed(demo.id, desk.id)
    // Goes with the demo resource: another student's dispute on a booking of it, open or answered.
    const otherOnSeedResource = await missed(other.id, SEED_RESOURCE_IDS[4])
    const otherOnSeedResourceAnswered = await missed(other.id, SEED_RESOURCE_IDS[2])
    const gone = [
      await dispute(seedOnSeedResource.id, student.id),
      await dispute(seedOnDesk.id, student.id),
      await dispute(seedOnDeskAnswered.id, student.id, librarianUser.id),
      await dispute(demoOnDesk.id, demo.id),
      await dispute(otherOnSeedResource.id, other.id),
      await dispute(otherOnSeedResourceAnswered.id, other.id, librarianUser.id),
    ]
    // Stay: the other student's disputes on the librarian's desk, one open and one answered by the librarian.
    const keptOpenBooking = await missed(other.id, desk.id)
    const keptAnsweredBooking = await missed(other.id, desk.id)
    const keptOpen = await dispute(keptOpenBooking.id, other.id)
    const keptAnswered = await dispute(keptAnsweredBooking.id, other.id, librarianUser.id)
    // Notices about those bookings: the one on a booking that goes loses its link, the one on a booking that stays keeps it.
    const noticeAbout = (bookingId: string) =>
      prisma.notice.create({ data: { userId: other.id, kind: 'no_show', title: 'Missed booking', body: 'You did not check in.', bookingId } })
    const aboutGoneBooking = await noticeAbout(otherOnSeedResource.id)
    const aboutKeptBooking = await noticeAbout(keptOpenBooking.id)
    const theirRows = async () => ({
      disputes: await prisma.noShowDispute.findMany({ where: { userId: other.id, bookingId: { in: [keptOpenBooking.id, keptAnsweredBooking.id] } }, orderBy: { id: 'asc' } }),
      bookings: await prisma.resourceBooking.findMany({ where: { id: { in: [keptOpenBooking.id, keptAnsweredBooking.id] } }, orderBy: { id: 'asc' } }),
    })
    const before = await theirRows()
    expect(before.disputes.map((d) => d.id).sort()).toEqual([keptOpen.id, keptAnswered.id].sort())

    await runSeed(prisma)

    // Every dispute of a seed account, and every one on a booking of a demo resource, is gone, with those bookings.
    expect(await prisma.noShowDispute.count({ where: { id: { in: gone.map((d) => d.id) } } })).toBe(0)
    expect(
      await prisma.resourceBooking.count({
        where: { id: { in: [seedOnSeedResource, seedOnDesk, seedOnDeskAnswered, demoOnDesk, otherOnSeedResource, otherOnSeedResourceAnswered].map((b) => b.id) } },
      }),
    ).toBe(0)
    // The librarian-made ones stand with their bookings, every column as it was (status, answer, who, when).
    expect(await theirRows()).toEqual(before)
    expect(await prisma.noShowDispute.findUniqueOrThrow({ where: { id: keptAnswered.id } })).toMatchObject({ status: 'upheld', resolvedById: librarianUser.id })
    // The other student's notice keeps its text; its link is cleared only where the booking went.
    expect(await prisma.notice.findUniqueOrThrow({ where: { id: aboutGoneBooking.id } })).toMatchObject({ userId: other.id, title: 'Missed booking', bookingId: null })
    expect((await prisma.notice.findUniqueOrThrow({ where: { id: aboutKeptBooking.id } })).bookingId).toBe(keptOpenBooking.id)
    // The librarian and the student are ordinary accounts and stay; the seed accounts were recreated.
    expect(await prisma.user.findUnique({ where: { id: librarianUser.id } })).not.toBeNull()
    expect(await prisma.user.findUnique({ where: { id: other.id } })).not.toBeNull()
    expect(await prisma.user.count({ where: { email: { in: [DEMO_EMAIL, ...SEED_STUDENT_EMAILS] } } })).toBe(82)
  }, SLOW)

  it('a fresh seed leaves no booked row past its grace period', async () => {
    // 11:05 today: the 9 and 10 o'clock "taken" slots are over, 11 o'clock has started and is inside its
    // grace period, and every later slot is still to come, so each of the three final states appears.
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 5)
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    await runSeed(prisma, today)
    const graceEnd = (b: { startTime: Date; gracePeriodMinutes: number }) => b.startTime.getTime() + b.gracePeriodMinutes * 60_000

    const bookings = await prisma.resourceBooking.findMany()
    // The sweep would record any of these, so none may be left.
    expect(bookings.filter((b) => b.status === 'booked' && graceEnd(b) < today.getTime())).toEqual([])
    // The history is all over: each booking is attended or a recorded no-show.
    const history = bookings.filter((b) => b.startTime < midnight)
    expect(history.length).toBeGreaterThan(0)
    expect(new Set(history.map((b) => b.status))).toEqual(new Set(['checked_in', 'no_show']))
    // Today's "taken" slots follow the seed's clock.
    const taken = bookings.filter((b) => b.startTime >= midnight)
    expect(taken.length).toBeGreaterThan(0)
    for (const b of taken) {
      const expected = graceEnd(b) < today.getTime() ? 'no_show' : b.startTime.getTime() <= today.getTime() ? 'checked_in' : 'booked'
      expect(b.status, `${b.resourceId} ${b.startTime.toISOString()}`).toBe(expected)
      if (b.status === 'checked_in') {
        expect(b.checkedInAt!.getTime()).toBeGreaterThanOrEqual(b.startTime.getTime())
        expect(b.checkedInAt!.getTime()).toBeLessThanOrEqual(today.getTime())
      } else {
        expect(b.checkedInAt).toBeNull()
      }
    }
    expect(new Set(taken.map((b) => b.status))).toEqual(new Set(['no_show', 'checked_in', 'booked']))
  }, SLOW)

  it('seeded no-shows have an event and no reliability log, notice or email', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    vi.mocked(sendEmail).mockClear()
    // With a transport injected the mailer counts as configured, so anything the seed tried to send would reach it.
    setMailTransport({ send })
    let summary: Awaited<ReturnType<typeof runSeed>>
    try {
      summary = await runSeed(prisma)
    } finally {
      setMailTransport(null)
    }

    const missed = await prisma.resourceBooking.findMany({ where: { status: 'no_show' }, include: { noShowEvent: true } })
    expect(summary.noShows).toBeGreaterThan(0)
    expect(missed).toHaveLength(summary.noShows)
    for (const b of missed) {
      // The record a later retraining reads: labelled a no-show, a probability a model could have given, and no points taken.
      expect(b.noShowEvent, b.id).toMatchObject({ userId: b.userId, actualNoShow: true, reliabilityDelta: null })
      expect(b.noShowEvent!.predictedProbability).toBeGreaterThan(0)
      expect(b.noShowEvent!.predictedProbability).toBeLessThan(1)
    }
    // One event per no-show and no other event: an attended booking was never scored.
    expect(await prisma.noShowEvent.count()).toBe(summary.noShows)

    // Backstory, not events: no log line, no change of score, no notice, no email.
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    expect(await prisma.reliabilityScoreLog.count({ where: { reason: { startsWith: 'No-show' } } })).toBe(0)
    // The demo student's one existing log line is the whole log, and her score is still what it was.
    expect(await prisma.reliabilityScoreLog.count({ where: { userId: { not: demo.id } } })).toBe(0)
    expect(demo.reliabilityScore).toBe(50)
    expect(await prisma.user.count({ where: { email: { in: [...SEED_STUDENT_EMAILS] }, reliabilityScore: { not: 100 } } })).toBe(0)
    expect(await prisma.notice.count()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  }, SLOW)

  it('the demo student has one disputable no-show and the two seeded disputes are open on other seed students', async () => {
    const before = Date.now()
    await runSeed(prisma)
    const after = Date.now()
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    const seedStudentIds = new Set(
      (await prisma.user.findMany({ where: { email: { in: [...SEED_STUDENT_EMAILS] } } })).map((u) => u.id),
    )
    const graceEndedAt = (b: { startTime: Date; gracePeriodMinutes: number }) => b.startTime.getTime() + b.gracePeriodMinutes * 60_000

    // The demo student has exactly one booking: a recent no-show with no dispute, which she can still dispute.
    const hers = await prisma.resourceBooking.findMany({ where: { userId: demo.id }, include: { noShowDispute: true, noShowEvent: true } })
    expect(hers).toHaveLength(1)
    const [missed] = hers
    expect(missed).toMatchObject({ status: 'no_show', noShowDispute: null })
    expect(missed.noShowEvent).toMatchObject({ actualNoShow: true, reliabilityDelta: null })
    expect(SEED_RESOURCE_IDS).toContain(missed.resourceId)
    // Its grace period ended within the last 6 days, so the 7-day window has a day or more to run.
    expect(graceEndedAt(missed)).toBeLessThan(before)
    expect(graceEndedAt(missed)).toBeGreaterThan(before - 6 * DAY_MS)
    expect(noShowInfo(missed, null, new Date())).toEqual({ canDispute: true, dispute: null })

    // Two open disputes, on two different seed students' recent no-shows (not the demo student's).
    const disputes = await prisma.noShowDispute.findMany({ include: { booking: true }, orderBy: { createdAt: 'asc' } })
    expect(disputes).toHaveLength(2)
    expect(new Set(disputes.map((d) => d.userId)).size).toBe(2)
    for (const d of disputes) {
      expect(d).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
      expect(seedStudentIds.has(d.userId)).toBe(true)
      expect(d.booking).toMatchObject({ userId: d.userId, status: 'no_show' })
      // A student's words as plain text, within the limit a real dispute has.
      expect(d.reason).toBe(d.reason.trim())
      expect(d.reason.length).toBeGreaterThan(0)
      expect(d.reason.length).toBeLessThanOrEqual(300)
      expect(d.reason).not.toMatch(/[<>]/)
      // Opened after the miss and before the seed ran, with the window still open.
      expect(d.createdAt.getTime()).toBeGreaterThan(graceEndedAt(d.booking))
      expect(d.createdAt.getTime()).toBeLessThanOrEqual(after)
      expect(noShowDisputeDeadline(d.booking).getTime()).toBeGreaterThan(after)
      expect(noShowInfo(d.booking, d, new Date())).toEqual({ canDispute: false, dispute: { status: 'open', note: null } })
    }
  }, SLOW)

  it('the first sweep after a seed records nothing for seeded rows', async () => {
    // The sweep runs at the seed's own clock: one a minute later could legitimately catch a
    // future "taken" slot whose grace period ends in between, as it would for any real booking.
    const today = new Date()
    await runSeed(prisma, today)
    const state = async () => ({
      bookings: await prisma.resourceBooking.findMany({ orderBy: { id: 'asc' } }),
      events: await prisma.noShowEvent.findMany({ orderBy: { id: 'asc' } }),
      logs: await prisma.reliabilityScoreLog.findMany({ orderBy: { id: 'asc' } }),
      users: await prisma.user.findMany({ orderBy: { id: 'asc' } }),
      notices: await prisma.notice.findMany({ orderBy: { id: 'asc' } }),
    })
    const before = await state()
    expect(before.events.length).toBeGreaterThan(0)

    expect(await sweepBookings(today)).toEqual({ noShows: 0, reminders: 0, remaining: 0 })

    expect(await state()).toEqual(before)
  }, SLOW)

  it('a librarian-made no-show dispute on a non-seed booking survives a re-seed', async () => {
    const today = new Date()
    await runSeed(prisma, today)
    const { user: librarianUser } = await librarian()
    const other = await otherStudent()
    // A desk a librarian added: not one of the demo resources.
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })
    const seeded = await prisma.noShowDispute.findMany({ select: { id: true } })
    expect(seeded).toHaveLength(2)

    // Two no-shows of the other student's on that desk, as the sweep leaves them (with the event that holds the
    // points taken): one disputed and still open, one disputed and answered by a librarian.
    const missed = async (daysAgo: number) => {
      const startTime = new Date(today.getTime() - daysAgo * DAY_MS)
      const booking = await prisma.resourceBooking.create({
        data: { userId: other.id, resourceId: desk.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'no_show' },
      })
      await prisma.noShowEvent.create({
        data: { resourceBookingId: booking.id, userId: other.id, predictedProbability: 0.4, actualNoShow: true, reliabilityDelta: -10 },
      })
      return booking
    }
    const openBooking = await missed(2)
    const answeredBooking = await missed(3)
    const open = await prisma.noShowDispute.create({
      data: { bookingId: openBooking.id, userId: other.id, reason: 'I was at the desk the whole time.' },
    })
    const answered = await prisma.noShowDispute.create({
      data: {
        bookingId: answeredBooking.id,
        userId: other.id,
        reason: 'I was at the desk the whole time.',
        status: 'upheld',
        resolutionNote: 'The desk log shows nobody checked in.',
        resolvedById: librarianUser.id,
        resolvedAt: new Date(),
      },
    })
    const bookingIds = [openBooking.id, answeredBooking.id]
    const theirRows = async () => ({
      disputes: await prisma.noShowDispute.findMany({ where: { userId: other.id }, orderBy: { id: 'asc' } }),
      bookings: await prisma.resourceBooking.findMany({ where: { id: { in: bookingIds } }, orderBy: { id: 'asc' } }),
      events: await prisma.noShowEvent.findMany({ where: { resourceBookingId: { in: bookingIds } }, orderBy: { id: 'asc' } }),
    })
    const before = await theirRows()
    expect(before.disputes.map((d) => d.id).sort()).toEqual([open.id, answered.id].sort())

    await runSeed(prisma, today)

    // Every column of their rows is as it was: status, who answered and when, the booking and the points on the event.
    expect(await theirRows()).toEqual(before)
    expect(await prisma.noShowDispute.findUniqueOrThrow({ where: { id: answered.id } })).toMatchObject({ status: 'upheld', resolvedById: librarianUser.id })
    expect(await prisma.user.findUnique({ where: { id: librarianUser.id } })).not.toBeNull()
    // The first seed's two disputes were replaced, and the new seed's two stand beside the kept pair.
    expect(await prisma.noShowDispute.count({ where: { id: { in: seeded.map((d) => d.id) } } })).toBe(0)
    expect(await prisma.noShowDispute.count()).toBe(4)
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

  it('every seed desk is placed where the layout says, and both zones have their front labels', async () => {
    const summary = await runSeed(prisma)
    expect(summary).toMatchObject({ resources: 131, users: 82 })

    const seats = await prisma.resource.findMany({ where: { type: 'seat' } })
    expect(seats).toHaveLength(128)
    const byId = new Map(seats.map((s) => [s.id, s]))
    for (const desk of seedSeats(KEPT_DESKS)) {
      expect(byId.get(desk.id), desk.id).toMatchObject({
        name: desk.name, location: desk.location, row: desk.row, column: desk.column, capacity: 1, status: 'available', statusNote: null,
      })
    }
    // s1 to s4 are the desks they always were, now with a place on the map.
    expect(byId.get('s1')).toMatchObject({ name: 'Reading Room A · Desk 12', location: 'Reading Room A', capacity: 1, row: 2, column: 2 })
    expect(byId.get('s2')).toMatchObject({ name: 'Reading Room A · Desk 14', location: 'Reading Room A', capacity: 1, row: 2, column: 5 })
    expect(byId.get('s3')).toMatchObject({ name: 'Silent Zone · Desk 3', location: 'Silent Zone', capacity: 1, row: 1, column: 3 })
    expect(byId.get('s4')).toMatchObject({ name: 'Silent Zone · Desk 7', location: 'Silent Zone', capacity: 1, row: 1, column: 8 })
    // The rooms stay off the map.
    const rooms = await prisma.resource.findMany({ where: { type: 'room' }, orderBy: { id: 'asc' } })
    expect(rooms.map((r) => [r.id, r.row, r.column])).toEqual([['r1', null, null], ['r2', null, null], ['r3', null, null]])
    // SEED_RESOURCE_IDS names every one of them, so a re-seed resets them all.
    expect([...SEED_RESOURCE_IDS].sort()).toEqual([...seats, ...rooms].map((r) => r.id).sort())

    expect(await prisma.seatZone.findMany({ orderBy: { name: 'asc' } })).toEqual([
      { name: 'Reading Room A', frontLabel: 'Windows' },
      { name: 'Silent Zone', frontLabel: 'Entrance' },
    ])
    // What the app's seat map reads: every desk with its place and its zone's front.
    const res = await request(app).get(`/resources/availability?type=seat&date=${isoDay(new Date())}`)
    expect(res.status).toBe(200)
    const items = res.body as Array<{ id: string; location: string; row: number; column: number; zoneFront: string | null }>
    expect(items).toHaveLength(128)
    for (const item of items) {
      expect(item.zoneFront, item.id).toBe(item.location === 'Reading Room A' ? 'Windows' : 'Entrance')
      expect([item.row, item.column], item.id).toEqual([byId.get(item.id)!.row, byId.get(item.id)!.column])
    }
  }, SLOW)

  it('the new desks have no booking today or later, and s1 to s4 keep today\'s taken slots', async () => {
    // 8:00 today, before the first slot: every scripted "taken" slot is still to come, so the map shows it taken.
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    await runSeed(prisma, new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0))

    // Every booking from today on is a scripted "taken" slot today, on s1, s2, s4 or a room.
    const fromToday = await prisma.resourceBooking.findMany({ where: { startTime: { gte: midnight } } })
    expect(new Set(fromToday.map((b) => b.resourceId))).toEqual(new Set(['s1', 's2', 's4', 'r1', 'r2', 'r3']))
    expect(fromToday.filter((b) => b.startTime >= tomorrow)).toEqual([])
    const hoursOn = (id: string) => fromToday.filter((b) => b.resourceId === id).map((b) => b.startTime.getHours()).sort((a, b) => a - b)
    expect(hoursOn('s1')).toEqual([11, 12])
    expect(hoursOn('s2')).toEqual([9, 10, 15, 16])
    expect(hoursOn('s3')).toEqual([])
    expect(hoursOn('s4')).toEqual([13, 14, 18])

    // What the app's seat map reads: s1, s2 and s4 show their slots today, every other desk is free, and tomorrow all are.
    const takenOn = async (day: Date) => {
      const res = await request(app).get(`/resources/availability?type=seat&date=${isoDay(day)}&includeOffline=true`)
      expect(res.status).toBe(200)
      return new Map((res.body as Array<{ id: string; takenSlotsToday: string[] }>).map((s) => [s.id, s.takenSlotsToday]))
    }
    const scripted = new Map(KEPT_DESKS.map((k) => [k.id, k.taken]))
    const today = await takenOn(midnight)
    expect(today.size).toBe(128)
    for (const [id, taken] of today) expect(taken, id).toEqual(scripted.get(id) ?? [])
    const next = await takenOn(tomorrow)
    expect(next.size).toBe(128)
    for (const [id, taken] of next) expect(taken, id).toEqual([])

    // The history before today covers the new desks as well as the old ones.
    const withHistory = new Set(
      (await prisma.resourceBooking.groupBy({ by: ['resourceId'], where: { startTime: { lt: midnight } } })).map((g) => g.resourceId),
    )
    for (const desk of seedSeats(KEPT_DESKS)) expect(withHistory.has(desk.id), desk.id).toBe(true)
  }, SLOW)

  it('resetSeedData removes all 81 seed students and every seed desk', async () => {
    const today = new Date()
    await runSeed(prisma, today)
    const firstStudents = await prisma.user.findMany({ where: { email: { in: SEED_STUDENT_EMAILS } }, select: { id: true } })
    expect(firstStudents).toHaveLength(81)
    // Every seed desk changed the way a librarian could change it, so one that was kept rather than recreated would show it.
    await prisma.resource.updateMany({ where: { id: { in: SEED_RESOURCE_IDS } }, data: { status: 'offline', statusNote: 'Set before the re-seed' } })
    await prisma.resource.update({ where: { id: 's-sz-48' }, data: { row: 9, column: 5 } })
    // The last seed student's booking on a desk a librarian added goes with the student; the desk stays.
    const student81 = await seedStudent(81)
    const desk = await prisma.resource.create({ data: { type: 'seat', name: 'Console Desk', capacity: 1 } })
    const startTime = new Date(today.getTime() - 3 * DAY_MS)
    const booking = await prisma.resourceBooking.create({
      data: { userId: student81.id, resourceId: desk.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'checked_in', checkedInAt: startTime },
    })

    await runSeed(prisma, today)

    // None of the first run's 81 accounts is left; the second run's 81 stand in their place.
    expect(await prisma.user.count({ where: { id: { in: firstStudents.map((u) => u.id) } } })).toBe(0)
    expect(await prisma.user.count({ where: { email: { in: SEED_STUDENT_EMAILS } } })).toBe(81)
    expect(await prisma.user.count()).toBe(82)
    // Every seed desk was recreated as the layout has it.
    expect(await prisma.resource.count({ where: { id: { in: SEED_RESOURCE_IDS } } })).toBe(131)
    expect(await prisma.resource.count({ where: { id: { in: SEED_RESOURCE_IDS }, OR: [{ status: 'offline' }, { statusNote: { not: null } }] } })).toBe(0)
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: 's-sz-48' } })).toMatchObject({ location: 'Silent Zone', row: 6, column: 9 })
    expect(await prisma.resourceBooking.findUnique({ where: { id: booking.id } })).toBeNull()
    expect(await prisma.resource.findUnique({ where: { id: desk.id } })).not.toBeNull()
  }, SLOW)

  it("a librarian's seat with a position survives a re-seed with its position", async () => {
    await runSeed(prisma)
    // A desk a librarian put in Reading Room A's aisle, and an out-of-service one in a zone of their own with its label.
    const inAisle = await prisma.resource.create({
      data: { type: 'seat', name: 'Window Nook', location: 'Reading Room A', row: 3, column: 4, capacity: 1 },
    })
    const inAnnex = await prisma.resource.create({
      data: { type: 'seat', name: 'Annex Desk 1', location: 'Annex', row: 1, column: 1, capacity: 1, status: 'offline', statusNote: 'Wobbly leg' },
    })
    await prisma.seatZone.create({ data: { name: 'Annex', frontLabel: 'Stairs' } })
    // The librarian also relabelled a demo zone.
    await prisma.seatZone.update({ where: { name: 'Reading Room A' }, data: { frontLabel: 'Garden' } })

    await runSeed(prisma)

    // Every column as it was: zone, row and column, and the offline desk's status.
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: inAisle.id } })).toEqual(inAisle)
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: inAnnex.id } })).toEqual(inAnnex)
    expect(await prisma.resource.count({ where: { type: 'seat' } })).toBe(130)
    // resetSeedData leaves SeatZone alone, so the librarian's own zone keeps its label; the seed puts the demo zones' back.
    expect(await prisma.seatZone.findMany({ orderBy: { name: 'asc' } })).toEqual([
      { name: 'Annex', frontLabel: 'Stairs' },
      { name: 'Reading Room A', frontLabel: 'Windows' },
      { name: 'Silent Zone', frontLabel: 'Entrance' },
    ])
  }, SLOW)

  it("refuses to re-seed, deleting nothing, while a librarian's seat stands in a demo desk's place", async () => {
    await runSeed(prisma)
    // The librarian moves Desk 1 into the aisle and puts a desk of their own where it stood.
    await prisma.resource.update({ where: { id: 's-rra-1' }, data: { row: 9, column: 4 } })
    const inTheWay = await prisma.resource.create({
      data: { type: 'seat', name: 'Window Nook', location: 'Reading Room A', row: 1, column: 1, capacity: 1 },
    })
    const everything = async () => ({
      users: await prisma.user.count(),
      books: await prisma.book.count(),
      copies: await prisma.bookCopy.count(),
      resources: await prisma.resource.count(),
      bookings: await prisma.resourceBooking.count(),
      noShowEvents: await prisma.noShowEvent.count(),
      loans: await prisma.loan.count(),
      fines: await prisma.fine.count(),
      fineDisputes: await prisma.fineDispute.count(),
      noShowDisputes: await prisma.noShowDispute.count(),
      reports: await prisma.issueReport.count(),
      zones: await prisma.seatZone.findMany({ orderBy: { name: 'asc' } }),
    })
    const before = await everything()

    // The refusal names the seat in the way and its place, and says what to do.
    await expect(runSeed(prisma)).rejects.toThrow(/"Window Nook" \(Reading Room A, row 1, column 1\).*Move/)

    // Nothing was deleted: the first seed's data stands, and both desks are where the librarian left them.
    expect(await everything()).toEqual(before)
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: 's-rra-1' } })).toMatchObject({ row: 9, column: 4 })
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: inTheWay.id } })).toEqual(inTheWay)

    // Once that seat is moved off the place, the seed runs and puts Desk 1 back.
    await prisma.resource.update({ where: { id: inTheWay.id }, data: { row: 3, column: 4 } })
    await runSeed(prisma)
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: 's-rra-1' } })).toMatchObject({ location: 'Reading Room A', row: 1, column: 1 })
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: inTheWay.id } })).toMatchObject({ row: 3, column: 4 })
  }, SLOW)
})
