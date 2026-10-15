import { describe, expect, it } from 'vitest'
import {
  addDays,
  areaOf,
  bookedPercent,
  computeCirculation,
  computeDemand,
  computeOverdue,
  computeUtilization,
  isoDate,
  startOfDay,
  windowDays,
  type BookingRow,
  type LoanRow,
  type ResourceRow,
} from '../../src/services/adminMetrics'

// Thursday 15 Oct 2026, 1 PM library time. Everything is built with local-time
// constructors, so these tests pass in any machine time zone.
const NOW = new Date(2026, 9, 15, 13, 0)
const TODAY = startOfDay(NOW)
const at = (day: Date, hour: number, minute = 0) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)
const booking = (resourceId: string, day: Date, fromHour: number, toHour: number, status = 'booked'): BookingRow => ({
  resourceId,
  startTime: at(day, fromHour),
  endTime: at(day, toHour),
  status,
})
const seat = (id: string, location: string | null = 'Silent Zone'): ResourceRow => ({ id, type: 'seat', location })
const room = (id: string, location: string | null = null): ResourceRow => ({ id, type: 'room', location })

describe('library days', () => {
  it('windowDays lists the 7 days ending today, oldest first', () => {
    expect(windowDays(NOW).map(isoDate)).toEqual([
      '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15',
    ])
  })
})

describe('bookedPercent', () => {
  it('is booked hours over open hours, 11 per resource per day', () => {
    // 2 of 11 open hours -> 18%
    expect(bookedPercent([booking('s1', TODAY, 10, 11), booking('s1', TODAY, 15, 16)], [seat('s1')], [TODAY])).toBe(18)
  })

  it('ignores cancelled bookings and bookings on other resources or days', () => {
    const bookings = [
      booking('s1', TODAY, 10, 11, 'cancelled'),
      booking('s2', TODAY, 10, 11),
      booking('s1', addDays(TODAY, -1), 10, 11),
    ]
    expect(bookedPercent(bookings, [seat('s1')], [TODAY])).toBe(0)
  })

  it('counts a no-show, which stays booked, the same as a check-in', () => {
    const bookings = [booking('s1', TODAY, 10, 11, 'booked'), booking('s1', TODAY, 11, 12, 'checked_in')]
    expect(bookedPercent(bookings, [seat('s1')], [TODAY])).toBe(18)
  })

  it('counts only the part of a booking inside open hours', () => {
    // 8:30-9:30 adds half an hour, 19:30-21:00 adds half an hour: 1 of 11 -> 9%
    const early: BookingRow = { resourceId: 's1', startTime: at(TODAY, 8, 30), endTime: at(TODAY, 9, 30), status: 'booked' }
    const late: BookingRow = { resourceId: 's1', startTime: at(TODAY, 19, 30), endTime: at(TODAY, 21), status: 'booked' }
    expect(bookedPercent([early, late], [seat('s1')], [TODAY])).toBe(9)
  })

  it("counts a booking across midnight only within each day's open hours", () => {
    // Today 19:00-20:00 is open (1 h); tomorrow 9:00-10:00 is open (1 h).
    const overnight: BookingRow = {
      resourceId: 's1', startTime: at(TODAY, 19), endTime: at(addDays(TODAY, 1), 10), status: 'booked',
    }
    expect(bookedPercent([overnight], [seat('s1')], [TODAY])).toBe(9)
    expect(bookedPercent([overnight], [seat('s1')], [addDays(TODAY, 1)])).toBe(9)
  })

  it('is 0 when there are no resources', () => {
    expect(bookedPercent([], [], [TODAY])).toBe(0)
  })
})

describe('computeUtilization', () => {
  const resources = [seat('s1'), seat('s2'), room('r1')]

  it("reports today's booked share, including bookings later today", () => {
    // NOW is 1 PM; the 6 PM booking is still ahead but already booked. 3 of 33 h -> 9%
    const u = computeUtilization([booking('s1', TODAY, 18, 19), booking('r1', TODAY, 10, 12)], resources, NOW)
    expect(u.today).toEqual({ date: '2026-10-15', percent: 9, lastWeekPercent: 0 })
  })

  it('compares with the same weekday last week', () => {
    // 11 of 33 open hours on 8 Oct -> 33%
    const u = computeUtilization([booking('s1', addDays(TODAY, -7), 9, 20)], resources, NOW)
    expect(u.today.lastWeekPercent).toBe(33)
  })

  it('splits the last 7 days into seats and rooms, oldest first', () => {
    const u = computeUtilization([booking('s1', addDays(TODAY, -6), 9, 20), booking('r1', TODAY, 14, 16)], resources, NOW)
    expect(u.days).toHaveLength(7)
    expect(u.days[0]).toEqual({ date: '2026-10-09', seatPercent: 50, roomPercent: 0 }) // 11 of 22 seat hours
    expect(u.days[6]).toEqual({ date: '2026-10-15', seatPercent: 0, roomPercent: 18 }) // 2 of 11 room hours
  })
})

describe('computeDemand', () => {
  it('groups resources by location, falling back to Seats or Rooms', () => {
    expect(areaOf(seat('s1', 'Reading Room A'))).toBe('Reading Room A')
    expect(areaOf(seat('s1', null))).toBe('Seats')
    expect(areaOf(room('r1', null))).toBe('Rooms')
  })

  it("reports each area's 7-day booked share and busiest slot, busiest area first", () => {
    const resources = [seat('s1', 'Silent Zone'), room('r1', 'Group study rooms'), room('r2', 'Group study rooms')]
    const bookings = [
      booking('s1', TODAY, 9, 10),
      booking('r1', TODAY, 14, 16), // 2 PM and 3 PM
      booking('r2', addDays(TODAY, -1), 14, 15), // 2 PM again
      booking('r2', addDays(TODAY, -2), 10, 11, 'cancelled'),
    ]
    expect(computeDemand(bookings, resources, NOW).areas).toEqual([
      { area: 'Group study rooms', percent: 2, busiestSlot: '2:00 PM' }, // 3 of 154 h
      { area: 'Silent Zone', percent: 1, busiestSlot: '9:00 AM' }, // 1 of 77 h
    ])
  })

  it('breaks ties toward the earliest slot, and has no busiest slot without bookings', () => {
    const resources = [seat('s1', 'Silent Zone'), seat('s2', 'Reading Room A')]
    const bookings = [booking('s1', TODAY, 15, 16), booking('s1', TODAY, 11, 12)]
    expect(computeDemand(bookings, resources, NOW).areas).toEqual([
      { area: 'Silent Zone', percent: 3, busiestSlot: '11:00 AM' }, // 2 of 77 h
      { area: 'Reading Room A', percent: 0, busiestSlot: null },
    ])
  })

  it('orders areas with equal shares by name', () => {
    const resources = [seat('a', 'Zeta wing'), seat('b', 'Alpha wing')]
    expect(computeDemand([], resources, NOW).areas.map((a) => a.area)).toEqual(['Alpha wing', 'Zeta wing'])
  })
})

const loan = (over: Partial<LoanRow>): LoanRow => ({
  bookId: 'b1',
  title: 'Introduction to Algorithms',
  borrowedAt: at(TODAY, 10),
  dueAt: at(addDays(TODAY, 14), 10),
  returnedAt: null,
  ...over,
})

describe('computeCirculation', () => {
  it('counts borrows and returns from the start of the 7-day window up to now', () => {
    const loans = [
      loan({ borrowedAt: at(addDays(TODAY, -6), 0, 0) }), // first moment of the window: counts
      loan({ borrowedAt: at(addDays(TODAY, -7), 23, 59) }), // the evening before: doesn't
      loan({ borrowedAt: at(addDays(TODAY, -10), 10), returnedAt: at(addDays(TODAY, -2), 12) }), // a return only
      loan({ borrowedAt: at(addDays(TODAY, -3), 10), returnedAt: at(addDays(TODAY, -1), 12) }), // both
    ]
    expect(computeCirculation(loans, NOW)).toMatchObject({ borrows: 2, returns: 2 })
  })

  it('ranks up to 5 titles by borrows, ties by title', () => {
    const counts: [string, string, number][] = [
      ['b1', 'Introduction to Algorithms', 3],
      ['b8', 'Clean Code', 3],
      ['b3', 'Database System Concepts', 2],
      ['b4', 'Computer Networks', 1],
      ['b5', 'Data Structures and Algorithms in Java', 1],
      ['b6', 'Design Patterns', 1],
    ]
    const loans = counts.flatMap(([bookId, title, n]) => Array.from({ length: n }, () => loan({ bookId, title })))
    expect(computeCirculation(loans, NOW).topTitles).toEqual([
      { bookId: 'b8', title: 'Clean Code', borrows: 3 },
      { bookId: 'b1', title: 'Introduction to Algorithms', borrows: 3 },
      { bookId: 'b3', title: 'Database System Concepts', borrows: 2 },
      { bookId: 'b4', title: 'Computer Networks', borrows: 1 },
      { bookId: 'b5', title: 'Data Structures and Algorithms in Java', borrows: 1 },
    ])
  })
})

describe('computeOverdue', () => {
  it('counts unreturned loans past due now, and as of exactly 24 hours earlier', () => {
    const loans = [
      loan({ borrowedAt: at(addDays(TODAY, -17), 10), dueAt: at(addDays(TODAY, -3), 10) }), // both
      loan({ borrowedAt: at(addDays(TODAY, -14), 18), dueAt: at(TODAY, 1) }), // now only
      loan({ borrowedAt: at(addDays(TODAY, -14), 19), dueAt: at(TODAY, 2) }), // now only
      // Returned this morning: overdue yesterday, not now.
      loan({ borrowedAt: at(addDays(TODAY, -20), 10), dueAt: at(addDays(TODAY, -6), 10), returnedAt: at(TODAY, 9) }),
      loan({ borrowedAt: at(addDays(TODAY, -2), 10), dueAt: at(addDays(TODAY, 12), 10) }), // not due
    ]
    expect(computeOverdue(loans, NOW)).toEqual({ count: 3, countYesterday: 2 })
  })

  it('ignores a loan borrowed after the moment being measured', () => {
    const loans = [loan({ borrowedAt: at(TODAY, 1), dueAt: at(TODAY, 2) })]
    expect(computeOverdue(loans, NOW)).toEqual({ count: 1, countYesterday: 0 })
  })
})
