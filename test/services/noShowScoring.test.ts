// Scoring a new booking with the no-show model (slice 7, spec section 6): `createBooking`
// kicks `scoreBooking` off after its transaction has committed, never awaits it, and the
// scorer builds the features, asks the AI service (2-second timeout, `fetch` stubbed here: no
// network), and writes `NoShowEvent.predictedProbability` and `ResourceBooking.priorityScore`.
// Any failure leaves `priorityScore` null (read as 1.0, no nudge) and writes nothing.
//
// The scorer runs in the background, so every test that lets one start waits for it before it
// ends (settleScoringForTests, in afterEach): an un-awaited scorer must never write into the
// next test's freshly reset database. Scoring is OFF under test unless a test turns it on
// (enableScoringForTests), because this machine's .env sets AI_BACKEND_URL for every test file
// and every other file that books something must stay free of fetches and stray rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PENALTY_CAP, PREDICT_TIMEOUT_MS } from '../../src/config/constants'
import type { BookingStatus } from '../../src/generated/prisma/client'
import { isAiBackendConfigured, NO_SHOW_FEATURE_KEYS, NoShowPredictionError, predictNoShow, type NoShowFeatures } from '../../src/lib/aiClient'
import { prisma } from '../../src/lib/prisma'
import { createBooking } from '../../src/services/bookingService'
import { buildNoShowFeatures } from '../../src/services/noShowFeatures'
import { enableScoringForTests, logScoringFailure, scoreBooking, settleScoringForTests } from '../../src/services/noShowScoring'
import { bookingLockedThenCompete } from '../helpers/bookingLock'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

// Each case seeds and reads through a remote database.
vi.setConfig({ testTimeout: 60_000 })

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const AI_URL = 'http://ai.test:8000'
const GOOD = { predicted_probability: 0.31, penalty_factor: 0.12, model_version: 'noshow-test' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Settles with `promise`, or with 'timed out' after `ms`; the timer never outlives the answer. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'timed out'>((resolve) => (timer = setTimeout(() => resolve('timed out'), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>
let recorder: ReturnType<typeof recordEvents>
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await resetDb()
  vi.stubEnv('AI_BACKEND_URL', AI_URL)
  enableScoringForTests(true)
  fetchStub = vi.fn<typeof fetch>(async () => json(GOOD))
  vi.stubGlobal('fetch', fetchStub)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  recorder = recordEvents()
})

afterEach(async () => {
  // Before anything is reset or restored: a scorer still running must finish while the stubs are in place.
  await settleScoringForTests()
  recorder.stop()
  enableScoringForTests(undefined)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function seedStudent(reliabilityScore?: number) {
  return prisma.user.create({
    data: { name: `Student ${Math.random()}`, email: `student${Math.random()}@example.com`, passwordHash: 'x', reliabilityScore },
  })
}

async function seedResource(type: 'seat' | 'room') {
  return prisma.resource.create({ data: { type, name: `${type === 'room' ? 'Room' : 'Desk'} ${Math.random()}` } })
}

/** A one-hour booking tomorrow on a resource of its own: a room's is a request, a seat's is booked. */
async function seedBooking(userId: string, type: 'seat' | 'room' = 'room', status?: BookingStatus) {
  const resource = await seedResource(type)
  const startTime = new Date(Date.now() + DAY_MS)
  return prisma.resourceBooking.create({
    data: {
      userId,
      resourceId: resource.id,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status: status ?? (type === 'room' ? 'requested' : 'booked'),
    },
  })
}

/** The student books a one-hour slot two days ahead through the real service. */
async function book(userId: string, type: 'seat' | 'room') {
  const resource = await seedResource(type)
  const start = new Date(Date.now() + 2 * DAY_MS)
  start.setMinutes(0, 0, 0)
  return createBooking(userId, resource.id, start, new Date(start.getTime() + HOUR_MS))
}

const priorityOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } }).then((b) => b.priorityScore)
const statusOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } }).then((b) => b.status)
const eventOf = (bookingId: string) => prisma.noShowEvent.findUnique({ where: { resourceBookingId: bookingId } })

/** Nothing was written for the booking: no score, no event row, nothing published. */
async function expectNothingWritten(bookingId: string) {
  expect(await priorityOf(bookingId)).toBeNull()
  expect(await prisma.noShowEvent.count()).toBe(0)
  expect(recorder.events).toEqual([])
}

describe('predictNoShow', () => {
  const features: NoShowFeatures = {
    hour_of_day: 10,
    day_of_week: 2,
    duration_minutes: 60,
    lead_time_hours: 22,
    resource_type: 'room',
    past_attendance_ratio: 0.85,
    consecutive_attended_count: 3,
    recent_noshows_count: 1,
    reliability_score: 90,
    bookings_last_30d: 4,
  }

  it('posts the ten features as JSON to /predict/no-show and returns the three fields', async () => {
    await expect(predictNoShow(features)).resolves.toEqual(GOOD)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]
    expect(String(url)).toBe(`${AI_URL}/predict/no-show`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    // Exactly the ten fields, in the AI service's order (it rejects anything else).
    expect(Object.keys(JSON.parse(String(init?.body)))).toEqual([...NO_SHOW_FEATURE_KEYS])
    expect(JSON.parse(String(init?.body))).toEqual(features)
  })

  it('reads AI_BACKEND_URL on every call, and a trailing slash does not double up', async () => {
    vi.stubEnv('AI_BACKEND_URL', 'http://elsewhere.test:9000/')

    await predictNoShow(features)

    expect(String(fetchStub.mock.calls[0][0])).toBe('http://elsewhere.test:9000/predict/no-show')
  })

  it('gives the call the 2-second timeout by default, and uses a signal it is handed', async () => {
    expect(PREDICT_TIMEOUT_MS).toBe(2000)
    await predictNoShow(features)
    const own = fetchStub.mock.calls[0][1]?.signal
    expect(own).toBeInstanceOf(AbortSignal)
    expect(own?.aborted).toBe(false)

    const mine = new AbortController()
    await predictNoShow(features, mine.signal)
    expect(fetchStub.mock.calls[1][1]?.signal).toBe(mine.signal)
  })

  it('is not called, and does not fetch, when AI_BACKEND_URL is unset', async () => {
    vi.stubEnv('AI_BACKEND_URL', '')

    await expect(predictNoShow(features)).rejects.toThrow(/AI_BACKEND_URL/)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it.each([
    // A refusal is a refusal whatever its body says: these two carry a body that would pass every other check.
    ['a 503 with a plausible body', () => json(GOOD, 503)],
    ['a 422 with a plausible body', () => json(GOOD, 422)],
    ['invalid JSON', () => new Response('<html>oops', { status: 200 })],
    ['a body that is not an object', () => json([GOOD])],
    ['a probability above 1', () => json({ ...GOOD, predicted_probability: 1.4 })],
    ['a negative probability', () => json({ ...GOOD, predicted_probability: -0.1 })],
    ['a probability that is not a number', () => json({ ...GOOD, predicted_probability: '0.3' })],
    ['a negative penalty', () => json({ ...GOOD, penalty_factor: -0.05 })],
    ['a penalty that is null (a JSON NaN)', () => json({ ...GOOD, penalty_factor: null })],
    ['a missing penalty', () => json({ predicted_probability: 0.3, model_version: 'v' })],
    ['a missing model_version', () => json({ predicted_probability: 0.3, penalty_factor: 0.1 })],
    ['an empty model_version', () => json({ ...GOOD, model_version: '' })],
  ])('throws on %s', async (_name, answer) => {
    fetchStub.mockImplementation(async () => answer())

    await expect(predictNoShow(features)).rejects.toThrow()
  })

  it('accepts the edges of the ranges, and leaves a penalty above the cap for the caller to clamp', async () => {
    for (const body of [
      { ...GOOD, predicted_probability: 0, penalty_factor: 0 },
      { ...GOOD, predicted_probability: 1, penalty_factor: MAX_PENALTY_CAP },
      // Over the cap is not "invalid": the service caps it, and scoreBooking clamps again (below).
      { ...GOOD, penalty_factor: 0.9 },
    ]) {
      fetchStub.mockImplementationOnce(async () => json(body))
      await expect(predictNoShow(features)).resolves.toEqual(body)
    }
  })
})

describe('isAiBackendConfigured', () => {
  it('is true only for a non-blank AI_BACKEND_URL, read when asked', () => {
    expect(isAiBackendConfigured()).toBe(true)
    vi.stubEnv('AI_BACKEND_URL', '')
    expect(isAiBackendConfigured()).toBe(false)
    vi.stubEnv('AI_BACKEND_URL', '   ')
    expect(isAiBackendConfigured()).toBe(false)
    vi.stubEnv('AI_BACKEND_URL', undefined)
    expect(isAiBackendConfigured()).toBe(false)
    vi.stubEnv('AI_BACKEND_URL', 'http://x.test')
    expect(isAiBackendConfigured()).toBe(true)
  })
})

describe('scoreBooking', () => {
  it('writes predictedProbability and priorityScore = 1 - penalty for a room request and publishes request.scored once', async () => {
    const student = await seedStudent(88)
    const booking = await seedBooking(student.id, 'room')

    await scoreBooking(booking.id)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]
    expect(String(url)).toBe(`${AI_URL}/predict/no-show`)
    // What it sent is what the builder gives for this booking.
    expect(JSON.parse(String(init?.body))).toEqual(await buildNoShowFeatures(booking.id))
    expect(JSON.parse(String(init?.body))).toMatchObject({ resource_type: 'room', reliability_score: 88 })
    expect(await eventOf(booking.id)).toMatchObject({
      userId: student.id,
      predictedProbability: 0.31,
      // The outcome is the sweep's and the check-in's to record, never the scorer's.
      actualNoShow: null,
      reliabilityDelta: null,
    })
    expect(await priorityOf(booking.id)).toBeCloseTo(1 - 0.12, 12)
    expect(await statusOf(booking.id)).toBe('requested')
    expect(recorder.events).toEqual([{ type: 'request.scored', topics: ['requests'] }])
  })

  it.each([
    ['no penalty', 0, 1],
    ['a small penalty', 0.05, 0.95],
    ['exactly the cap', 0.2, 0.8],
  ])('%s: priorityScore = 1 - penalty', async (_name, penalty, expected) => {
    fetchStub.mockImplementation(async () => json({ ...GOOD, penalty_factor: penalty }))
    const booking = await seedBooking((await seedStudent()).id, 'room')

    await scoreBooking(booking.id)

    // A zero penalty is a score of 1, written: it is not the same as "never scored" (null).
    expect(await priorityOf(booking.id)).toBeCloseTo(expected, 12)
  })

  it('a penalty above the cap is clamped to 0.2', async () => {
    expect(MAX_PENALTY_CAP).toBe(0.2)
    fetchStub.mockImplementation(async () => json({ ...GOOD, penalty_factor: 0.9 }))
    const booking = await seedBooking((await seedStudent()).id, 'room')

    await scoreBooking(booking.id)

    expect(await priorityOf(booking.id)).toBeCloseTo(0.8, 12)
    // The probability is the model's, untouched.
    expect((await eventOf(booking.id))?.predictedProbability).toBe(0.31)
  })

  it('a seat booking gets a NoShowEvent and a priorityScore but publishes no request event', async () => {
    const student = await seedStudent()
    const booking = await seedBooking(student.id, 'seat')

    await scoreBooking(booking.id)

    expect(await eventOf(booking.id)).toMatchObject({ userId: student.id, predictedProbability: 0.31, actualNoShow: null })
    expect(await priorityOf(booking.id)).toBeCloseTo(0.88, 12)
    expect(recorder.events).toEqual([])
  })

  it.each([
    ['a 503 with a plausible body', () => json(GOOD, 503)],
    ['invalid JSON', () => new Response('<html>oops', { status: 200 })],
    ['a probability of 1.4', () => json({ ...GOOD, predicted_probability: 1.4 })],
    ['a negative penalty', () => json({ ...GOOD, penalty_factor: -0.2 })],
    ['a missing model_version', () => json({ predicted_probability: 0.3, penalty_factor: 0.1 })],
    ['a 422 with a plausible body', () => json(GOOD, 422)],
    [
      'the service being down',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
  ])('%s leaves priorityScore null and writes nothing', async (_name, answer) => {
    fetchStub.mockImplementation(async () => answer())
    const booking = await seedBooking((await seedStudent()).id, 'room')

    await expect(scoreBooking(booking.id)).resolves.toBeUndefined()

    expect(fetchStub).toHaveBeenCalledTimes(1)
    await expectNothingWritten(booking.id)
  })

  it('a 3-second answer is cut off at the timeout: priorityScore stays null and nothing is written', async () => {
    let signal: AbortSignal | null | undefined
    fetchStub.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          signal = init?.signal
          const answer = setTimeout(() => resolve(json(GOOD)), PREDICT_TIMEOUT_MS + 1000)
          // What a real fetch does with the signal it is given.
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(answer)
            reject(init.signal?.reason)
          })
        }),
    )
    const booking = await seedBooking((await seedStudent()).id, 'room')

    await expect(scoreBooking(booking.id)).resolves.toBeUndefined()

    expect(signal?.aborted).toBe(true)
    await expectNothingWritten(booking.id)
  })

  it('logs the failure by booking and error class, never with the features or a name', async () => {
    fetchStub.mockImplementation(async () => json({ detail: 'model_unavailable' }, 503))
    // 61.5 cannot occur by chance in a booking's id, so finding it in the line would mean a feature leaked.
    const student = await seedStudent(61.5)
    const booking = await seedBooking(student.id, 'room')

    await scoreBooking(booking.id)

    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain(booking.id)
    expect(line).toContain('503')
    expect(line).not.toMatch(/reliability|hour_of_day|Student|@example\.com|61\.5/)
  })

  // What Node's fetch throws when nothing listens: a bare TypeError('fetch failed') whose `cause`
  // is the socket error. "TypeError" says nothing to a developer whose AI service is not running.
  describe('when the AI service cannot be reached at all', () => {
    const unreachable = (cause?: unknown) => Object.assign(new TypeError('fetch failed'), cause === undefined ? {} : { cause })

    it.each([
      ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' })],
      ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND ai.test'), { code: 'ENOTFOUND' })],
    ])('logs the cause code (%s), and neither the address nor the features', async (code, cause) => {
      fetchStub.mockImplementation(async () => {
        throw unreachable(cause)
      })
      const booking = await seedBooking((await seedStudent(61.5)).id, 'room')

      await scoreBooking(booking.id)

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toBe(`no-show scoring: booking ${booking.id} was not scored (${code})`)
      expect(line).not.toMatch(/TypeError|127\.0\.0\.1|ai\.test|reliability|hour_of_day|Student|@example\.com|61\.5/)
    })

    it.each([
      ['no cause at all', unreachable()],
      ['a cause with no code', unreachable(new Error('socket hang up'))],
      ['a cause whose code is not a plain error code', unreachable(Object.assign(new Error('x'), { code: 'connect to 10.0.0.7 failed' }))],
    ])('says "AI service unreachable" for %s', async (_name, error) => {
      fetchStub.mockImplementation(async () => {
        throw error
      })
      const booking = await seedBooking((await seedStudent()).id, 'room')

      await scoreBooking(booking.id)

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toBe(`no-show scoring: booking ${booking.id} was not scored (AI service unreachable)`)
      expect(line).not.toMatch(/TypeError|10\.0\.0\.7|socket hang up/)
    })

    it('keeps the old wording for every other failure: a timeout, a bad answer, any other error class, a non-error', () => {
      logScoringFailure('b1', new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      logScoringFailure('b2', new SyntaxError('Unexpected token < in JSON'))
      logScoringFailure('b3', new NoShowPredictionError('AI backend no-show prediction failed: 503'))
      logScoringFailure('b4', new RangeError('nope'))
      logScoringFailure('b5', 'a string')

      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        'no-show scoring: booking b1 was not scored (TimeoutError)',
        'no-show scoring: booking b2 was not scored (SyntaxError)',
        'no-show scoring: booking b3 was not scored (AI backend no-show prediction failed: 503)',
        'no-show scoring: booking b4 was not scored (RangeError)',
        'no-show scoring: booking b5 was not scored (unknown error)',
      ])
    })
  })

  it('never throws: a booking that does not exist is a logged non-event', async () => {
    await expect(scoreBooking('no-such-booking')).resolves.toBeUndefined()

    expect(fetchStub).not.toHaveBeenCalled()
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it.each([
    ['no_show', { actualNoShow: true, reliabilityDelta: -10 }],
    ['released', { actualNoShow: false, reliabilityDelta: -10 }],
    ['checked_in', { actualNoShow: false, reliabilityDelta: null }],
    ['cancelled', null],
  ] as const)('a booking that has since become %s keeps its status and its recorded outcome', async (status, existing) => {
    const student = await seedStudent()
    const booking = await seedBooking(student.id, 'room', status)
    if (existing) await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: student.id, ...existing } })

    await scoreBooking(booking.id)

    expect(await statusOf(booking.id)).toBe(status)
    // The probability is filled in; the outcome (and what the sweep took) is left exactly as it was.
    expect(await eventOf(booking.id)).toMatchObject({
      predictedProbability: 0.31,
      actualNoShow: existing ? existing.actualNoShow : null,
      reliabilityDelta: existing ? existing.reliabilityDelta : null,
    })
    expect(await prisma.noShowEvent.count()).toBe(1)
    expect(await priorityOf(booking.id)).toBeCloseTo(0.88, 12)
  })

  it('scoring a booking twice leaves one event, with the latest probability', async () => {
    const booking = await seedBooking((await seedStudent()).id, 'room')

    await scoreBooking(booking.id)
    fetchStub.mockImplementation(async () => json({ ...GOOD, predicted_probability: 0.5, penalty_factor: 0.2 }))
    await scoreBooking(booking.id)

    expect(await prisma.noShowEvent.count()).toBe(1)
    expect((await eventOf(booking.id))?.predictedProbability).toBe(0.5)
    expect(await priorityOf(booking.id)).toBeCloseTo(0.8, 12)
  })

  it('writes the score and the event in one transaction: a failing event write leaves the score null too', async () => {
    const booking = await seedBooking((await seedStudent()).id, 'room')
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
    // The event write fails inside the transaction the scorer opens.
    vi.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
      real(
        (tx: Record<string, unknown>) =>
          fn(
            new Proxy(tx, {
              get: (target, key) =>
                key === 'noShowEvent'
                  ? {
                      upsert: () => {
                        throw new Error('event write down')
                      },
                    }
                  : target[key as string],
            }),
          ),
        ...rest,
      )) as never)

    await expect(scoreBooking(booking.id)).resolves.toBeUndefined()

    await expectNothingWritten(booking.id)
  })

  it('updates the booking row before it writes the event, the order every other writer takes', async () => {
    const student = await seedStudent()
    const booking = await seedBooking(student.id, 'room')
    // An event row to contend for: the scorer's upsert must update it, which takes its row lock.
    await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId: student.id } })

    let eventHeldByScorer: boolean | undefined
    const settled = await bookingLockedThenCompete(
      booking.id,
      () => scoreBooking(booking.id),
      async () => {
        // The scorer is now stuck waiting for the booking row the test holds. If it had already
        // locked the event row (event first, booking second: the reverse of the sweep, a check-in
        // and an overturn) this NOWAIT read, from another connection, would be refused.
        try {
          await prisma.$queryRaw`SELECT id FROM "NoShowEvent" WHERE "resourceBookingId" = ${booking.id} FOR UPDATE NOWAIT`
          eventHeldByScorer = false
        } catch {
          eventHeldByScorer = true
        }
      },
    )

    expect(settled.status).toBe('fulfilled')
    expect(eventHeldByScorer).toBe(false)
    // And it did go on to write both once the lock was released.
    expect(await priorityOf(booking.id)).toBeCloseTo(0.88, 12)
    expect((await eventOf(booking.id))?.predictedProbability).toBe(0.31)
  })

  describe('with no AI_BACKEND_URL', () => {
    it.each([
      ['set to nothing', ''],
      ['blank', '   '],
      ['not set at all', undefined],
    ])('does nothing when it is %s: no fetch, no log, no rows, no event', async (_name, value) => {
      vi.stubEnv('AI_BACKEND_URL', value)
      const booking = await seedBooking((await seedStudent()).id, 'room')

      await expect(scoreBooking(booking.id)).resolves.toBeUndefined()

      expect(fetchStub).not.toHaveBeenCalled()
      // Not even a failure line: nothing was attempted, so nothing failed.
      expect(warn).not.toHaveBeenCalled()
      await expectNothingWritten(booking.id)
    })
  })

  describe('under test, unless a test turns it on', () => {
    it('is off by default whatever AI_BACKEND_URL says (this machine\'s .env sets it for every test file)', async () => {
      enableScoringForTests(undefined)
      const booking = await seedBooking((await seedStudent()).id, 'room')

      await scoreBooking(booking.id)

      expect(fetchStub).not.toHaveBeenCalled()
      await expectNothingWritten(booking.id)
    })

    it('createBooking then makes no fetch and leaves nothing running or written', async () => {
      enableScoringForTests(undefined)
      const student = await seedStudent()

      const seat = await book(student.id, 'seat')
      const room = await book(student.id, 'room')
      await settleScoringForTests()

      expect(fetchStub).not.toHaveBeenCalled()
      expect(await priorityOf(seat.id)).toBeNull()
      expect(await priorityOf(room.id)).toBeNull()
      expect(await prisma.noShowEvent.count()).toBe(0)
      expect(recorder.events.map((event) => event.type)).not.toContain('request.scored')
    })
  })
})

describe('createBooking', () => {
  it.each([
    ['seat', 'booked'],
    ['room', 'requested'],
  ] as const)('scores a new %s after it is made: the event row, the priorityScore', async (type, status) => {
    const student = await seedStudent()

    const created = await book(student.id, type)
    await settleScoringForTests()

    expect(created.status).toBe(status)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(await priorityOf(created.id)).toBeCloseTo(0.88, 12)
    expect(await eventOf(created.id)).toMatchObject({ userId: student.id, predictedProbability: 0.31, actualNoShow: null })
    // The create event goes first (the score does not exist yet), then, for a room, the scored one.
    const types = recorder.events.map((event) => event.type)
    expect(types).toEqual(type === 'room' ? ['request.created', 'request.scored'] : ['booking.changed'])
  })

  it('answers before a slow prediction finishes', async () => {
    const gate = deferred<Response>()
    fetchStub.mockImplementation(() => gate.promise)
    const student = await seedStudent()

    const outcome = await within(book(student.id, 'room').then((dto) => dto), 10_000)
    // The scorer did start (after the booking committed) and is still waiting for the service.
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1))
    const stillUnscored = await prisma.resourceBooking.findFirstOrThrow({ where: { userId: student.id } })
    gate.resolve(json(GOOD))
    await settleScoringForTests()

    expect(outcome).not.toBe('timed out')
    expect(stillUnscored.priorityScore).toBeNull()
    expect(await priorityOf(stillUnscored.id)).toBeCloseTo(0.88, 12)
  })

  it.each([
    ['unreachable', async () => Promise.reject(new TypeError('fetch failed'))],
    ['answering 503', async () => json({ detail: 'model_unavailable' }, 503)],
    ['answering garbage', async () => new Response('garbage', { status: 200 })],
  ])('the AI service being %s does not fail createBooking', async (_name, answer) => {
    fetchStub.mockImplementation(answer)
    const student = await seedStudent()

    const seat = await book(student.id, 'seat')
    const room = await book(student.id, 'room')
    await settleScoringForTests()

    expect(seat).toMatchObject({ status: 'booked', frontendStatus: 'upcomingFar' })
    expect(room).toMatchObject({ status: 'requested', frontendStatus: 'requested' })
    expect(await priorityOf(seat.id)).toBeNull()
    expect(await priorityOf(room.id)).toBeNull()
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(recorder.events.map((event) => event.type)).not.toContain('request.scored')
  })

  it('scoring never runs inside a transaction: the call is made after createBooking has resolved, with none open', async () => {
    let open = 0
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
    const transactions = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      open += 1
      return real(...args).finally(() => {
        open -= 1
      })
    }) as never)
    let resolved = false
    const calls: Array<{ transactionsOpen: number; afterCreateBookingResolved: boolean }> = []
    fetchStub.mockImplementation(async () => {
      calls.push({ transactionsOpen: open, afterCreateBookingResolved: resolved })
      return json(GOOD)
    })
    const student = await seedStudent()

    await book(student.id, 'room')
    resolved = true
    await settleScoringForTests()

    expect(calls).toEqual([{ transactionsOpen: 0, afterCreateBookingResolved: true }])
    // The spy was live: createBooking's own transaction and the scorer's write both went through it.
    expect(transactions).toHaveBeenCalledTimes(2)
  })
})
