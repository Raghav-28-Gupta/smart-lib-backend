// The demo seat map: where the seed's desks stand in their two zones. Pure (no
// Prisma), so the seed and its tests share one copy of the layout. The student
// app's mock repository builds the same layout from the same values.
//
// A zone is a grid of rows by columns. Desks stand only in `deskColumns`; the
// columns left out are aisles, so the map shows a gap there. Desk N is numbered
// row by row, left to right, over the desks only, from 1 in each zone.

export interface SeatZoneLayout {
  /** The seats' `location`, and the `SeatZone` row's key. */
  name: string
  /** What the front of the zone faces, shown on the map. */
  frontLabel: string
  rows: number
  deskColumns: readonly number[]
  /** A generated desk's id is `${idPrefix}-${N}`. */
  idPrefix: string
}

export const SEAT_ZONES: readonly SeatZoneLayout[] = [
  // 8 rows of 10, aisles after the 3rd and 7th desk, facing the windows.
  { name: 'Reading Room A', frontLabel: 'Windows', rows: 8, deskColumns: [1, 2, 3, 5, 6, 7, 8, 10, 11, 12], idPrefix: 's-rra' },
  // 6 rows of 8, an aisle after the 4th, by the entrance.
  { name: 'Silent Zone', frontLabel: 'Entrance', rows: 6, deskColumns: [1, 2, 3, 4, 6, 7, 8, 9], idPrefix: 's-sz' },
]

export interface SeedSeat {
  id: string
  name: string
  location: string
  row: number
  column: number
  /** Today's slots (TIME_SLOTS labels) the seed books on this desk. */
  taken: string[]
}

export interface KeptDesk {
  id: string
  location: string
  /** The desk's number in its zone. */
  desk: number
  taken: string[]
}

/**
 * Every desk of the layout, in zone order and then desk order. A kept desk (one
 * the demo already had) keeps its id and taken slots; every other desk gets
 * `${idPrefix}-${N}` and no taken slots. Throws when a kept desk names a place
 * the layout does not have, rather than dropping it from the seed.
 */
export function seedSeats(kept: KeptDesk[]): SeedSeat[] {
  const keptAt = new Map(kept.map((k) => [`${k.location} · Desk ${k.desk}`, k]))
  const seats: SeedSeat[] = []
  for (const zone of SEAT_ZONES) {
    const count = zone.rows * zone.deskColumns.length
    for (let n = 1; n <= count; n++) {
      const name = `${zone.name} · Desk ${n}`
      const k = keptAt.get(name)
      keptAt.delete(name)
      seats.push({
        id: k?.id ?? `${zone.idPrefix}-${n}`,
        name,
        location: zone.name,
        row: Math.floor((n - 1) / zone.deskColumns.length) + 1,
        column: zone.deskColumns[(n - 1) % zone.deskColumns.length],
        taken: k ? [...k.taken] : [],
      })
    }
  }
  if (keptAt.size > 0) throw new Error(`the seat layout has no ${[...keptAt.keys()].join(', ')}`)
  return seats
}
