// The sweep: finds the seat and room bookings nobody checked into and records
// them as no-shows (slice 7; spec 2026-11-24-no-show-handling-design.md, section 4).
//
// `sweepBookings(now)` is safe to run any number of times, at the same instant,
// from two places. Every status change is a conditional update on the status the
// sweep just read (`WHERE status = 'booked'`), one transaction per booking, so:
//   - a check-in landing at the same moment has exactly one winner (a booking the
//     student checked into is never penalized, and a booking the sweep recorded
//     cannot be checked into);
//   - two sweeps at once record a booking once (the loser's update matches nothing
//     and it writes, sends and publishes nothing for it);
//   - one booking that fails rolls back alone and is left for the next sweep.
//
// Lock order, the same in every writer that takes more than one of these (this sweep, a
// check-in, the scorer, an overturn): the booking row (the conditional update; FOR NO KEY
// UPDATE), then the dispute (the conditional `open` update, first; only a dispute's answer
// takes it), then the NoShowEvent row, then the student's row (applyReliabilityDelta locks it
// FOR UPDATE). This sweep takes the booking, the event, then the student, like `checkInBooking`.
//
// After every transaction has committed, and never inside one, each notice is
// emailed (deliverNotice never throws; 10 at a time) and only then are the live
// events published, once, so the console's refetch sees the true email status. A
// sweep that recorded nothing publishes nothing.
//
// The sweep has two steps, run one after the other, each on its own: (1) detect the
// missed bookings, as above; (2) send the "your booking starts soon" reminder. Step 2
// follows the same rules: a conditional update on the booking (`booked` and no
// reminder yet), one transaction per booking, a failing booking logged by id and left
// for the next sweep, the email only after the commit. It takes the booking row and
// inserts the notice and nothing else (no user lock), and it publishes no live event:
// a reminder changes nothing the console shows. Only a room's reminder is emailed (a
// library's seat bookings would burn a free mail plan); a seat's stays an in-app
// notice. A step that fails outright (its candidate query) does not take the other
// one's result with it (see sweepBookings).
import {
  GRACE_PERIOD_MINUTES,
  NO_SHOW_DISPUTE_DAYS,
  REMINDER_LEAD_MINUTES,
  RELIABILITY_NOSHOW_PENALTY,
  SWEEP_BATCH,
  SWEEP_LOOKBACK_HOURS,
} from '../config/constants'
import { Prisma, type Notice } from '../generated/prisma/client'
import { publishBookingChange, publishStudentChange } from '../lib/events'
import { prisma } from '../lib/prisma'
import { dayLabel, slotLabel } from '../lib/timeLabels'
import { createNotice, deliverNotice } from './noticeService'
import { applyReliabilityDelta, NO_SHOW_REASON_PREFIX } from './reliabilityService'

export const NO_SHOW_TITLE = 'Missed booking'
export const BOOKING_REMINDER_TITLE = 'Your booking starts soon'

/** The two steps of a sweep, as `failed` names them. */
export type SweepStep = 'record' | 'remind'

export interface SweepResult {
  noShows: number
  reminders: number
  /**
   * The record step's leftover (missed bookings still waiting for the next call). NOT a
   * "caught up" signal when `failed` is present: a record step that failed never counted
   * its leftover, so it reads 0 there.
   */
  remaining: number
  /**
   * The steps that failed, in step order: their candidate query failed outright (a database
   * error), or one or more of their bookings threw inside its own transaction (the counts
   * then hold only the bookings that succeeded).
   * PRESENT ONLY WHEN A STEP FAILED: a healthy result has no such key, not an empty one.
   * The other step's counts are real and its work has committed. Every caller must act on
   * it (the route answers 500, the timer and the lazy sweep log at error level): zero
   * counts next to `failed` mean "could not run", never "nothing to do".
   */
  failed?: SweepStep[]
}

const HOUR_MS = 60 * 60 * 1000
/** How many notices are emailed at once; the mailer bounds each at 5 seconds. */
const EMAIL_CONCURRENCY = 10

// Every per-booking transaction below gets these, not Prisma's defaults (2 s to get a
// connection, 5 s to finish): a no-show is about eleven round trips, so on a slow hop to
// the database the 5 s can run out, and if the latency stayed high no booking would ever
// be recorded (each one would roll back and be retried, and time out again).
export const SWEEP_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const

/** When a booking's grace period ends (the SQL twin of bookingService.graceEnd). Booking times are timestamptz. */
const GRACE_END = Prisma.sql`"startTime" + make_interval(mins => "gracePeriodMinutes")`

/**
 * A JS Date as the same instant in a SQL comparison with a `timestamptz` column,
 * whatever time zone the database SESSION is set to. Use it for EVERY date this
 * service binds against a booking time (the reminder step included).
 *
 * Why it exists: the pg driver adapter binds a Date as text with no offset (its UTC
 * wall-clock, "2026-11-24 09:36:49.080"). Written bare, `"startTime" < ${now}` makes
 * Postgres read that text as `timestamptz` in the session's zone, so on a session that
 * is not on UTC the instant moves by the zone's offset (Neon and the test database are
 * on UTC, which hides it). Here the text is read as a plain `timestamp` (no zone to
 * apply) and then declared to be UTC, which is what it is. The same rule the rest of
 * the date SQL follows (`${d}::timestamp`, see Fines in CLAUDE.md), so it needs no
 * other assumption about the adapter; `${d.toISOString()}::timestamptz` would work too
 * but would be a second way of doing it. Pinned under SET LOCAL TIME ZONE in
 * test/services/noShowSweep.test.ts.
 */
export function asUtcInstant(d: Date): Prisma.Sql {
  return Prisma.sql`(${d}::timestamp AT TIME ZONE 'UTC')`
}

type StepOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function attempt<T>(step: () => Promise<T>): Promise<StepOutcome<T>> {
  try {
    return { ok: true, value: await step() }
  } catch (error) {
    return { ok: false, error }
  }
}

// Why the log says the error's name and never its text: the text of a database
// error can carry the data of the row it was about.
const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown error')

/**
 * Runs one sweep: records the missed bookings, then sends the reminders. The two
 * steps are independent: each runs to its own end, so the other step's work is
 * never skipped or thrown away by a step's failure. A step is named in the result's
 * `failed` in two cases, and the counts of what DID succeed stay in the result:
 *  - its candidate query failed outright (a database error): it is logged by its
 *    error class and counts as zero;
 *  - the query worked but one or more of its bookings threw inside their own
 *    transaction (already logged by booking id and error class, and rolled back
 *    whole, left for the next sweep). That one must count too: when every
 *    transaction fails (a database so slow that each times out, a schema that
 *    drifted from the code) nothing throws out of the step, and without it every run
 *    would answer a green zero while the bookings aged out of the look-back
 *    unrecorded.
 * Only when BOTH steps' candidate queries fail is there nothing to report: both are
 * logged, and the sweep itself throws, so a database outage still shows as a failed
 * sweep and not as a quiet one.
 *
 * `remaining` is the first step's leftover (the missed bookings still waiting for
 * the next call); the reminders' leftover is not reported, it is picked up by the
 * next call since each unsent reminder stays a candidate until its booking starts.
 * Read `remaining: 0` as "caught up" only when `failed` is absent.
 */
export async function sweepBookings(now: Date = new Date()): Promise<SweepResult> {
  const detection = await attempt(() => detectNoShows(now))
  const reminding = await attempt(() => sendReminders(now))

  const failed: SweepStep[] = []
  if (!detection.ok) {
    failed.push('record')
    console.error(`no-show sweep: the record step failed (${errorName(detection.error)})`)
  } else if (detection.value.threw > 0) {
    failed.push('record')
  }
  if (!reminding.ok) {
    failed.push('remind')
    console.error(`no-show sweep: the reminder step failed (${errorName(reminding.error)})`)
  } else if (reminding.value.threw > 0) {
    failed.push('remind')
  }
  if (!detection.ok && !reminding.ok) throw detection.error

  return {
    noShows: detection.ok ? detection.value.noShows : 0,
    reminders: reminding.ok ? reminding.value.sent : 0,
    remaining: detection.ok ? detection.value.remaining : 0,
    // Absent, never empty, when nothing failed.
    ...(failed.length > 0 ? { failed } : {}),
  }
}

/** What the candidate queries need: the pool, or a transaction (a test runs them under SET LOCAL TIME ZONE). */
export type Queryable = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * The bookings still `booked` whose grace period ended strictly before `now` and
 * no more than SWEEP_LOOKBACK_HOURS ago: older ones are never penalized (the
 * migration turned them into plain `released` rows). Oldest grace end first, at
 * most SWEEP_BATCH of them; `remaining` is how many more there were.
 */
export async function findCandidates(db: Queryable, now: Date): Promise<{ ids: string[]; remaining: number }> {
  const batch = SWEEP_BATCH
  const lookbackStart = new Date(now.getTime() - SWEEP_LOOKBACK_HOURS * HOUR_MS)
  const eligible = Prisma.sql`status = 'booked' AND ${GRACE_END} < ${asUtcInstant(now)} AND ${GRACE_END} >= ${asUtcInstant(lookbackStart)}`

  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "ResourceBooking"
    WHERE ${eligible}
    ORDER BY ${GRACE_END}, id
    LIMIT ${batch}`)
  const ids = rows.map((r) => r.id)
  if (ids.length < batch) return { ids, remaining: 0 }

  // A full batch: count what is behind it, so the caller knows to come back.
  const [{ total }] = await db.$queryRaw<[{ total: number }]>(Prisma.sql`
    SELECT count(*)::int AS total FROM "ResourceBooking" WHERE ${eligible}`)
  return { ids, remaining: Math.max(0, total - ids.length) }
}

// "87.5" stays "87.5" and 90 stays "90". A score is whole in practice; the rounding
// only removes floating-point noise from a before-score worked out by subtraction. Exported for the
// dispute outcome's notice (noShowDisputeService), which names a score the same way.
export function scoreText(score: number): string {
  return String(Number(score.toFixed(2)))
}

function noShowBody(resource: string, startTime: Date, endTime: Date, before: number, after: number): string {
  return (
    `You didn't check in to ${resource} (${dayLabel(startTime)}, ${slotLabel(startTime, endTime)}), so the slot was released and a no-show was recorded. ` +
    `Your reliability score went from ${scoreText(before)} to ${scoreText(after)}. ` +
    `If this is wrong, you can dispute it from My Bookings within ${NO_SHOW_DISPUTE_DAYS} days.`
  )
}

/**
 * One booking, one transaction. Answers the notice it wrote, or null when the
 * booking was no longer `booked` (a check-in, a cancel or another sweep got there
 * first), in which case nothing at all was written.
 */
async function recordNoShow(bookingId: string): Promise<Notice | null> {
  return prisma.$transaction(async (tx) => {
    // Conditional on the status the candidate query read, so it has exactly one
    // winner against a check-in or another sweep. A competitor holding the row
    // makes this wait, then match nothing.
    const { count } = await tx.resourceBooking.updateMany({
      where: { id: bookingId, status: 'booked' },
      data: { status: 'no_show' },
    })
    if (count === 0) return null

    const booking = await tx.resourceBooking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { userId: true, startTime: true, endTime: true, resource: { select: { name: true } } },
    })
    const { userId } = booking

    // The labelled record a later retraining uses. A booking that was scored when it
    // was made already has an event: its probability stays. One never scored (the AI
    // service was down) has none, and gets an event with no probability.
    await tx.noShowEvent.upsert({
      where: { resourceBookingId: bookingId },
      create: { resourceBookingId: bookingId, userId, actualNoShow: true },
      update: { actualNoShow: true },
    })
    // Locks the student's row after the booking's, like a check-in. The score is
    // clamped, so what is applied may be less than the penalty: the event keeps
    // that, so an overturn gives back exactly what was taken.
    const { appliedDelta, score } = await applyReliabilityDelta(tx, userId, -RELIABILITY_NOSHOW_PENALTY, `${NO_SHOW_REASON_PREFIX}${booking.resource.name}`)
    await tx.noShowEvent.update({ where: { resourceBookingId: bookingId }, data: { reliabilityDelta: appliedDelta } })

    return createNotice(tx, {
      userId,
      kind: 'no_show',
      title: NO_SHOW_TITLE,
      body: noShowBody(booking.resource.name, booking.startTime, booking.endTime, score - appliedDelta, score),
      bookingId,
    })
  }, SWEEP_TX_OPTIONS)
}

/**
 * Records the missed bookings, emails the students and tells the console. Answers how many
 * it recorded, the leftover, and how many of its bookings THREW (`threw`: sweepBookings turns
 * a number above zero into `failed: ['record']`).
 */
async function detectNoShows(now: Date): Promise<{ noShows: number; remaining: number; threw: number }> {
  const { ids, remaining } = await findCandidates(prisma, now)

  const notices: Notice[] = []
  let threw = 0
  for (const id of ids) {
    try {
      const notice = await recordNoShow(id)
      if (notice) notices.push(notice)
    } catch (error) {
      // This booking's transaction rolled back as a whole and the next sweep tries it
      // again (it is still `booked`). Its id only: no student, resource or message.
      threw += 1
      console.error(`no-show sweep: booking ${id} failed (${errorName(error)})`)
    }
  }
  if (notices.length === 0) return { noShows: 0, remaining, threw }

  // Every transaction has committed. Email in chunks, then publish once.
  await emailAll(notices)
  publishBookingChange()
  publishStudentChange()
  return { noShows: notices.length, remaining, threw }
}

/** Emails committed notices, EMAIL_CONCURRENCY at a time (deliverNotice never throws and writes each outcome). */
async function emailAll(notices: Notice[]): Promise<void> {
  for (let i = 0; i < notices.length; i += EMAIL_CONCURRENCY) {
    await Promise.all(notices.slice(i, i + EMAIL_CONCURRENCY).map((notice) => deliverNotice(notice)))
  }
}

/**
 * The bookings that are due a "your booking starts soon" reminder, soonest start
 * first, at most SWEEP_BATCH:
 *  - `booked` (a room request nobody approved yet is `requested`, never reminded),
 *    and no reminder sent yet;
 *  - starting within REMINDER_LEAD_MINUTES from `now` and not yet started (a
 *    booking that has begun is never reminded, even inside its grace period);
 *  - made early enough: for a room the approval (`decidedAt`) is the time that
 *    counts, for a seat the booking (`requestedAt`), and it must be at least
 *    REMINDER_LEAD_MINUTES before the start. A room approved ten minutes before it
 *    starts, or a seat booked inside the window, has just been told and gets none.
 * `now` is bound through asUtcInstant, and the lead window is worked out in SQL from
 * it, so none of this depends on the database session's time zone.
 */
export async function findReminderCandidates(db: Queryable, now: Date): Promise<string[]> {
  const lead = Prisma.sql`make_interval(mins => ${REMINDER_LEAD_MINUTES}::int)`
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "ResourceBooking"
    WHERE status = 'booked'
      AND "reminderSentAt" IS NULL
      AND "startTime" > ${asUtcInstant(now)}
      AND "startTime" <= ${asUtcInstant(now)} + ${lead}
      AND COALESCE("decidedAt", "requestedAt") <= "startTime" - ${lead}
    ORDER BY "startTime", id
    LIMIT ${SWEEP_BATCH}`)
  return rows.map((r) => r.id)
}

interface SentReminder {
  notice: Notice
  room: boolean
}

function reminderBody(resource: string, startTime: Date, endTime: Date): string {
  return `${resource}, ${slotLabel(startTime, endTime)}. Check in within ${GRACE_PERIOD_MINUTES} minutes of the start or the slot is released.`
}

/**
 * One booking, one transaction. Answers its notice (and whether the resource is a
 * room), or null when the booking was no longer `booked` or had its reminder already
 * (a check-in, a cancel or another sweep got there first), in which case nothing at
 * all was written. The mark and the notice commit or roll back together, so a
 * reminder is never half-sent: it is either marked and written, or still due.
 */
async function sendReminder(bookingId: string, now: Date): Promise<SentReminder | null> {
  return prisma.$transaction(async (tx) => {
    // Conditional on both the status and the missing mark the candidate query read, so
    // it has exactly one winner against a check-in, a cancel or another sweep.
    const { count } = await tx.resourceBooking.updateMany({
      where: { id: bookingId, status: 'booked', reminderSentAt: null },
      data: { reminderSentAt: now },
    })
    if (count === 0) return null

    const booking = await tx.resourceBooking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { userId: true, startTime: true, endTime: true, resource: { select: { name: true, type: true } } },
    })
    const notice = await createNotice(tx, {
      userId: booking.userId,
      kind: 'booking_reminder',
      title: BOOKING_REMINDER_TITLE,
      body: reminderBody(booking.resource.name, booking.startTime, booking.endTime),
      bookingId,
    })
    return { notice, room: booking.resource.type === 'room' }
  }, SWEEP_TX_OPTIONS)
}

/**
 * Sends the due reminders and emails the rooms' (a seat's stays in the app). Answers how many were
 * sent and how many bookings THREW (`threw`: sweepBookings turns a number above zero into
 * `failed: ['remind']`).
 */
async function sendReminders(now: Date): Promise<{ sent: number; threw: number }> {
  const ids = await findReminderCandidates(prisma, now)

  const sent: SentReminder[] = []
  let threw = 0
  for (const id of ids) {
    try {
      const reminder = await sendReminder(id, now)
      if (reminder) sent.push(reminder)
    } catch (error) {
      // This booking's transaction rolled back as a whole (it is still unmarked and
      // still due) and the next sweep tries it again. Its id only, like the first step.
      threw += 1
      console.error(`no-show sweep: reminder for booking ${id} failed (${errorName(error)})`)
    }
  }

  // Every transaction has committed. Only a room's reminder is emailed, and nothing
  // is published: a reminder changes nothing the console shows.
  await emailAll(sent.filter((reminder) => reminder.room).map((reminder) => reminder.notice))
  return { sent: sent.length, threw }
}

// --- The callers -----------------------------------------------------------------------------
// Three things run `sweepBookings`: POST /internal/sweep (routes/internal.ts, for the scheduled
// workflow), the server's 60-second timer (runScheduledSweeps in requestHolds.ts) and
// `sweepIfDue` below, before the pages that read bookings. What they log is the same, so it
// lives here: `sweepBookings` itself logs only a step's failure, never a result.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Logs what a sweep did. Counts only: never a name, an email, a resource, an id, a token or
 * an error's text.
 *  - A result with a failed step is an ERROR (`console.error`) even when every count is zero:
 *    "0 recorded" next to a failed step means the step could not run, not that there was
 *    nothing to do, and it must be seen.
 *  - Otherwise the counts go to `console.log`, and ONLY when at least one is above zero:
 *    the timer calls this every minute and must not print an idle line each time.
 */
export function logSweepResult(result: SweepResult): void {
  const { noShows, reminders, remaining, failed } = result
  const counts = `${plural(noShows, 'no-show', 'no-shows')}, ${plural(reminders, 'reminder', 'reminders')}, ${remaining} still waiting`
  if (failed && failed.length > 0) {
    console.error(`no-show sweep finished with a failed step (${failed.join(', ')}): ${counts}`)
  } else if (noShows > 0 || reminders > 0 || remaining > 0) {
    console.log(`no-show sweep: ${counts}`)
  }
}

/** Logs a sweep that threw (both steps failed): the error's class only, since its text can carry a row's data. */
export function logSweepFailure(error: unknown): void {
  console.error(`no-show sweep failed (${errorName(error)})`)
}

/** How often, at most, a process runs the lazy sweep. */
export const LAZY_SWEEP_INTERVAL_MS = 60_000

/** The START time of the last lazy sweep: the throttle. Null before the first, and after a reset. */
let lastLazySweepAt: number | null = null
/** Set by a test (see enableLazySweepForTests); undefined means "the default for this process". */
let lazySweepOverride: boolean | undefined

/**
 * The in-process guard: true while a sweep started through `sweepUnlessRunning` (by the
 * timer or by `sweepIfDue`) is running. Released in a `finally`, so a sweep that fails or
 * throws cannot leave it set.
 */
let sweepRunning = false
/**
 * How long the sweep that holds the guard may have been running before a skipped call reports it as
 * stuck (see warnIfStuck). A healthy sweep takes seconds, a slow one a minute or two.
 */
export const STUCK_SWEEP_MS = 10 * 60_000
/** When the sweep that holds the guard began, on the clock its caller passed (`now`). Null while none runs. */
let sweepStartedAt: number | null = null
/** True once the sweep that holds the guard has been reported as stuck, so it is reported once, not once per skipped call. */
let stuckReported = false
/** The guarded sweeps still running, and the lazy chains around them, so a test can wait for them (settleSweepsForTests). */
const sweepsInFlight = new Set<Promise<unknown>>()

// True under a test run: Vitest always sets VITEST (the same test the mailer uses).
const underTest = () => process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)

/**
 * Runs one sweep unless one that was started through this same function is still running in
 * this process, in which case it answers `null` at once and does nothing. The timer
 * (`runScheduledSweeps`) and `sweepIfDue` both go through it, so the two share ONE guard.
 *
 * Why: under a slow database a sweep (up to 200 bookings, eleven round trips and an email
 * each) can outlast the 60-second beat. A second sweep started behind it only doubles the
 * wait, and the waiting sweeps hold pool connections (pg's default is 10) that students'
 * requests then queue for. Skipping is safe: the sweep is idempotent and the next beat or
 * read picks everything up.
 *
 * `POST /internal/sweep` does NOT use this: it is the scheduler's explicit call and runs
 * regardless (calling `sweepBookings` directly), so it neither sets nor clears this guard.
 *
 * A skip is silent, with one exception: a sweep that hangs for good keeps the guard for ever, so
 * a skip that finds the running sweep more than STUCK_SWEEP_MS old logs it once (warnIfStuck).
 * The skip's own answer is the same either way: `null`.
 */
export async function sweepUnlessRunning(now: Date = new Date()): Promise<SweepResult | null> {
  if (sweepRunning) {
    warnIfStuck(now)
    return null
  }
  sweepRunning = true
  sweepStartedAt = now.getTime()
  stuckReported = false
  let run: Promise<SweepResult> | undefined
  try {
    // Started synchronously (sweepBookings' first query is issued before this function first yields).
    run = sweepBookings(now)
    sweepsInFlight.add(run)
    return await run
  } finally {
    // Also when the sweep threw: nothing of it is left behind for the next one.
    sweepRunning = false
    sweepStartedAt = null
    stuckReported = false
    if (run) sweepsInFlight.delete(run)
  }
}

/**
 * Called by every call the guard refuses (`sweepUnlessRunning`, and `sweepIfDue` before it gets that far).
 *
 * Why: a candidate query runs outside any transaction, so nothing times it out. On a half-open
 * connection it can hang for good, and with it the guard: every timer beat and lazy sweep after that
 * is skipped, and without this nobody would hear that detection has dropped to the scheduled
 * workflow's 10-minute pace. So when the running sweep began more than STUCK_SWEEP_MS ago, ONE
 * `console.error` says so: once per stuck sweep, not once per skip (the timer skips every minute),
 * and it can be reported again only by a later sweep that hangs too (the flag is cleared when a
 * sweep starts and when it ends).
 *
 * The age is measured on the clock the callers pass (`now`), the one the throttle uses. The line is
 * a fixed sentence: no name, email, id, token or error text.
 */
function warnIfStuck(now: Date): void {
  if (sweepStartedAt === null || stuckReported) return
  if (now.getTime() - sweepStartedAt <= STUCK_SWEEP_MS) return
  stuckReported = true
  console.error(
    `no-show sweep: one has been running for more than ${STUCK_SWEEP_MS / 60_000} minutes, so new sweeps are skipped until it ends (is a database connection hung?)`,
  )
}

/**
 * Runs a sweep in the BACKGROUND if none has started in the last LAZY_SWEEP_INTERVAL_MS in
 * this process and none is still running (the guard above). Called at the start of
 * `listMyBookings`, `checkInBooking`, `cancelBooking` and the console's bookings list, so a
 * missed booking is recorded when anyone looks at bookings even if the scheduled workflow
 * is paused or the instance has just woken up.
 *
 *  - NEVER awaited and never throws: a sweep may email up to 200 people at up to 5 seconds
 *    each, and a student's request must not wait for that (or fail because of it). So the
 *    request that triggers it still sees the booking as released (the face it shows today);
 *    the next read shows the recorded no-show.
 *  - The throttle is stamped BEFORE the sweep starts, so a burst of simultaneous callers
 *    starts one sweep, not a stack of them. A call the guard refuses does NOT stamp it (a
 *    sweep that never started must not postpone the next one). It is per process; the sweep
 *    itself is safe to run from several places at once (see the top of this file).
 *  - A skipped call is silent, except that one which finds the running sweep stuck (more than
 *    STUCK_SWEEP_MS old) logs that once (warnIfStuck). A result is logged like the timer's
 *    (logSweepResult), a failure by its error class.
 *  - DISABLED UNDER TEST: every route test reads bookings, and a sweep running behind a
 *    request would record no-shows and truncate-race with the next test. A test that is
 *    about the lazy sweep switches it on with enableLazySweepForTests(true) (and
 *    resetLazySweepForTests() puts it back).
 */
export function sweepIfDue(now: Date = new Date()): void {
  try {
    if (!(lazySweepOverride ?? !underTest())) return
    const at = now.getTime()
    if (lastLazySweepAt !== null && at - lastLazySweepAt < LAZY_SWEEP_INTERVAL_MS) return
    if (sweepRunning) {
      warnIfStuck(now)
      return
    }
    lastLazySweepAt = at

    const chain: Promise<void> = sweepUnlessRunning(now)
      .then((result) => {
        if (result) logSweepResult(result)
      })
      .catch(logSweepFailure)
      .finally(() => {
        sweepsInFlight.delete(chain)
      })
    sweepsInFlight.add(chain)
  } catch (error) {
    // Nothing above can throw (sweepUnlessRunning is async), but a request must never fail because of this.
    logSweepFailure(error)
  }
}

/** Test only. Turns the lazy sweep on (true) or off (false) whatever the process default is. */
export function enableLazySweepForTests(enabled: boolean): void {
  lazySweepOverride = enabled
}

/**
 * Test only. Waits for every guarded sweep still running, and for the lazy sweeps' logging
 * after them, so a test can look at the outcome of one sweep before it starts the next (the
 * guard would otherwise refuse it) and none runs into the next test's database reset. Does
 * not change any state.
 */
export async function settleSweepsForTests(): Promise<void> {
  await Promise.allSettled([...sweepsInFlight])
}

/**
 * Test only. Waits for every sweep still running (settleSweepsForTests), then clears the
 * throttle and the guard and puts the default back (off under test).
 */
export async function resetLazySweepForTests(): Promise<void> {
  await settleSweepsForTests()
  lastLazySweepAt = null
  lazySweepOverride = undefined
  sweepRunning = false
  sweepStartedAt = null
  stuckReported = false
}
