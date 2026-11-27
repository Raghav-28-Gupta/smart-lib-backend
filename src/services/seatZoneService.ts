// The librarian's side of the seat map's zones. A zone is not a table of its own:
// it is a distinct seat `location`, so a new zone appears the moment a seat is
// given that location. The only stored part is `SeatZone`, the label of the
// zone's front ("Windows", "Entrance"), matched to a location by exact text with
// no foreign key (a location typed with other case, or renamed, is simply
// another zone and has no label until one is set).
import { publishResourceChange } from '../lib/events'
import { NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

export interface SeatZoneDto {
  name: string
  frontLabel: string | null
  /** Seats in the zone, of any status (an offline desk still stands in its place). */
  seats: number
  /** Those with a place on the map (a row and a column). */
  placed: number
}

// Plain code-unit order, so the list reads the same on every database whatever
// its collation ("Reading Room A" before "Reading room A").
function byName(a: SeatZoneDto, b: SeatZoneDto): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

export async function listSeatZones(): Promise<SeatZoneDto[]> {
  // Seats only: a room's location (Group study rooms) is never a zone.
  const seats = await prisma.resource.findMany({
    where: { type: 'seat', location: { not: null } },
    select: { location: true, row: true },
  })

  const counts = new Map<string, { seats: number; placed: number }>()
  for (const seat of seats) {
    // A location is stored trimmed or null; a blank one (only from a write that
    // bypassed the API) is no zone.
    if (seat.location === null || seat.location.trim() === '') continue
    const count = counts.get(seat.location) ?? { seats: 0, placed: 0 }
    count.seats += 1
    if (seat.row !== null) count.placed += 1
    counts.set(seat.location, count)
  }
  if (counts.size === 0) return []

  const labels = await prisma.seatZone.findMany({ where: { name: { in: [...counts.keys()] } } })
  const frontByZone = new Map(labels.map((zone) => [zone.name, zone.frontLabel]))

  return [...counts]
    .map(([name, count]) => ({ name, frontLabel: frontByZone.get(name) ?? null, seats: count.seats, placed: count.placed }))
    .sort(byName)
}

export async function setZoneFrontLabel(name: string, frontLabel: string): Promise<SeatZoneDto> {
  const seats = await prisma.resource.findMany({ where: { type: 'seat', location: name }, select: { row: true } })
  if (seats.length === 0) throw new NotFoundError('Zone')

  // A blank label means none, stored as null so it never reads as an empty "front".
  const label = frontLabel.trim() === '' ? null : frontLabel.trim()
  const zone = await prisma.seatZone.upsert({
    where: { name },
    create: { name, frontLabel: label },
    update: { frontLabel: label },
  })

  publishResourceChange()
  return { name: zone.name, frontLabel: zone.frontLabel, seats: seats.length, placed: seats.filter((seat) => seat.row !== null).length }
}
