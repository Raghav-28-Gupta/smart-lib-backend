import { GRACE_PERIOD_MINUTES, RELIABILITY_ONTIME_BOOKING_BONUS, REQUEST_OUTCOME_VISIBLE_DAYS, TIME_SLOTS } from '../config/constants'
import { Prisma } from '../generated/prisma/client'
import type { BookingStatus, ResourceBooking, ResourceType } from '../generated/prisma/client'
import { publish, publishActivity } from '../lib/events'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { dayLabel, slotLabel } from '../lib/timeLabels'
import { applyReliabilityDelta } from './reliabilityService'
import { expireStaleRequests } from './requestHolds'

export interface BookingDto {
  id: string
  userId: string
  resourceId: string
  resourceName: string
  resourceType: string
  startTime: Date
  endTime: Date
  status: string
  frontendStatus: 'requested' | 'declined' | 'expired' | 'upcomingFar' | 'inWindow' | 'checkedIn' | 'released'
  graceRemainingSeconds: number
  checkedInAt: Date | null
  /** A room request's deadline: its start plus the grace period. Null otherwise. */
  expiresAt: Date | null
  /** Set only on a declined request, and only if the librarian gave one. */
  declineReason: string | null
}

/**
 * The statuses that occupy a slot. The no_overlapping_bookings constraint
 * covers exactly these, so availability and conflict alternatives use them too.
 */
export const HOLDING_STATUSES: BookingStatus[] = ['requested', 'booked', 'checked_in']

/** When a booking's check-in window closes -- and when a room request for it lapses. */
export function graceEnd(booking: { startTime: Date; gracePeriodMinutes: number }): Date {
  return new Date(booking.startTime.getTime() + booking.gracePeriodMinutes * 60 * 1000)
}

interface BookingAlternative {
  resourceId: string
  resourceName: string
  resourceType: string
  timeSlot: string
  startTime: string
  endTime: string
}

// Prisma 7's driver-adapter path doesn't structurally expose the underlying
// SQLSTATE for constraint types it doesn't model itself (unlike P2002/P2025,
// which get their own known codes) -- an EXCLUDE-constraint violation surfaces
// as a generic P2039 "Database error" wrapper with the real code only present
// in the message text. Matching on it here is the only reliable option.
function isExclusionViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2039' &&
    e.message.includes('23P01') &&
    e.message.includes('no_overlapping_bookings')
  )
}

function localDateParts(d: Date): { year: number; month: number; day: number } {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
}

function slotForHour(hour: number) {
  return TIME_SLOTS.find((s) => s.hour === hour)
}

// Computes the frontend's window-based status/countdown for a still-'booked'
// row (checked_in and the request statuses are handled by the caller, which
// has the raw status). No scheduler releases bookings, so 'released' is purely
// a read-time label -- the DB status stays 'booked' regardless.
function computeWindow(startTime: Date, gracePeriodMinutes: number, now: Date): { frontendStatus: 'upcomingFar' | 'inWindow' | 'released'; graceRemainingSeconds: number } {
  const end = graceEnd({ startTime, gracePeriodMinutes })
  if (now < startTime) return { frontendStatus: 'upcomingFar', graceRemainingSeconds: 0 }
  if (now <= end) return { frontendStatus: 'inWindow', graceRemainingSeconds: Math.floor((end.getTime() - now.getTime()) / 1000) }
  return { frontendStatus: 'released', graceRemainingSeconds: 0 }
}

function toBookingDto(booking: ResourceBooking & { resource: { name: string; type: string } }, now: Date): BookingDto {
  const window = computeWindow(booking.startTime, booking.gracePeriodMinutes, now)
  const frontendStatus: BookingDto['frontendStatus'] =
    booking.status === 'requested' || booking.status === 'declined' || booking.status === 'expired'
      ? booking.status
      : booking.status === 'checked_in'
        ? 'checkedIn'
        : window.frontendStatus

  return {
    id: booking.id,
    userId: booking.userId,
    resourceId: booking.resourceId,
    resourceName: booking.resource.name,
    resourceType: booking.resource.type,
    startTime: booking.startTime,
    endTime: booking.endTime,
    status: booking.status,
    frontendStatus,
    graceRemainingSeconds: frontendStatus === 'inWindow' ? window.graceRemainingSeconds : 0,
    checkedInAt: booking.checkedInAt,
    expiresAt: booking.status === 'requested' ? graceEnd(booking) : null,
    declineReason: booking.status === 'declined' ? booking.declineReason : null,
  }
}

// Suggests up to two alternatives for a slot that just conflicted: the same
// resource's next free slot that day, and another same-type resource that's
// free for the exact requested window. Assumes 1-hour slot granularity for
// the same-resource suggestion (the frontend's kTimeSlots vocabulary); a
// non-hour-long request just skips that half and still tries the other.
// Never suggests a window that has already started: on today's date the
// earliest free slots are usually in the past, and taking one would create a
// booking released by the grace period almost at once.
async function findAlternatives(
  resource: { id: string; type: ResourceType; name: string },
  startTime: Date,
  endTime: Date,
  now: Date,
): Promise<BookingAlternative[]> {
  const alternatives: BookingAlternative[] = []
  const { year, month, day } = localDateParts(startTime)
  const dayStart = new Date(year, month - 1, day, 0, 0, 0)
  const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0)
  const isOneHourSlot = endTime.getTime() - startTime.getTime() === 60 * 60 * 1000

  if (isOneHourSlot) {
    const sameResourceBookings = await prisma.resourceBooking.findMany({
      where: { resourceId: resource.id, status: { in: HOLDING_STATUSES }, startTime: { lt: dayEnd }, endTime: { gt: dayStart } },
      select: { startTime: true, endTime: true },
    })
    const requestedHour = startTime.getHours()
    const freeSlot = TIME_SLOTS.find(({ hour }) => {
      if (hour === requestedHour) return false
      const slotStart = new Date(year, month - 1, day, hour, 0, 0)
      if (slotStart <= now) return false
      const slotEnd = new Date(year, month - 1, day, hour + 1, 0, 0)
      return !sameResourceBookings.some((b) => b.startTime < slotEnd && b.endTime > slotStart)
    })
    if (freeSlot) {
      const altStart = new Date(year, month - 1, day, freeSlot.hour, 0, 0)
      const altEnd = new Date(year, month - 1, day, freeSlot.hour + 1, 0, 0)
      alternatives.push({
        resourceId: resource.id,
        resourceName: resource.name,
        resourceType: resource.type,
        timeSlot: freeSlot.label,
        startTime: altStart.toISOString(),
        endTime: altEnd.toISOString(),
      })
    }
  }

  // Same window elsewhere is only useful if the window is still ahead.
  const otherResources = startTime <= now ? [] : await prisma.resource.findMany({
    where: { type: resource.type, id: { not: resource.id } },
    orderBy: { name: 'asc' },
  })
  for (const other of otherResources) {
    const overlapping = await prisma.resourceBooking.findFirst({
      where: { resourceId: other.id, status: { in: HOLDING_STATUSES }, startTime: { lt: endTime }, endTime: { gt: startTime } },
    })
    if (!overlapping) {
      const slot = slotForHour(startTime.getHours())
      alternatives.push({
        resourceId: other.id,
        resourceName: other.name,
        resourceType: other.type,
        timeSlot: slot?.label ?? startTime.toISOString(),
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      })
      break
    }
  }

  return alternatives
}

export async function createBooking(userId: string, resourceId: string, startTime: Date, endTime: Date): Promise<BookingDto> {
  if (endTime <= startTime) throw new ValidationError('endTime must be after startTime.')

  // A slot whose check-in window has closed can only ever be released, never
  // used. The current slot stays bookable while it can still be checked into
  // -- the same rule the client uses to grey out past slots.
  const now = new Date()
  if (now.getTime() > startTime.getTime() + GRACE_PERIOD_MINUTES * 60 * 1000) {
    throw new ValidationError('That time slot has already passed. Pick a later one.')
  }

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } })
  if (!resource) throw new NotFoundError('Resource')
  // Rooms wait for a librarian (and hold the slot meanwhile); seats are booked at once.
  const isRoom = resource.type === 'room'

  try {
    // The no_overlapping_bookings constraint is what guarantees no double
    // booking. But when several requests insert overlapping rows at the same
    // instant, Postgres can abort the losers with a deadlock (40P01) while they
    // wait on each other's uncommitted rows, instead of the clean exclusion
    // violation (23P01) -- a 500 here, and about a second of waiting per
    // victim. Taking a per-resource lock first makes concurrent attempts for
    // one resource queue up: each loser then sees the winner's committed row
    // and fails fast with 23P01. Other resources are unaffected. The lock is
    // released automatically at commit or rollback.
    const booking = await prisma.$transaction(async (tx) => {
      // $executeRaw, not $queryRaw: the function returns void, which Prisma
      // cannot deserialize as a result column.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${resourceId}))`
      return tx.resourceBooking.create({
        data: { userId, resourceId, startTime, endTime, status: isRoom ? 'requested' : 'booked', requestedAt: now },
        include: { resource: { select: { name: true, type: true } }, user: { select: { name: true } } },
      })
    })
    if (isRoom) {
      publish({
        type: 'request.created',
        topics: ['requests'],
        kind: 'room',
        summary: `${booking.user.name} wants ${booking.resource.name} · ${dayLabel(startTime)} · ${slotLabel(startTime, endTime)}`,
      })
    } else {
      publishActivity()
    }
    return toBookingDto(booking, now)
  } catch (e) {
    if (isExclusionViolation(e)) {
      const alternatives = await findAlternatives(resource, startTime, endTime, now)
      throw new ConflictError('This resource is already booked for that time.', { alternatives })
    }
    throw e
  }
}

export async function listMyBookings(userId: string): Promise<BookingDto[]> {
  const now = new Date()
  await expireStaleRequests(now)
  const since = new Date(now.getTime() - REQUEST_OUTCOME_VISIBLE_DAYS * 24 * 60 * 60 * 1000)
  const bookings = await prisma.resourceBooking.findMany({
    where: {
      userId,
      OR: [
        { status: { notIn: ['cancelled', 'declined', 'expired'] } },
        // A request's answer stays visible for a week.
        { status: { in: ['declined', 'expired'] }, decidedAt: { gte: since } },
      ],
    },
    include: { resource: { select: { name: true, type: true } } },
    orderBy: { startTime: 'asc' },
  })
  return bookings.map((b) => toBookingDto(b, now))
}

async function getOwnedBooking(userId: string, bookingId: string) {
  const booking = await prisma.resourceBooking.findUnique({
    where: { id: bookingId },
    include: { resource: { select: { name: true, type: true } } },
  })
  if (!booking) throw new NotFoundError('Booking')
  if (booking.userId !== userId) throw new ForbiddenError('This booking belongs to another user.')
  return booking
}

export async function checkInBooking(userId: string, bookingId: string): Promise<BookingDto> {
  const booking = await getOwnedBooking(userId, bookingId)
  if (booking.status !== 'booked') throw new ConflictError('This booking cannot be checked into.')

  const now = new Date()
  const window = computeWindow(booking.startTime, booking.gracePeriodMinutes, now)
  if (window.frontendStatus === 'upcomingFar') throw new ConflictError('Check-in opens at the start of your booking window.')
  if (window.frontendStatus === 'released') throw new ConflictError('The grace period for this booking has passed.')

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.resourceBooking.update({
      where: { id: bookingId },
      data: { status: 'checked_in', checkedInAt: now },
      include: { resource: { select: { name: true, type: true } } },
    })
    await applyReliabilityDelta(tx, userId, RELIABILITY_ONTIME_BOOKING_BONUS, 'On-time check-in for a resource booking')
    return result
  })
  publishActivity()
  return toBookingDto(updated, now)
}

export async function cancelBooking(userId: string, bookingId: string): Promise<BookingDto> {
  const booking = await getOwnedBooking(userId, bookingId)
  if (booking.status !== 'booked' && booking.status !== 'requested') {
    throw new ConflictError('This booking cannot be cancelled.')
  }

  const now = new Date()
  const withdrawing = booking.status === 'requested'
  // Conditional on the status just read, so a librarian's decision landing at
  // the same moment wins cleanly instead of being overwritten.
  const { count } = await prisma.resourceBooking.updateMany({
    where: { id: bookingId, status: booking.status },
    data: withdrawing ? { status: 'cancelled', decidedAt: now } : { status: 'cancelled' },
  })
  if (count === 0) throw new ConflictError('This booking cannot be cancelled.')

  const updated = await prisma.resourceBooking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { resource: { select: { name: true, type: true } } },
  })
  if (withdrawing) publish({ type: 'request.cancelled', topics: ['requests'], kind: 'room' })
  else publishActivity()
  return toBookingDto(updated, now)
}
