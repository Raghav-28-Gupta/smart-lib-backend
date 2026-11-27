// The librarian's side of resources: list, add, edit, and take offline or bring
// back online. Offline means "no new bookings" (enforced for students in
// bookingService and resourceService); bookings that already exist stay, which
// is why the list says how many a resource still has. Offline and online are
// conditional updates on the current status, so of two librarians clicking at
// once only the first lands and the second is told what happened.
//
// A seat may also have a place on the seat map: a row and a column in the zone
// named by its location. The rules (both or neither, seats only, a location) are
// checked here against the seat as it will be after the write; that one place is
// held by one seat is the database's (the partial unique index
// Resource_seat_position_unique), never a read-then-write.
import { Prisma } from '../generated/prisma/client'
import { publishResourceChange } from '../lib/events'
import { ConflictError, NotFoundError, ValidationError } from '../lib/httpError'
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
  /** Place on the seat map (seats only; both set or both null). */
  row: number | null
  column: number | null
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
  row: number | null
  column: number | null
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
    row: row.row,
    column: row.column,
    upcomingBookings,
  }
}

interface FinalSeat {
  type: AdminResourceType
  location: string | null
  row: number | null
  column: number | null
}

// The position rules, in the order the librarian meets them. `seat` is the
// resource as it will be after the write.
function checkPosition(seat: FinalSeat): void {
  if ((seat.row === null) !== (seat.column === null)) throw new ValidationError('Set both row and column, or neither.')
  if (seat.row === null) return
  if (seat.type !== 'seat') throw new ValidationError('Only seats can have a position on the seat map.')
  if (!seat.location || seat.location.trim() === '') throw new ValidationError('A seat on the map needs a location: its zone.')
}

// The unique index Resource_seat_position_unique rejects a second seat at one
// place. Prisma reports a unique violation as P2002; through the pg driver
// adapter it can also arrive as a generic P2039 carrying SQLSTATE 23505 in its
// message (as in borrowRequestService).
function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2002' || (e.code === 'P2039' && e.message.includes('23505')))
  )
}

// What to throw for a failed write: the 409 naming the seat that holds the place
// when it was the position index, else the error itself. `exceptId` is the seat
// being edited, which is not "the other seat".
async function writeFailure(e: unknown, seat: FinalSeat, exceptId?: string): Promise<unknown> {
  if (!isUniqueViolation(e) || seat.row === null || seat.column === null || seat.location === null) return e
  const other = await prisma.resource.findFirst({
    where: { location: seat.location, row: seat.row, column: seat.column, ...(exceptId !== undefined && { id: { not: exceptId } }) },
    select: { name: true },
  })
  const taken = `Row ${seat.row}, column ${seat.column} in ${seat.location} is already taken`
  // The other seat may have moved between the failed write and this read.
  return new ConflictError(other ? `${taken} by ${other.name}.` : `${taken}.`)
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
  row?: number | null
  column?: number | null
}): Promise<AdminResourceDto> {
  const seat: FinalSeat = { type: input.type, location: input.location ?? null, row: input.row ?? null, column: input.column ?? null }
  checkPosition(seat)
  let row
  try {
    row = await prisma.resource.create({
      data: { type: input.type, name: input.name, location: seat.location, capacity: input.capacity, row: seat.row, column: seat.column },
    })
  } catch (e) {
    throw await writeFailure(e, seat)
  }
  publishResourceChange()
  return toDto(row, 0)
}

export async function updateResource(
  id: string,
  input: { name?: string; location?: string | null; capacity?: number; row?: number | null; column?: number | null },
): Promise<AdminResourceDto> {
  const current = await findResource(id)
  // The seat as it will be: what was sent over what is stored (an omitted field
  // keeps its value, null clears it). The position rules look at the whole.
  const seat: FinalSeat = {
    type: current.type,
    location: input.location !== undefined ? input.location : current.location,
    row: input.row !== undefined ? input.row : current.row,
    column: input.column !== undefined ? input.column : current.column,
  }
  checkPosition(seat)
  let row
  try {
    // Only the fields that were sent; the type is never one of them. The
    // position is written as the pair when either half was sent, so a racing
    // edit can never leave half of one.
    row = await prisma.resource.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.location !== undefined && { location: input.location }),
        ...(input.capacity !== undefined && { capacity: input.capacity }),
        ...((input.row !== undefined || input.column !== undefined) && { row: seat.row, column: seat.column }),
      },
    })
  } catch (e) {
    throw await writeFailure(e, seat, id)
  }
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
