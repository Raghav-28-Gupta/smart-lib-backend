import { beforeEach, describe, expect, it } from 'vitest'
import { FINE_PER_DAY_INR } from '../../src/config/constants'
import { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { accruingAmountSql, overdueFineAmount } from '../../src/services/fineRules'
import { resetDb } from '../helpers/db'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('overdueFineAmount', () => {
  const at = new Date()

  it('0 before and exactly at the due time', () => {
    expect(overdueFineAmount(new Date(at.getTime() + 2 * HOUR), at)).toBe(0)
    expect(overdueFineAmount(at, at)).toBe(0)
  })

  it('0 for 23h59m late', () => {
    expect(overdueFineAmount(new Date(at.getTime() - (23 * HOUR + 59 * 60 * 1000)), at)).toBe(0)
  })

  it('10 for exactly one day late', () => {
    expect(overdueFineAmount(new Date(at.getTime() - DAY), at)).toBe(10)
  })

  it('30 for 3 days and 5 hours late', () => {
    expect(overdueFineAmount(new Date(at.getTime() - (3 * DAY + 5 * HOUR)), at)).toBe(30)
  })
})

describe('accruingAmountSql', () => {
  beforeEach(resetDb)

  // Loan.dueAt is a plain timestamp(3), not timestamptz, so this runs the SQL
  // against real Loan rows: the comparison with a bound JS Date has to land on
  // the same whole-day count as overdueFineAmount.
  async function seedLoansDue(dueAts: Date[]) {
    const user = await prisma.user.create({ data: { name: 'Reader', email: 'reader@test.com', passwordHash: 'x' } })
    const book = await prisma.book.create({
      data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: 1 },
    })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
    for (const dueAt of dueAts) {
      await prisma.loan.create({ data: { userId: user.id, bookCopyId: copy.id, dueAt } })
    }
  }

  async function sqlAmounts(now: Date): Promise<Map<number, number>> {
    const rows = await prisma.$queryRaw<Array<{ dueAt: Date; amount: number }>>(Prisma.sql`
      SELECT l."dueAt", ${accruingAmountSql(now, Prisma.sql`l."dueAt"`)} AS amount
      FROM "Loan" l`)
    return new Map(rows.map((row) => [row.dueAt.getTime(), row.amount]))
  }

  it('agrees with overdueFineAmount', async () => {
    const now = new Date()
    const dueAts = [
      new Date(now.getTime() + 2 * HOUR),
      now,
      new Date(now.getTime() - 1),
      new Date(now.getTime() - (23 * HOUR + 59 * 60 * 1000)),
      new Date(now.getTime() - DAY),
      new Date(now.getTime() - (DAY + 1)),
      new Date(now.getTime() - (3 * DAY + 5 * HOUR)),
      new Date(now.getTime() - 100 * DAY),
    ]
    await seedLoansDue(dueAts)

    const amounts = await sqlAmounts(now)

    expect(amounts.size).toBe(dueAts.length)
    for (const dueAt of dueAts) {
      expect(amounts.get(dueAt.getTime()), `due ${now.getTime() - dueAt.getTime()} ms ago`).toBe(overdueFineAmount(dueAt, now))
    }
    expect(overdueFineAmount(dueAts[6], now)).toBe(3 * FINE_PER_DAY_INR)
  })

  it('agrees when the database session is not on UTC', async () => {
    const now = new Date()
    const dueAts = [new Date(now.getTime() - DAY), new Date(now.getTime() - (DAY - 1)), new Date(now.getTime() + 5 * HOUR)]
    await seedLoansDue(dueAts)

    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
      return tx.$queryRaw<Array<{ dueAt: Date; amount: number }>>(Prisma.sql`
        SELECT l."dueAt", ${accruingAmountSql(now, Prisma.sql`l."dueAt"`)} AS amount
        FROM "Loan" l`)
    })

    expect(rows).toHaveLength(dueAts.length)
    for (const row of rows) {
      expect(row.amount, `due ${now.getTime() - row.dueAt.getTime()} ms ago`).toBe(overdueFineAmount(row.dueAt, now))
    }
  })
})
