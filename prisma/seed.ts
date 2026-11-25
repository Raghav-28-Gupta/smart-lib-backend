// The seed's command line: `npm run seed`. It builds a client from
// DATABASE_URL, runs prisma/seedData.ts's runSeed() and prints what it made.
// What gets seeded, and what a re-seed resets and never touches, is written up
// at the top of seedData.ts and in the README's "Seed data" section.
import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { runSeed } from './seedData'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function main() {
  const summary = await runSeed(prisma)
  // eslint-disable-next-line no-console
  console.log(`Seeded ${summary.books} books, ${summary.resources} resources, and ${summary.users} users.`)
  // eslint-disable-next-line no-console
  console.log(`Demo login: ${summary.demoEmail} / ${summary.demoPassword}`)
  // eslint-disable-next-line no-console
  console.log(`Generated ${summary.bookings} past bookings and ${summary.loans} past loans for the seed students.`)
  const by = summary.finesByStatus
  // eslint-disable-next-line no-console
  console.log(
    `Generated ${summary.fines} fines on the late returns (${by.pending} outstanding, ${by.paid} paid, ${by.adjusted} adjusted, ${by.waived} waived).`,
  )
  // eslint-disable-next-line no-console
  console.log(`Opened ${summary.disputes} fine disputes and ${summary.reports} problem reports for Needs attention.`)
  // eslint-disable-next-line no-console
  console.log(
    `Recorded ${summary.noShows} past no-shows (one disputable by ${summary.demoEmail}) and opened ${summary.noShowDisputes} no-show disputes for Needs attention.`,
  )
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
