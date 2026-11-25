// POST /internal/sweep: how a scheduled GitHub Actions workflow runs the no-show sweep
// (slice 7, spec section 4). It is not an admin route and has no login: the only
// credential is the `x-sweep-token` header, compared in constant time with SWEEP_TOKEN,
// and with no SWEEP_TOKEN configured the route does not exist.
//
// A sweep that could not run one of its steps must be LOUD here: the route answers 500
// (with the counts and the failed step in the body), because the workflow's curl fails on
// a non-2xx answer and GitHub then emails the owner. A quiet 200 would let no-shows or
// reminders stop for weeks with nobody told.
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetLazySweepForTests, settleSweepsForTests, sweepIfDue, enableLazySweepForTests } from '../../src/services/noShowService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

// Knobs the tests turn to make EVERY booking of one step fail inside its own transaction (a candidate
// query that works, then a write that does not: a slow database that times every transaction out, or a
// production schema that drifted). Both are off by default, so every other test runs the real services.
const knobs = vi.hoisted(() => ({ failNoShowWrites: false, failReminderWrites: false }))

vi.mock('../../src/services/reliabilityService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/reliabilityService')>()
  return {
    ...actual,
    applyReliabilityDelta: async (...args: Parameters<typeof actual.applyReliabilityDelta>) => {
      if (knobs.failNoShowWrites) throw new Error('reliability write down')
      return actual.applyReliabilityDelta(...args)
    },
  }
})

vi.mock('../../src/services/noticeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/noticeService')>()
  return {
    ...actual,
    createNotice: (...args: Parameters<typeof actual.createNotice>) => {
      if (knobs.failReminderWrites && args[1].kind === 'booking_reminder') throw new Error('notice write down')
      return actual.createNotice(...args)
    },
  }
})

// A sweep with real work is a few dozen round trips to a remote database.
vi.setConfig({ testTimeout: 60_000 })

// Not a secret: a made-up value for this file, never one a real deployment uses.
const TOKEN = `unit-test-sweep-token-${'q'.repeat(40)}`
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const originalToken = process.env.SWEEP_TOKEN
beforeEach(() => {
  process.env.SWEEP_TOKEN = TOKEN
})
afterEach(() => {
  if (originalToken === undefined) delete process.env.SWEEP_TOKEN
  else process.env.SWEEP_TOKEN = originalToken
  knobs.failNoShowWrites = false
  knobs.failReminderWrites = false
  vi.restoreAllMocks()
})

const sweep = (token?: string) => {
  const req = request(app).post('/internal/sweep')
  return token === undefined ? req : req.set('x-sweep-token', token)
}

async function seedStudent() {
  const user = await prisma.user.create({
    data: { name: `Student ${Math.random()}`, email: `student${Math.random()}@example.com`, passwordHash: 'x' },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

/** A booked seat whose grace period ended 5 minutes ago: the sweep records it as a no-show. */
async function seedMissedBooking(userId: string) {
  const seat = await prisma.resource.create({ data: { type: 'seat', name: `Desk ${Math.random()}` } })
  const startTime = new Date(Date.now() - 20 * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: { userId, resourceId: seat.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'booked' },
  })
}

/** A booked seat that starts in 20 minutes and was made two hours before: due its reminder. */
async function seedUpcomingBooking(userId: string) {
  const seat = await prisma.resource.create({ data: { type: 'seat', name: `Desk ${Math.random()}` } })
  const startTime = new Date(Date.now() + 20 * MINUTE_MS)
  return prisma.resourceBooking.create({
    data: {
      userId,
      resourceId: seat.id,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status: 'booked',
      requestedAt: new Date(startTime.getTime() - 2 * HOUR_MS),
    },
  })
}

/** Makes every raw query whose SQL says `matches` fail with a connection error; the others pass straight through. */
function failRawQueriesWhere(matches: (sql: string) => boolean) {
  const real = prisma.$queryRaw.bind(prisma) as (...args: unknown[]) => unknown
  return vi.spyOn(prisma, '$queryRaw').mockImplementation(((query: unknown, ...rest: unknown[]) => {
    if (matches(JSON.stringify(query))) throw new Error('connection lost')
    return real(query, ...rest)
  }) as never)
}
const isReminderQuery = (sql: string) => sql.includes('reminderSentAt')

/** Every console method the app could print through, so a test can prove the token never reaches any. */
function captureConsole() {
  return (['log', 'error', 'warn', 'info', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
}
// An Error is spelled out (name, message, stack): JSON.stringify prints one as {}, which would hide a leak.
const printed = (spies: ReturnType<typeof captureConsole>) =>
  spies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => (arg instanceof Error ? [arg.name, arg.message, arg.stack].join(' ') : typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' | ')

describe('POST /internal/sweep: the route only exists when SWEEP_TOKEN is set', () => {
  it('is 404 when SWEEP_TOKEN is unset, even for a request that sends a token', async () => {
    delete process.env.SWEEP_TOKEN

    const res = await sweep(TOKEN)
    const unknown = await request(app).post('/internal/no-such-route')

    expect(res.status).toBe(404)
    // The same answer as a path that was never defined: the route behaves as absent.
    expect(res.status).toBe(unknown.status)
    expect(res.text).toBe(unknown.text.replace('no-such-route', 'sweep'))
  })

  it.each(['', '   ', '\t'])('is 404 when SWEEP_TOKEN is blank (%j), so an empty header cannot match an empty secret', async (blank) => {
    process.env.SWEEP_TOKEN = blank

    expect((await sweep(blank.trim())).status).toBe(404)
    expect((await sweep(TOKEN)).status).toBe(404)
    expect((await sweep()).status).toBe(404)
  })

  it('answers only POST: a GET is 404 even with the right token', async () => {
    const res = await request(app).get('/internal/sweep').set('x-sweep-token', TOKEN)

    expect(res.status).toBe(404)
  })
})

describe('POST /internal/sweep: the token', () => {
  beforeEach(resetDb)

  it('is 401 for a missing token, and 200 with the counts for the right one', async () => {
    const missing = await sweep()
    expect(missing.status).toBe(401)
    expect(missing.body).toEqual({ error: expect.any(String) })

    const ok = await sweep(TOKEN)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ noShows: 0, reminders: 0, remaining: 0 })
  })

  it('is 401 for a wrong token', async () => {
    const res = await sweep('not-the-token')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: expect.any(String) })
  })

  it('is 401 for a token that differs only in its last character', async () => {
    const res = await sweep(`${TOKEN.slice(0, -1)}r`)

    expect(res.status).toBe(401)
  })

  it.each([1, TOKEN.length - 1, TOKEN.length + 1, TOKEN.length * 2, 4000])(
    'a wrong token of a different length (%i characters) is 401, not an error',
    async (length) => {
      // timingSafeEqual throws on two buffers of different lengths; that must never reach the caller.
      const res = await sweep('z'.repeat(length))

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: expect.any(String) })
    },
  )

  it('is 401 for an empty token header', async () => {
    const res = await sweep('')

    expect(res.status).toBe(401)
  })

  it('compares two SHA-256 digests with crypto.timingSafeEqual, whatever the length of what was sent', async () => {
    const compare = vi.spyOn(crypto, 'timingSafeEqual')

    await sweep(TOKEN)
    await sweep('short')
    await sweep('z'.repeat(1000))

    expect(compare).toHaveBeenCalledTimes(3)
    for (const [a, b] of compare.mock.calls) {
      // Equal length every time (a digest), and never the token itself.
      expect(Buffer.byteLength(a as Buffer)).toBe(32)
      expect(Buffer.byteLength(b as Buffer)).toBe(32)
      expect(Buffer.from(a as Buffer).equals(Buffer.from(TOKEN))).toBe(false)
      expect(Buffer.from(b as Buffer).equals(Buffer.from(TOKEN))).toBe(false)
    }
  })

  it('is not an admin route and takes no login: a login token is no substitute for the sweep token', async () => {
    const admin = await prisma.user.create({
      data: { name: 'Librarian', email: `lib${Math.random()}@example.com`, passwordHash: 'x', role: 'admin' },
    })
    const adminJwt = jwt.sign({ sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
    const { token: studentJwt } = await seedStudent()

    for (const bearer of [adminJwt, studentJwt]) {
      const without = await request(app).post('/internal/sweep').set('Authorization', `Bearer ${bearer}`)
      const wrong = await request(app).post('/internal/sweep').set('Authorization', `Bearer ${bearer}`).set('x-sweep-token', 'nope')
      expect(without.status).toBe(401)
      expect(wrong.status).toBe(401)
    }
    // ...and the sweep token needs no login.
    expect((await sweep(TOKEN)).status).toBe(200)
  })

  it('does not take the token from the Authorization header or the query string', async () => {
    const viaBearer = await request(app).post('/internal/sweep').set('Authorization', `Bearer ${TOKEN}`)
    const viaQuery = await request(app).post(`/internal/sweep?token=${TOKEN}&x-sweep-token=${TOKEN}`)

    expect(viaBearer.status).toBe(401)
    expect(viaQuery.status).toBe(401)
  })

  it('never prints the token or the header: not for a good call, a refused one or a failed sweep', async () => {
    const spies = captureConsole()
    const student = await seedStudent()
    await seedMissedBooking(student.user.id)

    await sweep(TOKEN)
    await sweep('wrong-token-value-to-look-for')
    await sweep()
    failRawQueriesWhere(isReminderQuery)
    await sweep(TOKEN)
    failRawQueriesWhere(() => true)
    await sweep(TOKEN)

    const output = printed(spies)
    expect(output).not.toContain(TOKEN)
    expect(output).not.toContain('wrong-token-value-to-look-for')
    expect(output.toLowerCase()).not.toContain('x-sweep-token')
  })
})

describe('POST /internal/sweep: the sweep', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('does the work before it answers, and answers the counts', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.user.id)
    const upcoming = await seedUpcomingBooking(student.user.id)

    const res = await sweep(TOKEN)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ noShows: 1, reminders: 1, remaining: 0 })
    // Awaited: by the time the answer arrived the work was committed, so a workflow that exits
    // when the answer comes back has not abandoned a half-done sweep.
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('no_show')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: upcoming.id } })).reminderSentAt).not.toBeNull()
    expect(await prisma.notice.count({ where: { userId: student.user.id } })).toBe(2)
  })

  it('a second call right after has nothing left to do', async () => {
    const student = await seedStudent()
    await seedMissedBooking(student.user.id)

    expect((await sweep(TOKEN)).body).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
    expect((await sweep(TOKEN)).body).toEqual({ noShows: 0, reminders: 0, remaining: 0 })
  })

  it('no live event is published for an empty sweep', async () => {
    recorder = recordEvents()

    const res = await sweep(TOKEN)

    expect(res.status).toBe(200)
    expect(recorder.events).toEqual([])
  })

  it('publishes the booking and student events once for a recorded no-show', async () => {
    const student = await seedStudent()
    await seedMissedBooking(student.user.id)
    recorder = recordEvents()

    await sweep(TOKEN)

    expect(recorder.events).toEqual([
      { type: 'booking.changed', topics: ['bookings', 'metrics'] },
      { type: 'student.changed', topics: ['students'] },
    ])
  })

  it('logs the three counts when something was done, and nothing when the sweep was idle', async () => {
    const student = await seedStudent()
    await seedMissedBooking(student.user.id)
    const [log, error] = captureConsole()

    await sweep(TOKEN)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toMatch(/1 no-show.*0 reminders.*0/)
    expect(error).not.toHaveBeenCalled()

    log.mockClear()
    await sweep(TOKEN)
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('POST /internal/sweep: a failing sweep is a failing request, so the workflow turns red', () => {
  beforeEach(resetDb)

  it('answers 500 with the counts and the failed step when the reminder step failed, its work and the other step committed', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.user.id)
    const upcoming = await seedUpcomingBooking(student.user.id)
    const spies = captureConsole()
    failRawQueriesWhere(isReminderQuery)

    const res = await sweep(TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ noShows: 1, reminders: 0, remaining: 0, failed: ['remind'] })
    // The record step's work stands; the failed step's candidate was left for the next sweep.
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('no_show')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: upcoming.id } })).reminderSentAt).toBeNull()
    // Logged at error level with the counts and the step name, and no error text.
    const errors = spies[1].mock.calls.map((call) => String(call[0]))
    expect(errors.some((line) => line.includes('(remind)') && /1 no-show/.test(line))).toBe(true)
    expect(printed(spies)).not.toContain('connection lost')
  })

  it('answers 500 with the failed record step, and still sends the reminders', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.user.id)
    const upcoming = await seedUpcomingBooking(student.user.id)
    captureConsole()
    failRawQueriesWhere((sql) => !isReminderQuery(sql))

    const res = await sweep(TOKEN)

    expect(res.status).toBe(500)
    // `remaining: 0` next to `failed` is "could not run", not "caught up".
    expect(res.body).toEqual({ noShows: 0, reminders: 1, remaining: 0, failed: ['record'] })
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('booked')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: upcoming.id } })).reminderSentAt).not.toBeNull()
  })

  it('answers 500 with no error text when both steps failed (the sweep threw)', async () => {
    const spies = captureConsole()
    failRawQueriesWhere(() => true)

    const res = await sweep(TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: expect.any(String) })
    expect(JSON.stringify(res.body)).not.toContain('connection lost')
    // Both steps and the sweep itself are in the log, by error class only.
    const errors = spies[1].mock.calls.map((call) => String(call[0]))
    expect(errors.some((line) => line.includes('record step failed'))).toBe(true)
    expect(errors.some((line) => line.includes('reminder step failed'))).toBe(true)
    expect(printed(spies)).not.toContain('connection lost')
  })

  // The candidate query works and then every booking's own transaction fails (a slow database that
  // times each one out, a production schema that drifted from the code). Nothing throws out of the
  // step, so before this was counted such a run answered a green 200 with zeros, every run, until the
  // bookings aged out of the 24-hour look-back and were never recorded.
  it('answers 500 with the failed record step when EVERY booking of it threw, and still sends the reminders', async () => {
    const first = await seedStudent()
    const second = await seedStudent()
    const missedOne = await seedMissedBooking(first.user.id)
    const missedTwo = await seedMissedBooking(second.user.id)
    const upcoming = await seedUpcomingBooking(first.user.id)
    const spies = captureConsole()
    knobs.failNoShowWrites = true

    const res = await sweep(TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ noShows: 0, reminders: 1, remaining: 0, failed: ['record'] })
    // Every transaction rolled back whole; the other step's work committed.
    for (const booking of [missedOne, missedTwo]) {
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('booked')
    }
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: upcoming.id } })).reminderSentAt).not.toBeNull()
    // The log: one line per failed booking (its id and the error class), and the step's summary at error level.
    const errors = spies[1].mock.calls.map((call) => String(call[0]))
    expect(errors.filter((line) => line.includes('booking') && line.includes('failed (Error)'))).toHaveLength(2)
    expect(errors.some((line) => line.includes('(record)') && /0 no-shows, 1 reminder/.test(line))).toBe(true)
    const everything = printed(spies)
    for (const secret of ['reliability write down', first.user.name, first.user.email, first.user.id]) expect(everything).not.toContain(secret)
    expect(everything).toContain(missedOne.id)
  })

  it('answers 500 with the failed remind step when EVERY reminder of it threw, and still records the no-shows', async () => {
    const first = await seedStudent()
    const second = await seedStudent()
    const missed = await seedMissedBooking(first.user.id)
    const upcomingOne = await seedUpcomingBooking(first.user.id)
    const upcomingTwo = await seedUpcomingBooking(second.user.id)
    const spies = captureConsole()
    knobs.failReminderWrites = true

    const res = await sweep(TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ noShows: 1, reminders: 0, remaining: 0, failed: ['remind'] })
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('no_show')
    for (const booking of [upcomingOne, upcomingTwo]) {
      // Rolled back whole: still unmarked and still due, so the next sweep sends it.
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).reminderSentAt).toBeNull()
    }
    const errors = spies[1].mock.calls.map((call) => String(call[0]))
    expect(errors.filter((line) => line.includes('reminder for booking') && line.includes('failed (Error)'))).toHaveLength(2)
    expect(errors.some((line) => line.includes('(remind)') && /1 no-show, 0 reminders/.test(line))).toBe(true)
    expect(printed(spies)).not.toContain('notice write down')

    // The fault clears: the very next call sends them, and the run is green again.
    knobs.failReminderWrites = false
    const next = await sweep(TOKEN)
    expect(next.status).toBe(200)
    expect(next.body).toEqual({ noShows: 0, reminders: 2, remaining: 0 })
  })
})

// The timer and sweepIfDue share an in-process "a sweep is running" guard (noShowService). The route is the
// scheduler's explicit call, so it is not subject to it: it runs even while another sweep is running, and
// it neither sets nor clears the guard of that other run.
describe('POST /internal/sweep and the in-process guard', () => {
  beforeEach(resetDb)
  afterEach(async () => {
    await resetLazySweepForTests()
  })

  it('runs while a sweep from a page read is still running, and leaves that run\'s guard alone', async () => {
    const student = await seedStudent()
    const missed = await seedMissedBooking(student.user.id)
    // Holds only the FIRST detection query (the page read's sweep) and counts every one.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = { detection: 0 }
    const real = prisma.$queryRaw.bind(prisma) as (...args: unknown[]) => unknown
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((query: unknown, ...rest: unknown[]) => {
      const sql = JSON.stringify(query).replaceAll('\\"', '"')
      if (sql.includes('SELECT id FROM "ResourceBooking"') && !sql.includes('reminderSentAt')) {
        seen.detection += 1
        if (seen.detection === 1) return gate.then(() => real(query, ...rest))
      }
      return real(query, ...rest)
    }) as never)
    enableLazySweepForTests(true)
    const t0 = Date.now()

    try {
      sweepIfDue(new Date(t0))
      expect(seen.detection).toBe(1) // started, and parked before it recorded anything

      const res = await sweep(TOKEN)

      // The route ran its own sweep regardless, and recorded the booking.
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ noShows: 1, reminders: 0, remaining: 0 })
      expect(seen.detection).toBe(2)
      expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('no_show')

      // The page read's guard is still held: the route did not clear it.
      sweepIfDue(new Date(t0 + 10 * MINUTE_MS))
      expect(seen.detection).toBe(2)
    } finally {
      release()
    }
    await settleSweepsForTests()

    // That run is over (it found nothing left to do), so its guard is released and a read can sweep again.
    sweepIfDue(new Date(t0 + 20 * MINUTE_MS))
    expect(seen.detection).toBe(3)
  })

  it('does not set the guard either: a sweep a page read starts right after the route finished is not refused', async () => {
    const seen = { detection: 0 }
    const real = prisma.$queryRaw.bind(prisma) as (...args: unknown[]) => unknown
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((query: unknown, ...rest: unknown[]) => {
      const sql = JSON.stringify(query).replaceAll('\\"', '"')
      if (sql.includes('SELECT id FROM "ResourceBooking"') && !sql.includes('reminderSentAt')) seen.detection += 1
      return real(query, ...rest)
    }) as never)
    enableLazySweepForTests(true)

    expect((await sweep(TOKEN)).status).toBe(200)
    sweepIfDue()

    expect(seen.detection).toBe(2)
  })
})
