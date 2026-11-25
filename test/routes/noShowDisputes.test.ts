// A student disputing a recorded no-show from the app (slice 7): ownership (another student's
// booking is a 404), eligibility (a `no_show` booking inside the 7 days after its own grace end),
// one dispute per booking, the order the refusals come in, what a refusal leaves behind (nothing
// written, nothing published), and the races (two submissions at once; a dispute beside a writer
// that holds the booking row). The `noShow` key every booking response carries is in
// test/routes/bookings.test.ts; the librarian's side is Task 7's.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { GRACE_PERIOD_MINUTES, JWT_SECRET } from '../../src/config/constants'
import { Prisma, type BookingStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { noShowInfo } from '../../src/services/bookingService'
import {
  createNoShowDispute,
  NOT_A_NO_SHOW,
  NO_SHOW_ALREADY_DISPUTED,
  NO_SHOW_WINDOW_PASSED,
} from '../../src/services/noShowDisputeService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 6

const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

// The contract's wording, spelled out here so a changed message fails a test.
const NOT_A_NO_SHOW_TEXT = 'This booking is not a recorded no-show.'
const WINDOW_PASSED_TEXT = 'The 7 days to dispute this no-show have passed.'
const ALREADY_DISPUTED_TEXT = "You've already disputed this no-show."

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A one-hour booking on a seat of its own whose check-in window closed `endedAgoMs` ago. */
async function seedBooking(userId: string, endedAgoMs: number, status: BookingStatus = 'no_show', gracePeriodMinutes = GRACE_PERIOD_MINUTES) {
  const seat = await prisma.resource.create({ data: { type: 'seat', name: `Desk ${Math.random()}` } })
  const startTime = new Date(Date.now() - endedAgoMs - gracePeriodMinutes * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status, gracePeriodMinutes },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const dispute = (token: string, bookingId: string, body?: unknown) => {
  const req = request(app).post(`/bookings/${bookingId}/dispute`).set(auth(token))
  return body === undefined ? req : req.send(body as object)
}
const disputesOf = (bookingId: string) => prisma.noShowDispute.findMany({ where: { bookingId } })
const stored = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } })

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

// A race needs both requests to get a database connection at once. A fresh pool has one warm
// connection and opens the next on demand (slow on a remote database), which would queue the
// second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

describe('POST /bookings/:id/dispute', { timeout: 60_000 }, () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
    vi.restoreAllMocks()
  })

  it('exports the contract constants verbatim', () => {
    expect(NOT_A_NO_SHOW).toBe(NOT_A_NO_SHOW_TEXT)
    expect(NO_SHOW_WINDOW_PASSED).toBe(WINDOW_PASSED_TEXT)
    expect(NO_SHOW_ALREADY_DISPUTED).toBe(ALREADY_DISPUTED_TEXT)
  })

  it('creates an open dispute and publishes attention.changed once', async () => {
    const { user, token } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)
    const before = Date.now()
    recorder = recordEvents()

    const res = await dispute(token, booking.id, { reason: 'I was at the desk, the scanner was down' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: expect.any(String), status: 'open' })
    const [row] = await disputesOf(booking.id)
    expect(row).toMatchObject({
      id: res.body.id,
      bookingId: booking.id,
      userId: user.id,
      reason: 'I was at the desk, the scanner was down',
      status: 'open',
      resolutionNote: null,
      resolvedById: null,
      resolvedAt: null,
    })
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    // The booking is exactly as the sweep left it: opening a dispute changes nothing else.
    expect(await stored(booking.id)).toEqual(booking)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).reliabilityScore).toBe(100)
    // One event, once: the librarian's queue changed. No booking, fine or student event with it.
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
  })

  it('the reason is trimmed, and exactly 300 characters is accepted', async () => {
    const { user, token } = await seedUser()
    const padded = await seedBooking(user.id, HOUR_MS)
    const longest = await seedBooking(user.id, HOUR_MS)

    const trimmed = await dispute(token, padded.id, { reason: '   The scanner was down \n' })
    const limit = await dispute(token, longest.id, { reason: ` ${'x'.repeat(300)} ` })

    expect(trimmed.status).toBe(201)
    expect(limit.status).toBe(201)
    expect((await disputesOf(padded.id))[0].reason).toBe('The scanner was down')
    expect((await disputesOf(longest.id))[0].reason).toBe('x'.repeat(300))
  })

  it("another student's booking is 404", async () => {
    const { token } = await seedUser()
    const { user: owner } = await seedUser()
    const theirs = await seedBooking(owner.id, HOUR_MS)
    recorder = recordEvents()

    const other = await dispute(token, theirs.id, { reason: 'Not mine to dispute' })
    const unknown = await dispute(token, 'no-such-booking', { reason: 'Whatever' })

    // 404, not the 403 that check-in and cancel use: another student's id is just not found.
    expect(other.status).toBe(404)
    expect(other.body).toEqual({ error: 'Booking not found' })
    expect(unknown.status).toBe(404)
    expect(unknown.body).toEqual({ error: 'Booking not found' })
    expect(await prisma.noShowDispute.count()).toBe(0)
    expect(await stored(theirs.id)).toEqual(theirs)
    expect(recorder.events).toEqual([])
  })

  it('a booking that is not a no-show is 409 "This booking is not a recorded no-show."', async () => {
    const { user, token } = await seedUser()
    // Every other status, inside what would be the window; a plain release (the legacy backfill) is not a no-show either.
    const statuses: BookingStatus[] = ['booked', 'checked_in', 'completed', 'cancelled', 'requested', 'declined', 'expired', 'released']
    const bookings = await Promise.all(statuses.map((status) => seedBooking(user.id, HOUR_MS, status)))
    recorder = recordEvents()

    for (const [i, booking] of bookings.entries()) {
      const res = await dispute(token, booking.id, { reason: 'It was a no-show, surely' })
      expect(res.status, statuses[i]).toBe(409)
      expect(res.body, statuses[i]).toEqual({ error: NOT_A_NO_SHOW_TEXT })
    }

    expect(await prisma.noShowDispute.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('after seven days from the grace end is 409', async () => {
    const { user, token } = await seedUser()
    const late = await seedBooking(user.id, 7 * DAY_MS + MINUTE_MS)
    const inside = await seedBooking(user.id, 7 * DAY_MS - MINUTE_MS)
    recorder = recordEvents()

    const refused = await dispute(token, late.id, { reason: 'Too late' })
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: WINDOW_PASSED_TEXT })
    expect(await disputesOf(late.id)).toEqual([])
    expect(recorder.events).toEqual([])

    const allowed = await dispute(token, inside.id, { reason: 'Just in time' })
    expect(allowed.status).toBe(201)
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
  })

  it('the window ends exactly seven days after the grace end: at it the dispute is allowed, a millisecond later it is not', async () => {
    const { user } = await seedUser()
    const atTheEnd = await seedBooking(user.id, 0)
    const justAfter = await seedBooking(user.id, 0)
    const windowEnd = (b: { startTime: Date }) => b.startTime.getTime() + (GRACE_PERIOD_MINUTES * MINUTE_MS + 7 * DAY_MS)

    expect(await createNoShowDispute(user.id, atTheEnd.id, 'At the end', new Date(windowEnd(atTheEnd)))).toEqual({
      id: expect.any(String),
      status: 'open',
    })
    await expect(createNoShowDispute(user.id, justAfter.id, 'A moment late', new Date(windowEnd(justAfter) + 1))).rejects.toMatchObject({
      status: 409,
      message: WINDOW_PASSED_TEXT,
    })
    // The dispute is stamped with the instant it was made at (the `now` it was given), not the database's clock.
    expect(await disputesOf(atTheEnd.id)).toEqual([expect.objectContaining({ createdAt: new Date(windowEnd(atTheEnd)) })])
    expect(await disputesOf(justAfter.id)).toEqual([])
  })

  it("the window is the booking's own grace end, not when the sweep recorded the no-show and not the default grace period", async () => {
    const { user, token } = await seedUser()
    // Its own 45-minute grace ended 7 days less 20 minutes ago, so its window closes 20 minutes from now. Read with the
    // default 15 minutes (its start plus 15 is 30 minutes earlier) the window would have closed 10 minutes ago.
    const longGrace = await seedBooking(user.id, 7 * DAY_MS - 20 * MINUTE_MS, 'no_show', 45)
    // A sweep that ran just now does not reopen a window that closed eight days ago.
    const sweptLate = await seedBooking(user.id, 8 * DAY_MS)
    await prisma.noShowEvent.create({ data: { resourceBookingId: sweptLate.id, userId: user.id, actualNoShow: true, reliabilityDelta: -10 } })

    const open = await dispute(token, longGrace.id, { reason: 'My grace was 45 minutes' })
    const closed = await dispute(token, sweptLate.id, { reason: 'The sweep was late' })

    expect(open.status).toBe(201)
    expect(closed.status).toBe(409)
    expect(closed.body).toEqual({ error: WINDOW_PASSED_TEXT })
  })

  it('a second dispute is 409', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user, token } = await seedUser()
    const open = await seedBooking(user.id, HOUR_MS)
    const upheld = await seedBooking(user.id, HOUR_MS)
    // An upheld dispute leaves the booking a no-show, so only the unique bookingId can refuse a second one.
    await prisma.noShowDispute.create({
      data: { bookingId: upheld.id, userId: user.id, reason: 'First go', status: 'upheld', resolvedById: librarian.id, resolvedAt: new Date(), resolutionNote: 'Checked' },
    })
    expect((await dispute(token, open.id, { reason: 'First go' })).status).toBe(201)
    recorder = recordEvents()

    const again = await dispute(token, open.id, { reason: 'Second go' })
    const afterUpheld = await dispute(token, upheld.id, { reason: 'Second go' })

    for (const res of [again, afterUpheld]) {
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: ALREADY_DISPUTED_TEXT })
    }
    // Still one dispute each, the first, unchanged.
    expect(await disputesOf(open.id)).toEqual([expect.objectContaining({ reason: 'First go', status: 'open' })])
    expect(await disputesOf(upheld.id)).toEqual([expect.objectContaining({ reason: 'First go', status: 'upheld', resolutionNote: 'Checked' })])
    expect(recorder.events).toEqual([])
  })

  it('a duplicate that the driver reports as P2039 with SQLSTATE 23505 is the same 409; any other P2039 stays an error', async () => {
    const { user } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)
    const failure = (message: string) => new Prisma.PrismaClientKnownRequestError(message, { code: 'P2039', clientVersion: 'test' })
    const create = vi.spyOn(prisma.noShowDispute, 'create')
    recorder = recordEvents()

    // The database here answers a duplicate with P2002; through the pg driver adapter it can arrive as a generic
    // P2039 whose message carries the SQLSTATE (as the fine dispute's and the borrow request's do).
    create.mockRejectedValueOnce(failure('Database error: duplicate key value violates unique constraint (SQLSTATE 23505)'))
    await expect(createNoShowDispute(user.id, booking.id, 'First')).rejects.toMatchObject({ status: 409, message: ALREADY_DISPUTED_TEXT })

    // A different SQLSTATE is not a duplicate: it is rethrown, never turned into a 409.
    create.mockRejectedValueOnce(failure('Database error: deadlock detected (SQLSTATE 40P01)'))
    await expect(createNoShowDispute(user.id, booking.id, 'First')).rejects.toMatchObject({ code: 'P2039' })

    expect(await disputesOf(booking.id)).toEqual([])
    expect(recorder.events).toEqual([])
  })

  it('the refusals come in order: not found, not a no-show, the window, then already disputed', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user, token } = await seedUser()
    const { user: owner } = await seedUser()
    // A past-window release of someone else's: not found, whatever else is wrong with it.
    const theirs = await seedBooking(owner.id, 9 * DAY_MS, 'released')
    // A release past the window: not a no-show comes before the window.
    const releasedAndLate = await seedBooking(user.id, 9 * DAY_MS, 'released')
    // A no-show past the window that already carries a dispute: the window comes before the unique insert.
    const lateAndDisputed = await seedBooking(user.id, 9 * DAY_MS)
    await prisma.noShowDispute.create({ data: { bookingId: lateAndDisputed.id, userId: user.id, reason: 'Early', status: 'upheld', resolvedById: librarian.id, resolvedAt: new Date() } })
    // An overturned dispute leaves the booking `released`: it answers "not a no-show", the status check first.
    const overturned = await seedBooking(user.id, HOUR_MS, 'released')
    await prisma.noShowDispute.create({ data: { bookingId: overturned.id, userId: user.id, reason: 'Early', status: 'overturned', resolvedById: librarian.id, resolvedAt: new Date() } })
    recorder = recordEvents()

    const answers = await Promise.all(
      [theirs, releasedAndLate, lateAndDisputed, overturned].map((b) => dispute(token, b.id, { reason: 'Again' })),
    )

    expect(answers.map((r) => [r.status, r.body.error])).toEqual([
      [404, 'Booking not found'],
      [409, NOT_A_NO_SHOW_TEXT],
      [409, WINDOW_PASSED_TEXT],
      [409, NOT_A_NO_SHOW_TEXT],
    ])
    expect(recorder.events).toEqual([])
  })

  it('a blank or 301-character reason is 400', async () => {
    const { user, token } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)
    const invalid: Array<[string, unknown]> = [
      ['no body', undefined],
      ['an empty body', {}],
      ['a blank reason', { reason: '   ' }],
      ['an empty reason', { reason: '' }],
      ['301 characters', { reason: 'x'.repeat(301) }],
      ['301 characters between spaces', { reason: ` ${'x'.repeat(301)} ` }],
      ['a number', { reason: 12 }],
      ['null', { reason: null }],
    ]
    recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await dispute(token, booking.id, body)
      expect(res.status, what).toBe(400)
    }

    expect(await prisma.noShowDispute.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('no token is 401', async () => {
    const { user } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)

    const anonymous = await request(app).post(`/bookings/${booking.id}/dispute`).send({ reason: 'Wrong' })
    const garbage = await request(app).post(`/bookings/${booking.id}/dispute`).set('Authorization', 'Bearer not-a-token').send({ reason: 'Wrong' })
    // Authentication comes before the body check.
    const anonymousBadBody = await request(app).post(`/bookings/${booking.id}/dispute`).send({})

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(anonymousBadBody.status).toBe(401)
    expect(await prisma.noShowDispute.count()).toBe(0)
  })

  it('a refusal publishes nothing', async () => {
    const { user, token } = await seedUser()
    const { user: owner } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)
    const notANoShow = await seedBooking(user.id, HOUR_MS, 'checked_in')
    const late = await seedBooking(user.id, 8 * DAY_MS)
    const theirs = await seedBooking(owner.id, HOUR_MS)
    recorder = recordEvents()

    await dispute(token, theirs.id, { reason: 'x' }) // 404
    await dispute(token, notANoShow.id, { reason: 'x' }) // 409, not a no-show
    await dispute(token, late.id, { reason: 'x' }) // 409, the window
    await dispute(token, booking.id, { reason: '' }) // 400
    await request(app).post(`/bookings/${booking.id}/dispute`).send({ reason: 'x' }) // 401
    expect(recorder.events).toEqual([])

    expect((await dispute(token, booking.id, { reason: 'Wrong' })).status).toBe(201)
    expect(recorder.events).toEqual([ATTENTION_CHANGED])

    expect((await dispute(token, booking.id, { reason: 'Again' })).status).toBe(409) // already disputed
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
  })

  it('does not lock the booking row: a dispute goes through while a sweep or a check-in holds it', async () => {
    const { user, token } = await seedUser()
    const booking = await seedBooking(user.id, HOUR_MS)

    // A writer updating the row (the sweep, a check-in) holds FOR NO KEY UPDATE until it commits. The
    // dispute's insert only takes the foreign key's KEY SHARE on the row, which that does not block;
    // a FOR UPDATE on the booking would queue the dispute behind the writer.
    const held = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ResourceBooking" WHERE id = ${booking.id} FOR NO KEY UPDATE`
        const pending = Promise.resolve(dispute(token, booking.id, { reason: 'The scanner was down' }))
        const outcome = await Promise.race([pending, new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 8_000))])
        return { pending, outcome }
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    // Never leave the request running into the next test, even when it was blocked.
    const res = await held.pending

    expect(held.outcome).not.toBe('blocked')
    expect(res.status).toBe(201)
  })
})

describe('two disputes of one booking at once', { timeout: 120_000 }, () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('two submissions at once give one 201 and one 409', async () => {
    const { user, token } = await seedUser()
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const booking = await seedBooking(user.id, HOUR_MS)
      recorder = recordEvents()

      const [first, second] = await together(
        round,
        () => dispute(token, booking.id, { reason: 'First' }),
        () => dispute(token, booking.id, { reason: 'Second' }),
      )

      recorder.stop()
      expect([first.status, second.status].sort()).toEqual([201, 409])
      const loser = first.status === 409 ? first : second
      expect(loser.body).toEqual({ error: ALREADY_DISPUTED_TEXT })
      const winner = first.status === 201 ? 'First' : 'Second'
      expect(await disputesOf(booking.id)).toEqual([expect.objectContaining({ reason: winner, status: 'open' })])
      // The winner announced itself once; the loser published nothing.
      expect(recorder.events).toEqual([ATTENTION_CHANGED])
    }
  })
})

describe('noShowInfo', () => {
  // A booking whose check-in window closed at `graceEnd` (its own grace period of `grace` minutes).
  const graceEnd = new Date('2026-06-10T12:00:00.000Z')
  const row = (status: BookingStatus, grace = 15) => ({
    status,
    gracePeriodMinutes: grace,
    startTime: new Date(graceEnd.getTime() - grace * MINUTE_MS),
  })
  const windowEnd = graceEnd.getTime() + 7 * DAY_MS

  it('is null for a booking that is not a no-show and has no dispute', () => {
    const now = new Date(graceEnd.getTime() + HOUR_MS)
    for (const status of ['booked', 'checked_in', 'released', 'completed', 'cancelled', 'requested', 'declined', 'expired'] as const) {
      expect(noShowInfo(row(status), null, now), status).toBeNull()
    }
  })

  it('a no-show with no dispute can be disputed up to and including seven days after its grace end', () => {
    expect(noShowInfo(row('no_show'), null, new Date(graceEnd.getTime() + MINUTE_MS))).toEqual({ canDispute: true, dispute: null })
    expect(noShowInfo(row('no_show'), null, new Date(windowEnd))).toEqual({ canDispute: true, dispute: null })
    expect(noShowInfo(row('no_show'), null, new Date(windowEnd + 1))).toEqual({ canDispute: false, dispute: null })
  })

  it("uses the booking's own grace period", () => {
    // 45 minutes of grace: the window ends 30 minutes after one with the default 15 would.
    const longGrace = row('no_show', 45)
    const longEnd = longGrace.startTime.getTime() + 45 * MINUTE_MS + 7 * DAY_MS
    expect(noShowInfo(longGrace, null, new Date(longEnd))).toEqual({ canDispute: true, dispute: null })
    expect(noShowInfo(longGrace, null, new Date(longEnd + 1))).toEqual({ canDispute: false, dispute: null })
  })

  it('a dispute, whatever its state, means canDispute is false and carries its status and note', () => {
    const now = new Date(graceEnd.getTime() + HOUR_MS)
    expect(noShowInfo(row('no_show'), { status: 'open', resolutionNote: null }, now)).toEqual({
      canDispute: false,
      dispute: { status: 'open', note: null },
    })
    expect(noShowInfo(row('no_show'), { status: 'upheld', resolutionNote: 'Scanner log shows no tap' }, now)).toEqual({
      canDispute: false,
      dispute: { status: 'upheld', note: 'Scanner log shows no tap' },
    })
  })

  it('an overturned booking is released again but keeps saying what happened', () => {
    const now = new Date(graceEnd.getTime() + HOUR_MS)
    expect(noShowInfo(row('released'), { status: 'overturned', resolutionNote: 'Scanner was down' }, now)).toEqual({
      canDispute: false,
      dispute: { status: 'overturned', note: 'Scanner was down' },
    })
    // Any booking that carries a dispute row has a noShow, whatever its status says.
    expect(noShowInfo(row('completed'), { status: 'open', resolutionNote: null }, now)).toEqual({
      canDispute: false,
      dispute: { status: 'open', note: null },
    })
  })
})
