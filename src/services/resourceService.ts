import { TIME_SLOTS } from '../config/constants'
import { prisma } from '../lib/prisma'
import { HOLDING_STATUSES } from './bookingService'

export interface ResourceDto {
  id: string
  type: string
  name: string
  location: string | null
  capacity: number
  takenSlotsToday: string[]
  // Place on the seat map: both null for rooms and for seats not yet placed.
  row: number | null
  column: number | null
  // The front label of the seat's zone (SeatZone matched by exact location text), or null.
  zoneFront: string | null
  status: 'available' | 'offline'
}

function parseDateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

export async function getAvailability(
  type: 'seat' | 'room',
  date: string,
  options: { includeOffline?: boolean } = {},
): Promise<ResourceDto[]> {
  // Offline resources take no new bookings, so students are not shown them unless the
  // caller asks (the seat map keeps an offline desk in its place).
  const resources = await prisma.resource.findMany({
    where: options.includeOffline ? { type } : { type, status: 'available' },
    orderBy: { name: 'asc' },
  })
  if (resources.length === 0) return []

  const locations = [...new Set(resources.flatMap((r) => (r.location === null ? [] : [r.location])))]
  const zones = locations.length === 0 ? [] : await prisma.seatZone.findMany({ where: { name: { in: locations } } })
  const frontByZone = new Map(zones.map((z) => [z.name, z.frontLabel]))

  const { year, month, day } = parseDateParts(date)
  const dayStart = new Date(year, month - 1, day, 0, 0, 0)
  const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0)

  // An offline resource reports no taken slots, so only the available ones are looked up.
  const bookings = await prisma.resourceBooking.findMany({
    where: {
      resourceId: { in: resources.filter((r) => r.status === 'available').map((r) => r.id) },
      status: { in: HOLDING_STATUSES },
      startTime: { lt: dayEnd },
      endTime: { gt: dayStart },
    },
    select: { resourceId: true, startTime: true, endTime: true },
  })

  const bookingsByResource = new Map<string, { startTime: Date; endTime: Date }[]>()
  for (const b of bookings) {
    const list = bookingsByResource.get(b.resourceId) ?? []
    list.push(b)
    bookingsByResource.set(b.resourceId, list)
  }

  return resources.map((r) => {
    const resourceBookings = bookingsByResource.get(r.id) ?? []
    const takenSlotsToday = TIME_SLOTS.filter(({ hour }) => {
      const slotStart = new Date(year, month - 1, day, hour, 0, 0)
      const slotEnd = new Date(year, month - 1, day, hour + 1, 0, 0)
      return resourceBookings.some((b) => b.startTime < slotEnd && b.endTime > slotStart)
    }).map((s) => s.label)

    return {
      id: r.id,
      type: r.type,
      name: r.name,
      location: r.location,
      capacity: r.capacity,
      takenSlotsToday,
      row: r.row,
      column: r.column,
      zoneFront: (r.location !== null ? frontByZone.get(r.location) : null) ?? null,
      status: r.status,
    }
  })
}
