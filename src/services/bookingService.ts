import { GRACE_PERIOD_MINUTES, NO_SHOW_DISPUTE_DAYS, RELIABILITY_ONTIME_BOOKING_BONUS, REQUEST_OUTCOME_VISIBLE_DAYS, TIME_SLOTS } from '../config/constants'
import { Prisma } from '../generated/prisma/client'
import type { BookingStatus, NoShowDisputeStatus, ResourceBooking, ResourceType } from '../generated/prisma/client'
import { publish, publishBookingChange } from '../lib/events'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/httpError'
import { prisma } from '../lib/prisma'
import { dayLabel, slotLabel } from '../lib/timeLabels'
import { logScoringFailure, scoreBooking } from './noShowScoring'
import { sweepIfDue } from './noShowService'
import { applyReliabilityDelta } from './reliabilityService'
import { isReportableBooking } from './reportService'
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
  frontendStatus: 'requested' | 'declined' | 'expired' | 'cancelledByLibrary' | 'upcomingFar' | 'inWindow' | 'checkedIn' | 'released'
  graceRemainingSeconds: number
  checkedInAt: Date | null
  /** A room request's deadline: its start plus the grace period. Null otherwise. */
  expiresAt: Date | null
  /** Set only on a declined request, and only if the librarian gave one. */
  declineReason: string | null
  /** Set only when the library cancelled the booking, and only if the librarian gave a reason. */
  cancelReason: string | null
  /** The name of the resource the library moved this booking from, for REQUEST_OUTCOME_VISIBLE_DAYS after the move. Null otherwise. */
  movedFrom: string | null
  /** This booking entitles the student to report its resource (reportService.isReportableBooking) and they have no open report on it. */
  canReport: boolean
  /** The student has an open report on this booking's resource. */
  reportOpen: boolean
  /** Null unless the booking is a recorded no-show or carries a no-show dispute (see noShowInfo). */
  noShow: NoShowInfo | null
}

/** What a student's booking says about a recorded no-show and their dispute of it. */
export interface NoShowInfo {
  /** A recorded no-show, inside the dispute window, with no dispute yet. */
  canDispute: boolean
  /** The student's dispute of it, if any; `note` is the librarian's answer (null while it is open). */
  dispute: { status: NoShowDisputeStatus; note: string | null } | null
}

type ReportFlags = Pick<BookingDto, 'canReport' | 'reportOpen'>

/**
 * The statuses that occupy a slot. The no_overlapping_bookings constraint
 * covers exactly these, so availability and conflict alternatives use them too.
 */
export const HOLDING_STATUSES: BookingStatus[] = ['requested', 'booked', 'checked_in']

/** What a student is told about a booking whose grace period has ended (the librarian's cancel says the same for a released one). */
const RELEASED_MESSAGE = 'This booking has already been released.'

/** When a booking's check-in window closes -- and when a room request for it lapses. */
export function graceEnd(booking: { startTime: Date; gracePeriodMinutes: number }): Date {
  return new Date(booking.startTime.getTime() + booking.gracePeriodMinutes * 60 * 1000)
}

/**
 * The last instant a student may dispute a recorded no-show: NO_SHOW_DISPUTE_DAYS after the
 * booking's own grace end. Computed from the booking's start and grace period, never from when the
 * sweep happened to run, so a late sweep does not move it and no column is needed.
 */
export function noShowDisputeDeadline(booking: { startTime: Date; gracePeriodMinutes: number }): Date {
  return new Date(graceEnd(booking).getTime() + NO_SHOW_DISPUTE_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * The `noShow` of a booking response. Null for every booking that is not a recorded no-show and has
 * no no-show dispute. Otherwise `dispute` is the student's dispute (status, and the librarian's
 * note once answered) and `canDispute` is true only for a `no_show` booking inside the window with
 * no dispute yet. An overturned dispute leaves the booking `released`, and its card must keep
 * saying what happened, so a dispute makes `noShow` non-null whatever the booking's status is.
 */
export function noShowInfo(
  booking: { status: BookingStatus; startTime: Date; gracePeriodMinutes: number },
  dispute: { status: NoShowDisputeStatus; resolutionNote: string | null } | null,
  now: Date,
): NoShowInfo | null {
  if (dispute) return { canDispute: false, dispute: { status: dispute.status, note: dispute.resolutionNote } }
  if (booking.status !== 'no_show') return null
  return { canDispute: now <= noShowDisputeDeadline(booking), dispute: null }
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
export function isExclusionViolation(e: unknown): boolean {
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
// has the raw status). 'released' is the label for a row whose grace period
// has passed, whatever the stored status is: the no-show sweep
// (noShowService.sweepBookings) turns such a row into 'no_show' in the
// database, but it runs about once a minute, so until it has, the stored
// status is still 'booked' and this read-time label is what the student sees.
function computeWindow(startTime: Date, gracePeriodMinutes: number, now: Date): { frontendStatus: 'upcomingFar' | 'inWindow' | 'released'; graceRemainingSeconds: number } {
  const end = graceEnd({ startTime, gracePeriodMinutes })
  if (now < startTime) return { frontendStatus: 'upcomingFar', graceRemainingSeconds: 0 }
  if (now <= end) return { frontendStatus: 'inWindow', graceRemainingSeconds: Math.floor((end.getTime() - now.getTime()) / 1000) }
  return { frontendStatus: 'released', graceRemainingSeconds: 0 }
}

// How far back an outcome the student did not cause (a decline, an expiry, a
// library cancel or move) is still shown to them.
function outcomeVisibleSince(now: Date): Date {
  return new Date(now.getTime() - REQUEST_OUTCOME_VISIBLE_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * canReport and reportOpen for each of the student's bookings, in order, from one
 * lookup of their open reports on those bookings' resources: the cost does not grow
 * with the number of bookings. reportOpen is the resource's (every booking of a
 * reported desk says so); canReport is the booking's own (it qualifies by itself, and
 * the student has no open report on its resource), so it is true exactly when
 * POST /reports for that resource would be accepted because of this booking.
 */
async function reportFlags(
  userId: string,
  bookings: ReadonlyArray<Pick<ResourceBooking, 'resourceId' | 'status' | 'startTime'>>,
  now: Date,
): Promise<ReportFlags[]> {
  if (bookings.length === 0) return []
  const open = await prisma.issueReport.findMany({
    where: { userId, status: 'open', resourceId: { in: [...new Set(bookings.map((b) => b.resourceId))] } },
    select: { resourceId: true },
  })
  const reported = new Set(open.map((r) => r.resourceId))
  return bookings.map((b) => {
    const reportOpen = reported.has(b.resourceId)
    return { canReport: !reportOpen && isReportableBooking(b, now), reportOpen }
  })
}

/**
 * What every booking response loads with the booking row: its resource, and its no-show dispute
 * (at most one) in the same query, so a list of bookings costs one read however many were disputed.
 */
const BOOKING_INCLUDE = {
  resource: { select: { name: true, type: true } },
  noShowDispute: { select: { status: true, resolutionNote: true } },
} satisfies Prisma.ResourceBookingInclude

type BookingRow = ResourceBooking & {
  resource: { name: string; type: string }
  noShowDispute: { status: NoShowDisputeStatus; resolutionNote: string | null } | null
}

function toBookingDto(booking: BookingRow, now: Date, flags: ReportFlags): BookingDto {
  const window = computeWindow(booking.startTime, booking.gracePeriodMinutes, now)
  // The library cancelled it exactly when cancelledById is set: a student's own cancel leaves it null.
  const cancelledByLibrary = booking.status === 'cancelled' && booking.cancelledById !== null
  const frontendStatus: BookingDto['frontendStatus'] = cancelledByLibrary
    ? 'cancelledByLibrary'
    : booking.status === 'requested' || booking.status === 'declined' || booking.status === 'expired'
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
    cancelReason: cancelledByLibrary ? booking.cancelReason : null,
    movedFrom: booking.movedAt !== null && booking.movedAt >= outcomeVisibleSince(now) ? booking.movedFromName : null,
    noShow: noShowInfo(booking, booking.noShowDispute, now),
    ...flags,
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

  // Same window elsewhere is only useful if the window is still ahead, and an
  // offline resource takes no new bookings.
  const otherResources = startTime <= now ? [] : await prisma.resource.findMany({
    where: { type: resource.type, id: { not: resource.id }, status: 'available' },
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
  // Offline means no new bookings. Bookings made before it went offline stay.
  if (resource.status === 'offline') throw new ConflictError('This resource is offline right now.')
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
        include: { ...BOOKING_INCLUDE, user: { select: { name: true } } },
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
      publishBookingChange()
    }
    const [flags] = await reportFlags(userId, [booking], now)
    const dto = toBookingDto(booking, now, flags)
    // The no-show prediction (a seat's and a room's), off the request path: started only now, after the
    // commit and with the answer in hand, and never awaited, so a slow or dead AI service costs this
    // request nothing. It never throws (and does nothing without AI_BACKEND_URL); the catch is the net.
    void scoreBooking(booking.id).catch((error) => logScoringFailure(booking.id, error))
    return dto
  } catch (e) {
    if (isExclusionViolation(e)) {
      const alternatives = await findAlternatives(resource, startTime, endTime, now)
      throw new ConflictError('This resource is already booked for that time.', { alternatives })
    }
    throw e
  }
}

export async function listMyBookings(userId: string): Promise<BookingDto[]> {
  // In the background and never awaited: this read still shows a just-missed booking as
  // released; the next one shows the recorded no-show (see sweepIfDue).
  sweepIfDue()
  const now = new Date()
  await expireStaleRequests(now)
  const since = outcomeVisibleSince(now)
  const bookings = await prisma.resourceBooking.findMany({
    where: {
      userId,
      OR: [
        { status: { notIn: ['cancelled', 'declined', 'expired'] } },
        // A request's answer stays visible for a week.
        { status: { in: ['declined', 'expired'] }, decidedAt: { gte: since } },
        // So does a booking the library cancelled. A student's own cancel leaves
        // cancelledById null and stays hidden.
        { status: 'cancelled', cancelledById: { not: null }, cancelledAt: { gte: since } },
      ],
    },
    include: BOOKING_INCLUDE,
    orderBy: { startTime: 'asc' },
  })
  const flags = await reportFlags(userId, bookings, now)
  return bookings.map((b, i) => toBookingDto(b, now, flags[i]))
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
  sweepIfDue()
  const booking = await getOwnedBooking(userId, bookingId)
  if (booking.status !== 'booked') throw new ConflictError('This booking cannot be checked into.')

  const now = new Date()
  const window = computeWindow(booking.startTime, booking.gracePeriodMinutes, now)
  if (window.frontendStatus === 'upcomingFar') throw new ConflictError('Check-in opens at the start of your booking window.')
  if (window.frontendStatus === 'released') throw new ConflictError('The grace period for this booking has passed.')

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional on the status just read, like cancelBooking: a librarian's
    // cancel or a release landing between that read and this write wins cleanly,
    // instead of being overwritten by a check-in (and rewarded with the bonus).
    const { count } = await tx.resourceBooking.updateMany({
      where: { id: bookingId, status: 'booked' },
      data: { status: 'checked_in', checkedInAt: now },
    })
    if (count === 0) return null
    // A booking the AI scored when it was made has a NoShowEvent: the student came, so the
    // labelled record says so (no event, nothing to do: this never creates one). It sits
    // between the booking write above and the student's lock below on purpose: the sweep
    // takes booking, event, student, and so must this, or the two could wait in a circle.
    await tx.noShowEvent.updateMany({ where: { resourceBookingId: bookingId }, data: { actualNoShow: false } })
    await applyReliabilityDelta(tx, userId, RELIABILITY_ONTIME_BOOKING_BONUS, 'On-time check-in for a resource booking')
    return tx.resourceBooking.findUniqueOrThrow({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    })
  })
  if (!updated) throw new ConflictError('This booking cannot be checked into.')
  publishBookingChange()
  const [flags] = await reportFlags(userId, [updated], now)
  return toBookingDto(updated, now, flags)
}

export async function cancelBooking(userId: string, bookingId: string): Promise<BookingDto> {
  sweepIfDue()
  const booking = await getOwnedBooking(userId, bookingId)
  // A recorded no-show and a plain release are the same fact the grace rule below names for a
  // booking whose grace period has just ended and has not been swept yet: one reason, whichever
  // side of the sweep the student pressed Cancel on (and the one the librarian's cancel uses).
  if (booking.status === 'no_show' || booking.status === 'released') throw new ConflictError(RELEASED_MESSAGE)
  if (booking.status !== 'booked' && booking.status !== 'requested') {
    throw new ConflictError('This booking cannot be cancelled.')
  }

  const now = new Date()
  const withdrawing = booking.status === 'requested'
  // Once the grace period has ended a booked slot is a missed one: cancelling it now would
  // dodge the no-show the sweep is about to record. Strictly after the grace end, like a
  // check-in's released window, so at the very end the student can still cancel; before it,
  // even after the start, a cancel is allowed and costs nothing. A room REQUEST is
  // withdrawn under its own lapse rules (expireStaleRequests), so it is exempt.
  if (!withdrawing && now > graceEnd(booking)) throw new ConflictError(RELEASED_MESSAGE)
  // Conditional on the status just read, so a librarian's decision landing at
  // the same moment wins cleanly instead of being overwritten.
  const { count } = await prisma.resourceBooking.updateMany({
    where: { id: bookingId, status: booking.status },
    data: withdrawing ? { status: 'cancelled', decidedAt: now } : { status: 'cancelled' },
  })
  if (count === 0) {
    // Someone else's write landed between the read and this one: say what it was. When it was the
    // sweep recording the no-show, it is the released wording; a librarian's cancel or a check-in
    // keeps the generic one.
    const current = await prisma.resourceBooking.findUnique({ where: { id: bookingId }, select: { status: true } })
    const released = current?.status === 'no_show' || current?.status === 'released'
    throw new ConflictError(released ? RELEASED_MESSAGE : 'This booking cannot be cancelled.')
  }

  const updated = await prisma.resourceBooking.findUniqueOrThrow({
    where: { id: bookingId },
    include: BOOKING_INCLUDE,
  })
  if (withdrawing) publish({ type: 'request.cancelled', topics: ['requests'], kind: 'room' })
  else publishBookingChange()
  const [flags] = await reportFlags(userId, [updated], now)
  return toBookingDto(updated, now, flags)
}
