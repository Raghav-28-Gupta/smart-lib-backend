// The sweep that records missed seat and room bookings (slice 7, spec section 4):
// a booking still `booked` once its grace period has ended becomes `no_show`, the
// student's reliability drops by a recoverable amount, a notice says so, the email
// goes out after the commit, and the console hears about it once.
//
// The second step of the sweep, the "your booking starts soon" reminder, is tested
// further down in the same way (slice 7, spec section 4 step 2).
//
// The races that matter are pinned with a held booking-row lock
// (test/helpers/bookingLock.ts: the sweep's write waits on the lock, the competitor
// lands, then the sweep runs against the changed row) and, where they are cheap,
// also run free for several rounds, swapping which side starts first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMINDER_LEAD_MINUTES, RELIABILITY_NOSHOW_PENALTY, RELIABILITY_ONTIME_BOOKING_BONUS } from '../../src/config/constants'
import { Prisma, type BookingStatus } from '../../src/generated/prisma/client'
import { ConflictError } from '../../src/lib/httpError'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { dayLabel, slotLabel } from '../../src/lib/timeLabels'
import { cancelBooking, checkInBooking } from '../../src/services/bookingService'
import { listMyNotices } from '../../src/services/noticeService'
import {
  asUtcInstant,
  BOOKING_REMINDER_TITLE,
  findCandidates,
  findReminderCandidates,
  NO_SHOW_TITLE,
  SWEEP_TX_OPTIONS,
  sweepBookings,
} from '../../src/services/noShowService'
import { applyReliabilityDelta } from '../../src/services/reliabilityService'
import { bookingLockedThenCompete } from '../helpers/bookingLock'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

// Knobs the tests turn: a small SWEEP_BATCH (200 sequential transactions would take
// minutes on a remote database), a student whose reliability write fails (the one way
// to make a single no-show's transaction fail on demand) and a student whose
// REMINDER notice write fails (the same for a single reminder's transaction). All are
// off by default, so every other test runs the real constants and the real service.
const knobs = vi.hoisted(() => ({
  batch: undefined as number | undefined,
  failUsers: new Set<string>(),
  failReminderUsers: new Set<string>(),
}))

vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>()
  return {
    ...actual,
    get SWEEP_BATCH() {
      return knobs.batch ?? actual.SWEEP_BATCH
    },
  }
})

vi.mock('../../src/services/reliabilityService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/reliabilityService')>()
  return {
    ...actual,
    applyReliabilityDelta: async (...args: Parameters<typeof actual.applyReliabilityDelta>) => {
      if (knobs.failUsers.has(args[1])) throw new Error('reliability write down')
      return actual.applyReliabilityDelta(...args)
    },
  }
})

vi.mock('../../src/services/noticeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/noticeService')>()
  return {
    ...actual,
    createNotice: (...args: Parameters<typeof actual.createNotice>) => {
      const [, input] = args
      if (input.kind === 'booking_reminder' && knobs.failReminderUsers.has(input.userId)) throw new Error('notice write down')
      return actual.createNotice(...args)
    },
  }
})

// Each case seeds and checks through a remote database (a sweep of several bookings
// is a few dozen round trips), which can take 12 s or more: the 15 s default is too tight.
vi.setConfig({ testTimeout: 60_000 })

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const ROUNDS = 4
const NOTHING = { noShows: 0, reminders: 0, remaining: 0 }
const BOOKING_CHANGED = { type: 'booking.changed', topics: ['bookings', 'metrics'] }
const STUDENT_CHANGED = { type: 'student.changed', topics: ['students'] }

async function seedStudent(overrides: { name?: string; email?: string; reliabilityScore?: number } = {}) {
  return prisma.user.create({
    data: {
      name: overrides.name ?? `Student ${Math.random()}`,
      // A non-demo address, so the injected fake transport is exercised.
      email: overrides.email ?? `student${Math.random()}@example.com`,
      passwordHash: 'x',
      reliabilityScore: overrides.reliabilityScore,
    },
  })
}

interface BookingSeed {
  userId: string
  now: Date
  status?: BookingStatus
  /** How long before `now` the grace period ended; negative means it is still running. Default 5 minutes. */
  graceEndedMsAgo?: number
  gracePeriodMinutes?: number
  type?: 'seat' | 'room'
  resourceName?: string
}

/** A one-hour booking on a resource of its own (no overlap with the others), whose grace period ends `graceEndedMsAgo` before `now`. */
async function seedBooking(o: BookingSeed) {
  const grace = o.gracePeriodMinutes ?? 15
  const resource = await prisma.resource.create({ data: { type: o.type ?? 'seat', name: o.resourceName ?? `Desk ${Math.random()}` } })
  const startTime = new Date(o.now.getTime() - (o.graceEndedMsAgo ?? 5 * MINUTE_MS) - grace * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: {
      userId: o.userId,
      resourceId: resource.id,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status: o.status ?? 'booked',
      gracePeriodMinutes: grace,
    },
  })
}

interface UpcomingSeed {
  userId: string
  now: Date
  /** How long from `now` until the booking starts (negative: it started). Default 20 minutes. */
  startsInMs?: number
  /** How long before it starts the booking was made (a seat) or approved (a room). Default 2 hours: early enough. */
  madeMsBeforeStart?: number
  type?: 'seat' | 'room'
  status?: BookingStatus
  gracePeriodMinutes?: number
  resourceName?: string
}

/**
 * A one-hour booking that starts `startsInMs` from `now`, on a resource of its own. A seat is
 * made in one step (`requestedAt`); a room is requested three hours earlier still and then
 * approved (`decidedAt`), except a room still `requested`, which has no decision yet.
 */
async function seedUpcoming(o: UpcomingSeed) {
  const type = o.type ?? 'seat'
  const status = o.status ?? 'booked'
  const resource = await prisma.resource.create({ data: { type, name: o.resourceName ?? `Desk ${Math.random()}` } })
  const startTime = new Date(o.now.getTime() + (o.startsInMs ?? 20 * MINUTE_MS))
  const made = new Date(startTime.getTime() - (o.madeMsBeforeStart ?? 2 * HOUR_MS))
  const room = type === 'room'
  return prisma.resourceBooking.create({
    data: {
      userId: o.userId,
      resourceId: resource.id,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status,
      gracePeriodMinutes: o.gracePeriodMinutes ?? 15,
      requestedAt: room ? new Date(made.getTime() - 3 * HOUR_MS) : made,
      decidedAt: room && status !== 'requested' ? made : null,
    },
  })
}

const reminderSentAtOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } }).then((b) => b.reminderSentAt)
const remindersOf = (bookingId: string) => prisma.notice.findMany({ where: { bookingId, kind: 'booking_reminder' } })
const allRemindersFor = (userId: string) => prisma.notice.findMany({ where: { userId, kind: 'booking_reminder' } })

const statusOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } }).then((b) => b.status)
const scoreOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } }).then((u) => u.reliabilityScore)
const eventsOf = (bookingId: string) => prisma.noShowEvent.findMany({ where: { resourceBookingId: bookingId } })
const logsOf = (userId: string) => prisma.reliabilityScoreLog.findMany({ where: { userId }, orderBy: { computedAt: 'asc' } })
const noticesOf = (bookingId: string) => prisma.notice.findMany({ where: { bookingId } })
const noticesFor = (userId: string) => prisma.notice.findMany({ where: { userId } })

/** Nothing recorded for this booking: no event, no notice, and its student's score and log untouched. */
async function expectUntouched(bookingId: string, userId: string, score = 100) {
  expect(await eventsOf(bookingId)).toEqual([])
  expect(await noticesOf(bookingId)).toEqual([])
  expect(await logsOf(userId)).toEqual([])
  expect(await scoreOf(userId)).toBe(score)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = <T>(p: PromiseLike<T>) => Promise.allSettled([p]).then(([r]) => r)

// A race needs both sides to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

/** Starts both at once; on odd rounds the second is started first, so each order gets hit. */
async function together<A, B>(round: number, first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondResult, firstResult] = await Promise.all([second(), first()])
  return [firstResult, secondResult]
}

function fakeMail(behaviour: MailTransport['send'] = async () => ({ ok: true })) {
  const send = vi.fn<MailTransport['send']>(behaviour)
  setMailTransport({ send })
  return send
}

/**
 * A fake mail send for the "at most 10 at a time" cases. Every call waits until `limit` calls are in
 * flight together, and then a little longer, so that one call too many has the time to join. Without
 * the wait a call could finish before the tenth had started (the sweep reads the database before each
 * send, and on a cold pool or a remote database those reads finish at uneven times), and the peak
 * would come out below 10 with nothing wrong in the code. The wait gives up after 2 s, counted from
 * the first call, so a regression that never gets `limit` calls in flight fails the assertion on the
 * peak instead of hanging the test. `mostInFlight()` is the peak: exactly `limit` when the sweep sends
 * `limit` at a time, below it when it sends fewer, above it when it sends more.
 */
function sendsHeldUntilFull(limit: number) {
  let inFlight = 0
  let peak = 0
  let fallback: ReturnType<typeof setTimeout> | undefined
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = () => {
      clearTimeout(fallback)
      resolve()
    }
  })
  const send: MailTransport['send'] = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    fallback ??= setTimeout(open, 2_000)
    if (inFlight >= limit) open()
    await gate
    await sleep(150)
    inFlight--
    return { ok: true }
  }
  return { send, mostInFlight: () => peak }
}

let savedAllowedDomains: string | undefined
let recorder: ReturnType<typeof recordEvents> | undefined

beforeEach(async () => {
  savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
  delete process.env.MAIL_ALLOWED_DOMAINS
  setMailTransport(null)
  knobs.batch = undefined
  knobs.failUsers.clear()
  knobs.failReminderUsers.clear()
  await resetDb()
})

afterEach(() => {
  recorder?.stop()
  recorder = undefined
  setMailTransport(null)
  knobs.batch = undefined
  knobs.failUsers.clear()
  knobs.failReminderUsers.clear()
  if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
  else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
  vi.restoreAllMocks()
})

describe('recording a no-show', () => {
  it('records a no-show: status no_show, one NoShowEvent actualNoShow true, one -10 reliability log, one no_show notice linked to the booking', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBooking({ userId: student.id, now, resourceName: 'Desk 12' })

    const result = await sweepBookings(now)

    expect(result).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect(await statusOf(booking.id)).toBe('no_show')
    expect(await eventsOf(booking.id)).toEqual([
      expect.objectContaining({ userId: student.id, actualNoShow: true, predictedProbability: null, reliabilityDelta: -10 }),
    ])
    expect(RELIABILITY_NOSHOW_PENALTY).toBe(10)
    expect(await scoreOf(student.id)).toBe(90)
    expect(await logsOf(student.id)).toEqual([expect.objectContaining({ delta: -10, score: 90, reason: 'No-show: Desk 12', adjustedById: null })])
    expect(await noticesOf(booking.id)).toEqual([
      expect.objectContaining({ userId: student.id, kind: 'no_show', title: 'Missed booking', bookingId: booking.id, createdById: null, emailStatus: 'skipped' }),
    ])
    expect(NO_SHOW_TITLE).toBe('Missed booking')
  })

  it('handles seat and room bookings', async () => {
    const now = new Date()
    const seatStudent = await seedStudent()
    const roomStudent = await seedStudent()
    const seat = await seedBooking({ userId: seatStudent.id, now, type: 'seat', resourceName: 'Desk 3' })
    // An approved room request is a `booked` row like a seat.
    const room = await seedBooking({ userId: roomStudent.id, now, type: 'room', resourceName: 'Study Room A' })

    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0 })

    expect(await statusOf(seat.id)).toBe('no_show')
    expect(await statusOf(room.id)).toBe('no_show')
    expect((await logsOf(seatStudent.id))[0].reason).toBe('No-show: Desk 3')
    expect((await logsOf(roomStudent.id))[0].reason).toBe('No-show: Study Room A')
    expect((await noticesOf(seat.id))[0].body).toContain("You didn't check in to Desk 3 (")
    expect((await noticesOf(room.id))[0].body).toContain("You didn't check in to Study Room A (")
  })

  it('a student at score 4 loses 4 and the event stores reliabilityDelta -4', async () => {
    const now = new Date()
    const student = await seedStudent({ reliabilityScore: 4 })
    const booking = await seedBooking({ userId: student.id, now })

    await sweepBookings(now)

    expect(await scoreOf(student.id)).toBe(0)
    expect(await eventsOf(booking.id)).toEqual([expect.objectContaining({ actualNoShow: true, reliabilityDelta: -4 })])
    expect(await logsOf(student.id)).toEqual([expect.objectContaining({ delta: -4, score: 0 })])
    expect((await noticesOf(booking.id))[0].body).toContain('Your reliability score went from 4 to 0.')
  })

  it('a student already at 0 still has the no-show recorded, with a zero delta', async () => {
    const now = new Date()
    const student = await seedStudent({ reliabilityScore: 0 })
    const booking = await seedBooking({ userId: student.id, now })

    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })

    expect(await statusOf(booking.id)).toBe('no_show')
    expect(await scoreOf(student.id)).toBe(0)
    expect(await eventsOf(booking.id)).toEqual([expect.objectContaining({ actualNoShow: true, reliabilityDelta: 0 })])
    expect((await noticesOf(booking.id))[0].body).toContain('Your reliability score went from 0 to 0.')
  })

  it('keeps an existing predictedProbability', async () => {
    const now = new Date()
    const student = await seedStudent()
    const scored = await seedBooking({ userId: student.id, now })
    const unscored = await seedBooking({ userId: student.id, now })
    // The booking was scored when it was made: an event with a probability and no outcome yet.
    await prisma.noShowEvent.create({ data: { resourceBookingId: scored.id, userId: student.id, predictedProbability: 0.31 } })

    await sweepBookings(now)

    expect(await eventsOf(scored.id)).toEqual([
      expect.objectContaining({ predictedProbability: 0.31, actualNoShow: true, reliabilityDelta: -10 }),
    ])
    // One that was never scored gets an event with no probability.
    expect(await eventsOf(unscored.id)).toEqual([
      expect.objectContaining({ predictedProbability: null, actualNoShow: true, reliabilityDelta: -10 }),
    ])
    expect(await prisma.noShowEvent.count()).toBe(2)
  })
})

describe('which bookings are swept', () => {
  it('a booking at the very end of its grace period is not swept, one minute later it is', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBooking({ userId: student.id, now, graceEndedMsAgo: 0 })

    // Strictly before `now`: a grace period that ends at this very instant is still running.
    expect(await sweepBookings(now)).toEqual(NOTHING)
    expect(await statusOf(booking.id)).toBe('booked')
    await expectUntouched(booking.id, student.id)

    expect(await sweepBookings(new Date(now.getTime() + MINUTE_MS))).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect(await statusOf(booking.id)).toBe('no_show')
  })

  it('a booking whose grace ended more than 24 hours ago is left alone', async () => {
    const now = new Date()
    const student = await seedStudent()
    const tooOld = await seedBooking({ userId: student.id, now, graceEndedMsAgo: 24 * HOUR_MS + MINUTE_MS })
    const veryOld = await seedBooking({ userId: student.id, now, graceEndedMsAgo: 30 * 24 * HOUR_MS })
    const atTheLimit = await seedBooking({ userId: student.id, now, graceEndedMsAgo: 24 * HOUR_MS })
    const recent = await seedBooking({ userId: student.id, now, graceEndedMsAgo: 23 * HOUR_MS })

    // Not candidates at all, so not "remaining" either.
    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0 })

    expect(await statusOf(tooOld.id)).toBe('booked')
    expect(await statusOf(veryOld.id)).toBe('booked')
    expect(await eventsOf(tooOld.id)).toEqual([])
    expect(await noticesOf(veryOld.id)).toEqual([])
    // The look-back includes its own limit.
    expect(await statusOf(atTheLimit.id)).toBe('no_show')
    expect(await statusOf(recent.id)).toBe('no_show')
    expect(await scoreOf(student.id)).toBe(80)
  })

  it('requested, cancelled, declined, checked_in and released rows are never swept', async () => {
    const now = new Date()
    const student = await seedStudent()
    const others: BookingStatus[] = ['requested', 'cancelled', 'declined', 'checked_in', 'released', 'completed', 'expired', 'no_show']
    const seeded: Awaited<ReturnType<typeof seedBooking>>[] = []
    for (const status of others) seeded.push(await seedBooking({ userId: student.id, now, status }))

    expect(await sweepBookings(now)).toEqual(NOTHING)

    for (const [i, status] of others.entries()) expect(await statusOf(seeded[i].id)).toBe(status)
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(await noticesFor(student.id)).toEqual([])
    expect(await logsOf(student.id)).toEqual([])
    expect(await scoreOf(student.id)).toBe(100)
  })

  it('a booking still inside its grace period, or not yet started, is not swept', async () => {
    const now = new Date()
    const student = await seedStudent()
    const inWindow = await seedBooking({ userId: student.id, now, graceEndedMsAgo: -5 * MINUTE_MS })
    const upcoming = await seedBooking({ userId: student.id, now, graceEndedMsAgo: -3 * HOUR_MS })

    expect(await sweepBookings(now)).toEqual(NOTHING)

    expect(await statusOf(inWindow.id)).toBe('booked')
    expect(await statusOf(upcoming.id)).toBe('booked')
    expect(await scoreOf(student.id)).toBe(100)
  })

  it("uses each booking's own grace period", async () => {
    const now = new Date()
    const student = await seedStudent()
    // Both started 20 minutes ago: the 15-minute grace has ended, the 30-minute one has not.
    const shortGrace = await seedBooking({ userId: student.id, now, gracePeriodMinutes: 15, graceEndedMsAgo: 5 * MINUTE_MS })
    const longGrace = await seedBooking({ userId: student.id, now, gracePeriodMinutes: 30, graceEndedMsAgo: -10 * MINUTE_MS })

    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })

    expect(await statusOf(shortGrace.id)).toBe('no_show')
    expect(await statusOf(longGrace.id)).toBe('booked')
  })

  it('stops at SWEEP_BATCH, takes the oldest first and reports how many remain', async () => {
    const now = new Date()
    knobs.batch = 3
    const student = await seedStudent()
    const ages = [5, 50, 20, 40, 10].map((minutes) => minutes * MINUTE_MS)
    const bookings: Awaited<ReturnType<typeof seedBooking>>[] = []
    for (const age of ages) bookings.push(await seedBooking({ userId: student.id, now, graceEndedMsAgo: age }))
    const byAge = (age: number) => bookings[ages.indexOf(age)]

    expect(await sweepBookings(now)).toEqual({ noShows: 3, reminders: 0, remaining: 2 })

    // The three whose grace ended longest ago (50, 40 and 20 minutes) went first.
    for (const age of [50, 40, 20]) expect(await statusOf(byAge(age * MINUTE_MS).id)).toBe('no_show')
    for (const age of [10, 5]) expect(await statusOf(byAge(age * MINUTE_MS).id)).toBe('booked')

    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0 })
    expect(await sweepBookings(now)).toEqual(NOTHING)
    expect(await scoreOf(student.id)).toBe(50)
  })

  it('a full batch with nothing behind it reports no remaining', async () => {
    const now = new Date()
    knobs.batch = 2
    const student = await seedStudent()
    await seedBooking({ userId: student.id, now })
    await seedBooking({ userId: student.id, now })

    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0 })
  })
})

describe('sweeping twice, or two sweeps at once', () => {
  it('a second sweep after the first records nothing more', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent()
    const booking = await seedBooking({ userId: student.id, now })

    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })
    recorder = recordEvents()
    expect(await sweepBookings(now)).toEqual(NOTHING)

    expect(await scoreOf(student.id)).toBe(90)
    expect(await logsOf(student.id)).toHaveLength(1)
    expect(await noticesOf(booking.id)).toHaveLength(1)
    expect(await eventsOf(booking.id)).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    // The second sweep found nothing to record, so it announced nothing.
    expect(recorder.events).toEqual([])
  })

  it('two sweeps at once record one no-show, one penalty, one notice and one email', async () => {
    const send = fakeMail()
    const student = await seedStudent()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const now = new Date()
      const name = `Desk ${round}`
      const booking = await seedBooking({ userId: student.id, now, resourceName: name })
      send.mockClear()
      recorder = recordEvents()

      const [one, two] = await together(round, () => sweepBookings(now), () => sweepBookings(now))

      recorder.stop()
      expect(one.noShows + two.noShows).toBe(1)
      expect(await statusOf(booking.id)).toBe('no_show')
      expect(await eventsOf(booking.id)).toHaveLength(1)
      expect((await logsOf(student.id)).filter((l) => l.reason === `No-show: ${name}`)).toHaveLength(1)
      expect(await scoreOf(student.id)).toBe(100 - RELIABILITY_NOSHOW_PENALTY * (round + 1))
      expect(await noticesOf(booking.id)).toHaveLength(1)
      expect(send).toHaveBeenCalledTimes(1)
      // Only the sweep that recorded the no-show announced it.
      expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
    }
  }, 120_000)

  it('a second sweep that waited for the first one to record the no-show changes nothing', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent()
    const booking = await seedBooking({ userId: student.id, now, resourceName: 'Desk 5' })
    recorder = recordEvents()

    // The first sweep lands (as the competitor, with what it writes); the sweep waiting on the row then finds it recorded.
    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => sweepBookings(now),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'no_show' } })
        await tx.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: student.id, actualNoShow: true, reliabilityDelta: -10 } })
        await applyReliabilityDelta(tx, student.id, -RELIABILITY_NOSHOW_PENALTY, 'No-show: Desk 5')
        await tx.notice.create({ data: { userId: student.id, kind: 'no_show', title: NO_SHOW_TITLE, body: 'The first sweep wrote this.', bookingId: booking.id } })
      },
    )

    expect(outcome).toEqual({ status: 'fulfilled', value: NOTHING })
    expect(await statusOf(booking.id)).toBe('no_show')
    expect(await scoreOf(student.id)).toBe(90)
    expect(await logsOf(student.id)).toHaveLength(1)
    expect(await eventsOf(booking.id)).toHaveLength(1)
    expect(await noticesOf(booking.id)).toEqual([expect.objectContaining({ body: 'The first sweep wrote this.' })])
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 60_000)
})

describe('a check-in and the sweep at the same moment', () => {
  it('a check-in that lands first wins: the sweep waits for it, records nothing, and the student is never penalized', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent({ reliabilityScore: 50 })
    const booking = await seedBooking({ userId: student.id, now })
    recorder = recordEvents()

    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => sweepBookings(now),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'checked_in', checkedInAt: new Date(now.getTime() - 10 * MINUTE_MS) } })
        await applyReliabilityDelta(tx, student.id, RELIABILITY_ONTIME_BOOKING_BONUS, 'On-time check-in for a resource booking')
      },
    )

    expect(outcome).toEqual({ status: 'fulfilled', value: NOTHING })
    expect(await statusOf(booking.id)).toBe('checked_in')
    expect(await scoreOf(student.id)).toBe(52)
    expect(await logsOf(student.id)).toEqual([expect.objectContaining({ delta: RELIABILITY_ONTIME_BOOKING_BONUS })])
    expect(await eventsOf(booking.id)).toEqual([])
    expect(await noticesOf(booking.id)).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a sweep that lands first wins: the check-in waits for it, is refused, and earns no bonus', async () => {
    const realNow = new Date()
    const student = await seedStudent({ reliabilityScore: 50 })
    // Started two minutes ago: a real check-in is still inside the grace period.
    const booking = await seedBooking({ userId: student.id, now: realNow, graceEndedMsAgo: -13 * MINUTE_MS })

    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => checkInBooking(student.id, booking.id),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'no_show' } })
        await tx.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: student.id, actualNoShow: true, reliabilityDelta: -10 } })
        await applyReliabilityDelta(tx, student.id, -RELIABILITY_NOSHOW_PENALTY, 'No-show: Desk')
      },
    )

    expect(outcome.status).toBe('rejected')
    const refusal = (outcome as PromiseRejectedResult).reason
    expect(refusal).toBeInstanceOf(ConflictError)
    expect((refusal as Error).message).toBe('This booking cannot be checked into.')
    expect(await statusOf(booking.id)).toBe('no_show')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).checkedInAt).toBeNull()
    expect(await scoreOf(student.id)).toBe(40)
    expect(await logsOf(student.id)).toEqual([expect.objectContaining({ delta: -10 })])
  }, 60_000)

  it('a check-in and a sweep sent at once: exactly one wins, a checked-in student is never penalized, nothing deadlocks', async () => {
    const student = await seedStudent({ reliabilityScore: 50 })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await warmPool()

    for (let round = 0; round < ROUNDS + 2; round++) {
      const realNow = new Date()
      // Ten minutes of grace left in real time, but over in the sweep's clock: both sides are entitled to win.
      const booking = await seedBooking({ userId: student.id, now: realNow, graceEndedMsAgo: -10 * MINUTE_MS })
      const sweepNow = new Date(realNow.getTime() + 30 * MINUTE_MS)
      // A fresh score each round, so six sweep wins in a row cannot run into the clamp at 0.
      const before = 50
      await prisma.user.update({ where: { id: student.id }, data: { reliabilityScore: before } })
      recorder = recordEvents()

      const [swept, checkedIn] = await together(
        round,
        () => sweepBookings(sweepNow),
        () => settle(checkInBooking(student.id, booking.id)),
      )

      recorder.stop()
      if (swept.noShows === 1) {
        // The sweep won: the check-in was told it could not be done and earned nothing.
        expect(checkedIn.status).toBe('rejected')
        expect((checkedIn as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)
        expect(await statusOf(booking.id)).toBe('no_show')
        expect(await scoreOf(student.id)).toBe(before - RELIABILITY_NOSHOW_PENALTY)
        expect(await eventsOf(booking.id)).toHaveLength(1)
        expect(await noticesOf(booking.id)).toHaveLength(1)
      } else {
        // The check-in won: nothing was recorded against the student.
        expect(swept).toEqual(NOTHING)
        expect(checkedIn.status).toBe('fulfilled')
        expect(await statusOf(booking.id)).toBe('checked_in')
        expect(await scoreOf(student.id)).toBe(before + RELIABILITY_ONTIME_BOOKING_BONUS)
        expect(await eventsOf(booking.id)).toEqual([])
        expect(await noticesOf(booking.id)).toEqual([])
      }
    }
    // A deadlock would have been logged as a failed booking (and failed the check-in with a 500's error).
    expect(logged).not.toHaveBeenCalled()
  }, 120_000)
})

describe('the notice', () => {
  const bodyFor = (resource: string, start: Date, end: Date, from: string, to: string) =>
    `You didn't check in to ${resource} (${dayLabel(start)}, ${slotLabel(start, end)}), so the slot was released and a no-show was recorded. ` +
    `Your reliability score went from ${from} to ${to}. If this is wrong, you can dispute it from My Bookings within 7 days.`

  it('names the resource, the day and slot, and the score change', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBooking({ userId: student.id, now, resourceName: 'Study Room B', type: 'room' })

    await sweepBookings(now)

    const [notice] = await noticesOf(booking.id)
    expect(notice.title).toBe('Missed booking')
    expect(notice.body).toBe(bodyFor('Study Room B', booking.startTime, booking.endTime, '100', '90'))
    expect(notice.body.startsWith("You didn't check in to Study Room B (")).toBe(true)
    expect(notice.body.endsWith('Your reliability score went from 100 to 90. If this is wrong, you can dispute it from My Bookings within 7 days.')).toBe(true)
  })

  it('shows whole scores as whole numbers and a fractional score as it is stored', async () => {
    const now = new Date()
    const whole = await seedStudent({ reliabilityScore: 72 })
    const fractional = await seedStudent({ reliabilityScore: 87.5 })
    const wholeBooking = await seedBooking({ userId: whole.id, now })
    const fractionalBooking = await seedBooking({ userId: fractional.id, now })

    await sweepBookings(now)

    expect((await noticesOf(wholeBooking.id))[0].body).toContain('went from 72 to 62.')
    expect((await noticesOf(fractionalBooking.id))[0].body).toContain('went from 87.5 to 77.5.')
  })
})

describe('one failing booking', () => {
  it('does not stop the rest, and is logged by its id only', async () => {
    const now = new Date()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent({ name: 'Broken Student', email: 'broken.student@example.com' })
    const healthy = await seedStudent({ name: 'Healthy Student', email: 'healthy.student@example.com' })
    // The broken one is the oldest, so it is tried first and the loop has to carry on past it.
    const brokenBooking = await seedBooking({ userId: broken.id, now, graceEndedMsAgo: 40 * MINUTE_MS, resourceName: 'Secret Desk' })
    const healthyBooking = await seedBooking({ userId: healthy.id, now, graceEndedMsAgo: 10 * MINUTE_MS })
    knobs.failUsers.add(broken.id)
    recorder = recordEvents()

    // A booking that threw makes the step `failed` (the route answers 500 and the workflow turns red),
    // while the good one's count and work stand.
    expect(await sweepBookings(now)).toEqual({ noShows: 1, reminders: 0, remaining: 0, failed: ['record'] })

    // The failed booking's transaction rolled back as a whole.
    expect(await statusOf(brokenBooking.id)).toBe('booked')
    await expectUntouched(brokenBooking.id, broken.id)
    expect(await statusOf(healthyBooking.id)).toBe('no_show')
    expect(await scoreOf(healthy.id)).toBe(90)
    expect(await noticesOf(healthyBooking.id)).toHaveLength(1)
    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])

    // One line, naming the booking and nothing else about it or its student.
    expect(logged).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(logged.mock.calls)
    expect(line).toContain(brokenBooking.id)
    for (const secret of ['Broken Student', 'broken.student', broken.id, 'Secret Desk', 'reliability write down']) expect(line).not.toContain(secret)

    // The booking is still `booked` and inside the look-back, so the next sweep records it
    // (and, with nothing failing any more, is a plain healthy result with no `failed` key).
    knobs.failUsers.clear()
    expect(await sweepBookings(now)).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect(await statusOf(brokenBooking.id)).toBe('no_show')
    expect(await scoreOf(broken.id)).toBe(90)
  })

  it('publishes nothing when every booking in the sweep failed, and says the step failed', async () => {
    const now = new Date()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent()
    const booking = await seedBooking({ userId: broken.id, now })
    knobs.failUsers.add(broken.id)
    const send = fakeMail()
    recorder = recordEvents()

    // Zeros with `failed`: "could not record", never "nothing to do".
    expect(await sweepBookings(now)).toEqual({ ...NOTHING, failed: ['record'] })

    expect(await statusOf(booking.id)).toBe('booked')
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('records the good ones among several and reports the step as failed, whichever place the broken one has', async () => {
    const now = new Date()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent()
    const goodStudents = [await seedStudent(), await seedStudent(), await seedStudent()]
    // Oldest grace end first: the broken one is tried second, with a good one on each side of it.
    const first = await seedBooking({ userId: goodStudents[0].id, now, graceEndedMsAgo: 50 * MINUTE_MS })
    const middle = await seedBooking({ userId: broken.id, now, graceEndedMsAgo: 40 * MINUTE_MS })
    const second = await seedBooking({ userId: goodStudents[1].id, now, graceEndedMsAgo: 30 * MINUTE_MS })
    const third = await seedBooking({ userId: goodStudents[2].id, now, graceEndedMsAgo: 20 * MINUTE_MS })
    knobs.failUsers.add(broken.id)
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual({ noShows: 3, reminders: 0, remaining: 0, failed: ['record'] })

    for (const booking of [first, second, third]) expect(await statusOf(booking.id)).toBe('no_show')
    expect(await statusOf(middle.id)).toBe('booked')
    // The good ones were announced once; the failed one wrote and announced nothing.
    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
  })

  it('a failing booking in the record step does not make the reminder step failed, and the reverse', async () => {
    const now = new Date()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenRecord = await seedStudent()
    const brokenRemind = await seedStudent()
    const healthy = await seedStudent()
    await seedBooking({ userId: brokenRecord.id, now })
    await seedUpcoming({ userId: healthy.id, now })
    knobs.failUsers.add(brokenRecord.id)

    // Only the record step had a booking that threw.
    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0, failed: ['record'] })

    knobs.failUsers.clear()
    knobs.failReminderUsers.add(brokenRemind.id)
    await seedBooking({ userId: healthy.id, now })
    await seedUpcoming({ userId: brokenRemind.id, now })
    // Only the reminder step had one.
    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0, failed: ['remind'] })
  })
})

describe('the email', () => {
  it('is sent once per notice after the commit, and its outcome is stored', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent({ email: 'real.student@example.com' })
    const booking = await seedBooking({ userId: student.id, now, resourceName: 'Desk 9' })

    await sweepBookings(now)

    expect(send).toHaveBeenCalledTimes(1)
    const [message] = send.mock.calls[0]
    expect(message.to).toBe('real.student@example.com')
    expect(message.subject).toBe('SmartLib: Missed booking')
    expect(message.text).toContain("You didn't check in to Desk 9")
    const [notice] = await noticesOf(booking.id)
    expect(notice.emailStatus).toBe('sent')
    expect(notice.emailedAt).not.toBeNull()
  })

  it('a failing email (fake transport) records failed and the no-show stands', async () => {
    const now = new Date()
    // The mailer warns (error name only) when a transport throws; that is expected here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = await seedStudent()
    const throwing = await seedStudent()
    const refused = await seedBooking({ userId: refusing.id, now, graceEndedMsAgo: 20 * MINUTE_MS })
    const thrown = await seedBooking({ userId: throwing.id, now, graceEndedMsAgo: 10 * MINUTE_MS })
    // The provider answers an error for the first student and the connection drops for the second.
    fakeMail(async (message) => {
      if (message.to === refusing.email) return { ok: false }
      throw new Error('socket hang up')
    })
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 0, remaining: 0 })

    for (const [booking, student] of [[refused, refusing], [thrown, throwing]] as const) {
      expect(await statusOf(booking.id)).toBe('no_show')
      expect(await scoreOf(student.id)).toBe(90)
      expect(await eventsOf(booking.id)).toEqual([expect.objectContaining({ actualNoShow: true, reliabilityDelta: -10 })])
      const [notice] = await noticesOf(booking.id)
      expect(notice.emailStatus).toBe('failed')
      expect(notice.emailedAt).not.toBeNull()
    }
    // The console is told all the same.
    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
  })

  it('a demo address is skipped without touching the transport', async () => {
    const now = new Date()
    const send = fakeMail()
    const demo = await seedStudent({ email: 'seed.student3@thapar.edu' })
    const booking = await seedBooking({ userId: demo.id, now })

    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })

    expect(send).not.toHaveBeenCalled()
    const [notice] = await noticesOf(booking.id)
    expect(notice.emailStatus).toBe('skipped')
    expect(notice.emailedAt).toBeNull()
    expect(await statusOf(booking.id)).toBe('no_show')
  })

  it('goes out at most 10 at a time', async () => {
    const now = new Date()
    const held = sendsHeldUntilFull(10)
    const send = fakeMail(held.send)
    for (let i = 0; i < 12; i++) {
      const student = await seedStudent()
      await seedBooking({ userId: student.id, now })
    }

    expect(await sweepBookings(now)).toMatchObject({ noShows: 12 })

    expect(send).toHaveBeenCalledTimes(12)
    // Exactly 10 (the first ten are held until they are all in flight) and never 11.
    expect(held.mostInFlight()).toBe(10)
    expect(await prisma.notice.count({ where: { emailStatus: 'sent' } })).toBe(12)
  }, 90_000)
})

describe('live events', () => {
  it('publishes booking.changed and student.changed once each, after every email outcome is written; none when nothing was swept', async () => {
    const now = new Date()
    const order: string[] = []
    fakeMail(async () => {
      await sleep(30)
      order.push('email')
      return { ok: true }
    })
    // What the notices say about their email at the moment the console is told.
    let statusesWhenTold: Promise<string[]> | undefined
    const stop = subscribe((event) => {
      order.push(`event:${event.type}`)
      statusesWhenTold ??= prisma.notice.findMany({ orderBy: { id: 'asc' } }).then((notices) => notices.map((n) => n.emailStatus))
    })
    try {
      for (let i = 0; i < 2; i++) {
        const student = await seedStudent()
        await seedBooking({ userId: student.id, now })
      }

      expect(await sweepBookings(now)).toMatchObject({ noShows: 2 })

      expect(order).toEqual(['email', 'email', 'event:booking.changed', 'event:student.changed'])
      expect(await statusesWhenTold).toEqual(['sent', 'sent'])

      // Nothing left to sweep: nothing published, nothing emailed.
      order.length = 0
      expect(await sweepBookings(now)).toEqual(NOTHING)
      expect(order).toEqual([])
    } finally {
      stop()
    }
  })

  it('publishes the exact events: the Bookings page and Dashboard, and the Students page', async () => {
    const now = new Date()
    const student = await seedStudent()
    await seedBooking({ userId: student.id, now })
    recorder = recordEvents()

    await sweepBookings(now)

    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
  })

  it('publishes nothing for a sweep with no candidates', async () => {
    const now = new Date()
    const student = await seedStudent()
    await seedBooking({ userId: student.id, now, graceEndedMsAgo: -5 * MINUTE_MS })
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual(NOTHING)

    expect(recorder.events).toEqual([])
  })
})

const ZONES = ['America/New_York', 'Asia/Kolkata']

/** Runs `work` in a transaction whose session time zone is `zone` (SET LOCAL ends with it). */
async function underZone<T>(zone: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
    // The setting took, so what follows really ran under it.
    const [{ zone: inForce }] = await tx.$queryRaw<[{ zone: string }]>`SELECT current_setting('TimeZone') AS zone`
    expect(inForce).toBe(zone)
    return work(tx)
    // Prisma's defaults (2 s to get a connection, 5 s to finish) are too tight for a remote database: one
    // run died here with "Unable to start a transaction in the given time" (P2028). Same options the sweep uses.
  }, SWEEP_TX_OPTIONS)
}

// The window is decided in SQL, and the pg adapter binds a JS Date as text with no
// offset (UTC wall-clock). A parameter that Postgres reads as timestamptz is then
// read in the SESSION's time zone, so on a database that is not on UTC the window
// moves by hours: west of UTC a booking whose grace has not ended would be recorded
// as a no-show; east of it detection would lag and bookings older than the look-back
// would be penalized. Neon and the test database are on UTC, so every other test
// here cannot see it: these run the same query under a session set to another zone
// (the way test/services/fineRules.test.ts does for the fine SQL).
describe('the candidate window does not depend on the database session time zone', () => {
  it.each(ZONES)('finds only the booking whose grace just ended under a %s session', async (zone) => {
    const now = new Date()
    const student = await seedStudent()
    // Not a candidate: its grace period ends 10 minutes from now.
    await seedBooking({ userId: student.id, now, graceEndedMsAgo: -10 * MINUTE_MS })
    // The one candidate: its grace ended a minute ago.
    const justEnded = await seedBooking({ userId: student.id, now, graceEndedMsAgo: MINUTE_MS })
    // Not a candidate: its grace ended 24 hours 30 minutes ago, past the look-back.
    await seedBooking({ userId: student.id, now, graceEndedMsAgo: 24 * HOUR_MS + 30 * MINUTE_MS })

    const found = await underZone(zone, (tx) => findCandidates(tx, now))

    expect(found).toEqual({ ids: [justEnded.id], remaining: 0 })
  })

  it.each(ZONES)('asUtcInstant reads a Date as that very instant under a %s session', async (zone) => {
    const date = new Date()

    // Compared as epoch milliseconds inside SQL, which does not depend on the session's zone:
    // reading a timestamptz back through the driver under a non-UTC session drops its offset.
    const [row] = await underZone(zone, (tx) =>
      tx.$queryRaw<{ ms: number }[]>(Prisma.sql`SELECT round(extract(epoch FROM ${asUtcInstant(date)}) * 1000)::float8 AS ms`),
    )

    expect(row.ms).toBe(date.getTime())
  })
})

// ---------------------------------------------------------------------------
// Step 2 of the sweep: the "your booking starts soon" reminder.
// ---------------------------------------------------------------------------

const REMINDER_BODY = (resource: string, start: Date, end: Date) =>
  `${resource}, ${slotLabel(start, end)}. Check in within 15 minutes of the start or the slot is released.`
const LEAD_MS = REMINDER_LEAD_MINUTES * MINUTE_MS

describe('the reminder', () => {
  it('sends one reminder per booking and never a second', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now, resourceName: 'Desk 7' })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0 })

    expect(BOOKING_REMINDER_TITLE).toBe('Your booking starts soon')
    expect((await reminderSentAtOf(booking.id))?.getTime()).toBe(now.getTime())
    expect(await statusOf(booking.id)).toBe('booked')
    expect(await remindersOf(booking.id)).toEqual([
      expect.objectContaining({
        userId: student.id,
        kind: 'booking_reminder',
        title: 'Your booking starts soon',
        body: REMINDER_BODY('Desk 7', booking.startTime, booking.endTime),
        bookingId: booking.id,
        createdById: null,
        emailStatus: 'skipped',
      }),
    ])

    // Again at the same instant, and again later: the booking has had its reminder.
    expect(await sweepBookings(now)).toEqual(NOTHING)
    expect(await sweepBookings(new Date(now.getTime() + 10 * MINUTE_MS))).toEqual(NOTHING)
    expect(await remindersOf(booking.id)).toHaveLength(1)
    expect((await reminderSentAtOf(booking.id))?.getTime()).toBe(now.getTime())

    // A reminder is not a penalty: no event, no log, the score untouched.
    expect(await eventsOf(booking.id)).toEqual([])
    expect(await logsOf(student.id)).toEqual([])
    expect(await scoreOf(student.id)).toBe(100)
  })

  it('names the resource and the slot, and tells the student how long they have to check in', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now, type: 'room', resourceName: 'Study Room B' })

    await sweepBookings(now)

    const [notice] = await remindersOf(booking.id)
    expect(notice.body.startsWith('Study Room B, ')).toBe(true)
    expect(notice.body).toBe(`Study Room B, ${slotLabel(booking.startTime, booking.endTime)}. Check in within 15 minutes of the start or the slot is released.`)
    expect(notice.body.endsWith('. Check in within 15 minutes of the start or the slot is released.')).toBe(true)
  })

  it(`is sent from ${REMINDER_LEAD_MINUTES} minutes before the start up to the start itself, and not outside that`, async () => {
    const now = new Date()
    const student = await seedStudent()
    const startsIn: Record<string, number> = {
      atTheEdge: LEAD_MS, // exactly the lead time ahead: inside
      middle: 12 * MINUTE_MS,
      aMillisecondAhead: 1, // inside
      justOutside: LEAD_MS + 1, // a millisecond too far ahead
      farAhead: 3 * HOUR_MS,
      startsNow: 0, // already started: the start is not "ahead"
      started: -MINUTE_MS,
      startedLongAgo: -10 * MINUTE_MS,
    }
    const seeded: Record<string, Awaited<ReturnType<typeof seedUpcoming>>> = {}
    for (const [name, startsInMs] of Object.entries(startsIn)) seeded[name] = await seedUpcoming({ userId: student.id, now, startsInMs })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 3, remaining: 0 })

    const reminded: string[] = []
    for (const [name, booking] of Object.entries(seeded)) if ((await reminderSentAtOf(booking.id)) !== null) reminded.push(name)
    expect(reminded.sort()).toEqual(['aMillisecondAhead', 'atTheEdge', 'middle'])
    expect(await allRemindersFor(student.id)).toHaveLength(3)
  })

  it('a booking that has already started is never reminded', async () => {
    const now = new Date()
    const student = await seedStudent()
    // Still inside its grace period (so the student could check in) but past its start.
    const justStarted = await seedUpcoming({ userId: student.id, now, startsInMs: -MINUTE_MS })
    const startsNow = await seedUpcoming({ userId: student.id, now, startsInMs: 0 })
    const lateInGrace = await seedUpcoming({ userId: student.id, now, startsInMs: -14 * MINUTE_MS })

    expect(await sweepBookings(now)).toEqual(NOTHING)

    for (const booking of [justStarted, startsNow, lateInGrace]) {
      expect(await statusOf(booking.id)).toBe('booked')
      expect(await reminderSentAtOf(booking.id)).toBeNull()
    }
    expect(await allRemindersFor(student.id)).toEqual([])
  })

  it('a room approved ten minutes before it starts gets none; a seat booked inside the window gets none', async () => {
    const now = new Date()
    const student = await seedStudent()
    // The sweep runs 5 minutes before the start, after the approval or the booking. For a room the
    // approval is the time that counts (it was requested hours earlier), and the student has just been told.
    const lateApproval = await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: 5 * MINUTE_MS, madeMsBeforeStart: 10 * MINUTE_MS })
    const lateSeat = await seedUpcoming({ userId: student.id, now, type: 'seat', startsInMs: 5 * MINUTE_MS, madeMsBeforeStart: 10 * MINUTE_MS })
    const onTime = await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: 5 * MINUTE_MS })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0 })

    expect(await reminderSentAtOf(lateApproval.id)).toBeNull()
    expect(await reminderSentAtOf(lateSeat.id)).toBeNull()
    expect(await remindersOf(lateApproval.id)).toEqual([])
    expect(await remindersOf(lateSeat.id)).toEqual([])
    expect(await reminderSentAtOf(onTime.id)).not.toBeNull()

    // Later sweeps, closer to the start, still send them nothing.
    expect(await sweepBookings(new Date(now.getTime() + 2 * MINUTE_MS))).toEqual(NOTHING)
    expect(await allRemindersFor(student.id)).toHaveLength(1)
  })

  it('a booking made exactly the lead time before it starts is reminded, one made a millisecond later is not', async () => {
    const now = new Date()
    const student = await seedStudent()
    const exactly = await seedUpcoming({ userId: student.id, now, startsInMs: 10 * MINUTE_MS, madeMsBeforeStart: LEAD_MS })
    const aMillisecondLate = await seedUpcoming({ userId: student.id, now, startsInMs: 10 * MINUTE_MS, madeMsBeforeStart: LEAD_MS - 1 })
    // The same for a room, whose approval is the time that counts.
    const roomExactly = await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: 10 * MINUTE_MS, madeMsBeforeStart: LEAD_MS })
    const roomLate = await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: 10 * MINUTE_MS, madeMsBeforeStart: LEAD_MS - 1 })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0 })

    expect(await reminderSentAtOf(exactly.id)).not.toBeNull()
    expect(await reminderSentAtOf(roomExactly.id)).not.toBeNull()
    expect(await reminderSentAtOf(aMillisecondLate.id)).toBeNull()
    expect(await reminderSentAtOf(roomLate.id)).toBeNull()
  })

  it('an unapproved room request gets none, and neither does any booking that is not booked', async () => {
    const now = new Date()
    const student = await seedStudent()
    // A room request waiting for a librarian is `requested`, never `booked`.
    const request = await seedUpcoming({ userId: student.id, now, type: 'room', status: 'requested' })
    const others: BookingStatus[] = ['cancelled', 'declined', 'checked_in', 'released', 'completed', 'expired', 'no_show']
    const seeded = [request]
    for (const status of others) seeded.push(await seedUpcoming({ userId: student.id, now, status }))

    expect(await sweepBookings(now)).toEqual(NOTHING)

    for (const booking of seeded) expect(await reminderSentAtOf(booking.id)).toBeNull()
    expect(await statusOf(request.id)).toBe('requested')
    expect(await allRemindersFor(student.id)).toEqual([])
    expect(await noticesFor(student.id)).toEqual([])
  })

  it('stops at SWEEP_BATCH, soonest start first, and the rest wait for the next sweep', async () => {
    const now = new Date()
    knobs.batch = 3
    const student = await seedStudent()
    const startsIn = [5, 25, 10, 20, 15].map((minutes) => minutes * MINUTE_MS)
    const bookings: Awaited<ReturnType<typeof seedUpcoming>>[] = []
    for (const startsInMs of startsIn) bookings.push(await seedUpcoming({ userId: student.id, now, startsInMs }))
    const byStart = (minutes: number) => bookings[startsIn.indexOf(minutes * MINUTE_MS)]

    // `remaining` is the first step's leftover (none here), not the reminders'.
    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 3, remaining: 0 })
    for (const minutes of [5, 10, 15]) expect(await reminderSentAtOf(byStart(minutes).id)).not.toBeNull()
    for (const minutes of [20, 25]) expect(await reminderSentAtOf(byStart(minutes).id)).toBeNull()

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0 })
    expect(await sweepBookings(now)).toEqual(NOTHING)
    expect(await allRemindersFor(student.id)).toHaveLength(5)
  })

  it("the batch limit applies to each step on its own, and `remaining` stays the first step's", async () => {
    const now = new Date()
    knobs.batch = 2
    const student = await seedStudent()
    for (let i = 0; i < 3; i++) await seedBooking({ userId: student.id, now, graceEndedMsAgo: (10 + i) * MINUTE_MS })
    for (let i = 0; i < 3; i++) await seedUpcoming({ userId: student.id, now, startsInMs: (5 + i) * MINUTE_MS })

    // Two recorded and one still waiting; two reminded and one still waiting.
    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 2, remaining: 1 })
    expect(await sweepBookings(now)).toEqual({ noShows: 1, reminders: 1, remaining: 0 })
    expect(await sweepBookings(now)).toEqual(NOTHING)
  })

  it('a reminded booking that nobody attends is recorded as a no-show later, and its reminder leaves the list', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0 })
    expect((await listMyNotices(student.id, now)).map((n) => n.title)).toEqual(['Your booking starts soon'])

    // 40 minutes on, the grace period (start + 15 minutes = 35 minutes on) is over.
    const later = new Date(now.getTime() + 40 * MINUTE_MS)
    expect(await sweepBookings(later)).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect(await statusOf(booking.id)).toBe('no_show')
    expect((await listMyNotices(student.id, later)).map((n) => n.title)).toEqual(['Missed booking'])
  })
})

describe('the reminder candidates', () => {
  it('are only the booked bookings still without a reminder that are due now, soonest start first', async () => {
    const now = new Date()
    const student = await seedStudent()
    const later = await seedUpcoming({ userId: student.id, now, startsInMs: 20 * MINUTE_MS })
    const sooner = await seedUpcoming({ userId: student.id, now, startsInMs: 5 * MINUTE_MS })
    const reminded = await seedUpcoming({ userId: student.id, now, startsInMs: 10 * MINUTE_MS })
    await prisma.resourceBooking.update({ where: { id: reminded.id }, data: { reminderSentAt: now } })
    // Every other status is due by the clock and still not a candidate (a status or a mark the
    // conditional update would also refuse; the list must not hand them a place in the batch).
    const others: BookingStatus[] = ['requested', 'cancelled', 'declined', 'checked_in', 'released', 'completed', 'expired', 'no_show']
    for (const status of others) await seedUpcoming({ userId: student.id, now, status, type: status === 'requested' ? 'room' : 'seat' })

    expect(await findReminderCandidates(prisma, now)).toEqual([sooner.id, later.id])
  })

  it('takes at most SWEEP_BATCH of them', async () => {
    const now = new Date()
    knobs.batch = 2
    const student = await seedStudent()
    await seedUpcoming({ userId: student.id, now, startsInMs: 15 * MINUTE_MS })
    const first = await seedUpcoming({ userId: student.id, now, startsInMs: 5 * MINUTE_MS })
    const second = await seedUpcoming({ userId: student.id, now, startsInMs: 10 * MINUTE_MS })

    expect(await findReminderCandidates(prisma, now)).toEqual([first.id, second.id])
  })
})

describe('the reminder email', () => {
  it('email goes only for a room: a seat reminder is never emailed', async () => {
    const now = new Date()
    const send = fakeMail()
    const roomStudent = await seedStudent({ email: 'room.student@example.com' })
    const seatStudent = await seedStudent({ email: 'seat.student@example.com' })
    const room = await seedUpcoming({ userId: roomStudent.id, now, type: 'room', resourceName: 'Study Room A' })
    const seat = await seedUpcoming({ userId: seatStudent.id, now, type: 'seat', resourceName: 'Desk 9' })

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    const [message] = send.mock.calls[0]
    expect(message.to).toBe('room.student@example.com')
    expect(message.subject).toBe('SmartLib: Your booking starts soon')
    expect(message.text).toContain(REMINDER_BODY('Study Room A', room.startTime, room.endTime))
    const [roomNotice] = await remindersOf(room.id)
    expect(roomNotice.emailStatus).toBe('sent')
    expect(roomNotice.emailedAt).not.toBeNull()
    // The seat's reminder is a notice in the app and nothing more: it stays as it was written.
    const [seatNotice] = await remindersOf(seat.id)
    expect(seatNotice.emailStatus).toBe('skipped')
    expect(seatNotice.emailedAt).toBeNull()
  })

  it('a failing email records failed and the reminder notice stands', async () => {
    const now = new Date()
    // The mailer warns (error name only) when a transport throws; that is expected here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = await seedStudent()
    const throwing = await seedStudent()
    const refused = await seedUpcoming({ userId: refusing.id, now, type: 'room', startsInMs: 10 * MINUTE_MS })
    const thrown = await seedUpcoming({ userId: throwing.id, now, type: 'room', startsInMs: 15 * MINUTE_MS })
    fakeMail(async (message) => {
      if (message.to === refusing.email) return { ok: false }
      throw new Error('socket hang up')
    })
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0 })

    for (const [booking, student] of [[refused, refusing], [thrown, throwing]] as const) {
      expect(await reminderSentAtOf(booking.id)).not.toBeNull()
      const [notice] = await remindersOf(booking.id)
      expect(notice.emailStatus).toBe('failed')
      expect(notice.emailedAt).not.toBeNull()
      // The reminder is still there for the student to read in the app.
      expect((await listMyNotices(student.id, now)).map((n) => n.title)).toEqual(['Your booking starts soon'])
    }
    expect(recorder.events).toEqual([])
  })

  it('a demo address is skipped without touching the transport', async () => {
    const now = new Date()
    const send = fakeMail()
    const demo = await seedStudent({ email: 'seed.student3@thapar.edu' })
    const room = await seedUpcoming({ userId: demo.id, now, type: 'room' })

    expect(await sweepBookings(now)).toMatchObject({ reminders: 1 })

    expect(send).not.toHaveBeenCalled()
    const [notice] = await remindersOf(room.id)
    expect(notice.emailStatus).toBe('skipped')
    expect(notice.emailedAt).toBeNull()
  })

  it('goes out at most 10 at a time, and only for the rooms', async () => {
    const now = new Date()
    const held = sendsHeldUntilFull(10)
    const send = fakeMail(held.send)
    const student = await seedStudent()
    for (let i = 0; i < 12; i++) await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: (2 + i) * MINUTE_MS })
    for (let i = 0; i < 2; i++) await seedUpcoming({ userId: student.id, now, type: 'seat', startsInMs: (2 + i) * MINUTE_MS })

    expect(await sweepBookings(now)).toMatchObject({ reminders: 14 })

    expect(send).toHaveBeenCalledTimes(12)
    // Exactly 10 (the first ten are held until they are all in flight) and never 11.
    expect(held.mostInFlight()).toBe(10)
    expect(await prisma.notice.count({ where: { kind: 'booking_reminder', emailStatus: 'sent' } })).toBe(12)
    expect(await prisma.notice.count({ where: { kind: 'booking_reminder', emailStatus: 'skipped' } })).toBe(2)
  }, 90_000)
})

describe('live events for a reminder', () => {
  it('no events are published for a reminder, nor for a sweep that sent nothing', async () => {
    const now = new Date()
    const student = await seedStudent()
    await seedUpcoming({ userId: student.id, now, type: 'room' })
    await seedUpcoming({ userId: student.id, now, type: 'seat' })
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0 })
    expect(await sweepBookings(now)).toEqual(NOTHING)

    // A reminder changes nothing the console shows.
    expect(recorder.events).toEqual([])
  })

  it('a sweep that records a no-show and sends a reminder announces only the no-show', async () => {
    const now = new Date()
    const student = await seedStudent()
    await seedBooking({ userId: student.id, now })
    await seedUpcoming({ userId: student.id, now, type: 'room' })
    recorder = recordEvents()

    expect(await sweepBookings(now)).toEqual({ noShows: 1, reminders: 1, remaining: 0 })

    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
  })
})

describe('a reminder and a change to the booking at the same moment', () => {
  it('a cancel that lands first wins: the sweep waits for it and sends no reminder', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now, type: 'room' })
    recorder = recordEvents()

    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => sweepBookings(now),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'cancelled' } })
      },
    )

    expect(outcome).toEqual({ status: 'fulfilled', value: NOTHING })
    expect(await statusOf(booking.id)).toBe('cancelled')
    expect(await reminderSentAtOf(booking.id)).toBeNull()
    expect(await noticesOf(booking.id)).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a check-in that lands first wins: the sweep waits for it and sends no reminder', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent({ reliabilityScore: 50 })
    const booking = await seedUpcoming({ userId: student.id, now, type: 'room' })

    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => sweepBookings(now),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { status: 'checked_in', checkedInAt: now } })
        await applyReliabilityDelta(tx, student.id, RELIABILITY_ONTIME_BOOKING_BONUS, 'On-time check-in for a resource booking')
      },
    )

    expect(outcome).toEqual({ status: 'fulfilled', value: NOTHING })
    expect(await statusOf(booking.id)).toBe('checked_in')
    expect(await reminderSentAtOf(booking.id)).toBeNull()
    expect(await noticesOf(booking.id)).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(await scoreOf(student.id)).toBe(52)
  }, 60_000)

  it('a reminder sent at the same moment as a cancel is hidden: the reminder lands first, the cancel goes through', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now })

    // The reminder lands (as the competitor, with what it writes); the student's cancel waiting on the row
    // then still finds the booking `booked` and cancels it, so the notice outlives the booking's usefulness.
    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => cancelBooking(student.id, booking.id),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { reminderSentAt: now } })
        await tx.notice.create({
          data: { userId: student.id, kind: 'booking_reminder', title: BOOKING_REMINDER_TITLE, body: 'The sweep wrote this.', bookingId: booking.id },
        })
      },
    )

    expect(outcome.status).toBe('fulfilled')
    expect(await statusOf(booking.id)).toBe('cancelled')
    expect(await remindersOf(booking.id)).toHaveLength(1)
    // It exists, and the student never sees it.
    expect(await listMyNotices(student.id)).toEqual([])
  }, 60_000)

  it('a sweep and a cancel sent at once: neither fails, and the student never sees a reminder for the cancelled booking', async () => {
    const student = await seedStudent()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const now = new Date()
      const booking = await seedUpcoming({ userId: student.id, now, startsInMs: (5 + round) * MINUTE_MS })

      const [swept, cancelled] = await together(
        round,
        () => sweepBookings(now),
        () => settle(cancelBooking(student.id, booking.id)),
      )

      // The cancel cannot lose to a reminder (it does not change the status); the sweep may or may not have got there first.
      expect(cancelled.status).toBe('fulfilled')
      expect(await statusOf(booking.id)).toBe('cancelled')
      expect(await remindersOf(booking.id)).toHaveLength(swept.reminders)
      expect((await reminderSentAtOf(booking.id)) !== null).toBe(swept.reminders === 1)
    }
    expect(await listMyNotices(student.id)).toEqual([])
    // A deadlock between the reminder's transaction and the cancel would have been logged as a failed booking.
    expect(logged).not.toHaveBeenCalled()
  }, 120_000)

  it('a second sweep that waited for the first one to send the reminder sends nothing more', async () => {
    const now = new Date()
    const send = fakeMail()
    const student = await seedStudent()
    const booking = await seedUpcoming({ userId: student.id, now, type: 'room' })
    recorder = recordEvents()

    const outcome = await bookingLockedThenCompete(
      booking.id,
      () => sweepBookings(now),
      async (tx) => {
        await tx.resourceBooking.update({ where: { id: booking.id }, data: { reminderSentAt: now } })
        await tx.notice.create({
          data: { userId: student.id, kind: 'booking_reminder', title: BOOKING_REMINDER_TITLE, body: 'The first sweep wrote this.', bookingId: booking.id },
        })
      },
    )

    expect(outcome).toEqual({ status: 'fulfilled', value: NOTHING })
    expect(await remindersOf(booking.id)).toEqual([expect.objectContaining({ body: 'The first sweep wrote this.' })])
    expect(send).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('two sweeps at once send one reminder, one notice and one email', async () => {
    const send = fakeMail()
    const student = await seedStudent()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const now = new Date()
      const booking = await seedUpcoming({ userId: student.id, now, type: 'room', startsInMs: (5 + round) * MINUTE_MS })
      send.mockClear()
      recorder = recordEvents()

      const [one, two] = await together(round, () => sweepBookings(now), () => sweepBookings(now))

      recorder.stop()
      expect(one.reminders + two.reminders).toBe(1)
      expect(await remindersOf(booking.id)).toHaveLength(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(recorder.events).toEqual([])
    }
    expect(await allRemindersFor(student.id)).toHaveLength(ROUNDS)
  }, 120_000)
})

describe('one failing reminder', () => {
  it('does not stop the rest, rolls back whole, and is logged by its id only', async () => {
    const now = new Date()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent({ name: 'Broken Student', email: 'broken.student@example.com' })
    const healthy = await seedStudent({ name: 'Healthy Student', email: 'healthy.student@example.com' })
    // The broken one starts first, so it is tried first and the loop has to carry on past it.
    const brokenBooking = await seedUpcoming({ userId: broken.id, now, type: 'room', startsInMs: 5 * MINUTE_MS, resourceName: 'Secret Room' })
    const healthyBooking = await seedUpcoming({ userId: healthy.id, now, type: 'room', startsInMs: 10 * MINUTE_MS })
    knobs.failReminderUsers.add(broken.id)
    const send = fakeMail()
    recorder = recordEvents()

    // The reminder that threw makes the step `failed`; the healthy one's count stands.
    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0, failed: ['remind'] })

    // The notice and the mark are one transaction: the failure leaves neither.
    expect(await reminderSentAtOf(brokenBooking.id)).toBeNull()
    expect(await noticesOf(brokenBooking.id)).toEqual([])
    expect(await reminderSentAtOf(healthyBooking.id)).not.toBeNull()
    expect(await remindersOf(healthyBooking.id)).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(recorder.events).toEqual([])

    // One line, naming the booking and nothing else about it or its student.
    expect(logged).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(logged.mock.calls)
    expect(line).toContain(brokenBooking.id)
    for (const secret of ['Broken Student', 'broken.student', broken.id, 'Secret Room', 'notice write down']) expect(line).not.toContain(secret)

    // Still `booked`, still unmarked and still inside the window: the next sweep sends it.
    knobs.failReminderUsers.clear()
    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0 })
    expect(await remindersOf(brokenBooking.id)).toHaveLength(1)
    expect(await reminderSentAtOf(brokenBooking.id)).not.toBeNull()
  })

  it('reminders: the good ones are sent among several, and the step is reported as failed', async () => {
    const now = new Date()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent()
    const goodStudents = [await seedStudent(), await seedStudent()]
    const first = await seedUpcoming({ userId: goodStudents[0].id, now, startsInMs: 5 * MINUTE_MS })
    const middle = await seedUpcoming({ userId: broken.id, now, startsInMs: 10 * MINUTE_MS })
    const last = await seedUpcoming({ userId: goodStudents[1].id, now, startsInMs: 15 * MINUTE_MS })
    knobs.failReminderUsers.add(broken.id)

    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 2, remaining: 0, failed: ['remind'] })

    expect(await reminderSentAtOf(first.id)).not.toBeNull()
    expect(await reminderSentAtOf(last.id)).not.toBeNull()
    expect(await reminderSentAtOf(middle.id)).toBeNull()
  })

  it('every reminder failing is a failed step with zero reminders, not a quiet sweep', async () => {
    const now = new Date()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = await seedStudent()
    await seedUpcoming({ userId: broken.id, now })
    knobs.failReminderUsers.add(broken.id)

    expect(await sweepBookings(now)).toEqual({ ...NOTHING, failed: ['remind'] })
  })
})

describe('the two steps are independent', () => {
  /** Makes every raw query whose SQL says `matches` fail with a connection error; the others pass straight through. */
  function failRawQueriesWhere(matches: (sql: string) => boolean) {
    const real = prisma.$queryRaw.bind(prisma) as (...args: unknown[]) => unknown
    return vi.spyOn(prisma, '$queryRaw').mockImplementation(((query: unknown, ...rest: unknown[]) => {
      if (matches(JSON.stringify(query))) throw new Error('connection lost')
      return real(query, ...rest)
    }) as never)
  }
  const isReminderQuery = (sql: string) => sql.includes('reminderSentAt')

  it("a reminder step that fails does not discard the first step's result", async () => {
    const now = new Date()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const student = await seedStudent()
    const missed = await seedBooking({ userId: student.id, now })
    const upcoming = await seedUpcoming({ userId: student.id, now })
    recorder = recordEvents()
    failRawQueriesWhere(isReminderQuery)

    // The failure is part of the result (`failed`), so a caller (the route, the timer) can tell
    // "nothing to remind" from "the reminders could not run".
    expect(await sweepBookings(now)).toEqual({ noShows: 1, reminders: 0, remaining: 0, failed: ['remind'] })

    expect(await statusOf(missed.id)).toBe('no_show')
    expect(await reminderSentAtOf(upcoming.id)).toBeNull()
    expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED])
    // One line, saying which step and the error's class, nothing else.
    expect(logged).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('connection lost')
  })

  it("a first step that fails does not stop the reminders, and the reminders' result is returned", async () => {
    const now = new Date()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const student = await seedStudent()
    const missed = await seedBooking({ userId: student.id, now })
    const upcoming = await seedUpcoming({ userId: student.id, now })
    failRawQueriesWhere((sql) => !isReminderQuery(sql))

    // `remaining: 0` here is NOT "caught up": the record step never ran, and `failed` says so.
    expect(await sweepBookings(now)).toEqual({ noShows: 0, reminders: 1, remaining: 0, failed: ['record'] })

    expect(await reminderSentAtOf(upcoming.id)).not.toBeNull()
    // Nothing was recorded; the booking is left for the next sweep.
    expect(await statusOf(missed.id)).toBe('booked')
    expect(logged).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('connection lost')
  })

  it('a sweep that fails nowhere has no `failed` key at all, not an empty one', async () => {
    const now = new Date()
    const student = await seedStudent()
    await seedBooking({ userId: student.id, now })
    await seedUpcoming({ userId: student.id, now })

    const result = await sweepBookings(now)

    expect(result).toEqual({ noShows: 1, reminders: 1, remaining: 0 })
    expect(Object.keys(result).sort()).toEqual(['noShows', 'remaining', 'reminders'])
  })

  it('when both steps fail there is nothing to report, so the sweep itself fails, after logging both steps', async () => {
    const now = new Date()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const student = await seedStudent()
    await seedUpcoming({ userId: student.id, now })
    failRawQueriesWhere(() => true)

    await expect(sweepBookings(now)).rejects.toThrow('connection lost')

    // One line per failed step (the second step's failure is not lost behind the first's),
    // each with the error's class only.
    const lines = logged.mock.calls.map((call) => String(call[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('record step failed (Error)')
    expect(lines[1]).toContain('reminder step failed (Error)')
    expect(JSON.stringify(logged.mock.calls)).not.toContain('connection lost')
  })
})

describe('the reminder window does not depend on the database session time zone', () => {
  // The same hazard as the first step's window (see its describe above): the bound `now`
  // is read in the session's zone unless it is declared to be UTC.
  it.each(ZONES)('finds only the booking about to start, made early enough, under a %s session', async (zone) => {
    const now = new Date()
    const student = await seedStudent()
    // The one candidate: starts in 20 minutes, made two hours before.
    const due = await seedUpcoming({ userId: student.id, now, startsInMs: 20 * MINUTE_MS })
    // Not candidates: too far ahead, already started, made inside the window, and the two that a session
    // five hours west or five and a half hours east of UTC would wrongly let in (a reminder hours
    // early, and one for a booking that began hours ago).
    await seedUpcoming({ userId: student.id, now, startsInMs: 45 * MINUTE_MS })
    await seedUpcoming({ userId: student.id, now, startsInMs: -5 * MINUTE_MS })
    await seedUpcoming({ userId: student.id, now, startsInMs: 5 * MINUTE_MS, madeMsBeforeStart: 10 * MINUTE_MS })
    await seedUpcoming({ userId: student.id, now, startsInMs: 5 * HOUR_MS + 15 * MINUTE_MS })
    await seedUpcoming({ userId: student.id, now, startsInMs: -(5 * HOUR_MS + 20 * MINUTE_MS) })

    const found = await underZone(zone, (tx) => findReminderCandidates(tx, now))

    expect(found).toEqual([due.id])
  })
})

// Prisma's interactive transactions give up after 5 s by default. A no-show's transaction is
// about eleven round trips and a reminder's four, and on a slow hop to the database (Render to
// Neon under load) the 5 s can run out: the booking rolls back and the next sweep retries it,
// but if the latency stays high NO booking would ever be recorded. So every transaction the
// sweep opens is given a generous wait for a connection and a generous limit.
describe('the transactions the sweep opens', () => {
  it('all wait and run for much longer than Prisma\'s 5 s default', async () => {
    const now = new Date()
    const student = await seedStudent()
    for (let i = 0; i < 2; i++) await seedBooking({ userId: student.id, now, graceEndedMsAgo: (10 + i) * MINUTE_MS })
    for (let i = 0; i < 2; i++) await seedUpcoming({ userId: student.id, now, startsInMs: (5 + i) * MINUTE_MS })
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => unknown
    const opened = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => real(...args)) as never)

    expect(await sweepBookings(now)).toEqual({ noShows: 2, reminders: 2, remaining: 0 })

    // One transaction per booking: two no-shows and two reminders.
    const calls = opened.mock.calls as unknown as [unknown, { maxWait?: number; timeout?: number } | undefined][]
    expect(calls).toHaveLength(4)
    for (const [, options] of calls) {
      expect(options?.timeout ?? 5_000).toBeGreaterThanOrEqual(15_000)
      expect(options?.maxWait ?? 2_000).toBeGreaterThanOrEqual(10_000)
    }
  })
})
