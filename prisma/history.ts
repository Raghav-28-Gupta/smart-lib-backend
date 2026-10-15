// Four weeks of past library activity for the seed, so the admin Dashboard
// has history to show. Pure and deterministic: the same `today` and random
// sequence always give the same rows. Everything ends before today, so
// nothing collides with the seed's "taken slots today", with the student
// app's fixtures, or with anything booked from now on. Only the seed
// students own these rows; the demo student's account is untouched.
import { LOAN_PERIOD_DAYS, TIME_SLOTS } from '../src/config/constants'

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
  userId: string
  bookCopyId: string
  borrowedAt: Date
  dueAt: Date
  returnedAt: Date | null
  status: 'active' | 'returned'
}

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_IN_RATE = 0.8

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
): { bookings: HistoryBooking[]; loans: HistoryLoan[] } {
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

  const makeLoan = (day: Date): HistoryLoan => {
    const book = pickBook()
    const userId = pick(inputs.studentIds)
    const borrowedAt = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(), 10 + Math.floor(random() * 8), Math.floor(random() * 60),
    )
    const dueAt = new Date(borrowedAt.getTime() + LOAN_PERIOD_DAYS * DAY_MS)
    const roll = random()
    let returnedAt: Date | null =
      roll < 0.75
        ? new Date(borrowedAt.getTime() + (3 + Math.floor(random() * 11)) * DAY_MS) // on time: 3-13 days
        : roll < 0.9
          ? new Date(borrowedAt.getTime() + (15 + Math.floor(random() * 4)) * DAY_MS) // late: 15-18 days
          : null
    if (returnedAt && returnedAt >= midnight) returnedAt = null // not back yet
    if (returnedAt === null) {
      const copy = freeCopies.get(book.id)?.shift()
      if (copy) return { userId, bookCopyId: copy, borrowedAt, dueAt, returnedAt: null, status: 'active' }
      // No borrowed copy is free to carry an open loan, so record it as returned.
      returnedAt = new Date(Math.min(borrowedAt.getTime() + 7 * DAY_MS, midnight.getTime() - 60 * 60 * 1000))
    }
    const index = nextCopy.get(book.id) ?? 0
    nextCopy.set(book.id, index + 1)
    return { userId, bookCopyId: book.copyIds[index % book.copyIds.length], borrowedAt, dueAt, returnedAt, status: 'returned' }
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
    for (let i = 0; i < borrows; i++) loans.push(makeLoan(day))
  }
  return { bookings, loans }
}
