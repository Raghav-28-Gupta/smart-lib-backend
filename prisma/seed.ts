// Seeds the database so a live demo matches the frontend's mock UI exactly:
// the same 12 books, 4 seats, 3 rooms, and demo user the frontend was built
// and screenshotted against (see book_repository.dart, booking_repository.dart,
// auth_repository.dart, loan_repository.dart, profile_repository.dart).
//
// Safe to re-run: deletes only the rows this script owns (matched by the
// fixed seed ids/emails below) before recreating them, so it won't touch
// anything a developer created through the live API separately. It does
// assume a migrated, otherwise-empty-of-these-ids database.
//
// Deliberately NOT reproduced: the booking mock's own pre-seeded bookings for
// its demo user reference a resource ("Desk 4") that doesn't exist among the
// seeded seats, and any personal bookings for Aditi would risk colliding with
// the "taken slots today" bookings seeded below for the same resources.
// Booking a resource is easy enough to demo live instead.
import 'dotenv/config'
import bcrypt from 'bcrypt'
import { PrismaPg } from '@prisma/adapter-pg'
import { TIME_SLOTS } from '../src/config/constants'
import { PrismaClient } from '../src/generated/prisma/client'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const DEMO_PASSWORD = 'password123'

const SEED_BOOK_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12']
const SEED_RESOURCE_IDS = ['s1', 's2', 's3', 's4', 'r1', 'r2', 'r3']
const SEED_STUDENT_EMAILS = Array.from({ length: 6 }, (_, i) => `seed.student${i + 1}@thapar.edu`)
const DEMO_EMAIL = 'aditi.sharma@thapar.edu'
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
  { id: 'r1', type: 'room' as const, name: 'Group Room 201 · 4 seats', location: null, capacity: 4, taken: ['2:00 PM', '3:00 PM'] },
  { id: 'r2', type: 'room' as const, name: 'Group Room 202 · 6 seats', location: null, capacity: 6, taken: TIME_SLOTS.map((s) => s.label) },
  { id: 'r3', type: 'room' as const, name: 'Discussion Pod 1 · 2 seats', location: null, capacity: 2, taken: ['10:00 AM', '11:00 AM'] },
]

// Mirrors loan_repository.dart's MockLoanRepository exactly, including
// loan3's fineAmount (3 days × ₹10/day) and loan4's waitlist-blocked renewal.
const DEMO_LOANS = [
  { bookId: 'b1', dueInDays: 8 },
  { bookId: 'b3', dueInDays: 2 },
  { bookId: 'b4', dueInDays: -3 }, // overdue
  { bookId: 'b8', dueInDays: 5 }, // waitlisted -- blocks renewal
] as const

async function deleteExistingSeedData() {
  const existingUsers = await prisma.user.findMany({ where: { email: { in: SEED_USER_EMAILS } }, select: { id: true } })
  const userIds = existingUsers.map((u) => u.id)

  await prisma.fine.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.resourceBooking.deleteMany({ where: { resourceId: { in: SEED_RESOURCE_IDS } } })
  await prisma.reliabilityScoreLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.recommendationCache.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.reservation.deleteMany({ where: { bookId: { in: SEED_BOOK_IDS } } })
  await prisma.loan.deleteMany({ where: { bookCopy: { bookId: { in: SEED_BOOK_IDS } } } })
  await prisma.bookCopy.deleteMany({ where: { bookId: { in: SEED_BOOK_IDS } } })
  await prisma.resource.deleteMany({ where: { id: { in: SEED_RESOURCE_IDS } } })
  await prisma.book.deleteMany({ where: { id: { in: SEED_BOOK_IDS } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function main() {
  await deleteExistingSeedData()

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

  for (const b of BOOKS) {
    await prisma.book.create({
      data: { id: b.id, isbn: `978-seed-${b.id}`, title: b.title, author: b.author, genre: b.genre, description: b.description, totalCopies: b.totalCopies },
    })

    const demoLoan = DEMO_LOANS.find((l) => l.bookId === b.id)
    const borrowedCount = b.totalCopies - b.availableCopies
    for (let i = 0; i < b.totalCopies; i++) {
      const isBorrowed = i < borrowedCount
      const copy = await prisma.bookCopy.create({ data: { bookId: b.id, status: isBorrowed ? 'borrowed' : 'available' } })
      // The first borrowed copy of a book that's in DEMO_LOANS is the one
      // Aditi holds; any other borrowed copies are left without a Loan row
      // since the mock has no data on who else holds them.
      if (isBorrowed && demoLoan && i === 0) {
        const dueAt = new Date(Date.now() + demoLoan.dueInDays * 24 * 60 * 60 * 1000)
        const borrowedAt = new Date(dueAt.getTime() - 14 * 24 * 60 * 60 * 1000)
        await prisma.loan.create({ data: { userId: demoUser.id, bookCopyId: copy.id, borrowedAt, dueAt } })
      }
    }

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

  const today = new Date()
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

  // eslint-disable-next-line no-console
  console.log(`Seeded ${BOOKS.length} books, ${RESOURCES.length} resources, and ${1 + seedStudents.length} users.`)
  // eslint-disable-next-line no-console
  console.log(`Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
