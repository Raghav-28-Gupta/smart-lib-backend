// The librarian's side of bookings. The list shows each booking as the student
// app would: the status is worked out at read time from the stored status, the
// booking's own times and its grace period (no scheduler rewrites rows), so the
// status filter has to run in SQL too. One query returns a page with its
// student and resource and, through count(*) OVER(), the total behind the
// filters, so a page costs one round trip however many rows it holds.
//
// The librarian can also cancel a booking or move it to another resource of the
// same type. Both are conditional updates on the booked status, so of a
// librarian and a student acting at once only the first write lands; the other
// is told what happened. Neither touches the student's reliability score.
import { Prisma } from '../generated/prisma/client'
import type { BookingStatus, PrismaClient, ResourceType } from '../generated/prisma/client'
import { publishBookingChange } from '../lib/events'
import { ConflictError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { graceEnd, HOLDING_STATUSES, isExclusionViolation } from './bookingService'

export type AdminBookingStatus = 'booked' | 'released' | 'checked_in' | 'completed' | 'cancelled'

export interface AdminBookingDto {
  id: string
  resource: { id: string; name: string; type: 'seat' | 'room' }
  student: { id: string; name: string; email: string }
  startTime: Date
  endTime: Date
  status: AdminBookingStatus
  /** Who cancelled it: the library when a librarian did (cancelledById is set), else the student. Null if not cancelled. */
  cancelledBy: 'student' | 'library' | null
  cancelReason: string | null
  /** The name of the resource a librarian moved this booking from, if one did. */
  movedFromName: string | null
  /** Whether the librarian can still cancel or reassign it: exactly when it is booked. */
  canManage: boolean
}

// A type alias, not an interface, so the route can cast req.validatedQuery to it.
export type AdminBookingListQuery = {
  search?: string
  status?: AdminBookingStatus
  page: number
  pageSize: number
}

export interface AdminBookingList {
  bookings: AdminBookingDto[]
  total: number
  page: number
  pageSize: number
}

interface BookingRow {
  id: string
  startTime: Date
  endTime: Date
  derivedStatus: AdminBookingStatus
  cancelledById: string | null
  cancelReason: string | null
  movedFromName: string | null
  studentId: string
  studentName: string
  studentEmail: string
  resourceId: string
  resourceName: string
  resourceType: 'seat' | 'room'
}

// Raw requested, declined, expired and no_show rows are never listed: a request
// is not a booking yet, and the other three are not something to manage.
const LISTED_STATUSES = Prisma.sql`('booked', 'checked_in', 'released', 'completed', 'cancelled')`

// A room request the student withdrew is stored as cancelled with decidedAt set
// and decidedById null (see cancelBooking). It never became a booking, so it is
// not listed or found, like the other request outcomes. A booking the student
// cancelled has decidedAt null, and one approved and cancelled later keeps its
// decidedById, so both stay listed. adminRequestService.roomSettled tells approved
// from withdrawn the same way. Keep isWithdrawnRequest and the SQL below in step.
function isWithdrawnRequest(b: { status: BookingStatus; decidedAt: Date | null; decidedById: string | null }): boolean {
  return b.status === 'cancelled' && b.decidedAt !== null && b.decidedById === null
}
const NOT_WITHDRAWN_REQUEST = Prisma.sql`NOT (b.status = 'cancelled' AND b."decidedAt" IS NOT NULL AND b."decidedById" IS NULL)`

/**
 * The status a booking is shown as at `now`. Same rules as the student app
 * (bookingService.computeWindow): a booking is released once its grace period
 * has passed (strictly: at the very end of the grace period it is still
 * booked), and a checked-in one is completed once its end time is reached.
 */
function derivedStatusSql(now: Date): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN b.status = 'cancelled' THEN 'cancelled'
    WHEN b.status = 'completed' THEN 'completed'
    WHEN b.status = 'checked_in' AND b."endTime" <= ${now} THEN 'completed'
    WHEN b.status = 'checked_in' THEN 'checked_in'
    WHEN b.status = 'booked' AND b."startTime" + make_interval(mins => b."gracePeriodMinutes") < ${now} THEN 'released'
    WHEN b.status = 'booked' THEN 'booked'
    ELSE b.status::text
  END`
}

/** Makes `%`, `_` and the escape character itself match as plain text in LIKE/ILIKE. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}

/**
 * The FROM and WHERE shared by the page query, the total-only query and the
 * single-booking read after a cancel or move: every listed booking with its
 * student, resource and derived status, narrowed by the status filter, the
 * search and, for one booking, its id. Values go in as bound parameters, never text.
 */
function filteredBookings(q: Pick<AdminBookingListQuery, 'search' | 'status'> & { id?: string }, now: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = []
  if (q.id) conditions.push(Prisma.sql`"id" = ${q.id}`)
  if (q.status) conditions.push(Prisma.sql`"derivedStatus" = ${q.status}`)

  const search = q.search?.trim()
  if (search) {
    const pattern = `%${escapeLike(search)}%`
    conditions.push(
      Prisma.sql`("studentName" ILIKE ${pattern} ESCAPE '\\' OR "studentEmail" ILIKE ${pattern} ESCAPE '\\' OR "resourceName" ILIKE ${pattern} ESCAPE '\\')`,
    )
  }
  const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty

  return Prisma.sql`
    FROM (
      SELECT b.id, b."startTime", b."endTime", b."cancelledById", b."cancelReason", b."movedFromName",
             u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
             r.id AS "resourceId", r.name AS "resourceName", r.type::text AS "resourceType",
             ${derivedStatusSql(now)} AS "derivedStatus"
      FROM "ResourceBooking" b
      JOIN "User" u ON u.id = b."userId"
      JOIN "Resource" r ON r.id = b."resourceId"
      WHERE b.status IN ${LISTED_STATUSES} AND ${NOT_WITHDRAWN_REQUEST}
    ) AS booking
    ${where}`
}

function toDto(row: BookingRow): AdminBookingDto {
  const cancelled = row.derivedStatus === 'cancelled'
  return {
    id: row.id,
    resource: { id: row.resourceId, name: row.resourceName, type: row.resourceType },
    student: { id: row.studentId, name: row.studentName, email: row.studentEmail },
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.derivedStatus,
    cancelledBy: cancelled ? (row.cancelledById ? 'library' : 'student') : null,
    cancelReason: cancelled ? row.cancelReason : null,
    movedFromName: row.movedFromName,
    canManage: row.derivedStatus === 'booked',
  }
}

/** One page of bookings, newest start time first, with the total behind the filters. */
export async function listBookings(q: AdminBookingListQuery, now = new Date()): Promise<AdminBookingList> {
  const from = filteredBookings(q, now)
  const offset = (q.page - 1) * q.pageSize

  const rows = await prisma.$queryRaw<Array<BookingRow & { total: number }>>(Prisma.sql`
    SELECT booking.*, (count(*) OVER ())::int AS total
    ${from}
    ORDER BY booking."startTime" DESC, booking.id
    LIMIT ${q.pageSize} OFFSET ${offset}`)

  let total = rows[0]?.total ?? 0
  // A page past the end has no row to carry the window count; ask for it on its
  // own so the console can still say how many bookings match.
  if (rows.length === 0 && q.page > 1) {
    const [counted] = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total ${from}`)
    total = counted?.total ?? 0
  }

  return { bookings: rows.map(toDto), total, page: q.page, pageSize: q.pageSize }
}

// --- Cancel and reassign -------------------------------------------------------

export interface ReassignOption {
  id: string
  name: string
  location: string | null
  capacity: number
}

interface BookingToManage {
  status: BookingStatus
  startTime: Date
  endTime: Date
  gracePeriodMinutes: number
  cancelledById: string | null
  decidedAt: Date | null
  decidedById: string | null
  resourceId: string
  resource: { name: string; type: ResourceType }
}

async function findBookingToManage(client: PrismaClient | Prisma.TransactionClient, id: string): Promise<BookingToManage> {
  const booking = await client.resourceBooking.findUnique({
    where: { id },
    select: {
      status: true,
      startTime: true,
      endTime: true,
      gracePeriodMinutes: true,
      cancelledById: true,
      decidedAt: true,
      decidedById: true,
      resourceId: true,
      resource: { select: { name: true, type: true } },
    },
  })
  if (!booking) throw new NotFoundError('Booking')
  return booking
}

/**
 * Throws the specific refusal for a booking the librarian can no longer manage.
 * Manageable means raw status booked and not past its grace end: the list's
 * canManage. The refusals follow the same derived rules the list shows (a
 * checked-in booking is finished once its end time is reached). Declined,
 * expired and no_show rows, and a room request the student withdrew, are not
 * bookings the console lists, so they are not found.
 */
function refuseUnlessManageable(
  booking: Pick<BookingToManage, 'status' | 'startTime' | 'endTime' | 'gracePeriodMinutes' | 'cancelledById' | 'decidedAt' | 'decidedById'>,
  now: Date,
): void {
  switch (booking.status) {
    case 'booked':
      // Strictly after the grace end, like the list: at the very end it can still be checked into.
      if (now > graceEnd(booking)) throw new ConflictError('This booking has already been released.')
      return
    case 'cancelled':
      if (isWithdrawnRequest(booking)) throw new NotFoundError('Booking')
      throw new ConflictError(booking.cancelledById ? 'Already cancelled by the library.' : 'The student already cancelled this booking.')
    case 'checked_in':
      throw new ConflictError(booking.endTime <= now ? 'This booking has already finished.' : 'The student already checked in.')
    case 'completed':
      throw new ConflictError('This booking has already finished.')
    case 'released':
      throw new ConflictError('This booking has already been released.')
    case 'requested':
      throw new ConflictError('This is a room request. Decide it on the Requests page.')
    default:
      throw new NotFoundError('Booking')
  }
}

async function findBookingDto(id: string, now: Date): Promise<AdminBookingDto> {
  const [row] = await prisma.$queryRaw<BookingRow[]>(Prisma.sql`SELECT booking.* ${filteredBookings({ id }, now)}`)
  if (!row) throw new NotFoundError('Booking')
  return toDto(row)
}

/**
 * Cancels a booking on the library's behalf and records who, when and why. The
 * write is conditional on the status still being booked, so a student who
 * checked in or cancelled a moment earlier wins and the librarian is told which.
 */
export async function cancelBookingAsLibrary(
  bookingId: string,
  adminId: string,
  reason: string | null,
  now = new Date(),
): Promise<AdminBookingDto> {
  refuseUnlessManageable(await findBookingToManage(prisma, bookingId), now)

  const { count } = await prisma.resourceBooking.updateMany({
    where: { id: bookingId, status: 'booked' },
    data: { status: 'cancelled', cancelledById: adminId, cancelledAt: now, cancelReason: reason },
  })
  if (count === 0) {
    // Someone else's write landed between the read and this one: say what it was.
    refuseUnlessManageable(await findBookingToManage(prisma, bookingId), now)
    throw new ConflictError('This booking can no longer be cancelled.')
  }

  publishBookingChange()
  return findBookingDto(bookingId, now)
}

/**
 * The resources a booking can move to: online, of the same type, not the one it
 * is on, and with no holding booking (requested, booked or checked in)
 * overlapping its time. A snapshot: reassignBooking re-checks under a lock.
 */
export async function listReassignOptions(bookingId: string, now = new Date()): Promise<ReassignOption[]> {
  const booking = await findBookingToManage(prisma, bookingId)
  refuseUnlessManageable(booking, now)

  return prisma.resource.findMany({
    where: {
      type: booking.resource.type,
      id: { not: booking.resourceId },
      status: 'available',
      bookings: { none: { status: { in: HOLDING_STATUSES }, startTime: { lt: booking.endTime }, endTime: { gt: booking.startTime } } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, location: true, capacity: true },
  })
}

/**
 * Moves a booking to another resource of the same type, keeping its time, and
 * records the name of the resource it left and when. Takes the target's
 * advisory lock first, the way createBooking does, so simultaneous moves onto
 * one resource queue up and the losers fail cleanly on the no_overlapping_bookings
 * constraint (23P01) instead of being aborted as deadlock victims.
 */
export async function reassignBooking(bookingId: string, resourceId: string, now = new Date()): Promise<AdminBookingDto> {
  try {
    await prisma.$transaction(async (tx) => {
      // $executeRaw, not $queryRaw: the function returns void, which Prisma
      // cannot deserialize as a result column.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${resourceId}))`

      const booking = await findBookingToManage(tx, bookingId)
      refuseUnlessManageable(booking, now)
      const target = await tx.resource.findUnique({ where: { id: resourceId } })
      if (!target) throw new NotFoundError('Resource')
      if (target.status === 'offline') throw new ConflictError('That resource is offline.')
      if (target.type !== booking.resource.type) throw new ValidationError('A booking can only move to a resource of the same type.')
      if (target.id === booking.resourceId) throw new ValidationError('That booking is already on that resource.')

      // Conditional on the status and the resource just read: a student who
      // checked in, or another librarian who moved it, wins and this one refuses.
      const { count } = await tx.resourceBooking.updateMany({
        where: { id: bookingId, status: 'booked', resourceId: booking.resourceId },
        data: { resourceId, movedFromName: booking.resource.name, movedAt: now },
      })
      if (count === 0) {
        refuseUnlessManageable(await findBookingToManage(tx, bookingId), now)
        // Still booked, so it was moved to another resource in the meantime.
        throw new ConflictError('This booking was just moved.')
      }
    })
  } catch (e) {
    if (isExclusionViolation(e)) throw new ConflictError('That resource is taken at this time.')
    throw e
  }

  publishBookingChange()
  return findBookingDto(bookingId, now)
}
