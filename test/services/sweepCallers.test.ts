// The places that RUN the sweep, other than the route (test/routes/internalSweep.test.ts):
//  - sweepIfDue(): a throttled, background sweep that runs before the pages that read
//    bookings (spec section 4). It must never slow, fail or stack up behind a request.
//  - the server's existing 60-second timer, which also sweeps bookings.
//
// These tests count sweeps by watching the sweep's own candidate queries on the real
// `prisma.$queryRaw` (the detection query runs synchronously when a sweep starts), so
// they exercise the real sweepBookings and need no mock of it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { listBookings } from '../../src/services/adminBookingService'
import { cancelBooking, checkInBooking, listMyBookings } from '../../src/services/bookingService'
import {
  enableLazySweepForTests,
  LAZY_SWEEP_INTERVAL_MS,
  logSweepResult,
  resetLazySweepForTests,
  settleSweepsForTests,
  STUCK_SWEEP_MS,
  sweepIfDue,
  sweepUnlessRunning,
} from '../../src/services/noShowService'
import { runScheduledSweeps, startExpirySweep, SWEEP_INTERVAL_MS } from '../../src/services/requestHolds'
import { resetDb } from '../helpers/db'

// Each case seeds and sweeps through a remote database.
vi.setConfig({ testTimeout: 60_000 })

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

async function seedStudent() {
  return prisma.user.create({
    data: { name: `Student ${Math.random()}`, email: `student${Math.random()}@example.com`, passwordHash: 'x' },
  })
}

/** A booked seat whose grace period ended 5 minutes ago: any sweep records it. */
async function seedMissedBooking(userId: string, resourceName = `Desk ${Math.random()}`) {
  const seat = await prisma.resource.create({ data: { type: 'seat', name: resourceName } })
  const startTime = new Date(Date.now() - 20 * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'booked' },
  })
}

/** A room request whose slot started 20 minutes ago: the expiry sweep lapses it. */
async function seedStaleRoomRequest(userId: string) {
  const room = await prisma.resource.create({ data: { type: 'room', name: `Room ${Math.random()}` } })
  const startTime = new Date(Date.now() - 20 * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: { userId, resourceId: room.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'requested' },
  })
}

const statusOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } }).then((b) => b.status)

// What the two candidate queries of a sweep look like in a spied `$queryRaw`.
const isDetectionQuery = (sql: string) => sql.includes('SELECT id FROM "ResourceBooking"') && !sql.includes('reminderSentAt')
const isReminderQuery = (sql: string) => sql.includes('SELECT id FROM "ResourceBooking"') && sql.includes('reminderSentAt')

interface ProbeOptions {
  /** Hold every reminder query (the sweep's second step) until this settles: a slow sweep. */
  hold?: Promise<unknown>
  /** Make both candidate queries fail: a sweep that throws. */
  fail?: boolean
  /** Make only the reminder query fail: a sweep with one failed step. */
  failReminders?: boolean
}

/**
 * Watches the real `prisma.$queryRaw`. `detection` counts sweeps STARTED (the first step's
 * query is issued synchronously when `sweepBookings` is called); `reminder` counts sweeps
 * that got as far as their second step.
 */
function probeSweeps(options: ProbeOptions = {}) {
  const seen = { detection: 0, reminder: 0 }
  const real = prisma.$queryRaw.bind(prisma) as (...args: unknown[]) => unknown
  vi.spyOn(prisma, '$queryRaw').mockImplementation(((query: unknown, ...rest: unknown[]) => {
    // JSON.stringify escapes the quotes around "ResourceBooking"; put them back before matching.
    const sql = JSON.stringify(query).replaceAll('\\"', '"')
    const detection = isDetectionQuery(sql)
    const reminder = isReminderQuery(sql)
    if (detection) seen.detection += 1
    if (reminder) seen.reminder += 1
    if ((detection && options.fail) || (reminder && (options.fail || options.failReminders))) throw new Error('connection lost')
    if (reminder && options.hold) return options.hold.then(() => real(query, ...rest))
    return real(query, ...rest)
  }) as never)
  return seen
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything the given console calls printed. An Error is spelled out (name, message, stack): JSON.stringify prints one as {}. */
const printedText = (calls: unknown[][]) =>
  calls
    .flat()
    .map((arg) => (arg instanceof Error ? [arg.name, arg.message, arg.stack].join(' ') : typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' | ')

// A background sweep on a remote database takes a few seconds; vi.waitFor's 1 s default is too tight.
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 30_000, interval: 50 })

beforeEach(resetDb)
afterEach(async () => {
  // Waits for any background sweep a test started, so none runs into the next test's reset.
  await resetLazySweepForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sweepIfDue', () => {
  it('runs at most once per minute', async () => {
    const probe = probeSweeps()
    enableLazySweepForTests(true)
    const t0 = Date.now()

    expect(LAZY_SWEEP_INTERVAL_MS).toBe(60_000)
    sweepIfDue(new Date(t0))
    // Each sweep is let finish before the next call, so only the throttle (never the in-process
    // "a sweep is running" guard) is what is being measured here.
    await settleSweepsForTests()
    sweepIfDue(new Date(t0 + 1_000))
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS - 1))
    expect(probe.detection).toBe(1)

    // A full minute after the last START it is due again, once.
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS))
    expect(probe.detection).toBe(2)
    await settleSweepsForTests()
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS + 5_000))
    expect(probe.detection).toBe(2)
    sweepIfDue(new Date(t0 + 2 * LAZY_SWEEP_INTERVAL_MS))
    expect(probe.detection).toBe(3)
  })

  it('a burst of callers starts one sweep, not a stack of them', async () => {
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    for (let i = 0; i < 25; i++) sweepIfDue()

    expect(probe.detection).toBe(1)
  })

  it('answers nothing and starts the sweep in the background, parked here on a held query', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)

    try {
      expect(sweepIfDue()).toBeUndefined()
      // The sweep is under way (it reaches its second step and waits there), yet this call has returned.
      await eventually(() => expect(probe.reminder).toBe(1))
    } finally {
      gate.resolve()
    }
  })

  it('a rejected sweep is swallowed: nothing is thrown, nothing is left unhandled, and the log has the error class only', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    probeSweeps({ fail: true })
    enableLazySweepForTests(true)

    expect(() => sweepIfDue()).not.toThrow()
    // Resolves only after the background sweep has failed and been logged; an unhandled rejection
    // would instead fail this whole test run.
    await resetLazySweepForTests()

    const lines = logged.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => /sweep failed \(Error\)/.test(line))).toBe(true)
    expect(printedText(logged.mock.calls)).not.toContain('connection lost')
  })

  it('a failed sweep still counts toward the throttle, and does not stop the next minute from sweeping', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const probe = probeSweeps({ fail: true })
    enableLazySweepForTests(true)
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    // Wait for the failure to be logged (the last thing a failed lazy sweep does).
    await eventually(() => expect(logged.mock.calls.some((call) => /sweep failed \(Error\)/.test(String(call[0])))).toBe(true))

    // A failing database is not hammered by every page read...
    sweepIfDue(new Date(t0 + 1_000))
    expect(probe.detection).toBe(1)
    // ...and the failure is not sticky: a minute after the start it tries again.
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS))
    expect(probe.detection).toBe(2)
  })

  it('a sweep with a failed step logs one error line with the counts and the step, and never a name or error text', async () => {
    const [error, log] = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ]
    const student = await prisma.user.create({
      data: { name: 'Ada Lovelace', email: 'ada.secret@example.com', passwordHash: 'x' },
    })
    const missed = await seedMissedBooking(student.id, 'Secret Reading Room')
    probeSweeps({ failReminders: true })
    enableLazySweepForTests(true)

    sweepIfDue()
    await resetLazySweepForTests()

    expect(await statusOf(missed.id)).toBe('no_show')
    const lines = error.mock.calls.map((call) => String(call[0]))
    const summary = lines.find((line) => line.includes('failed step'))
    expect(summary).toBeDefined()
    expect(summary).toContain('(remind)')
    expect(summary).toMatch(/1 no-show/)
    // The healthy line is for a sweep that finished cleanly; this one was an error.
    expect(log).not.toHaveBeenCalled()
    const everything = printedText([...error.mock.calls, ...log.mock.calls])
    for (const secret of ['Ada Lovelace', 'ada.secret', 'Secret Reading Room', student.id, missed.id, 'connection lost']) {
      expect(everything).not.toContain(secret)
    }
  })

  it('logs the three counts when it recorded something, and nothing at all when it found nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const student = await seedStudent()
    await seedMissedBooking(student.id)
    enableLazySweepForTests(true)
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    await eventually(() => expect(log).toHaveBeenCalledTimes(1))
    expect(String(log.mock.calls[0][0])).toMatch(/1 no-show.*0 reminders.*0/)

    log.mockClear()
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS))
    await resetLazySweepForTests()
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('is off under test unless a test enables it', async () => {
    const probe = probeSweeps()
    const t0 = Date.now()

    // The default under Vitest: no sweep, however often and however late it is called.
    sweepIfDue(new Date(t0))
    sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
    expect(probe.detection).toBe(0)

    enableLazySweepForTests(true)
    sweepIfDue(new Date(t0))
    expect(probe.detection).toBe(1)

    enableLazySweepForTests(false)
    sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
    expect(probe.detection).toBe(1)

    // And a reset puts the default back, whatever the last test left on.
    enableLazySweepForTests(true)
    await resetLazySweepForTests()
    sweepIfDue(new Date(t0 + 20 * MINUTE_MS))
    expect(probe.detection).toBe(1)
  })

  it('a disabled call does not use up the throttle', async () => {
    const probe = probeSweeps()
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    enableLazySweepForTests(true)
    sweepIfDue(new Date(t0 + 1))

    expect(probe.detection).toBe(1)
  })
})

// One process runs one booking sweep at a time: the timer and sweepIfDue share a guard. Under a slow
// database a sweep can outlast the 60-second beat, and a second one started behind it would hold more
// of the pool's ten connections while students' requests queue for them. (POST /internal/sweep is the
// scheduler's explicit call and ignores the guard: see test/routes/internalSweep.test.ts.)
describe('one sweep at a time per process', () => {
  it('a second sweepIfDue while one is running does not start another, even past the throttle', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)
    const t0 = Date.now()

    try {
      sweepIfDue(new Date(t0))
      await eventually(() => expect(probe.reminder).toBe(1)) // parked on its second step: still running
      // Five minutes later by its clock: the throttle allows it, only the guard can refuse it.
      sweepIfDue(new Date(t0 + 5 * LAZY_SWEEP_INTERVAL_MS))
      sweepIfDue(new Date(t0 + 6 * LAZY_SWEEP_INTERVAL_MS))
      expect(probe.detection).toBe(1)
    } finally {
      gate.resolve()
    }
    await settleSweepsForTests()
  })

  it('the timer skips the booking sweep while one is running, says nothing about it, and still runs the expiry sweep', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    enableLazySweepForTests(true)
    const student = await seedStudent()
    const stale = await seedStaleRoomRequest(student.id)

    try {
      sweepIfDue()
      await eventually(() => expect(probe.reminder).toBe(1))

      // Without the guard the timer would start a second sweep of its own, parked on the same held query,
      // and never return: the race keeps that a failed assertion and not a hung test.
      const outcome = await Promise.race([
        runScheduledSweeps().then(() => 'returned'),
        sleep(15_000).then(() => 'blocked behind a second sweep'),
      ])
      expect(outcome).toBe('returned')

      expect(probe.detection).toBe(1)
      // The expiry half is not held back by the guard...
      expect(await statusOf(stale.id)).toBe('expired')
      // ...and a skip is not an event: no line at all.
      expect(log).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
    }
    await settleSweepsForTests()
  })

  it('a sweep the timer started also holds the guard against sweepIfDue', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    // The skip below is ten minutes on (and a few milliseconds past it), which also counts as a
    // stuck sweep (see "a sweep that never finishes"): that line is not what this test is about.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    enableLazySweepForTests(true)
    let timerRun: Promise<void> | undefined

    try {
      timerRun = runScheduledSweeps()
      expect(probe.detection).toBe(1)
      await eventually(() => expect(probe.reminder).toBe(1))

      sweepIfDue(new Date(Date.now() + 10 * MINUTE_MS))
      expect(probe.detection).toBe(1)
    } finally {
      gate.resolve()
    }
    await timerRun
  })

  it('a call the guard refused does not use up the throttle', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)
    const t0 = Date.now()

    try {
      sweepIfDue(new Date(t0))
      await eventually(() => expect(probe.reminder).toBe(1))
      // Refused by the guard. Had it stamped the throttle at t0 + 10 min, the call below (earlier by
      // its own clock) would count as "inside the minute" and be refused as well.
      sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
    } finally {
      gate.resolve()
    }
    await settleSweepsForTests()

    sweepIfDue(new Date(t0 + 2 * MINUTE_MS))
    expect(probe.detection).toBe(2)
  })

  it('the guard is released after a sweep that succeeded (sweepIfDue and the timer both)', async () => {
    const probe = probeSweeps()
    enableLazySweepForTests(true)
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    await settleSweepsForTests()
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS))
    expect(probe.detection).toBe(2)
    await settleSweepsForTests()

    await runScheduledSweeps()
    await runScheduledSweeps()
    expect(probe.detection).toBe(4)
  })

  it('the guard is released after a sweep that failed (sweepIfDue and the timer both)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const probe = probeSweeps({ fail: true })
    enableLazySweepForTests(true)
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    await settleSweepsForTests()
    sweepIfDue(new Date(t0 + LAZY_SWEEP_INTERVAL_MS))
    expect(probe.detection).toBe(2)
    await settleSweepsForTests()

    await runScheduledSweeps()
    await runScheduledSweeps()
    expect(probe.detection).toBe(4)
  })

  it('resetLazySweepForTests also puts the guard and the throttle back', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)
    const t0 = Date.now()

    sweepIfDue(new Date(t0))
    await eventually(() => expect(probe.reminder).toBe(1))
    gate.resolve()
    await resetLazySweepForTests()

    // Off again by default under test...
    sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
    expect(probe.detection).toBe(1)
    // ...and, once switched on, free to start at once (neither the guard nor the throttle is left set).
    enableLazySweepForTests(true)
    sweepIfDue(new Date(t0 + 1))
    expect(probe.detection).toBe(2)
  })
})

// The guard has one blind spot: a sweep that hangs for good (its candidate query runs outside any
// transaction, so on a half-open connection nothing ever times it out) keeps the guard set, and every
// timer beat and lazy sweep after it is skipped, silently. So a skip that finds the running sweep
// more than STUCK_SWEEP_MS old says so, once per stuck sweep. The ages below are measured on the
// clock the callers pass (`now`), the same one the throttle uses.
describe('a sweep that never finishes', () => {
  const STUCK_LINE =
    'no-show sweep: one has been running for more than 10 minutes, so new sweeps are skipped until it ends (is a database connection hung?)'

  it('is stuck after 10 minutes', () => {
    expect(STUCK_SWEEP_MS).toBe(10 * MINUTE_MS)
  })

  it('logs ONE error line when a skipped call finds the running sweep more than 10 minutes old, and no more for the rest of that sweep', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    enableLazySweepForTests(true)
    const t0 = Date.now()

    try {
      sweepIfDue(new Date(t0))
      await eventually(() => expect(probe.reminder).toBe(1)) // parked on its second step: running

      // Slow is not stuck: skips up to and including the 10-minute mark are silent, as before, and still answer null.
      sweepIfDue(new Date(t0 + 5 * MINUTE_MS))
      sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
      expect(await sweepUnlessRunning(new Date(t0 + 10 * MINUTE_MS))).toBeNull()
      expect(error).not.toHaveBeenCalled()

      // One millisecond over: the first skip says so. The line is a fixed sentence: no name, email, id or token.
      sweepIfDue(new Date(t0 + 10 * MINUTE_MS + 1))
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0][0])).toBe(STUCK_LINE)
      expect(error.mock.calls[0]).toHaveLength(1)

      // Every later skip, from either caller, stays quiet, and still does nothing and answers null.
      sweepIfDue(new Date(t0 + 11 * MINUTE_MS))
      expect(await sweepUnlessRunning(new Date(t0 + 12 * MINUTE_MS))).toBeNull()
      sweepIfDue(new Date(t0 + 60 * MINUTE_MS))
      expect(error).toHaveBeenCalledTimes(1)
      expect(probe.detection).toBe(1)
    } finally {
      gate.resolve()
    }
    await settleSweepsForTests()
  })

  it('also reports it when the timer is the caller that finds it stuck', async () => {
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    enableLazySweepForTests(true)
    const t0 = Date.now()

    // The sweep that hangs began 11 minutes ago by the clock `sweepUnlessRunning` is given.
    const stuck = sweepUnlessRunning(new Date(t0 - 11 * MINUTE_MS))
    try {
      await eventually(() => expect(probe.reminder).toBe(1))

      // runScheduledSweeps passes no clock: it is "now", 11 minutes after the stuck sweep began.
      await runScheduledSweeps()

      expect(probe.detection).toBe(1)
      expect(error.mock.calls.map((call) => String(call[0]))).toEqual([STUCK_LINE])
    } finally {
      gate.resolve()
    }
    await stuck
  })

  it('forgets a sweep once it ends: the next sweep is judged by its own start, and a second stuck one is reported again', async () => {
    const first = deferred()
    const hold: ProbeOptions = { hold: first.promise }
    const probe = probeSweeps(hold)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    enableLazySweepForTests(true)
    const t0 = Date.now()

    try {
      sweepIfDue(new Date(t0))
      await eventually(() => expect(probe.reminder).toBe(1))
      sweepIfDue(new Date(t0 + 11 * MINUTE_MS))
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      first.resolve()
    }
    await settleSweepsForTests()
    error.mockClear()

    // A new sweep starts at t0 + 12 minutes and hangs too.
    const second = deferred()
    hold.hold = second.promise
    try {
      sweepIfDue(new Date(t0 + 12 * MINUTE_MS))
      await eventually(() => expect(probe.reminder).toBe(2))

      // Fifteen minutes after the FIRST one began, three after this one did: nothing to report yet.
      sweepIfDue(new Date(t0 + 15 * MINUTE_MS))
      expect(error).not.toHaveBeenCalled()

      // Over ten minutes after this one began: reported, once more.
      sweepIfDue(new Date(t0 + 22 * MINUTE_MS + 1))
      sweepIfDue(new Date(t0 + 23 * MINUTE_MS))
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0][0])).toBe(STUCK_LINE)
    } finally {
      second.resolve()
    }
    await settleSweepsForTests()
  })
})

describe('logSweepResult', () => {
  it('stays quiet for a sweep that did nothing, and says the counts when any is above zero', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logSweepResult({ noShows: 0, reminders: 0, remaining: 0 })
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()

    logSweepResult({ noShows: 2, reminders: 0, remaining: 0 })
    logSweepResult({ noShows: 0, reminders: 3, remaining: 0 })
    logSweepResult({ noShows: 0, reminders: 0, remaining: 5 })
    expect(log).toHaveBeenCalledTimes(3)
    expect(String(log.mock.calls[0][0])).toMatch(/2 no-shows.*0 reminders.*0/)
    expect(String(log.mock.calls[1][0])).toMatch(/0 no-shows.*3 reminders.*0/)
    expect(String(log.mock.calls[2][0])).toMatch(/0 no-shows.*0 reminders.*5/)
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a result with a failed step at error level, even when every count is zero', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logSweepResult({ noShows: 0, reminders: 0, remaining: 0, failed: ['record'] })
    logSweepResult({ noShows: 4, reminders: 0, remaining: 0, failed: ['remind'] })

    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(2)
    expect(String(error.mock.calls[0][0])).toContain('(record)')
    expect(String(error.mock.calls[1][0])).toContain('(remind)')
    expect(String(error.mock.calls[1][0])).toMatch(/4 no-shows/)
  })
})

// The four reads and writes a student or a librarian does on bookings. Each starts the
// sweep BEFORE its own first await, which is what these check: the sweep's first query is
// issued synchronously, so right after the call (not awaited) the count is already 1.
describe('the places that call sweepIfDue first', () => {
  it('listMyBookings', async () => {
    const student = await seedStudent()
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    const pending = listMyBookings(student.id)
    expect(probe.detection).toBe(1)
    await pending
  })

  it('checkInBooking (even for a booking that is then refused)', async () => {
    const student = await seedStudent()
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    const pending = checkInBooking(student.id, 'no-such-booking')
    expect(probe.detection).toBe(1)
    await expect(pending).rejects.toThrow('Booking not found')
  })

  it('cancelBooking (even for a booking that is then refused)', async () => {
    const student = await seedStudent()
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    const pending = cancelBooking(student.id, 'no-such-booking')
    expect(probe.detection).toBe(1)
    await expect(pending).rejects.toThrow('Booking not found')
  })

  it("the console's bookings list (listBookings)", async () => {
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    const pending = listBookings({ page: 1, pageSize: 10 })
    expect(probe.detection).toBe(1)
    await pending
  })

  it('they share one sweep per minute between them', async () => {
    const student = await seedStudent()
    const probe = probeSweeps()
    enableLazySweepForTests(true)

    await Promise.all([
      listMyBookings(student.id),
      listBookings({ page: 1, pageSize: 10 }),
      checkInBooking(student.id, 'no-such-booking').catch(() => undefined),
      cancelBooking(student.id, 'no-such-booking').catch(() => undefined),
    ])

    expect(probe.detection).toBe(1)
  })

  it('are inert under test by default: no sweep, and the read answers as before', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.id)
    const probe = probeSweeps()

    const bookings = await listMyBookings(student.id)
    await listBookings({ page: 1, pageSize: 10 })

    expect(probe.detection).toBe(0)
    // The booking is still `booked` in the database, read as released.
    expect(bookings.map((b) => b.frontendStatus)).toEqual(['released'])
    expect(await statusOf(missed.id)).toBe('booked')
  })
})

describe('a slow sweep never slows a request', () => {
  it('listMyBookings returns before a slow sweep finishes', async () => {
    const student = await seedStudent()
    const gate = deferred()
    const probe = probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)

    try {
      const outcome = await Promise.race([
        listMyBookings(student.id).then(() => 'returned'),
        // The outcome does not depend on this value: a request that waited for the sweep would sit here
        // until it elapsed, and a healthy one returns long before. It is generous so that a slow
        // database cannot make a healthy request lose the race.
        sleep(20_000).then(() => 'still waiting for the sweep'),
      ])

      expect(outcome).toBe('returned')
      // The sweep started, and it is still parked on its held query: the answer did not wait for it.
      expect(probe.detection).toBe(1)
      await eventually(() => expect(probe.reminder).toBe(1))
    } finally {
      gate.resolve()
    }
  })

  it('the next read shows what the sweep recorded; the first read still shows the booking as released', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.id)
    const gate = deferred()
    probeSweeps({ hold: gate.promise })
    enableLazySweepForTests(true)

    try {
      const first = await listMyBookings(student.id)
      expect(first.map((b) => ({ status: b.status, frontendStatus: b.frontendStatus }))).toEqual([{ status: 'booked', frontendStatus: 'released' }])
    } finally {
      gate.resolve()
    }
    await resetLazySweepForTests() // waits for the background sweep to finish

    const next = await listMyBookings(student.id)
    expect(await statusOf(missed.id)).toBe('no_show')
    expect(next.map((b) => ({ status: b.status, frontendStatus: b.frontendStatus }))).toEqual([{ status: 'no_show', frontendStatus: 'released' }])
  })
})

describe('the 60-second timer', () => {
  it('keeps its 60-second beat', () => {
    expect(SWEEP_INTERVAL_MS).toBe(60_000)
  })

  it('also sweeps: one call runs the expiry sweep and the booking sweep', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.id)
    const stale = await seedStaleRoomRequest(student.id)

    await runScheduledSweeps()

    expect(await statusOf(missed.id)).toBe('no_show')
    expect(await statusOf(stale.id)).toBe('expired')
    // The booking sweep's result is logged (it did something); nothing is said about an idle one.
    expect(log.mock.calls.map((call) => String(call[0])).some((line) => /1 no-show/.test(line))).toBe(true)
  })

  it('stays quiet when there is nothing to do', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runScheduledSweeps()

    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('survives the expiry sweep failing: the bookings are still swept, and the failure is logged on its own', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.id)
    vi.spyOn(prisma.borrowRequest, 'findMany').mockRejectedValue(new Error('expiry down'))

    await expect(runScheduledSweeps()).resolves.toBeUndefined()

    expect(await statusOf(missed.id)).toBe('no_show')
    expect(error).toHaveBeenCalledWith('Expiry sweep failed:', expect.objectContaining({ message: 'expiry down' }))
  })

  it('survives the booking sweep failing: the requests are still lapsed, and the log has the error class only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const student = await seedStudent()
    const stale = await seedStaleRoomRequest(student.id)
    probeSweeps({ fail: true })

    await expect(runScheduledSweeps()).resolves.toBeUndefined()

    expect(await statusOf(stale.id)).toBe('expired')
    const lines = error.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => /sweep failed \(Error\)/.test(line))).toBe(true)
    expect(printedText(error.mock.calls)).not.toContain('connection lost')
  })

  it('survives a step of the booking sweep failing: that step is named in an error line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.id)
    probeSweeps({ failReminders: true })

    await runScheduledSweeps()

    expect(await statusOf(missed.id)).toBe('no_show')
    expect(error.mock.calls.some((call) => /failed step \(remind\)/.test(String(call[0])))).toBe(true)
  })

  it('ticks at the start and every minute, running both sweeps each time, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const probe = probeSweeps()
    const running: Promise<void>[] = []
    const timed = () => {
      const run = runScheduledSweeps()
      running.push(run)
      return run
    }

    const stop = startExpirySweep(timed, SWEEP_INTERVAL_MS)
    expect(probe.detection).toBe(1)
    // A beat arrives a minute later, by which time the first beat's sweep has finished (a beat that
    // finds the previous sweep still running skips it: see "one sweep at a time per process").
    await running[0]
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS)
    expect(probe.detection).toBe(2)
    await running[1]
    stop()
    vi.advanceTimersByTime(3 * SWEEP_INTERVAL_MS)
    expect(probe.detection).toBe(2)

    await Promise.all(running)
    expect(probe.reminder).toBe(2)
  })

  it('is what src/index.ts hands to the timer (the one wiring the server cannot be imported to test)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8')

    expect(source).toMatch(/startExpirySweep\(\s*runScheduledSweeps\s*\)/)
    expect(source).toMatch(/import \{[^}]*\brunScheduledSweeps\b[^}]*\} from '\.\/services\/requestHolds'/)
  })
})
