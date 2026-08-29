import { TIME_SLOTS } from '../config/constants'
import { prisma } from '../lib/prisma'

export interface ResourceDto {
  id: string
  type: string
  name: string
  location: string | null
  capacity: number
  takenSlotsToday: string[]
}

function parseDateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

export async function getAvailability(type: 'seat' | 'room', date: string): Promise<ResourceDto[]> {
  const resources = await prisma.resource.findMany({ where: { type }, orderBy: { name: 'asc' } })
  if (resources.length === 0) return []

  const { year, month, day } = parseDateParts(date)
  const dayStart = new Date(year, month - 1, day, 0, 0, 0)
  const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0)

  const bookings = await prisma.resourceBooking.findMany({
    where: {
      resourceId: { in: resources.map((r) => r.id) },
      status: { in: ['booked', 'checked_in'] },
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

    return { id: r.id, type: r.type, name: r.name, location: r.location, capacity: r.capacity, takenSlotsToday }
  })
}
