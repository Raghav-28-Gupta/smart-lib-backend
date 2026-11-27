import { describe, expect, it } from 'vitest'
import { DEMO_EMAIL_PATTERN } from '../../src/config/constants'
import { SEAT_ZONES, seedSeats, type SeedSeat } from '../../prisma/seatLayout'
import { SEED_STUDENT_EMAILS } from '../../prisma/seedData'

// The four desks the demo has always had, with their scripted "taken today" slots.
const KEPT = [
  { id: 's1', location: 'Reading Room A', desk: 12, taken: ['11:00 AM', '12:00 PM'] },
  { id: 's2', location: 'Reading Room A', desk: 14, taken: ['9:00 AM', '10:00 AM', '3:00 PM', '4:00 PM'] },
  { id: 's3', location: 'Silent Zone', desk: 3, taken: [] },
  { id: 's4', location: 'Silent Zone', desk: 7, taken: ['1:00 PM', '2:00 PM', '6:00 PM'] },
]

const seats = seedSeats(KEPT)
const inZone = (zone: string) => seats.filter((s) => s.location === zone)
const desk = (zone: string, n: number): SeedSeat => {
  const found = seats.find((s) => s.name === `${zone} · Desk ${n}`)
  if (!found) throw new Error(`no ${zone} · Desk ${n}`)
  return found
}
const position = (zone: string, n: number) => {
  const { row, column } = desk(zone, n)
  return { row, column }
}

describe('seedSeats', () => {
  it('128 desks: 80 in Reading Room A and 48 in Silent Zone, numbered from 1 in each zone', () => {
    expect(SEAT_ZONES).toEqual([
      { name: 'Reading Room A', frontLabel: 'Windows', rows: 8, deskColumns: [1, 2, 3, 5, 6, 7, 8, 10, 11, 12], idPrefix: 's-rra' },
      { name: 'Silent Zone', frontLabel: 'Entrance', rows: 6, deskColumns: [1, 2, 3, 4, 6, 7, 8, 9], idPrefix: 's-sz' },
    ])
    expect(seats).toHaveLength(128)
    // Zone order, then desk order.
    expect(seats.slice(0, 80).map((s) => s.name)).toEqual(Array.from({ length: 80 }, (_, i) => `Reading Room A · Desk ${i + 1}`))
    expect(seats.slice(80).map((s) => s.name)).toEqual(Array.from({ length: 48 }, (_, i) => `Silent Zone · Desk ${i + 1}`))
    expect(inZone('Reading Room A')).toHaveLength(80)
    expect(inZone('Silent Zone')).toHaveLength(48)
  })

  it('desks run row by row over the desk columns', () => {
    expect(position('Reading Room A', 1)).toEqual({ row: 1, column: 1 })
    expect(position('Reading Room A', 10)).toEqual({ row: 1, column: 12 })
    expect(position('Reading Room A', 11)).toEqual({ row: 2, column: 1 })
    expect(position('Reading Room A', 12)).toEqual({ row: 2, column: 2 })
    expect(position('Reading Room A', 14)).toEqual({ row: 2, column: 5 })
    expect(position('Reading Room A', 80)).toEqual({ row: 8, column: 12 })
    expect(position('Silent Zone', 3)).toEqual({ row: 1, column: 3 })
    expect(position('Silent Zone', 7)).toEqual({ row: 1, column: 8 })
    expect(position('Silent Zone', 48)).toEqual({ row: 6, column: 9 })
    // Every row of a zone is full: one desk per desk column.
    for (const zone of SEAT_ZONES) {
      for (let row = 1; row <= zone.rows; row++) {
        const columns = inZone(zone.name).filter((s) => s.row === row).map((s) => s.column)
        expect(columns, `${zone.name} row ${row}`).toEqual([...zone.deskColumns])
      }
      expect(Math.max(...inZone(zone.name).map((s) => s.row))).toBe(zone.rows)
    }
  })

  it('no desk sits in an aisle column', () => {
    const columns = (zone: string) => new Set(inZone(zone).map((s) => s.column))
    expect(columns('Reading Room A').has(4)).toBe(false)
    expect(columns('Reading Room A').has(9)).toBe(false)
    expect(columns('Silent Zone').has(5)).toBe(false)
    expect([...columns('Reading Room A')].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7, 8, 10, 11, 12])
    expect([...columns('Silent Zone')].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 8, 9])
  })

  it('kept desks keep their ids and taken slots; the others get s-rra-N or s-sz-N and none', () => {
    expect(desk('Reading Room A', 12)).toEqual({ id: 's1', name: 'Reading Room A · Desk 12', location: 'Reading Room A', row: 2, column: 2, taken: ['11:00 AM', '12:00 PM'] })
    expect(desk('Reading Room A', 14)).toEqual({ id: 's2', name: 'Reading Room A · Desk 14', location: 'Reading Room A', row: 2, column: 5, taken: ['9:00 AM', '10:00 AM', '3:00 PM', '4:00 PM'] })
    expect(desk('Silent Zone', 3)).toEqual({ id: 's3', name: 'Silent Zone · Desk 3', location: 'Silent Zone', row: 1, column: 3, taken: [] })
    expect(desk('Silent Zone', 7)).toEqual({ id: 's4', name: 'Silent Zone · Desk 7', location: 'Silent Zone', row: 1, column: 8, taken: ['1:00 PM', '2:00 PM', '6:00 PM'] })

    const keptIds = new Set(KEPT.map((k) => k.id))
    for (const zone of SEAT_ZONES) {
      inZone(zone.name).forEach((seat, i) => {
        if (keptIds.has(seat.id)) return
        expect(seat.id).toBe(`${zone.idPrefix}-${i + 1}`)
        expect(seat.taken).toEqual([])
      })
    }
    // The kept numbers are skipped, not given a second desk.
    for (const id of ['s-rra-12', 's-rra-14', 's-sz-3', 's-sz-7']) expect(seats.some((s) => s.id === id)).toBe(false)
    expect(seats.filter((s) => s.taken.length > 0).map((s) => s.id)).toEqual(['s1', 's2', 's4'])

    // With nothing kept, every desk is a generated one.
    expect(seedSeats([]).map((s) => s.id)).toEqual([
      ...Array.from({ length: 80 }, (_, i) => `s-rra-${i + 1}`),
      ...Array.from({ length: 48 }, (_, i) => `s-sz-${i + 1}`),
    ])
    // A kept desk the layout has no place for would silently drop out of the seed (and of its reset).
    expect(() => seedSeats([{ id: 's9', location: 'Silent Zone', desk: 49, taken: [] }])).toThrow(/Silent Zone · Desk 49/)
    expect(() => seedSeats([{ id: 's9', location: 'Reading Room B', desk: 1, taken: [] }])).toThrow(/Reading Room B · Desk 1/)
  })

  it('ids are unique and every zone, row and column is unique', () => {
    expect(new Set(seats.map((s) => s.id)).size).toBe(128)
    expect(new Set(seats.map((s) => s.name)).size).toBe(128)
    expect(new Set(seats.map((s) => `${s.location}|${s.row}|${s.column}`)).size).toBe(128)
    // Inside the range the admin endpoints accept.
    for (const s of seats) {
      expect(s.row).toBeGreaterThanOrEqual(1)
      expect(s.row).toBeLessThanOrEqual(50)
      expect(s.column).toBeGreaterThanOrEqual(1)
      expect(s.column).toBeLessThanOrEqual(50)
    }
  })

  it('the mailer treats every seed student, up to seed.student81, as a demo address', () => {
    expect(DEMO_EMAIL_PATTERN.test('seed.student81@thapar.edu')).toBe(true)
    expect(SEED_STUDENT_EMAILS).toHaveLength(81)
    expect(SEED_STUDENT_EMAILS.at(-1)).toBe('seed.student81@thapar.edu')
    for (const email of SEED_STUDENT_EMAILS) expect(DEMO_EMAIL_PATTERN.test(email), email).toBe(true)
  })
})
