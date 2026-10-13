import { GRACE_PERIOD_MINUTES, RELIABILITY_ONTIME_BOOKING_BONUS, TIME_SLOTS } from '../config/constants'
import { Prisma } from '../generated/prisma/client'
import type { ResourceBooking, ResourceType } from '../generated/prisma/client'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { applyReliabilityDelta } from './reliabilityService'

export interface BookingDto {
  id: string
  userId: string
  resourceId: string
  resourceName: string
  resourceType: string
  startTime: Date
  endTime: Date
  status: string
  frontendStatus: 'upcomingFar' | 'inWindow' | 'checkedIn' | 'released'
  graceRemainingSeconds: number
  checkedInAt: Date | null
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
// row (checked_in is handled separately by the caller, which has the raw
// status). No scheduler runs in this phase, so 'released' is purely a
// read-time label -- the DB status stays 'booked' regardless.
function computeWindow(startTime: Date, gracePeriodMinutes: number, now: Date): { frontendStatus: 'upcomingFar' | 'inWindow' | 'released'; graceRemainingSeconds: number } {
  const graceEnd = new Date(startTime.getTime() + gracePeriodMinutes * 60 * 1000)
  if (now < startTime) return { frontendStatus: 'upcomingFar', graceRemainingSeconds: 0 }
  if (now <= graceEnd) return { frontendStatus: 'inWindow', graceRemainingSeconds: Math.floor((graceEnd.getTime() - now.getTime()) / 1000) }
  return { frontendStatus: 'released', graceRemainingSeconds: 0 }
}

function toBookingDto(booking: ResourceBooking & { resource: { name: string; type: string } }, now: Date): BookingDto {
  const window = computeWindow(booking.startTime, booking.gracePeriodMinutes, now)
  const frontendStatus = booking.status === 'checked_in' ? 'checkedIn' : window.frontendStatus

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
      where: { resourceId: resource.id, status: { in: ['booked', 'checked_in'] }, startTime: { lt: dayEnd }, endTime: { gt: dayStart } },
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
      where: { resourceId: other.id, status: { in: ['booked', 'checked_in'] }, startTime: { lt: endTime }, endTime: { gt: startTime } },
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
        data: { userId, resourceId, startTime, endTime },
        include: { resource: { select: { name: true, type: true } } },
      })
    })
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
  const bookings = await prisma.resourceBooking.findMany({
    where: { userId, status: { not: 'cancelled' } },
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
  return toBookingDto(updated, now)
}

export async function cancelBooking(userId: string, bookingId: string): Promise<BookingDto> {
  const booking = await getOwnedBooking(userId, bookingId)
  if (booking.status !== 'booked') throw new ConflictError('This booking cannot be cancelled.')

  const updated = await prisma.resourceBooking.update({
    where: { id: bookingId },
    data: { status: 'cancelled' },
    include: { resource: { select: { name: true, type: true } } },
  })
  return toBookingDto(updated, new Date())
}
