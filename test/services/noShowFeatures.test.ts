// The ten features of a booking, built from the database (slice 7, spec section 6, "Feature
// definitions"). The Node builder and the Python simulator must agree on every definition, so
// the heart of this file is the shared fixture: test/fixtures/noshow-features.json is a
// byte-identical copy of ai-backend/tests/fixtures/noshow_features.json (Task 12), whose cases
// carry their own `now` and `tz`. Each case is seeded into real rows (the fixture is the one
// place fixed calendar dates are allowed: the cases are authoritative), the builder runs against
// them, and all ten features are compared. The tests after it use the real clock.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_SHOW_PRIOR_ATTENDANCE } from '../../src/config/constants'
import type { BookingStatus } from '../../src/generated/prisma/client'
import { NO_SHOW_FEATURE_KEYS, type NoShowFeatures } from '../../src/lib/aiClient'
import { prisma } from '../../src/lib/prisma'
import { buildNoShowFeatures } from '../../src/services/noShowFeatures'
import { resetDb } from '../helpers/db'

interface FixtureCase {
  name: string
  description: string
  now: string
  tz: string
  booking: { startTime: string; endTime: string; requestedAt: string; resourceType: 'seat' | 'room' }
  history: Array<{ status: BookingStatus; startTime: string; requestedAt: string; overturned?: boolean }>
  reliability_score: number
  expected: NoShowFeatures
}

const CASES: FixtureCase[] = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/noshow-features.json', import.meta.url)), 'utf8'))

// Seeding a case and reading it back is a few dozen round trips: the 15 s default is too tight on a
// remote database.
vi.setConfig({ testTimeout: 60_000 })

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// The ints, the string and the floats of NoShowFeatures: the floats are compared to 9 decimals so
// a harmless last-bit difference between Python's and JavaScript's division is not a failure.
const FLOAT_KEYS = ['lead_time_hours', 'past_attendance_ratio', 'reliability_score'] as const
const EXACT_KEYS = NO_SHOW_FEATURE_KEYS.filter((key) => !(FLOAT_KEYS as readonly string[]).includes(key))

function expectFeatures(actual: NoShowFeatures, expected: NoShowFeatures) {
  // Same keys, in the AI service's field order.
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  for (const key of EXACT_KEYS) expect(actual[key], key).toBe(expected[key])
  for (const key of FLOAT_KEYS) expect(actual[key], key).toBeCloseTo(expected[key] as number, 9)
}

async function seedStudent(reliabilityScore?: number) {
  return prisma.user.create({
    data: { name: `Student ${Math.random()}`, email: `student${Math.random()}@example.com`, passwordHash: 'x', reliabilityScore },
  })
}

interface RowSeed {
  status: BookingStatus
  startTime: Date
  requestedAt: Date
  /** A `released` row whose no-show a librarian overturned (it carries an overturned dispute). */
  overturned?: boolean
}

/**
 * The scored booking (on a resource of its own, of the given type) and a student's other bookings
 * (all on one seat, an hour long each: none of the cases puts two slot-holding rows at one time).
 */
async function seedBookings(userId: string, booking: { startTime: Date; endTime: Date; requestedAt: Date; resourceType: 'seat' | 'room' }, history: RowSeed[]) {
  const [own, other] = await Promise.all([
    prisma.resource.create({ data: { type: booking.resourceType, name: `Scored ${Math.random()}` } }),
    prisma.resource.create({ data: { type: 'seat', name: `History ${Math.random()}` } }),
  ])
  const scored = await prisma.resourceBooking.create({
    data: {
      userId,
      resourceId: own.id,
      startTime: booking.startTime,
      endTime: booking.endTime,
      requestedAt: booking.requestedAt,
      status: booking.resourceType === 'room' ? 'requested' : 'booked',
    },
  })
  const rows = history.map((row) => ({ ...row, id: randomUUID() }))
  await prisma.resourceBooking.createMany({
    data: rows.map((row) => ({
      id: row.id,
      userId,
      resourceId: other.id,
      startTime: row.startTime,
      endTime: new Date(row.startTime.getTime() + HOUR_MS),
      requestedAt: row.requestedAt,
      status: row.status,
    })),
  })
  await prisma.noShowDispute.createMany({
    data: rows.filter((row) => row.overturned).map((row) => ({ bookingId: row.id, userId, reason: 'I was there', status: 'overturned' as const })),
  })
  return scored
}

describe('the shared feature fixture', () => {
  // Every case has a student of its own, so the rows of one cannot leak into another and the
  // database is cleared once (a reset per case would cost the file minutes on a remote database).
  beforeAll(resetDb)
  afterAll(resetDb)

  it('has the cases the ai-backend wrote, each with all ten features', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20)
    for (const c of CASES) expect(Object.keys(c.expected), c.name).toEqual([...NO_SHOW_FEATURE_KEYS])
  })

  for (const c of CASES) {
    it(c.name, async () => {
      const student = await seedStudent(c.reliability_score)
      const booking = await seedBookings(
        student.id,
        {
          startTime: new Date(c.booking.startTime),
          endTime: new Date(c.booking.endTime),
          requestedAt: new Date(c.booking.requestedAt),
          resourceType: c.booking.resourceType,
        },
        c.history.map((row) => ({
          status: row.status,
          startTime: new Date(row.startTime),
          requestedAt: new Date(row.requestedAt),
          overturned: row.overturned,
        })),
      )

      const features = await buildNoShowFeatures(booking.id, new Date(c.now), c.tz)

      expectFeatures(features, c.expected)
    })
  }
})

describe('buildNoShowFeatures', () => {
  beforeEach(resetDb)
  afterEach(() => vi.restoreAllMocks())

  it('a student with no history gets the 0.85 prior', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + 26 * HOUR_MS), endTime: new Date(now.getTime() + 27 * HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [],
    )

    const features = await buildNoShowFeatures(booking.id, now)

    expect(NO_SHOW_PRIOR_ATTENDANCE).toBe(0.85)
    expect(features).toMatchObject({
      past_attendance_ratio: 0.85,
      consecutive_attended_count: 0,
      recent_noshows_count: 0,
      bookings_last_30d: 0,
      reliability_score: 100,
      resource_type: 'seat',
      duration_minutes: 60,
    })
    expect(features.lead_time_hours).toBeCloseTo(26, 9)
  })

  it('an overturned no-show counts as attended', async () => {
    const now = new Date()
    const student = await seedStudent(90)
    const day = (ago: number) => new Date(now.getTime() - ago * DAY_MS)
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'room' },
      [
        { status: 'no_show', startTime: day(20), requestedAt: day(21) },
        // The librarian removed this no-show: the student was there.
        { status: 'released', startTime: day(10), requestedAt: day(11), overturned: true },
        { status: 'checked_in', startTime: day(4), requestedAt: day(5) },
      ],
    )

    const features = await buildNoShowFeatures(booking.id, now)

    // Attended twice, missed once: 2 of 3, and both attended rows come after the miss.
    expect(features.past_attendance_ratio).toBeCloseTo(2 / 3, 12)
    expect(features.consecutive_attended_count).toBe(2)
    expect(features.recent_noshows_count).toBe(1)
    expect(features.resource_type).toBe('room')
    expect(features.reliability_score).toBe(90)
  })

  it('a released row whose dispute was not overturned is not attended', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [{ status: 'released', startTime: new Date(now.getTime() - 3 * DAY_MS), requestedAt: new Date(now.getTime() - 4 * DAY_MS) }],
    )
    // A dispute that is still open (or upheld) does not make a row attended either.
    const released = await prisma.resourceBooking.findFirstOrThrow({ where: { userId: student.id, status: 'released' } })
    await prisma.noShowDispute.create({ data: { bookingId: released.id, userId: student.id, reason: 'I was there', status: 'open' } })

    const features = await buildNoShowFeatures(booking.id, now)

    expect(features.past_attendance_ratio).toBe(NO_SHOW_PRIOR_ATTENDANCE)
    expect(features.consecutive_attended_count).toBe(0)
  })

  it('legacy released and cancelled rows are ignored', async () => {
    const now = new Date()
    const student = await seedStudent()
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS)
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [
        { status: 'released', startTime: ago(5), requestedAt: ago(6) },
        { status: 'cancelled', startTime: ago(6), requestedAt: ago(7) },
        { status: 'declined', startTime: ago(7), requestedAt: ago(8) },
        { status: 'expired', startTime: ago(8), requestedAt: ago(9) },
        { status: 'completed', startTime: ago(2), requestedAt: ago(3) },
      ],
    )

    const features = await buildNoShowFeatures(booking.id, now)

    // Only the completed row is attended; the released one is not a miss, and the three that
    // never happened are not bookings at all (released still is one: it was made).
    expect(features.past_attendance_ratio).toBe(1)
    expect(features.consecutive_attended_count).toBe(1)
    expect(features.recent_noshows_count).toBe(0)
    expect(features.bookings_last_30d).toBe(2)
  })

  it('counts only the scored student: another student never moves the features', async () => {
    const now = new Date()
    const student = await seedStudent()
    const stranger = await seedStudent()
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS)
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [{ status: 'completed', startTime: ago(2), requestedAt: ago(3) }],
    )
    // Three misses by someone else, on the same kind of resource.
    await seedBookings(
      stranger.id,
      { startTime: new Date(now.getTime() + 2 * DAY_MS), endTime: new Date(now.getTime() + 2 * DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [
        { status: 'no_show', startTime: ago(1), requestedAt: ago(2) },
        { status: 'no_show', startTime: ago(2), requestedAt: ago(3) },
        { status: 'no_show', startTime: ago(3), requestedAt: ago(4) },
      ],
    )

    const features = await buildNoShowFeatures(booking.id, now)

    expect(features).toMatchObject({ past_attendance_ratio: 1, recent_noshows_count: 0, consecutive_attended_count: 1, bookings_last_30d: 1 })
  })

  it('does not count the booking being scored in bookings_last_30d', async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: new Date(now.getTime() - MINUTE_MS), resourceType: 'seat' },
      [],
    )

    // It was requested a minute ago, inside every window, and is the only booking there is.
    expect((await buildNoShowFeatures(booking.id, now)).bookings_last_30d).toBe(0)
  })

  it('anchors the lead time on the booking own requestedAt, not on now', async () => {
    const now = new Date()
    const student = await seedStudent()
    const start = new Date(now.getTime() + 10 * HOUR_MS)
    const booking = await seedBookings(
      student.id,
      { startTime: start, endTime: new Date(start.getTime() + HOUR_MS), requestedAt: new Date(now.getTime() - 2 * HOUR_MS), resourceType: 'room' },
      [],
    )

    // Asked for 12 hours before it starts, scored 2 hours later: still a 12-hour lead.
    expect((await buildNoShowFeatures(booking.id, now)).lead_time_hours).toBeCloseTo(12, 9)
    // Scoring it a day late does not change that.
    expect((await buildNoShowFeatures(booking.id, new Date(now.getTime() + DAY_MS))).lead_time_hours).toBeCloseTo(12, 9)
  })

  it("takes the 90-day and 30-day windows from the `now` it is given, not from the clock", async () => {
    const real = new Date()
    const student = await seedStudent()
    const ago = (days: number) => new Date(real.getTime() - days * DAY_MS)
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(real.getTime() + DAY_MS), endTime: new Date(real.getTime() + DAY_MS + HOUR_MS), requestedAt: real, resourceType: 'seat' },
      [{ status: 'no_show', startTime: ago(40), requestedAt: ago(41) }],
    )

    // Now: the miss is 40 days old, inside 90 days and outside 30.
    expect(await buildNoShowFeatures(booking.id, real)).toMatchObject({ past_attendance_ratio: 0, recent_noshows_count: 0 })
    // Scored 60 days ago: the same miss had not happened yet (it starts after that `now`).
    expect(await buildNoShowFeatures(booking.id, ago(60))).toMatchObject({ past_attendance_ratio: NO_SHOW_PRIOR_ATTENDANCE })
    // Scored 15 days ago: the miss was 25 days old then, so recent.
    expect(await buildNoShowFeatures(booking.id, ago(15))).toMatchObject({ recent_noshows_count: 1 })
  })

  it("hour and weekday default to the server's time zone, Monday = 0", async () => {
    const now = new Date()
    const student = await seedStudent()
    // Late evening on a day in the server's own zone: in UTC it is a different hour on most servers.
    const start = new Date(now.getTime() + 2 * DAY_MS)
    start.setHours(23, 30, 0, 0)
    const booking = await seedBookings(
      student.id,
      { startTime: start, endTime: new Date(start.getTime() + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [],
    )

    const features = await buildNoShowFeatures(booking.id, now)

    expect(features.hour_of_day).toBe(23)
    // JavaScript's getDay() has Sunday = 0; the features have Monday = 0.
    expect(features.day_of_week).toBe((start.getDay() + 6) % 7)
  })

  it('takes hour and weekday in the zone it is given', async () => {
    const now = new Date()
    const student = await seedStudent()
    // 20:30 UTC on a Monday, which is 02:00 Tuesday in Asia/Kolkata (UTC+5:30).
    const monday = new Date(Date.UTC(2031, 0, 6, 20, 30, 0))
    expect(monday.getUTCDay()).toBe(1)
    const booking = await seedBookings(
      student.id,
      { startTime: monday, endTime: new Date(monday.getTime() + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [],
    )

    expect(await buildNoShowFeatures(booking.id, now, 'UTC')).toMatchObject({ hour_of_day: 20, day_of_week: 0 })
    expect(await buildNoShowFeatures(booking.id, now, 'Asia/Kolkata')).toMatchObject({ hour_of_day: 2, day_of_week: 1 })
  })

  it('reads a booking that does not exist as an error, not as a guess', async () => {
    await expect(buildNoShowFeatures(randomUUID(), new Date())).rejects.toThrow()
  })

  it('reads the history with one typed findMany, however long it is (no query per row, no raw SQL)', async () => {
    const now = new Date()
    const student = await seedStudent()
    const history: RowSeed[] = Array.from({ length: 25 }, (_, i) => ({
      status: 'completed' as const,
      startTime: new Date(now.getTime() - (i + 1) * DAY_MS),
      requestedAt: new Date(now.getTime() - (i + 2) * DAY_MS),
    }))
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      history,
    )
    const historyReads = vi.spyOn(prisma.resourceBooking, 'findMany')
    const disputeReads = [vi.spyOn(prisma.noShowDispute, 'findMany'), vi.spyOn(prisma.noShowDispute, 'findFirst'), vi.spyOn(prisma.noShowDispute, 'findUnique')]
    const rawReads = vi.spyOn(prisma, '$queryRaw')

    const features = await buildNoShowFeatures(booking.id, now)

    // The 25 rows (each with its dispute, if any) come in one findMany: the disputes are selected
    // with them, never read per row, and nothing goes through raw SQL (a raw read of a timestamptz
    // column comes back shifted under a non-UTC session; the typed read does not).
    expect(features.consecutive_attended_count).toBe(20)
    expect(historyReads).toHaveBeenCalledTimes(1)
    for (const read of disputeReads) expect(read).not.toHaveBeenCalled()
    expect(rawReads).not.toHaveBeenCalled()
  })
})

describe('the feature keys', () => {
  beforeEach(resetDb)

  it("the feature keys equal the fixture's and aiClient's NoShowFeatures keys", async () => {
    const now = new Date()
    const student = await seedStudent()
    const booking = await seedBookings(
      student.id,
      { startTime: new Date(now.getTime() + DAY_MS), endTime: new Date(now.getTime() + DAY_MS + HOUR_MS), requestedAt: now, resourceType: 'seat' },
      [],
    )

    const built = Object.keys(await buildNoShowFeatures(booking.id, now)).sort()

    for (const c of CASES) expect(Object.keys(c.expected).sort(), c.name).toEqual(built)
    expect([...NO_SHOW_FEATURE_KEYS].sort()).toEqual(built)
    expect(built).toHaveLength(10)
  })
})
