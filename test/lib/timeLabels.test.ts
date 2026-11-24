import { describe, expect, it } from 'vitest'
import { dateLabel, dayLabel, slotLabel } from '../../src/lib/timeLabels'

// Local-time constructors, so these pass in any machine time zone.
const at = (hour: number, minute = 0) => new Date(2026, 9, 22, hour, minute)

// The student app's Fines page spells its months this way, by hand, so the notice text matches it.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

describe('time labels', () => {
  it('names the day like "Thu, Oct 22"', () => {
    expect(dayLabel(at(14))).toBe('Thu, Oct 22')
  })

  describe('dateLabel', () => {
    const year = new Date().getFullYear()

    it('reads like the student app\'s Fines page: day, abbreviated month, year', () => {
      // 22 Oct of this year, written out by hand rather than through the formatter.
      expect(dateLabel(new Date(year, 9, 22, 14))).toBe(`22 Oct ${year}`)
    })

    it('has no leading zero on the day and no comma', () => {
      expect(dateLabel(new Date(year, 10, 3, 12))).toBe(`3 Nov ${year}`)
    })

    it('spells September "Sep", not "Sept", and every month as the app does', () => {
      expect(dateLabel(new Date(year, 8, 3, 12))).toBe(`3 Sep ${year}`)
      for (let month = 0; month < 12; month++) {
        expect(dateLabel(new Date(year, month, 15, 12))).toBe(`15 ${MONTHS[month]} ${year}`)
      }
    })

    it('uses the local day and year at both ends of it', () => {
      expect(dateLabel(new Date(year, 0, 1, 0, 5))).toBe(`1 Jan ${year}`)
      expect(dateLabel(new Date(year, 11, 31, 23, 55))).toBe(`31 Dec ${year}`)
    })
  })

  it('shows an hour slot the way the console does', () => {
    expect(slotLabel(at(14), at(15))).toBe('2–3 PM')
    expect(slotLabel(at(9), at(10))).toBe('9–10 AM')
    expect(slotLabel(at(11), at(12))).toBe('11 AM–12 PM')
    expect(slotLabel(at(12), at(13))).toBe('12–1 PM')
  })

  it('keeps the minutes when a slot is not on the hour', () => {
    expect(slotLabel(at(14, 30), at(15, 30))).toBe('2:30–3:30 PM')
  })
})
