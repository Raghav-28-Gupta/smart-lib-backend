import { describe, expect, it } from 'vitest'
import { dayLabel, slotLabel } from '../../src/lib/timeLabels'

// Local-time constructors, so these pass in any machine time zone.
const at = (hour: number, minute = 0) => new Date(2026, 9, 22, hour, minute)

describe('time labels', () => {
  it('names the day like "Thu, Oct 22"', () => {
    expect(dayLabel(at(14))).toBe('Thu, Oct 22')
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
