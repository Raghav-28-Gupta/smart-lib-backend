// The librarian's side of bookings. The list shows each booking as the student
// app would: the status is worked out at read time from the stored status, the
// booking's own times and its grace period (no scheduler rewrites rows), so the
// status filter has to run in SQL too. One query returns a page with its
// student and resource and, through count(*) OVER(), the total behind the
// filters, so a page costs one round trip however many rows it holds.
import { Prisma } from '../generated/prisma/client'
import { prisma } from '../lib/prisma'

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
 * The FROM and WHERE shared by the page query and the total-only query: every
 * listed booking with its student, resource and derived status, narrowed by the
 * status filter and the search. Values go in as bound parameters, never text.
 */
function filteredBookings(q: Pick<AdminBookingListQuery, 'search' | 'status'>, now: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = []
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
      WHERE b.status IN ${LISTED_STATUSES}
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
