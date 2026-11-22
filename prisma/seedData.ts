// Seeds the database so a live demo matches the frontend's mock UI exactly:
// the same 12 books, 4 seats, 3 rooms, and demo user the frontend was built
// and screenshotted against (see book_repository.dart, booking_repository.dart,
// auth_repository.dart, loan_repository.dart, profile_repository.dart).
//
// This file is the seed's work, as runSeed(); prisma/seed.ts is the thin CLI
// around it, and test/seed/reseed.test.ts calls it against the test database.
//
// Re-runnable: it resets the seeded books, resources and seed accounts (the
// fixed ids/emails below) before recreating them. The reset takes every loan,
// borrow request, booking, waitlist entry and fine on those books and
// resources with it, including ones made through the live API or the admin
// console, and the seed accounts' own rows on any other book or resource.
// Books, copies and resources a librarian added, and other students' rows on
// them, are left alone, so a re-seed after console use succeeds; see
// resetSeedData() for the order. It assumes a migrated database.
//
// It also generates four weeks of past bookings and loans for the six seed
// students (prisma/history.ts), ending yesterday, so the admin Dashboard has
// history to show, and an overdue fine for each late return, some paid, some
// adjusted or waived (naming no librarian), so the Fines page has every state
// to show. The demo student's account gets none of it.
//
// Deliberately NOT reproduced: the booking mock's own pre-seeded bookings for
// its demo user reference a resource ("Desk 4") that doesn't exist among the
// seeded seats, and any personal bookings for Aditi would risk colliding with
// the "taken slots today" bookings seeded below for the same resources.
// Booking a resource is easy enough to demo live instead.
import bcrypt from 'bcrypt'
import { TIME_SLOTS } from '../src/config/constants'
import type { Prisma, PrismaClient } from '../src/generated/prisma/client'
import { generateHistory, HISTORY_SEED, mulberry32 } from './history'

export const DEMO_PASSWORD = 'password123'

export const SEED_BOOK_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12']
export const SEED_RESOURCE_IDS = ['s1', 's2', 's3', 's4', 'r1', 'r2', 'r3']
export const SEED_STUDENT_EMAILS = Array.from({ length: 6 }, (_, i) => `seed.student${i + 1}@thapar.edu`)
export const DEMO_EMAIL = 'aditi.sharma@thapar.edu'
const SEED_USER_EMAILS = [DEMO_EMAIL, ...SEED_STUDENT_EMAILS]

const BOOKS = [
  { id: 'b1', title: 'Introduction to Algorithms', author: 'Cormen, Leiserson, Rivest & Stein', genre: 'Algorithms', description: 'The standard reference on algorithm design and analysis — sorting, graph algorithms, dynamic programming, and NP-completeness, with rigorous proofs throughout.', totalCopies: 4, availableCopies: 1 },
  { id: 'b2', title: 'Operating System Concepts', author: 'Silberschatz, Galvin & Gagne', genre: 'Operating Systems', description: 'Process management, memory management, file systems, and concurrency — the core operating systems course text.', totalCopies: 3, availableCopies: 0, waitlistCount: 2 },
  { id: 'b3', title: 'Database System Concepts', author: 'Silberschatz, Korth & Sudarshan', genre: 'Databases', description: 'The relational model, SQL, normalization, transaction processing, and query optimization.', totalCopies: 5, availableCopies: 2 },
  { id: 'b4', title: 'Computer Networks', author: 'Andrew S. Tanenbaum', genre: 'Networks', description: 'A layer-by-layer treatment of network architecture, from the physical layer up through applications.', totalCopies: 3, availableCopies: 1 },
  { id: 'b5', title: 'Data Structures and Algorithms in Java', author: 'Robert Lafore', genre: 'Data Structures', description: 'Core data structures — trees, graphs, hash tables — built up from first principles with working Java code.', totalCopies: 6, availableCopies: 3 },
  { id: 'b6', title: 'Design Patterns', author: 'Gamma, Helm, Johnson & Vlissides', genre: 'Software Eng.', description: 'The classic catalog of object-oriented design patterns, from the Gang of Four.', totalCopies: 2, availableCopies: 0 },
  { id: 'b7', title: 'Artificial Intelligence: A Modern Approach', author: 'Russell & Norvig', genre: 'AI', description: 'A comprehensive survey of AI, from search and logic through machine learning.', totalCopies: 3, availableCopies: 1 },
  { id: 'b8', title: 'Clean Code', author: 'Robert C. Martin', genre: 'Software Eng.', description: 'Practical guidance on writing maintainable code, with before-and-after refactoring examples.', totalCopies: 4, availableCopies: 2, waitlistCount: 1 },
  { id: 'b9', title: 'The Midnight Library', author: 'Matt Haig', genre: 'Fiction', description: 'A novel about all the lives you could have lived, told through a library between life and death.', totalCopies: 2, availableCopies: 1 },
  { id: 'b10', title: 'Project Hail Mary', author: 'Andy Weir', genre: 'Fiction', description: "A lone astronaut wakes with no memory of his mission — or that humanity's survival depends on it.", totalCopies: 3, availableCopies: 0, waitlistCount: 4 },
  { id: 'b11', title: 'Sapiens', author: 'Yuval Noah Harari', genre: 'Non-fiction', description: 'A sweeping account of how Homo sapiens came to dominate the planet.', totalCopies: 2, availableCopies: 1 },
  { id: 'b12', title: 'Atomic Habits', author: 'James Clear', genre: 'Non-fiction', description: 'A practical framework for building good habits and breaking bad ones.', totalCopies: 3, availableCopies: 2 },
] as const

const RESOURCES = [
  { id: 's1', type: 'seat' as const, name: 'Reading Room A · Desk 12', location: 'Reading Room A', capacity: 1, taken: ['11:00 AM', '12:00 PM'] },
  { id: 's2', type: 'seat' as const, name: 'Reading Room A · Desk 14', location: 'Reading Room A', capacity: 1, taken: ['9:00 AM', '10:00 AM', '3:00 PM', '4:00 PM'] },
  { id: 's3', type: 'seat' as const, name: 'Silent Zone · Desk 3', location: 'Silent Zone', capacity: 1, taken: [] as string[] },
  { id: 's4', type: 'seat' as const, name: 'Silent Zone · Desk 7', location: 'Silent Zone', capacity: 1, taken: ['1:00 PM', '2:00 PM', '6:00 PM'] },
  { id: 'r1', type: 'room' as const, name: 'Group Room 201 · 4 seats', location: 'Group study rooms', capacity: 4, taken: ['2:00 PM', '3:00 PM'] },
  { id: 'r2', type: 'room' as const, name: 'Group Room 202 · 6 seats', location: 'Group study rooms', capacity: 6, taken: TIME_SLOTS.map((s) => s.label) },
  { id: 'r3', type: 'room' as const, name: 'Discussion Pod 1 · 2 seats', location: 'Discussion pods', capacity: 2, taken: ['10:00 AM', '11:00 AM'] },
]

// Mirrors loan_repository.dart's MockLoanRepository exactly, including
// loan3's fineAmount (3 days × ₹10/day) and loan4's waitlist-blocked renewal.
const DEMO_LOANS = [
  { bookId: 'b1', dueInDays: 8 },
  { bookId: 'b3', dueInDays: 2 },
  { bookId: 'b4', dueInDays: -3 }, // overdue
  { bookId: 'b8', dueInDays: 5 }, // waitlisted -- blocks renewal
] as const

// Relative borrow weights for the generated history, so a few titles stand
// out on the admin Dashboard. Books not listed weigh 1.
const BOOK_POPULARITY: Record<string, number> = { b1: 6, b8: 5, b3: 4, b2: 3, b4: 3, b12: 3, b5: 2, b7: 2, b9: 2, b11: 2 }

export interface SeedSummary {
  books: number
  resources: number
  /** The demo student plus the seed students. */
  users: number
  bookings: number
  loans: number
  fines: number
  finesByStatus: { pending: number; paid: number; adjusted: number; waived: number }
  demoEmail: string
  demoPassword: string
}

/**
 * Puts the demo books, resources and seed accounts back to nothing, and takes
 * with them every row that points at them, in an order that never leaves a
 * foreign key dangling. All of it runs in one transaction, so a failure
 * part-way leaves the database as it was.
 *
 * Gone: the demo books and every copy of them (including copies a librarian
 * added), the demo resources, the seed accounts, and every loan, borrow
 * request, fine, waitlist entry, booking, recommendation and no-show record
 * that belongs to a seed account or sits on a demo book or resource, other
 * students' included.
 *
 * Kept: books and resources a librarian added, their copies, and other
 * students' rows on them. The one change to those: a copy of such a book that
 * a seed account held (through a pending borrow request or an open loan) goes
 * back to 'available' before the request or loan is deleted, so the book does
 * not keep a copy marked held or on loan with nobody behind it. A copy that is
 * lost or in maintenance stays as the librarian left it.
 */
async function resetSeedData(db: Prisma.TransactionClient) {
  const seedUsers = await db.user.findMany({ where: { email: { in: SEED_USER_EMAILS } }, select: { id: true } })
  const userIds = seedUsers.map((u) => u.id)
  const onDemoBook = { in: SEED_BOOK_IDS }
  const ownedBySeed = { in: userIds }

  // 1. Release copies of non-demo books that a seed account holds.
  await db.bookCopy.updateMany({
    where: {
      bookId: { notIn: SEED_BOOK_IDS },
      status: 'requested',
      borrowRequests: { some: { userId: ownedBySeed, status: 'pending' } },
    },
    data: { status: 'available' },
  })
  await db.bookCopy.updateMany({
    where: {
      bookId: { notIn: SEED_BOOK_IDS },
      status: 'borrowed',
      loans: { some: { userId: ownedBySeed, returnedAt: null, status: { in: ['active', 'overdue'] } } },
    },
    data: { status: 'available' },
  })

  // 2. Borrow requests point at copies, loans and users, so they go before all three.
  await db.borrowRequest.deleteMany({ where: { OR: [{ bookId: onDemoBook }, { userId: ownedBySeed }] } })

  // 3. No-show records point at bookings.
  await db.noShowEvent.deleteMany({
    where: {
      OR: [
        { userId: ownedBySeed },
        { resourceBooking: { OR: [{ resourceId: { in: SEED_RESOURCE_IDS } }, { userId: ownedBySeed }] } },
      ],
    },
  })

  // 4. Fines point at loans and bookings: every fine on a loan or booking about to
  // go is deleted first, so none is left without its item.
  await db.fine.deleteMany({
    where: {
      OR: [
        { userId: ownedBySeed },
        { relatedLoan: { OR: [{ bookCopy: { bookId: onDemoBook } }, { userId: ownedBySeed }] } },
        { relatedBooking: { OR: [{ resourceId: { in: SEED_RESOURCE_IDS } }, { userId: ownedBySeed }] } },
      ],
    },
  })

  // 5. Bookings on the seed resources, and the seed accounts' own bookings on any
  // resource: a student can book a resource the console added, and a librarian
  // can move a booking onto one, and ResourceBooking.userId restricts the user delete.
  await db.resourceBooking.deleteMany({ where: { OR: [{ resourceId: { in: SEED_RESOURCE_IDS } }, { userId: ownedBySeed }] } })
  await db.reliabilityScoreLog.deleteMany({ where: { userId: ownedBySeed } })

  // 6. Cached recommendations of a demo book would block the book's delete,
  // whoever they were made for.
  await db.recommendationCache.deleteMany({ where: { OR: [{ userId: ownedBySeed }, { bookId: onDemoBook }] } })
  await db.reservation.deleteMany({ where: { OR: [{ bookId: onDemoBook }, { userId: ownedBySeed }] } })
  await db.loan.deleteMany({ where: { OR: [{ bookCopy: { bookId: onDemoBook } }, { userId: ownedBySeed }] } })

  // 7. The demo catalogue itself, then the seed accounts.
  await db.bookCopy.deleteMany({ where: { bookId: onDemoBook } })
  await db.resource.deleteMany({ where: { id: { in: SEED_RESOURCE_IDS } } })
  await db.book.deleteMany({ where: { id: onDemoBook } })
  await db.user.deleteMany({ where: { id: ownedBySeed } })
}

export async function runSeed(prisma: PrismaClient, today: Date = new Date()): Promise<SeedSummary> {
  // Sixty seconds, not Prisma's five: it is about a dozen statements, over a network.
  await prisma.$transaction(resetSeedData, { timeout: 60_000, maxWait: 30_000 })

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10)
  const demoUser = await prisma.user.create({
    data: { id: 'u1', name: 'Aditi Sharma', email: DEMO_EMAIL, passwordHash, roll: '1024160143' },
  })
  const seedStudents = await Promise.all(
    SEED_STUDENT_EMAILS.map((email, i) =>
      prisma.user.create({ data: { name: `Seed Student ${i + 1}`, email, passwordHash } }),
    ),
  )
  const nextStudent = (() => {
    let i = 0
    return () => seedStudents[i++ % seedStudents.length]
  })()

  const copiesByBook: { id: string; copyIds: string[]; borrowedCopyIds: string[] }[] = []
  for (const b of BOOKS) {
    await prisma.book.create({
      data: { id: b.id, isbn: `978-seed-${b.id}`, title: b.title, author: b.author, genre: b.genre, description: b.description, totalCopies: b.totalCopies },
    })

    const demoLoan = DEMO_LOANS.find((l) => l.bookId === b.id)
    const borrowedCount = b.totalCopies - b.availableCopies
    const copies = { id: b.id, copyIds: [] as string[], borrowedCopyIds: [] as string[] }
    for (let i = 0; i < b.totalCopies; i++) {
      const isBorrowed = i < borrowedCount
      // The barcode is the database's default (next_copy_barcode()), so it comes from the same sequence as any copy a librarian adds.
      const copy = await prisma.bookCopy.create({ data: { bookId: b.id, status: isBorrowed ? 'borrowed' : 'available' } })
      copies.copyIds.push(copy.id)
      // A borrowed copy with no loan behind it can carry one of the history's open loans.
      if (isBorrowed && !(demoLoan && i === 0)) copies.borrowedCopyIds.push(copy.id)
      // The first borrowed copy of a book that's in DEMO_LOANS is the one
      // Aditi holds; any other borrowed copies are left without a Loan row
      // since the mock has no data on who else holds them.
      if (isBorrowed && demoLoan && i === 0) {
        const dueAt = new Date(today.getTime() + demoLoan.dueInDays * 24 * 60 * 60 * 1000)
        const borrowedAt = new Date(dueAt.getTime() - 14 * 24 * 60 * 60 * 1000)
        await prisma.loan.create({ data: { userId: demoUser.id, bookCopyId: copy.id, borrowedAt, dueAt } })
      }
    }
    copiesByBook.push(copies)

    const waitlistCount = 'waitlistCount' in b ? b.waitlistCount : 0
    for (let i = 0; i < waitlistCount; i++) {
      await prisma.reservation.create({ data: { userId: nextStudent().id, bookId: b.id, status: 'waiting' } })
    }
  }

  // Overdue loan (b4) plus the reliability dip it causes -- mirrors
  // profile_repository.dart's "Building back up" 50% scenario for u1.
  await prisma.user.update({ where: { id: demoUser.id }, data: { reliabilityScore: 50 } })
  await prisma.reliabilityScoreLog.create({
    data: { userId: demoUser.id, score: 50, delta: -50, reason: 'Missed check-in window for a Group Room 201 booking' },
  })

  for (const r of RESOURCES) {
    await prisma.resource.create({ data: { id: r.id, type: r.type, name: r.name, location: r.location, capacity: r.capacity } })
    for (const label of r.taken) {
      const slot = TIME_SLOTS.find((s) => s.label === label)
      if (!slot) continue
      const startTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), slot.hour, 0, 0)
      const endTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), slot.hour + 1, 0, 0)
      await prisma.resourceBooking.create({ data: { userId: nextStudent().id, resourceId: r.id, startTime, endTime } })
    }
  }

  const history = generateHistory(today, mulberry32(HISTORY_SEED), {
    studentIds: seedStudents.map((s) => s.id),
    resources: RESOURCES.map((r) => ({ id: r.id, type: r.type })),
    books: copiesByBook,
    popularity: BOOK_POPULARITY,
  })
  await prisma.resourceBooking.createMany({ data: history.bookings })
  await prisma.loan.createMany({ data: history.loans })
  // After the loans: every fine points at one of them.
  await prisma.fine.createMany({ data: history.fines })

  const finesByStatus = { pending: 0, paid: 0, adjusted: 0, waived: 0 }
  for (const f of history.fines) finesByStatus[f.status]++
  return {
    books: BOOKS.length,
    resources: RESOURCES.length,
    users: 1 + seedStudents.length,
    bookings: history.bookings.length,
    loans: history.loans.length,
    fines: history.fines.length,
    finesByStatus,
    demoEmail: DEMO_EMAIL,
    demoPassword: DEMO_PASSWORD,
  }
}
