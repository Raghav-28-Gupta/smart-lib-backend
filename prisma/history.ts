// Four weeks of past library activity for the seed, so the admin Dashboard
// has history to show. Pure and deterministic: the same `today` and random
// sequence always give the same rows. Everything ends before today, so
// nothing collides with the seed's "taken slots today", with the student
// app's fixtures, or with anything booked from now on. Only the seed
// students own these rows; the demo student's account is untouched.
//
// Each late return also gets its overdue fine, so the admin Fines page has
// every state to show. Seeded fines name no librarian: nobody recorded the
// payments or made the adjustments.
import { LOAN_PERIOD_DAYS, TIME_SLOTS } from '../src/config/constants'
import { overdueFineAmount } from '../src/services/fineRules'

export const HISTORY_DAYS = 28
export const HISTORY_SEED = 20261015

export interface HistoryInputs {
  /** The seed students who own every generated row. */
  studentIds: string[]
  resources: { id: string; type: 'seat' | 'room' }[]
  /** Each book's copies, and which of them are 'borrowed' with no loan behind them. */
  books: { id: string; copyIds: string[]; borrowedCopyIds: string[] }[]
  /** Relative chance of each book being borrowed; unlisted books weigh 1. */
  popularity: Record<string, number>
}

export interface HistoryBooking {
  userId: string
  resourceId: string
  startTime: Date
  endTime: Date
  status: 'booked' | 'checked_in'
  checkedInAt: Date | null
}

export interface HistoryLoan {
  /** `hist-loan-<n>`, so the output is comparable between runs and the fines can point at it. */
  id: string
  userId: string
  bookCopyId: string
  borrowedAt: Date
  dueAt: Date
  returnedAt: Date | null
  status: 'active' | 'returned'
}

/** An overdue fine the way the console leaves it: the columns a librarian would have set, minus the librarian. */
export interface HistoryFine {
  userId: string
  relatedLoanId: string
  amount: number
  reason: 'overdue'
  /** When the loan came back late. */
  createdAt: Date
  status: 'pending' | 'paid' | 'waived' | 'adjusted'
  paidAt: Date | null
  /** What the fine was before it was lowered or waived; null when never adjusted. */
  originalAmount: number | null
  adjustedAt: Date | null
  adjustReason: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_IN_RATE = 0.8
// Where a loan's single roll lands: below ON_TIME_BELOW it comes back on time,
// below LATE_BELOW it comes back late, above that it is still out. The on-time
// and late branches each draw exactly one more random number and the still-out
// branch none, so moving ON_TIME_BELOW changes which loans are late without
// shifting the random stream: the bookings are identical either way.
const ON_TIME_BELOW = 0.6
const LATE_BELOW = 0.9
const WAIVE_REASON = 'First late return'
const ADJUST_REASON = 'Returned during exam week'

/** mulberry32: a small seeded PRNG, so the seed's history is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Chance a resource is booked in a slot: weekday afternoons busiest, rooms peak 2-4 PM, weekends quieter. */
export function occupancy(type: 'seat' | 'room', weekday: number, hour: number): number {
  const weekend = weekday === 0 || weekday === 6
  let p = weekend ? 0.16 : 0.32
  if (hour >= 13 && hour <= 17) p += 0.25
  if (hour >= 18) p -= 0.1
  if (type === 'room' && (hour === 14 || hour === 15)) p += 0.25
  return Math.min(0.95, Math.max(0.05, p))
}

export function generateHistory(
  today: Date,
  random: () => number,
  inputs: HistoryInputs,
): { bookings: HistoryBooking[]; loans: HistoryLoan[]; fines: HistoryFine[] } {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]

  const weights = inputs.books.map((b) => inputs.popularity[b.id] ?? 1)
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  const pickBook = () => {
    let r = random() * totalWeight
    for (let i = 0; i < inputs.books.length; i++) {
      r -= weights[i]
      if (r < 0) return inputs.books[i]
    }
    return inputs.books[inputs.books.length - 1]
  }
  const freeCopies = new Map(inputs.books.map((b) => [b.id, [...b.borrowedCopyIds]]))
  const nextCopy = new Map<string, number>()

  const makeLoan = (day: Date, id: string): HistoryLoan => {
    const book = pickBook()
    const userId = pick(inputs.studentIds)
    const borrowedAt = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(), 10 + Math.floor(random() * 8), Math.floor(random() * 60),
    )
    const dueAt = new Date(borrowedAt.getTime() + LOAN_PERIOD_DAYS * DAY_MS)
    const roll = random()
    let returnedAt: Date | null =
      roll < ON_TIME_BELOW
        ? new Date(borrowedAt.getTime() + (3 + Math.floor(random() * 11)) * DAY_MS) // on time: 3-13 days
        : roll < LATE_BELOW
          ? new Date(borrowedAt.getTime() + (15 + Math.floor(random() * 4)) * DAY_MS) // late: 15-18 days
          : null
    if (returnedAt && returnedAt >= midnight) returnedAt = null // not back yet
    if (returnedAt === null) {
      const copy = freeCopies.get(book.id)?.shift()
      if (copy) return { id, userId, bookCopyId: copy, borrowedAt, dueAt, returnedAt: null, status: 'active' }
      // No borrowed copy is free to carry an open loan, so record it as returned.
      returnedAt = new Date(Math.min(borrowedAt.getTime() + 7 * DAY_MS, midnight.getTime() - 60 * 60 * 1000))
    }
    const index = nextCopy.get(book.id) ?? 0
    nextCopy.set(book.id, index + 1)
    return { id, userId, bookCopyId: book.copyIds[index % book.copyIds.length], borrowedAt, dueAt, returnedAt, status: 'returned' }
  }

  const bookings: HistoryBooking[] = []
  const loans: HistoryLoan[] = []
  for (let back = HISTORY_DAYS; back >= 1; back--) {
    const day = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - back)
    for (const slot of TIME_SLOTS) {
      const busy = new Set<string>() // students already booked in this slot
      for (const resource of inputs.resources) {
        if (random() >= occupancy(resource.type, day.getDay(), slot.hour)) continue
        const free = inputs.studentIds.filter((id) => !busy.has(id))
        if (free.length === 0) continue
        const userId = pick(free)
        busy.add(userId)
        const startTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour)
        const endTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour + 1)
        const checkedIn = random() < CHECK_IN_RATE
        bookings.push({
          userId,
          resourceId: resource.id,
          startTime,
          endTime,
          status: checkedIn ? 'checked_in' : 'booked',
          checkedInAt: checkedIn ? new Date(startTime.getTime() + Math.floor(random() * 11) * 60_000) : null,
        })
      }
    }
    const weekend = day.getDay() === 0 || day.getDay() === 6
    const borrows = weekend ? (random() < 0.4 ? 1 : 0) : 2 + Math.floor(random() * 2)
    for (let i = 0; i < borrows; i++) loans.push(makeLoan(day, `hist-loan-${loans.length + 1}`))
  }
  return { bookings, loans, fines: generateFines(loans, midnight, random) }
}

/**
 * How many of the newest fines are never settled: the seed opens a dispute on each
 * (seedData.ts imports this, and refuses a plan with more disputes than it).
 */
export const OUTSTANDING_NEWEST = 2

/**
 * One overdue fine per loan returned after its due date, then a few settled so
 * every filter on the Fines page has something: a waived and a lowered example,
 * the older ones paid, and the two newest left outstanding. Three loans in ten
 * come back late, which gives five to eleven fines depending on the weekday:
 * enough for every status each day (one paid of five fines, six of eleven).
 * With fewer fines the older ones settle in the same order: three fines give the
 * two outstanding and the waived one, four add the lowered one, and the first
 * paid one appears at five.
 *
 * The statuses are decided after the bookings and loans, from the end of the
 * same random stream, so they never move the rows generated before them.
 */
export function generateFines(loans: HistoryLoan[], midnight: Date, random: () => number): HistoryFine[] {
  const fines: HistoryFine[] = []
  for (const loan of loans) {
    if (!loan.returnedAt) continue
    const amount = overdueFineAmount(loan.dueAt, loan.returnedAt)
    if (amount <= 0) continue
    fines.push({
      userId: loan.userId,
      relatedLoanId: loan.id,
      amount,
      reason: 'overdue',
      createdAt: loan.returnedAt,
      status: 'pending',
      paidAt: null,
      originalAmount: null,
      adjustedAt: null,
      adjustReason: null,
    })
  }

  // Settle the oldest returns first, and only ones old enough that the payment
  // or adjustment (1-3 days after the return) still falls before today.
  const daysBeforeToday = (f: HistoryFine) => Math.ceil((midnight.getTime() - f.createdAt.getTime()) / DAY_MS) - 1
  const oldestFirst = [...fines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  // The newest two always stay outstanding: the ones a librarian can act on, and the
  // ones the seed disputes. Settling takes the oldest first, so it never reaches them.
  const settleCount = Math.max(0, Math.min(fines.length - OUTSTANDING_NEWEST, Math.round(fines.length / 2) + 2))
  const settled = oldestFirst.filter((f) => daysBeforeToday(f) >= 1).slice(0, settleCount)

  // A waived and a lowered example, the rest paid, dealt out in random order.
  const kinds: ('waived' | 'adjusted' | 'paid')[] = settled.map((_, i) => (i === 0 ? 'waived' : i === 1 ? 'adjusted' : 'paid'))
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
  }

  settled.forEach((fine, i) => {
    const owed = fine.amount
    const days = 1 + Math.floor(random() * Math.min(3, daysBeforeToday(fine)))
    const at = new Date(fine.createdAt.getTime() + days * DAY_MS)
    if (kinds[i] === 'paid') {
      fine.status = 'paid'
      fine.paidAt = at
    } else {
      // The same columns the console sets when a librarian lowers or waives a fine (a waive is a lowering to nothing).
      const waived = kinds[i] === 'waived'
      fine.status = waived ? 'waived' : 'adjusted'
      fine.amount = waived ? 0 : Math.max(1, Math.floor(owed / 2))
      fine.originalAmount = owed
      fine.adjustedAt = at
      fine.adjustReason = waived ? WAIVE_REASON : ADJUST_REASON
    }
  })
  return fines
}
