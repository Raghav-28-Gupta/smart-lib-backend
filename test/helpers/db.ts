import { prisma } from '../../src/lib/prisma'

// Table order doesn't matter here — TRUNCATE ... CASCADE clears dependent
// rows too. Call this in a beforeEach so every test starts from a clean,
// known-empty database.
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "NoShowEvent", "Fine", "ReliabilityScoreLog", "RecommendationCache",
      "ResourceBooking", "Resource", "Reservation", "Loan", "BookCopy",
      "Book", "User"
    RESTART IDENTITY CASCADE
  `)
}
