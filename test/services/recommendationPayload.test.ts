// The payload of POST /recommend/batch, built from the database (slice 8, spec section 3, step 3):
// the catalog (books with at least one copy that is not lost) and the students' interactions
// (each loan 1, +0.5 when renewed; each reservation 0.5; summed per student and book, capped at 3).
// It carries user ids and book ids only: never a name, an email or any other user field. When a cap
// is exceeded the most recent interactions are kept, and an interaction on a book that was not
// sent is dropped (the AI service would ignore it anyway; here it never leaves the building).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RECOMMEND_LIMIT, RECOMMEND_MAX_PAIR_WEIGHT } from '../../src/config/constants'
import type { CopyStatus, LoanStatus, ReservationStatus } from '../../src/generated/prisma/client'
import type { RecommendBatchRequest } from '../../src/lib/aiClient'
import { prisma } from '../../src/lib/prisma'
import { buildRecommendationPayload } from '../../src/services/recommendationPayload'
import { resetDb } from '../helpers/db'

// Each case seeds and reads through a remote database.
vi.setConfig({ testTimeout: 60_000 })

const DAY_MS = 24 * 60 * 60 * 1000
// A fixed base, far from "now": the order of the interactions comes from these instants only.
const T0 = new Date('2026-06-01T09:00:00.000Z')
const day = (n: number) => new Date(T0.getTime() + n * DAY_MS)

const FIXTURE: { request: RecommendBatchRequest } = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/recommend-batch-example.json', import.meta.url)), 'utf8'))

beforeEach(() => resetDb())

async function seedStudent(name = `Student ${randomUUID()}`, email = `${randomUUID()}@example.com`) {
  return prisma.user.create({ data: { name, email, passwordHash: 'x', role: 'student' } })
}

async function seedAdmin() {
  return prisma.user.create({ data: { name: 'Librarian Name', email: `${randomUUID()}@library.example.com`, passwordHash: 'x', role: 'admin' } })
}

/** A book with one available copy (so it is sendable), unless `copies` says otherwise. */
async function seedBook(title: string, options: { copies?: CopyStatus[]; genre?: string | null; description?: string | null } = {}) {
  const { copies = ['available'], genre = null, description = null } = options
  const created = await prisma.book.create({
    data: {
      isbn: `isbn-${randomUUID()}`,
      title,
      author: `Author of ${title}`,
      genre,
      description,
      publishedYear: 1999,
      copies: { create: copies.map((status) => ({ status })) },
    },
  })
  return created
}

/** A loan of a NEW copy of the book (copy status follows the loan's), borrowed at `borrowedAt`. */
async function seedLoan(userId: string, bookId: string, options: { borrowedAt?: Date; renewedCount?: number; status?: LoanStatus } = {}) {
  const { borrowedAt = day(0), renewedCount = 0, status = 'returned' } = options
  const copyStatus: CopyStatus = status === 'lost' ? 'lost' : status === 'returned' ? 'available' : 'borrowed'
  await prisma.loan.create({
    data: {
      user: { connect: { id: userId } },
      borrowedAt,
      dueAt: new Date(borrowedAt.getTime() + 14 * DAY_MS),
      renewedCount,
      status,
      ...(status === 'returned' ? { returnedAt: new Date(borrowedAt.getTime() + DAY_MS) } : {}),
      ...(status === 'lost' ? { lostAt: new Date(borrowedAt.getTime() + DAY_MS) } : {}),
      bookCopy: { create: { book: { connect: { id: bookId } }, status: copyStatus } },
    },
  })
}

async function seedReservation(userId: string, bookId: string, options: { requestedAt?: Date; status?: ReservationStatus } = {}) {
  const { requestedAt = day(0), status = 'waiting' } = options
  await prisma.reservation.create({ data: { userId, bookId, requestedAt, status } })
}

/** The payload's interactions as a sorted list of "user|book|weight": order-free, easy to read in a failure. */
const triples = (payload: RecommendBatchRequest) => payload.interactions.map((i) => `${i.user_id}|${i.book_id}|${i.weight}`).sort()
const bookIds = (payload: RecommendBatchRequest) => payload.books.map((b) => b.id).sort()

async function mustBuild(limits?: { maxBooks: number; maxInteractions: number }) {
  const payload = await buildRecommendationPayload(limits)
  expect(payload, 'a payload was expected').not.toBeNull()
  return payload as RecommendBatchRequest
}

describe('buildRecommendationPayload', () => {
  it('weights: a loan is 1, a renewed loan 1.5, a reservation 0.5, a loan plus a reservation on one book 1.5', async () => {
    const student = await seedStudent()
    const plain = await seedBook('Plain loan')
    const renewed = await seedBook('Renewed loan')
    const reserved = await seedBook('Reservation only')
    const both = await seedBook('Loan and reservation')
    await seedLoan(student.id, plain.id)
    await seedLoan(student.id, renewed.id, { renewedCount: 1 })
    await seedReservation(student.id, reserved.id)
    await seedLoan(student.id, both.id)
    await seedReservation(student.id, both.id)

    const payload = await mustBuild()

    expect(triples(payload)).toEqual(
      [`${student.id}|${plain.id}|1`, `${student.id}|${renewed.id}|1.5`, `${student.id}|${reserved.id}|0.5`, `${student.id}|${both.id}|1.5`].sort(),
    )
    expect(payload.limit).toBe(RECOMMEND_LIMIT)
  })

  it('a loan renewed twice still adds the bonus once (1.5, not 2)', async () => {
    const student = await seedStudent()
    const book = await seedBook('Renewed twice')
    await seedLoan(student.id, book.id, { renewedCount: 2 })

    expect(triples(await mustBuild())).toEqual([`${student.id}|${book.id}|1.5`])
  })

  it('loans and reservations count in every status', async () => {
    const student = await seedStudent()
    const loanStatuses: LoanStatus[] = ['active', 'overdue', 'returned', 'lost']
    const reservationStatuses: ReservationStatus[] = ['waiting', 'fulfilled', 'expired', 'cancelled']
    const expected: string[] = []
    for (const status of loanStatuses) {
      // The book keeps a second, available copy: a lost copy alone would make the book unsendable.
      const book = await seedBook(`Loan ${status}`)
      await seedLoan(student.id, book.id, { status })
      expected.push(`${student.id}|${book.id}|1`)
    }
    for (const status of reservationStatuses) {
      const book = await seedBook(`Reservation ${status}`)
      await seedReservation(student.id, book.id, { status })
      expected.push(`${student.id}|${book.id}|0.5`)
    }

    expect(triples(await mustBuild())).toEqual(expected.sort())
  })

  it('three loans of one book cap at 3', async () => {
    const student = await seedStudent()
    const heavy = await seedBook('Borrowed again and again')
    const light = await seedBook('Borrowed twice')
    // 1 + 1 + 1.5 (renewed) + 0.5 (a reservation) = 4, over the cap.
    await seedLoan(student.id, heavy.id, { borrowedAt: day(1) })
    await seedLoan(student.id, heavy.id, { borrowedAt: day(2) })
    await seedLoan(student.id, heavy.id, { borrowedAt: day(3), renewedCount: 1 })
    await seedReservation(student.id, heavy.id, { requestedAt: day(4) })
    // The control: two loans (2) are under the cap and are left alone.
    await seedLoan(student.id, light.id, { borrowedAt: day(1) })
    await seedLoan(student.id, light.id, { borrowedAt: day(2) })

    const payload = await mustBuild()

    expect(RECOMMEND_MAX_PAIR_WEIGHT).toBe(3)
    expect(triples(payload)).toEqual([`${student.id}|${heavy.id}|3`, `${student.id}|${light.id}|2`].sort())
  })

  it("only students: a librarian's loans are left out", async () => {
    const student = await seedStudent()
    const admin = await seedAdmin()
    const book = await seedBook('Shared interest')
    await seedLoan(student.id, book.id)
    await seedLoan(admin.id, book.id)
    await seedReservation(admin.id, book.id)

    const payload = await mustBuild()

    expect(triples(payload)).toEqual([`${student.id}|${book.id}|1`])
    expect(JSON.stringify(payload)).not.toContain(admin.id)
    // The book is still in the catalog: it has a copy.
    expect(bookIds(payload)).toEqual([book.id])
  })

  it('a book with only lost copies is not sent and its interactions are dropped', async () => {
    const student = await seedStudent()
    const sendable = await seedBook('One copy lost, one on the shelf', { copies: ['lost', 'available'] })
    const allLost = await seedBook('Every copy lost', { copies: ['lost', 'lost'] })
    const noCopies = await seedBook('No copies at all', { copies: [] })
    await seedLoan(student.id, sendable.id)
    await seedLoan(student.id, allLost.id, { status: 'lost' })
    await seedReservation(student.id, allLost.id)
    await seedReservation(student.id, noCopies.id)

    const payload = await mustBuild()

    expect(bookIds(payload)).toEqual([sendable.id])
    expect(triples(payload)).toEqual([`${student.id}|${sendable.id}|1`])
  })

  it('a student whose every interaction was dropped is absent', async () => {
    const dropped = await seedStudent()
    const kept = await seedStudent()
    const sendable = await seedBook('On the shelf')
    const gone = await seedBook('Every copy lost', { copies: ['lost'] })
    await seedLoan(dropped.id, gone.id, { status: 'lost' })
    await seedReservation(dropped.id, gone.id)
    await seedLoan(kept.id, sendable.id)

    const payload = await mustBuild()

    expect([...new Set(payload.interactions.map((i) => i.user_id))]).toEqual([kept.id])
    expect(JSON.stringify(payload)).not.toContain(dropped.id)
  })

  it('sends only the allowed keys and no personal field', async () => {
    const name = 'Priyanka Raghunathan-Okonkwo'
    const email = 'priyanka.raghunathan.okonkwo@students.example.edu'
    const student = await seedStudent(name, email)
    const admin = await seedAdmin()
    const described = await seedBook('A described book', { genre: 'Algorithms', description: 'Sorting and graphs.' })
    const bare = await seedBook('A bare book')
    await seedLoan(student.id, described.id)
    await seedReservation(student.id, bare.id)
    await seedLoan(admin.id, bare.id)

    const payload = await mustBuild()

    // The exact key sets, and the same ones the fixture (the contract shared with the AI service) uses.
    expect(Object.keys(payload).sort()).toEqual(['books', 'interactions', 'limit'])
    expect(Object.keys(payload).sort()).toEqual(Object.keys(FIXTURE.request).sort())
    expect(payload.books).toHaveLength(2)
    for (const sent of payload.books) {
      expect(Object.keys(sent).sort()).toEqual(['author', 'description', 'genre', 'id', 'title'])
      expect(Object.keys(sent).sort()).toEqual(Object.keys(FIXTURE.request.books[0]).sort())
    }
    expect(payload.interactions).toHaveLength(2)
    for (const sent of payload.interactions) {
      expect(Object.keys(sent).sort()).toEqual(['book_id', 'user_id', 'weight'])
      expect(Object.keys(sent).sort()).toEqual(Object.keys(FIXTURE.request.interactions[0]).sort())
    }
    // Text passes through as it is; an empty genre or description is null, not missing.
    expect(payload.books.find((b) => b.id === described.id)).toEqual({
      id: described.id,
      title: 'A described book',
      author: 'Author of A described book',
      genre: 'Algorithms',
      description: 'Sorting and graphs.',
    })
    expect(payload.books.find((b) => b.id === bare.id)).toEqual({ id: bare.id, title: 'A bare book', author: 'Author of A bare book', genre: null, description: null })

    // Nothing personal, in any form: not the student's name or email or any part of it, not the librarian's, no isbn.
    const text = JSON.stringify(payload)
    for (const secret of [name, email, 'Priyanka', 'Raghunathan', 'okonkwo', 'students.example.edu', 'Librarian Name', 'library.example.com', 'isbn-']) {
      expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase())
    }
    // The ids are the only handle on a student.
    expect(payload.interactions.map((i) => i.user_id)).toEqual([student.id, student.id])
  })

  it('truncates to the most recent interactions and to the book cap', async () => {
    const s1 = await seedStudent()
    const s2 = await seedStudent()
    // Titles chosen so "interaction first" and "the rest by title" cannot be confused: the fillers sort BEFORE every borrowed title.
    const b = [] as Array<{ id: string }>
    for (let i = 1; i <= 6; i++) b.push(await seedBook(`Borrowed ${i}`))
    const f = [] as Array<{ id: string }>
    for (let i = 1; i <= 3; i++) f.push(await seedBook(`A filler ${i}`))
    // The newest activity of all is on a book with no copy left (not sent): it must take no place in either cap.
    const lost = await seedBook('Lost for good', { copies: ['lost'] })
    await seedLoan(s2.id, lost.id, { borrowedAt: day(9), status: 'lost' })
    // Pair recency is the LATEST activity of the pair: s1 + b1 is a day-1 loan AND a day-7 reservation.
    await seedLoan(s1.id, b[0].id, { borrowedAt: day(1) })
    await seedReservation(s1.id, b[0].id, { requestedAt: day(7) })
    await seedLoan(s2.id, b[1].id, { borrowedAt: day(2) })
    await seedLoan(s1.id, b[2].id, { borrowedAt: day(3) })
    await seedLoan(s2.id, b[3].id, { borrowedAt: day(4) })
    await seedLoan(s1.id, b[4].id, { borrowedAt: day(5) })
    await seedLoan(s2.id, b[5].id, { borrowedAt: day(6) })

    // Six pairs in all. Interaction cap 4: the four most recent (b1@7, b6@6, b5@5, b4@4), across both students.
    const cut = await mustBuild({ maxBooks: 100, maxInteractions: 4 })
    expect(triples(cut)).toEqual([`${s1.id}|${b[0].id}|1.5`, `${s2.id}|${b[5].id}|1`, `${s1.id}|${b[4].id}|1`, `${s2.id}|${b[3].id}|1`].sort())
    // No cut of the books: all nine are sent.
    expect(bookIds(cut)).toEqual([...b, ...f].map((x) => x.id).sort())

    // Book cap 8 of 9 (the full interactions): every borrowed book stays, and the two places left go to the first two fillers by title.
    const eight = await mustBuild({ maxBooks: 8, maxInteractions: 100 })
    expect(bookIds(eight)).toEqual([...b, f[0], f[1]].map((x) => x.id).sort())
    expect(eight.interactions).toHaveLength(6)

    // Book cap 6: the borrowed books fill it, no filler at all, and every interaction survives.
    const six = await mustBuild({ maxBooks: 6, maxInteractions: 100 })
    expect(bookIds(six)).toEqual(b.map((x) => x.id).sort())
    expect(six.interactions).toHaveLength(6)

    // Book cap 4, fewer than the borrowed books: the four with the most recent activity (b1@7, b6@6, b5@5, b4@4) stay, and the
    // interactions on the two books that were cut (b2, b3) are dropped with them: nothing points at a book that was not sent.
    const four = await mustBuild({ maxBooks: 4, maxInteractions: 100 })
    expect(bookIds(four)).toEqual([b[0], b[3], b[4], b[5]].map((x) => x.id).sort())
    expect(triples(four)).toEqual([`${s1.id}|${b[0].id}|1.5`, `${s2.id}|${b[5].id}|1`, `${s1.id}|${b[4].id}|1`, `${s2.id}|${b[3].id}|1`].sort())
    for (const payload of [cut, eight, six, four]) {
      const sent = new Set(payload.books.map((x) => x.id))
      expect(payload.interactions.every((i) => sent.has(i.book_id))).toBe(true)
    }
  })

  it('is deterministic: the same database gives the same payload, equal instants ordered by student then book', async () => {
    const a = await seedStudent()
    const b = await seedStudent()
    const first = await seedBook('Zeta')
    const second = await seedBook('Alpha')
    // Four pairs, one instant: nothing but the tie-break decides their order.
    for (const student of [a, b]) for (const book of [first, second]) await seedLoan(student.id, book.id, { borrowedAt: day(1) })

    const once = await mustBuild()
    const twice = await mustBuild()

    expect(twice).toEqual(once)
    const order = once.interactions.map((i) => `${i.user_id}|${i.book_id}`)
    expect(order).toEqual([...order].sort())
    // Books in title order, not insertion order.
    expect(once.books.map((x) => x.title)).toEqual(['Alpha', 'Zeta'])
    // The same four, cut to three by the cap, are cut the same way every time.
    expect(await mustBuild({ maxBooks: 10, maxInteractions: 3 })).toEqual(await mustBuild({ maxBooks: 10, maxInteractions: 3 }))
  })

  it('returns null when there is nothing to send', async () => {
    // An empty database.
    expect(await buildRecommendationPayload()).toBeNull()

    // Books but no interaction.
    const student = await seedStudent()
    const admin = await seedAdmin()
    const book = await seedBook('Unborrowed')
    const lostOnly = await seedBook('Every copy lost', { copies: ['lost'] })
    expect(await buildRecommendationPayload()).toBeNull()

    // Only a librarian's interactions, and a student's on a book that is not sent.
    await seedLoan(admin.id, book.id)
    await seedLoan(student.id, lostOnly.id, { status: 'lost' })
    expect(await buildRecommendationPayload()).toBeNull()

    // And one real interaction makes a payload.
    await seedLoan(student.id, book.id)
    expect(await buildRecommendationPayload()).not.toBeNull()
  })
})
