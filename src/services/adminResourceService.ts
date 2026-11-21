// The librarian's side of resources: list, add, edit, and take offline or bring
// back online. Offline means "no new bookings" (enforced for students in
// bookingService and resourceService); bookings that already exist stay, which
// is why the list says how many a resource still has. Offline and online are
// conditional updates on the current status, so of two librarians clicking at
// once only the first lands and the second is told what happened.
import { publishResourceChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { HOLDING_STATUSES } from './bookingService'

export type AdminResourceType = 'seat' | 'room'

export interface AdminResourceDto {
  id: string
  type: AdminResourceType
  name: string
  location: string | null
  capacity: number
  status: 'available' | 'offline'
  statusNote: string | null
  /** Holding bookings (requested, booked, checked in) that have not ended yet. */
  upcomingBookings: number
}

interface ResourceRow {
  id: string
  type: AdminResourceType
  name: string
  location: string | null
  capacity: number
  status: 'available' | 'offline'
  statusNote: string | null
}

function toDto(row: ResourceRow, upcomingBookings: number): AdminResourceDto {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    location: row.location,
    capacity: row.capacity,
    status: row.status,
    statusNote: row.statusNote,
    upcomingBookings,
  }
}

// Bookings that stay when a resource goes offline: still holding their slot and
// not over yet, so one in progress counts along with the ones still to come.
async function countUpcoming(resourceIds: string[], now: Date): Promise<Map<string, number>> {
  if (resourceIds.length === 0) return new Map()
  const groups = await prisma.resourceBooking.groupBy({
    by: ['resourceId'],
    where: { resourceId: { in: resourceIds }, status: { in: HOLDING_STATUSES }, endTime: { gt: now } },
    _count: true,
  })
  return new Map(groups.map((g) => [g.resourceId, g._count]))
}

async function findResource(id: string): Promise<ResourceRow> {
  const row = await prisma.resource.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('Resource')
  return row
}

async function toFreshDto(id: string): Promise<AdminResourceDto> {
  const row = await findResource(id)
  const upcoming = await countUpcoming([id], new Date())
  return toDto(row, upcoming.get(id) ?? 0)
}

export async function listResources(type?: AdminResourceType, now = new Date()): Promise<AdminResourceDto[]> {
  const rows = await prisma.resource.findMany({ where: type ? { type } : {}, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const upcoming = await countUpcoming(
    rows.map((r) => r.id),
    now,
  )
  return rows.map((r) => toDto(r, upcoming.get(r.id) ?? 0))
}

export async function createResource(input: {
  type: AdminResourceType
  name: string
  location?: string | null
  capacity: number
}): Promise<AdminResourceDto> {
  const row = await prisma.resource.create({
    data: { type: input.type, name: input.name, location: input.location ?? null, capacity: input.capacity },
  })
  publishResourceChange()
  return toDto(row, 0)
}

export async function updateResource(
  id: string,
  input: { name?: string; location?: string | null; capacity?: number },
): Promise<AdminResourceDto> {
  await findResource(id)
  // Only the fields that were sent; the type is never one of them.
  const row = await prisma.resource.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.location !== undefined && { location: input.location }),
      ...(input.capacity !== undefined && { capacity: input.capacity }),
    },
  })
  publishResourceChange()
  const upcoming = await countUpcoming([id], new Date())
  return toDto(row, upcoming.get(id) ?? 0)
}

export async function takeOffline(id: string, note: string | null): Promise<AdminResourceDto> {
  const current = await findResource(id)
  if (current.status === 'offline') throw new ConflictError('This resource is already offline.')

  const { count } = await prisma.resource.updateMany({ where: { id, status: 'available' }, data: { status: 'offline', statusNote: note } })
  // Another librarian took it offline between the read and the write.
  if (count === 0) throw new ConflictError('This resource is already offline.')

  publishResourceChange()
  return toFreshDto(id)
}

export async function bringOnline(id: string): Promise<AdminResourceDto> {
  const current = await findResource(id)
  if (current.status === 'available') throw new ConflictError('This resource is already online.')

  const { count } = await prisma.resource.updateMany({ where: { id, status: 'offline' }, data: { status: 'available', statusNote: null } })
  // Another librarian brought it back between the read and the write.
  if (count === 0) throw new ConflictError('This resource is already online.')

  publishResourceChange()
  return toFreshDto(id)
}
