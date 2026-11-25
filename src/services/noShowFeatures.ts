// The ten features of a booking, built from the database (slice 7; spec
// 2026-11-24-no-show-handling-design.md, section 6, "Feature definitions").
//
// The Python twin is `features_from_history` in ai-backend/app/ml/noshow/history.py, which the
// simulator also uses to build its training rows: what the model is trained on is what it is
// later asked about. The shared fixture (test/fixtures/noshow-features.json, a byte-identical
// copy of ai-backend/tests/fixtures/noshow_features.json) pins the two to the same definitions;
// change a definition in both places and in the fixture, or in none.
//
// For a booking scored at `now` (the booking itself is never part of its own history):
//  - attended: one of the student's other bookings that STARTED in the 90 days before `now`
//    (`now - 90 d <= startTime < now`) and is `checked_in` or `completed`, or is `released`
//    with a no-show dispute a librarian OVERTURNED (the student was there);
//  - missed: the same window, status `no_show`. Everything else (a plain `released` row from
//    before no-shows were recorded, `booked`, `requested`, cancelled, declined, expired) is
//    neither;
//  - past_attendance_ratio = attended / (attended + missed), or the 0.85 prior with neither;
//  - consecutive_attended_count = attended rows that start STRICTLY after the most recent miss
//    (all of them when there is no miss), at most 20;
//  - recent_noshows_count = misses with `now - 30 d <= startTime`, at most 10;
//  - bookings_last_30d = bookings MADE (requestedAt) in `now - 30 d <= requestedAt <= now`
//    whose status is not cancelled, declined or expired, at most 30;
//  - lead_time_hours = start minus the booking's OWN requestedAt (never `now`), at least 0;
//    duration_minutes = whole minutes from start to end; reliability_score as stored;
//  - hour_of_day and day_of_week are the start's, in the library's time zone, Monday = 0.
//
// Two reads, never one per row: the booking (with its resource's type and the student's score),
// then the student's other bookings in ONE typed `findMany` with each row's dispute selected.
// Typed on purpose: a raw read of a timestamptz column comes back shifted under a non-UTC
// session (Task 7), the typed read does not.
import { NO_SHOW_PRIOR_ATTENDANCE } from '../config/constants'
import type { NoShowFeatures } from '../lib/aiClient'
import { prisma } from '../lib/prisma'

export const HISTORY_DAYS = 90
export const RECENT_DAYS = 30
export const MAX_CONSECUTIVE_ATTENDED = 20
export const MAX_RECENT_NOSHOWS = 10
export const MAX_BOOKINGS_LAST_30D = 30

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Bookings that never took place: not part of anyone's history, and not "bookings made". */
const NOT_A_BOOKING = ['cancelled', 'declined', 'expired'] as const

// Intl's short English weekday names, Monday first: the index is the feature's day_of_week.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The server's own time zone (what `TZ` sets): the library's, until it has a setting of its own. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The hour (0 to 23) and the weekday (Monday = 0) of an instant on the wall clock of `timeZone`. */
function localHourAndWeekday(instant: Date, timeZone: string): { hour: number; dayOfWeek: number } {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    // hourCycle h23, so midnight is 0 and never 24; a RangeError here is an unknown zone name.
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', weekday: 'short' })
    formatters.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(instant)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value) % 24
  const dayOfWeek = WEEKDAYS.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? '')
  if (!Number.isInteger(hour) || dayOfWeek < 0) throw new Error(`Cannot read the local time in ${timeZone}`)
  return { hour, dayOfWeek }
}

/**
 * The ten features for the booking `bookingId`, for a prediction made at `now`.
 *
 * `now` anchors the history windows (90 and 30 days) and the bound on "made so far"; the lead
 * time is anchored on the booking's own `requestedAt`, so scoring it a little later changes
 * nothing. `timeZone` is the zone hour_of_day and day_of_week are read in: the server's own by
 * default (its `TZ`); the parameter exists so the shared fixture's cases, which carry a `tz`,
 * can be run on any machine without changing the process's environment.
 *
 * Throws when the booking does not exist (the caller, `scoreBooking`, never lets that out).
 */
export async function buildNoShowFeatures(bookingId: string, now: Date = new Date(), timeZone: string = serverTimeZone()): Promise<NoShowFeatures> {
  const booking = await prisma.resourceBooking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      userId: true,
      startTime: true,
      endTime: true,
      requestedAt: true,
      resource: { select: { type: true } },
      user: { select: { reliabilityScore: true } },
    },
  })

  const historyFrom = new Date(now.getTime() - HISTORY_DAYS * DAY_MS)
  const recentFrom = new Date(now.getTime() - RECENT_DAYS * DAY_MS)

  // The query only narrows: a row is needed either for attendance (it started inside the 90 days) or
  // for the count of bookings made (requested inside the 30 days). The exact bounds, the upper ones
  // included, are applied below, one row at a time, exactly as the Python twin does.
  const rows = await prisma.resourceBooking.findMany({
    where: {
      userId: booking.userId,
      id: { not: bookingId },
      status: { notIn: [...NOT_A_BOOKING] },
      OR: [{ startTime: { gte: historyFrom } }, { requestedAt: { gte: recentFrom } }],
    },
    select: { status: true, startTime: true, requestedAt: true, noShowDispute: { select: { status: true } } },
  })

  const nowMs = now.getTime()
  const historyFromMs = historyFrom.getTime()
  const recentFromMs = recentFrom.getTime()

  const attendedStarts: number[] = []
  let missed = 0
  let recentNoShows = 0
  let lastMiss: number | null = null
  let bookingsLast30d = 0

  for (const row of rows) {
    const start = row.startTime.getTime()
    const requested = row.requestedAt.getTime()

    if (requested >= recentFromMs && requested <= nowMs) bookingsLast30d += 1

    if (!(start >= historyFromMs && start < nowMs)) continue
    if (row.status === 'no_show') {
      missed += 1
      if (start >= recentFromMs) recentNoShows += 1
      if (lastMiss === null || start > lastMiss) lastMiss = start
    } else if (row.status === 'checked_in' || row.status === 'completed' || (row.status === 'released' && row.noShowDispute?.status === 'overturned')) {
      attendedStarts.push(start)
    }
  }

  const attended = attendedStarts.length
  const ratio = attended + missed === 0 ? NO_SHOW_PRIOR_ATTENDANCE : attended / (attended + missed)
  const consecutive = lastMiss === null ? attended : attendedStarts.filter((start) => start > lastMiss).length

  const { hour, dayOfWeek } = localHourAndWeekday(booking.startTime, timeZone)
  return {
    hour_of_day: hour,
    day_of_week: dayOfWeek,
    duration_minutes: Math.round((booking.endTime.getTime() - booking.startTime.getTime()) / MINUTE_MS),
    lead_time_hours: Math.max(0, (booking.startTime.getTime() - booking.requestedAt.getTime()) / HOUR_MS),
    resource_type: booking.resource.type,
    past_attendance_ratio: ratio,
    consecutive_attended_count: Math.min(consecutive, MAX_CONSECUTIVE_ATTENDED),
    recent_noshows_count: Math.min(recentNoShows, MAX_RECENT_NOSHOWS),
    reliability_score: booking.user.reliabilityScore,
    bookings_last_30d: Math.min(bookingsLast30d, MAX_BOOKINGS_LAST_30D),
  }
}
