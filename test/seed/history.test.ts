import { describe, expect, it } from 'vitest'
import { generateFines, generateHistory, HISTORY_SEED, mulberry32, type HistoryInputs, type HistoryLoan } from '../../prisma/history'
import { overdueFineAmount } from '../../src/services/fineRules'

const TODAY = new Date(2026, 9, 15, 13, 0)
// The midnight that starts TODAY, derived from it rather than written out a second time.
const MIDNIGHT = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate())
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

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
    const missed = bookings.filter((b) => b.status === 'no_show').length / bookings.length
    expect(missed).toBeGreaterThan(0.1)
    expect(missed).toBeLessThan(0.3)
    expect(loans.length).toBeGreaterThanOrEqual(40)
    expect(loans.length).toBeLessThanOrEqual(60)
  })

  it('writes every unattended booking as a no_show (none stays booked), each with an id and one plausible predicted probability', () => {
    const { bookings, noShows } = run()
    // Every history booking is over, so its final state is checked in or missed, never 'booked'.
    expect(new Set(bookings.map((b) => b.status as string))).toEqual(new Set(['checked_in', 'no_show']))
    expect(bookings.map((b) => b.id)).toEqual(bookings.map((_, i) => `hist-booking-${i + 1}`))
    const missed = bookings.filter((b) => b.status === 'no_show')
    // One record per no-show, in booking order, and a probability a model could have given a missed booking.
    expect(noShows.map((n) => n.bookingId)).toEqual(missed.map((b) => b.id))
    for (const n of noShows) {
      expect(n.predictedProbability).toBeGreaterThanOrEqual(0.25)
      expect(n.predictedProbability).toBeLessThanOrEqual(0.75)
    }
  })

  it('gives each loan a deterministic id, hist-loan-<n>', () => {
    const { loans } = run()
    expect(loans.map((l) => l.id)).toEqual(loans.map((_, i) => `hist-loan-${i + 1}`))
  })

  it('every late return has one overdue fine of the right amount', () => {
    const { loans, fines } = run()
    const late = loans.filter((l) => l.returnedAt && l.returnedAt.getTime() > l.dueAt.getTime())
    expect(late.length).toBeGreaterThan(0)
    // One fine per late return, and nothing owed for an on-time return or an open loan.
    expect(fines).toHaveLength(late.length)
    for (const loan of late) {
      const forLoan = fines.filter((f) => f.relatedLoanId === loan.id)
      expect(forLoan).toHaveLength(1)
      const [fine] = forLoan
      const owed = overdueFineAmount(loan.dueAt, loan.returnedAt!)
      expect(owed).toBeGreaterThan(0)
      expect(fine.userId).toBe(loan.userId)
      expect(fine.reason).toBe('overdue')
      expect(fine.createdAt).toEqual(loan.returnedAt)
      // Whatever its status, the fine started as what the late return owed.
      expect(fine.originalAmount ?? fine.amount).toBe(owed)
      if (fine.status === 'pending' || fine.status === 'paid') expect(fine.amount).toBe(owed)
    }
  })

  it('fines include paid, adjusted, waived and outstanding, with no librarian', () => {
    const { fines } = run()
    const byStatus = (status: string) => fines.filter((f) => f.status === status)
    expect(byStatus('paid').length).toBeGreaterThanOrEqual(1)
    expect(byStatus('adjusted').length).toBeGreaterThanOrEqual(1)
    expect(byStatus('waived').length).toBeGreaterThanOrEqual(1)
    // The seed opens a dispute on each of the two newest, so at least two stay outstanding.
    expect(byStatus('pending').length).toBeGreaterThanOrEqual(2)
    // About half are paid.
    expect(byStatus('paid').length / fines.length).toBeGreaterThan(0.25)
    expect(byStatus('paid').length / fines.length).toBeLessThan(0.75)

    for (const f of fines) {
      // Nobody is named: a fine has no recorder or adjuster field at all.
      expect(Object.keys(f).filter((k) => k.endsWith('ById'))).toEqual([])
      expect(f.createdAt.getTime()).toBeLessThan(MIDNIGHT.getTime())
    }
    for (const f of byStatus('paid')) {
      const days = (f.paidAt!.getTime() - f.createdAt.getTime()) / DAY_MS
      expect(days).toBeGreaterThanOrEqual(1)
      expect(days).toBeLessThanOrEqual(3)
      expect(f.paidAt!.getTime()).toBeLessThan(MIDNIGHT.getTime())
      expect([f.originalAmount, f.adjustedAt, f.adjustReason]).toEqual([null, null, null])
    }
    for (const f of byStatus('adjusted')) {
      // Looks like a fine the console lowered: the original kept, a lower whole-rupee amount, why and when.
      expect(f.originalAmount).not.toBeNull()
      expect(f.amount).toBeGreaterThan(0)
      expect(f.amount).toBeLessThan(f.originalAmount!)
      expect(Number.isInteger(f.amount)).toBe(true)
      expect(f.adjustReason).toBe('Returned during exam week')
      expect(f.adjustedAt!.getTime()).toBeGreaterThan(f.createdAt.getTime())
      expect(f.adjustedAt!.getTime()).toBeLessThan(MIDNIGHT.getTime())
      expect(f.paidAt).toBeNull()
    }
    for (const f of byStatus('waived')) {
      expect(f.amount).toBe(0)
      expect(f.originalAmount).toBeGreaterThan(0)
      expect(f.adjustReason).toBe('First late return')
      expect(f.adjustedAt!.getTime()).toBeGreaterThan(f.createdAt.getTime())
      expect(f.adjustedAt!.getTime()).toBeLessThan(MIDNIGHT.getTime())
      expect(f.paidAt).toBeNull()
    }
    for (const f of byStatus('pending')) {
      expect([f.paidAt, f.originalAmount, f.adjustedAt, f.adjustReason]).toEqual([null, null, null, null])
    }
  })

  it('still deterministic', () => {
    const a = run()
    const b = run()
    expect(a.fines.length).toBeGreaterThan(0)
    expect(b.fines).toEqual(a.fines)
    expect(b).toEqual(a)
  })

  it('every day of a week gives outstanding, paid, adjusted and waived fines, the two newest outstanding', () => {
    // The history depends on the date only through the weekday, so seven
    // consecutive days are every case there is.
    for (let ahead = 0; ahead < 7; ahead++) {
      const day = new Date()
      day.setDate(day.getDate() + ahead)
      const { loans, fines } = generateHistory(day, mulberry32(HISTORY_SEED), INPUTS)
      const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate())
      const count = (status: string) => fines.filter((f) => f.status === status).length

      // A late return is never left without its fine.
      expect(fines.length).toBe(loans.filter((l) => l.returnedAt && l.returnedAt > l.dueAt).length)
      // Five to eleven fines a day: enough to show every status with two left outstanding.
      expect(fines.length, day.toDateString()).toBeGreaterThanOrEqual(5)
      for (const status of ['pending', 'paid', 'adjusted', 'waived']) {
        expect(count(status), `${day.toDateString()}: ${status}`).toBeGreaterThanOrEqual(1)
      }
      expect(count('pending'), day.toDateString()).toBeGreaterThanOrEqual(2)
      // The two newest are outstanding: the seed disputes them.
      const newest = [...fines].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 2)
      expect(newest.map((f) => f.status), day.toDateString()).toEqual(['pending', 'pending'])
      // The rest are mostly paid: a fifth on the days with the fewest fines (one paid of five), up to three quarters.
      expect(count('paid') / fines.length).toBeGreaterThanOrEqual(0.2)
      expect(count('paid') / fines.length).toBeLessThanOrEqual(0.75)
      // Nothing is settled in the future.
      for (const f of fines) {
        for (const at of [f.paidAt, f.adjustedAt]) if (at) expect(at.getTime()).toBeLessThan(midnight.getTime())
      }
    }
  })
})

describe('generateFines', () => {
  // generateFines reads no clock: it is given the midnight that starts today, so any day will do, and this one is the real one.
  const now = new Date()
  const TODAY_MIDNIGHT = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  /** `n` loans returned late, the oldest first, each far enough back that its fine may be settled. */
  const lateLoans = (n: number): HistoryLoan[] =>
    Array.from({ length: n }, (_, i) => {
      const returnedAt = new Date(TODAY_MIDNIGHT.getTime() - (30 - i * 2) * DAY_MS + 12 * HOUR_MS)
      const dueAt = new Date(returnedAt.getTime() - 3 * DAY_MS)
      return { id: `hist-loan-${i + 1}`, userId: 'st1', bookCopyId: 'c1', borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), dueAt, returnedAt, status: 'returned' as const }
    })
  /** The fines' statuses, oldest first. */
  const statuses = (n: number) => generateFines(lateLoans(n), TODAY_MIDNIGHT, mulberry32(HISTORY_SEED)).map((f) => f.status)

  it('leaves the two newest outstanding, then settles the waived, the lowered and the paid, oldest first', () => {
    expect(statuses(0)).toEqual([])
    // One fine on its own is outstanding; with two or more, the two newest are.
    expect(statuses(1)).toEqual(['pending'])
    expect(statuses(2)).toEqual(['pending', 'pending'])
    expect(statuses(3)).toEqual(['waived', 'pending', 'pending'])
    expect(statuses(4).slice(0, 2).sort()).toEqual(['adjusted', 'waived'])
    expect(statuses(4).slice(2)).toEqual(['pending', 'pending'])
    // From five on, every status appears.
    expect(statuses(5).slice(0, 3).sort()).toEqual(['adjusted', 'paid', 'waived'])
    expect(statuses(5).slice(3)).toEqual(['pending', 'pending'])
    for (const n of [6, 7, 8, 9, 10, 11]) {
      const all = statuses(n)
      expect(all.slice(-2), `${n} fines`).toEqual(['pending', 'pending'])
      for (const status of ['paid', 'adjusted', 'waived']) expect(all, `${n} fines: ${status}`).toContain(status)
    }
  })

  it('leaves the two newest outstanding whatever the random numbers are', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(generateFines(lateLoans(7), TODAY_MIDNIGHT, mulberry32(seed)).slice(-2).map((f) => f.status), `seed ${seed}`).toEqual(['pending', 'pending'])
    }
  })
})
