import { describe, expect, it } from 'vitest'
import { generateHistory, HISTORY_SEED, mulberry32, type HistoryInputs } from '../../prisma/history'

const TODAY = new Date(2026, 9, 15, 13, 0)
const MIDNIGHT = new Date(2026, 9, 15)
const DAY_MS = 24 * 60 * 60 * 1000

const INPUTS: HistoryInputs = {
  studentIds: ['st1', 'st2', 'st3', 'st4', 'st5', 'st6'],
  resources: [
    { id: 's1', type: 'seat' }, { id: 's2', type: 'seat' }, { id: 's3', type: 'seat' }, { id: 's4', type: 'seat' },
    { id: 'r1', type: 'room' }, { id: 'r2', type: 'room' }, { id: 'r3', type: 'room' },
  ],
  books: Array.from({ length: 12 }, (_, i) => ({
    id: `b${i + 1}`,
    copyIds: [`b${i + 1}-c1`, `b${i + 1}-c2`, `b${i + 1}-c3`],
    borrowedCopyIds: i % 3 === 0 ? [`b${i + 1}-c2`] : [],
  })),
  popularity: { b1: 6, b8: 5, b3: 4 },
}

const run = () => generateHistory(TODAY, mulberry32(HISTORY_SEED), INPUTS)

describe('generateHistory', () => {
  it('is deterministic for the same day and seed', () => {
    expect(run()).toEqual(run())
  })

  it('dates nothing today or later', () => {
    const { bookings, loans } = run()
    for (const b of bookings) expect(b.endTime.getTime()).toBeLessThanOrEqual(MIDNIGHT.getTime())
    for (const l of loans) {
      expect(l.borrowedAt.getTime()).toBeLessThan(MIDNIGHT.getTime())
      if (l.returnedAt) expect(l.returnedAt.getTime()).toBeLessThan(MIDNIGHT.getTime())
    }
  })

  it('never double-books a resource or a student', () => {
    const { bookings } = run()
    const resourceSlots = new Set<string>()
    const studentSlots = new Set<string>()
    for (const b of bookings) {
      const r = `${b.resourceId}@${b.startTime.getTime()}`
      const s = `${b.userId}@${b.startTime.getTime()}`
      expect(resourceSlots.has(r)).toBe(false)
      expect(studentSlots.has(s)).toBe(false)
      resourceSlots.add(r)
      studentSlots.add(s)
      expect(b.endTime.getTime() - b.startTime.getTime()).toBe(60 * 60 * 1000)
    }
  })

  it('checks in only checked-in bookings, within 10 minutes of the start', () => {
    for (const b of run().bookings) {
      if (b.status === 'checked_in') {
        expect(b.checkedInAt).not.toBeNull()
        const late = b.checkedInAt!.getTime() - b.startTime.getTime()
        expect(late).toBeGreaterThanOrEqual(0)
        expect(late).toBeLessThanOrEqual(10 * 60 * 1000)
      } else {
        expect(b.checkedInAt).toBeNull()
      }
    }
  })

  it('keeps loans consistent: 14-day due dates, returns after borrows, open loans on free borrowed copies', () => {
    const free = new Set(INPUTS.books.flatMap((b) => b.borrowedCopyIds))
    const used = new Set<string>()
    for (const l of run().loans) {
      expect(l.dueAt.getTime() - l.borrowedAt.getTime()).toBe(14 * DAY_MS)
      if (l.returnedAt) {
        expect(l.status).toBe('returned')
        expect(l.returnedAt.getTime()).toBeGreaterThan(l.borrowedAt.getTime())
      } else {
        expect(l.status).toBe('active')
        expect(free.has(l.bookCopyId)).toBe(true)
        expect(used.has(l.bookCopyId)).toBe(false)
        used.add(l.bookCopyId)
      }
    }
  })

  it('produces a believable volume: 600-900 bookings, about 1 in 5 missed, 40-60 loans', () => {
    const { bookings, loans } = run()
    expect(bookings.length).toBeGreaterThanOrEqual(600)
    expect(bookings.length).toBeLessThanOrEqual(900)
    const missed = bookings.filter((b) => b.status === 'booked').length / bookings.length
    expect(missed).toBeGreaterThan(0.1)
    expect(missed).toBeLessThan(0.3)
    expect(loans.length).toBeGreaterThanOrEqual(40)
    expect(loans.length).toBeLessThanOrEqual(60)
  })
})
