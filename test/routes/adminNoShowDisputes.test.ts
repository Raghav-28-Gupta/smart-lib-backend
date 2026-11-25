// The librarian's answer to a student's no-show dispute (slice 7, spec section 7): overturn
// (the no-show is removed and exactly the points it took are given back) and uphold (it
// stands). Covers what each answer writes (the dispute, the booking, the event, the score
// and its history, the notice), the notice copy and its email, the refusals (and that a
// refusal writes, sends and publishes nothing), the live events and the order they come in,
// the guards, and the interleavings. The student's side is in test/routes/noShowDisputes.test.ts
// and the queue in test/routes/adminAttention.test.ts.
//
// The lock order (booking, dispute, event, student) is pinned without a timing guess: a test
// holds one row lock, starts the answer, waits until it is stuck behind that lock, and then
// asks the database which OTHER rows the answer already holds (`SKIP LOCKED` answers no row
// for a row somebody else has locked).
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { GRACE_PERIOD_MINUTES, JWT_SECRET } from '../../src/config/constants'
import type { EmailStatus, NoShowDisputeStatus, Prisma } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { dayLabel } from '../../src/lib/timeLabels'
import { overturnNoShow, upholdNoShow } from '../../src/services/noShowDisputeService'
import { sweepBookings } from '../../src/services/noShowService'
import { bookingLockedThenCompete, waitUntilAWriterIsBlocked } from '../helpers/bookingLock'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 4

const RESOLVED = 'This dispute was already resolved.'
const NOT_FOUND = 'No-show dispute not found'
const NOT_A_NO_SHOW = 'This booking is not a recorded no-show.'
const BOOKING_CHANGED = { type: 'booking.changed', topics: ['bookings', 'metrics'] }
const STUDENT_CHANGED = { type: 'student.changed', topics: ['students'] }
const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

async function seedUser(role: 'student' | 'admin' = 'student', extra: { name?: string; email?: string; score?: number } = {}) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@example.com`,
      passwordHash: 'x',
      role,
      reliabilityScore: extra.score,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

interface DisputeSeed {
  /** The student, when the test already made one; a new one otherwise. */
  student?: Awaited<ReturnType<typeof seedUser>>
  email?: string
  /** The student's score now (after the no-show cost them what `delta` says). */
  score?: number
  /** What the no-show took, as the sweep stored it on the event (negative). `null` is a seed-made event with no figure; `'no event'` has no event row at all. */
  delta?: number | null | 'no event'
  resourceName?: string
  type?: 'seat' | 'room'
  /** How long ago the booking's check-in window closed. */
  endedAgoMs?: number
  /** The booking's start, when the test cares about its time of day (the grace period still follows it). */
  startTime?: Date
  reason?: string
  openedAt?: Date
  status?: NoShowDisputeStatus
}

/**
 * A recorded no-show with the student's open dispute of it, as the sweep and the student's
 * request leave them: the booking is `no_show`, its event says what it cost, the reliability
 * log has the `No-show: <resource>` row, and the student's score is where `score` puts it.
 */
async function seedDispute(o: DisputeSeed = {}) {
  const student = o.student ?? (await seedUser('student', { email: o.email, score: o.score ?? 90 }))
  if (o.student && o.score !== undefined) await prisma.user.update({ where: { id: student.user.id }, data: { reliabilityScore: o.score } })
  const name = o.resourceName ?? `Desk ${Math.random()}`
  const resource = await prisma.resource.create({ data: { type: o.type ?? 'seat', name } })
  const startTime = o.startTime ?? new Date(Date.now() - (o.endedAgoMs ?? HOUR_MS) - GRACE_PERIOD_MINUTES * MINUTE_MS)
  const booking = await prisma.resourceBooking.create({
    data: {
      userId: student.user.id,
      resourceId: resource.id,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status: 'no_show',
      gracePeriodMinutes: GRACE_PERIOD_MINUTES,
    },
  })
  const delta = o.delta === undefined ? -10 : o.delta
  if (delta !== 'no event') {
    await prisma.noShowEvent.create({
      data: { resourceBookingId: booking.id, userId: student.user.id, predictedProbability: 0.31, actualNoShow: true, reliabilityDelta: delta },
    })
  }
  if (typeof delta === 'number') {
    await prisma.reliabilityScoreLog.create({
      // Written a minute after the grace period ended, like the sweep's, so it is older than anything the answer adds.
      data: { userId: student.user.id, score: o.score ?? 90, delta, reason: `No-show: ${name}`, computedAt: new Date(startTime.getTime() + (GRACE_PERIOD_MINUTES + 1) * MINUTE_MS) },
    })
  }
  const dispute = await prisma.noShowDispute.create({
    data: {
      bookingId: booking.id,
      userId: student.user.id,
      reason: o.reason ?? 'I was at the desk, the scanner was down',
      createdAt: o.openedAt,
      status: o.status,
    },
  })
  return { student, resource, booking, dispute, name }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const send = (req: request.Test, body?: unknown) => (body === undefined ? req : req.send(body as object))
const overturn = (token: string, id: string, body?: unknown) =>
  send(request(app).post(`/admin/no-show-disputes/${id}/overturn`).set(auth(token)), body)
const uphold = (token: string, id: string, body?: unknown) =>
  send(request(app).post(`/admin/no-show-disputes/${id}/uphold`).set(auth(token)), body)

const disputeOf = (id: string) => prisma.noShowDispute.findUniqueOrThrow({ where: { id } })
const bookingOf = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } })
const eventOf = (bookingId: string) => prisma.noShowEvent.findUnique({ where: { resourceBookingId: bookingId } })
const scoreOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).reliabilityScore
const logsOf = (userId: string) => prisma.reliabilityScoreLog.findMany({ where: { userId }, orderBy: { computedAt: 'asc' } })
const noticesOf = (userId: string) => prisma.notice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })

/** Injects a fake mail transport (cleared in afterEach); email is then configured, and nothing leaves the process. */
function fakeTransport(ok = true) {
  const sendMail = vi.fn<MailTransport['send']>(async () => ({ ok }))
  setMailTransport({ send: sendMail })
  return sendMail
}

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

// A developer's .env may set an allowed-domains list; these tests use their own addresses.
let savedAllowedDomains: string | undefined

beforeEach(async () => {
  savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
  delete process.env.MAIL_ALLOWED_DOMAINS
  setMailTransport(null)
  await resetDb()
})

afterEach(() => {
  setMailTransport(null)
  if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
  else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
  vi.restoreAllMocks()
})

describe('POST /admin/no-show-disputes/:id/overturn', { timeout: 60_000 }, () => {
  it('overturn restores the exact points taken, frees nothing else, sets the booking released and the event actualNoShow false', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    // The no-show took 7 (not the usual 10), so a restore that gave back the penalty constant would be seen.
    const mine = await seedDispute({ score: 47, delta: -7, resourceName: 'Desk 12', reason: 'The scanner was down' })
    // The same student's other no-show and another student's open dispute must stay exactly as they are.
    const sibling = await seedDispute({ student: mine.student, delta: -10 })
    const another = await seedDispute({ score: 60, delta: -10 })
    const before = {
      booking: await bookingOf(mine.booking.id),
      event: await eventOf(mine.booking.id),
      siblingBooking: await bookingOf(sibling.booking.id),
      siblingEvent: await eventOf(sibling.booking.id),
      siblingDispute: await disputeOf(sibling.dispute.id),
      anotherBooking: await bookingOf(another.booking.id),
      anotherEvent: await eventOf(another.booking.id),
      anotherDispute: await disputeOf(another.dispute.id),
      anotherLogs: await logsOf(another.student.user.id),
      logs: await logsOf(mine.student.user.id),
    }
    const at = Date.now()

    const res = await overturn(admin, mine.dispute.id, { reason: 'The door scanner log shows a tap at 09:02' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: mine.dispute.id })
    // Exactly 7 back: 47 to 54, not 57.
    expect(await scoreOf(mine.student.user.id)).toBe(54)
    expect(await disputeOf(mine.dispute.id)).toMatchObject({
      status: 'overturned',
      reason: 'The scanner was down',
      resolutionNote: 'The door scanner log shows a tap at 09:02',
      resolvedById: librarian.id,
    })
    const resolvedAt = (await disputeOf(mine.dispute.id)).resolvedAt!.getTime()
    expect(resolvedAt).toBeGreaterThanOrEqual(at - 1000)
    expect(resolvedAt).toBeLessThanOrEqual(Date.now())
    // The booking goes back to `released` (the face a grace-period miss without a penalty has), changing nothing else on it.
    expect(await bookingOf(mine.booking.id)).toEqual({ ...before.booking, status: 'released' })
    // The event is relabelled "attended" and keeps what the model predicted and what the no-show cost.
    expect(await eventOf(mine.booking.id)).toEqual({ ...before.event, actualNoShow: false })
    // The score history gets one row, the restore, and the no-show's own row stays as the audit trail.
    const logs = await logsOf(mine.student.user.id)
    expect(logs).toHaveLength(before.logs.length + 1)
    expect(logs.slice(0, before.logs.length)).toEqual(before.logs)
    expect(logs[logs.length - 1]).toMatchObject({ score: 54, delta: 7, reason: 'No-show overturned: Desk 12', adjustedById: null })
    // Nothing else moved.
    expect(await bookingOf(sibling.booking.id)).toEqual(before.siblingBooking)
    expect(await eventOf(sibling.booking.id)).toEqual(before.siblingEvent)
    expect(await disputeOf(sibling.dispute.id)).toEqual(before.siblingDispute)
    expect(await bookingOf(another.booking.id)).toEqual(before.anotherBooking)
    expect(await eventOf(another.booking.id)).toEqual(before.anotherEvent)
    expect(await disputeOf(another.dispute.id)).toEqual(before.anotherDispute)
    expect(await scoreOf(another.student.user.id)).toBe(60)
    expect(await logsOf(another.student.user.id)).toEqual(before.anotherLogs)
  })

  it('overturn after a clamp at 0 restores only what was taken', async () => {
    const { token: admin } = await seedUser('admin')
    // The student was at 4 when the no-show landed: it took 4 (the event says -4), not 10.
    const { student, dispute, name } = await seedDispute({ score: 0, delta: -4 })

    expect((await overturn(admin, dispute.id, { reason: 'Checked' })).status).toBe(200)

    expect(await scoreOf(student.user.id)).toBe(4)
    const logs = await logsOf(student.user.id)
    expect(logs[logs.length - 1]).toMatchObject({ delta: 4, score: 4, reason: `No-show overturned: ${name}` })
    expect((await noticesOf(student.user.id))[0].body).toContain('restored your reliability score to 4.')
  })

  it('overturn never takes the score above 100', async () => {
    const { token: admin } = await seedUser('admin')
    // The no-show took 10, but the student has earned 8 back since: giving 10 more would pass 100.
    const { student, dispute, name } = await seedDispute({ score: 98, delta: -10 })

    expect((await overturn(admin, dispute.id, { reason: 'Checked' })).status).toBe(200)

    expect(await scoreOf(student.user.id)).toBe(100)
    // The log records what was actually applied (2), not what was owed (10).
    const logs = await logsOf(student.user.id)
    expect(logs[logs.length - 1]).toMatchObject({ delta: 2, score: 100, reason: `No-show overturned: ${name}` })
    expect((await noticesOf(student.user.id))[0].body).toContain('restored your reliability score to 100.')
  })

  it('overturn with a zero or unknown delta restores nothing, and still removes the no-show and says what the score is now', async () => {
    const { token: admin } = await seedUser('admin')
    // Zero: the student was already at 0 when it was recorded. Null: a seed-made event with no figure.
    // No event at all: a seed-made no-show that was never scored (the sweep upserts one, a seed may not).
    const zero = await seedDispute({ score: 0, delta: 0 })
    const unknown = await seedDispute({ score: 55, delta: null })
    const noEvent = await seedDispute({ score: 70, delta: 'no event' })
    const recorder = recordEvents()

    for (const [label, seeded, score] of [
      ['zero', zero, 0],
      ['null', unknown, 55],
      ['no event', noEvent, 70],
    ] as const) {
      const logsBefore = await logsOf(seeded.student.user.id)
      const res = await overturn(admin, seeded.dispute.id, { reason: 'Checked' })

      expect(res.status, label).toBe(200)
      expect(await scoreOf(seeded.student.user.id), label).toBe(score)
      // No restore row: the score did not move, and nothing was invented.
      expect(await logsOf(seeded.student.user.id), label).toEqual(logsBefore)
      expect((await disputeOf(seeded.dispute.id)).status, label).toBe('overturned')
      expect((await bookingOf(seeded.booking.id)).status, label).toBe('released')
      const [notice] = await noticesOf(seeded.student.user.id)
      expect(notice.title, label).toBe('No-show removed')
      expect(notice.body, label).toContain(`restored your reliability score to ${score}.`)
    }
    recorder.stop()

    // A missing event is not made up, and the ones that exist are relabelled.
    expect(await eventOf(noEvent.booking.id)).toBeNull()
    expect(await eventOf(zero.booking.id)).toMatchObject({ actualNoShow: false, reliabilityDelta: 0 })
    expect(await eventOf(unknown.booking.id)).toMatchObject({ actualNoShow: false, reliabilityDelta: null })
    // Every overturn is announced, restore or not: the booking, the student's page and the queue changed.
    expect(recorder.events).toEqual(Array(3).fill([BOOKING_CHANGED, STUDENT_CHANGED, ATTENTION_CHANGED]).flat())
  })

  it('overturn with no reason is 400', async () => {
    const { token: admin } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute()
    const invalid: Array<[string, unknown]> = [
      ['no body', undefined],
      ['an empty body', {}],
      ['a blank reason', { reason: '   ' }],
      ['an empty reason', { reason: '' }],
      ['301 characters', { reason: 'x'.repeat(301) }],
      ['301 characters between spaces', { reason: ` ${'x'.repeat(301)} ` }],
      ['a number', { reason: 12 }],
      ['null', { reason: null }],
      ['a note instead of a reason', { note: 'Because' }],
    ]
    const sendMail = fakeTransport()
    const recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await overturn(admin, dispute.id, body)
      expect(res.status, what).toBe(400)
    }
    recorder.stop()

    // Nothing was written, sent or announced.
    expect((await disputeOf(dispute.id)).status).toBe('open')
    expect((await bookingOf(booking.id)).status).toBe('no_show')
    expect(await scoreOf(student.user.id)).toBe(90)
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('the reason is trimmed, exactly 300 characters is accepted, and the note the student sees is that text', async () => {
    const { token: admin } = await seedUser('admin')
    const padded = await seedDispute()
    const longest = await seedDispute()

    expect((await overturn(admin, padded.dispute.id, { reason: '  Scanner was down \n' })).status).toBe(200)
    expect((await overturn(admin, longest.dispute.id, { reason: ` ${'x'.repeat(300)} ` })).status).toBe(200)

    expect((await disputeOf(padded.dispute.id)).resolutionNote).toBe('Scanner was down')
    expect((await disputeOf(longest.dispute.id)).resolutionNote).toBe('x'.repeat(300))
    expect((await noticesOf(padded.student.user.id))[0].body).toMatch(/\n\nNote from the library: Scanner was down$/)
    // The student's own booking card reads the librarian's reason back (the dispute's status and note).
    const mine = await request(app).get('/bookings/me').set(auth(padded.student.token))
    expect(mine.body).toEqual([
      expect.objectContaining({ id: padded.booking.id, noShow: { canDispute: false, dispute: { status: 'overturned', note: 'Scanner was down' } } }),
    ])
  })

  it('a booking that is no longer a no-show is 409 and everything the answer began is rolled back', async () => {
    const { token: admin } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute({ score: 80, delta: -10 })
    // Not reachable through the app (only an overturn moves a no-show, and it needs this dispute), but the
    // dispute and the booking are two rows: the answer must not close one and leave the other behind.
    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { status: 'released' } })
    const sendMail = fakeTransport()
    const recorder = recordEvents()

    const res = await overturn(admin, dispute.id, { reason: 'Checked' })
    recorder.stop()

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: NOT_A_NO_SHOW })
    expect(await disputeOf(dispute.id)).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(await eventOf(booking.id)).toMatchObject({ actualNoShow: true })
    expect(await scoreOf(student.user.id)).toBe(80)
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('an overturned no-show reads end to end: the sweep, the dispute, the answer, then the history the student sees', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { score: 100 })
    const resource = await prisma.resource.create({ data: { type: 'room', name: 'Study Room A' } })
    const now = new Date()
    const startTime = new Date(now.getTime() - 20 * MINUTE_MS)
    const booking = await prisma.resourceBooking.create({
      data: { userId: student.id, resourceId: resource.id, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), status: 'booked' },
    })
    expect(await sweepBookings(now)).toMatchObject({ noShows: 1 })
    expect(await scoreOf(student.id)).toBe(90)
    const disputed = await request(app).post(`/bookings/${booking.id}/dispute`).set(auth(studentToken)).send({ reason: 'I was there' })
    expect(disputed.status).toBe(201)
    const queued = await request(app).get('/admin/attention?kind=no_show_dispute').set(auth(admin))
    expect(queued.body.items).toEqual([expect.objectContaining({ id: disputed.body.id, kind: 'no_show_dispute' })])

    const res = await overturn(admin, disputed.body.id as string, { reason: 'The scanner log shows you tapped in' })

    expect(res.status).toBe(200)
    expect(await scoreOf(student.id)).toBe(100)
    // Gone from the queue.
    const after = await request(app).get('/admin/attention').set(auth(admin))
    expect(after.body.items).toEqual([])
    expect(after.body.counts).toMatchObject({ all: 0, no_show_dispute: 0 })
    // The student's card: still `released` for an old app, and the new one reads the outcome.
    const bookings = await request(app).get('/bookings/me').set(auth(studentToken))
    expect(bookings.body[0]).toMatchObject({
      id: booking.id,
      frontendStatus: 'released',
      noShow: { canDispute: false, dispute: { status: 'overturned', note: 'The scanner log shows you tapped in' } },
    })
    // The notices: the recorded no-show, then its removal.
    const notices = await request(app).get('/notices/me').set(auth(studentToken))
    expect((notices.body as Array<{ kind: string; title: string }>).map((n) => [n.kind, n.title])).toEqual([
      ['no_show_outcome', 'No-show removed'],
      ['no_show', 'Missed booking'],
    ])
    // The score history keeps the truth: the no-show row stays a miss, and the restore follows it as an ok.
    const reliability = await request(app).get('/profile/reliability').set(auth(studentToken))
    expect(reliability.body).toMatchObject({ score: 100, history: ['miss', 'ok'] })
    expect((await logsOf(student.id)).map((l) => [l.delta, l.reason])).toEqual([
      [-10, 'No-show: Study Room A'],
      [10, 'No-show overturned: Study Room A'],
    ])
  })
})

describe('POST /admin/no-show-disputes/:id/uphold', { timeout: 60_000 }, () => {
  it('uphold closes the dispute and the booking stays no_show', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute({ score: 90, delta: -10 })
    const before = { booking: await bookingOf(booking.id), event: await eventOf(booking.id), logs: await logsOf(student.user.id) }
    const at = Date.now()

    const res = await uphold(admin, dispute.id, { note: 'The scanner log shows no tap' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: dispute.id })
    expect(await disputeOf(dispute.id)).toMatchObject({
      status: 'upheld',
      resolutionNote: 'The scanner log shows no tap',
      resolvedById: librarian.id,
    })
    const resolvedAt = (await disputeOf(dispute.id)).resolvedAt!.getTime()
    expect(resolvedAt).toBeGreaterThanOrEqual(at - 1000)
    expect(resolvedAt).toBeLessThanOrEqual(Date.now())
    // The no-show stands: the booking, the event and the score are exactly as they were, and no row was added to the history.
    expect(await bookingOf(booking.id)).toEqual(before.booking)
    expect((await bookingOf(booking.id)).status).toBe('no_show')
    expect(await eventOf(booking.id)).toEqual(before.event)
    expect(await scoreOf(student.user.id)).toBe(90)
    expect(await logsOf(student.user.id)).toEqual(before.logs)
    // The student's card reads the outcome, and cannot dispute again.
    const mine = await request(app).get('/bookings/me').set(auth(student.token))
    expect(mine.body[0]).toMatchObject({ noShow: { canDispute: false, dispute: { status: 'upheld', note: 'The scanner log shows no tap' } } })
  })

  it('takes the note trimmed, at most 300 characters, blank meaning none, and a bare POST', async () => {
    const { token: admin } = await seedUser('admin')
    const [bare, blank, padded, longest, tooLong] = [
      await seedDispute(),
      await seedDispute(),
      await seedDispute(),
      await seedDispute(),
      await seedDispute(),
    ]

    expect((await uphold(admin, bare.dispute.id)).status).toBe(200) // no body at all
    expect((await uphold(admin, blank.dispute.id, { note: '   ' })).status).toBe(200)
    expect((await uphold(admin, padded.dispute.id, { note: '  Checked twice \n' })).status).toBe(200)
    expect((await uphold(admin, longest.dispute.id, { note: ` ${'x'.repeat(300)} ` })).status).toBe(200)
    // Over the limit after trimming, or not text: 400, and the dispute stays open.
    expect((await uphold(admin, tooLong.dispute.id, { note: 'x'.repeat(301) })).status).toBe(400)
    expect((await uphold(admin, tooLong.dispute.id, { note: 12 })).status).toBe(400)
    expect((await uphold(admin, tooLong.dispute.id, { note: null })).status).toBe(400)

    expect((await disputeOf(bare.dispute.id)).resolutionNote).toBeNull()
    expect((await disputeOf(blank.dispute.id)).resolutionNote).toBeNull()
    expect((await disputeOf(padded.dispute.id)).resolutionNote).toBe('Checked twice')
    expect((await disputeOf(longest.dispute.id)).resolutionNote).toBe('x'.repeat(300))
    expect(await disputeOf(tooLong.dispute.id)).toMatchObject({ status: 'open', resolutionNote: null })
    expect(await prisma.notice.count({ where: { userId: tooLong.student.user.id } })).toBe(0)
    // A blank note adds nothing to the notice.
    expect((await noticesOf(blank.student.user.id))[0].body).not.toContain('Note from the library')
    expect((await noticesOf(bare.student.user.id))[0].body).not.toContain('Note from the library')
  })
})

describe('the notice each answer sends', { timeout: 60_000 }, () => {
  it('the notice copy and the note suffix', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const toOverturn = await seedDispute({ email: 'asha@example.org', score: 80, delta: -10, resourceName: 'Study Room A', type: 'room' })
    const toUphold = await seedDispute({ email: 'ben@example.org', score: 80, delta: -10, resourceName: 'Desk 12' })
    const toUpholdQuietly = await seedDispute({ email: 'cara@example.org', score: 80, delta: -10, resourceName: 'Desk 13' })
    const sendMail = fakeTransport()

    expect((await overturn(admin, toOverturn.dispute.id, { reason: '  The scanner log shows you tapped in.  ' })).status).toBe(200)
    expect((await uphold(admin, toUphold.dispute.id, { note: '  The scanner log shows no tap.  ' })).status).toBe(200)
    expect((await uphold(admin, toUpholdQuietly.dispute.id)).status).toBe(200)

    const day = (d: { startTime: Date }) => dayLabel(d.startTime)
    expect(day(toOverturn.booking)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/) // "Thu, Nov 5", the same label the no_show notice uses
    const [removed] = await noticesOf(toOverturn.student.user.id)
    expect(removed).toMatchObject({
      kind: 'no_show_outcome',
      title: 'No-show removed',
      body: `The library removed the no-show for Study Room A (${day(toOverturn.booking)}) and restored your reliability score to 90.\n\nNote from the library: The scanner log shows you tapped in.`,
      userId: toOverturn.student.user.id,
      bookingId: toOverturn.booking.id,
      createdById: librarian.id,
      loanId: null,
      fineId: null,
    })
    const [kept] = await noticesOf(toUphold.student.user.id)
    expect(kept).toMatchObject({
      kind: 'no_show_outcome',
      title: 'No-show stands',
      body: `The library kept the no-show for Desk 12 (${day(toUphold.booking)}).\n\nNote from the library: The scanner log shows no tap.`,
      bookingId: toUphold.booking.id,
      createdById: librarian.id,
    })
    // Without a note nothing follows the sentence.
    const [quiet] = await noticesOf(toUpholdQuietly.student.user.id)
    expect(quiet).toMatchObject({ kind: 'no_show_outcome', title: 'No-show stands', body: `The library kept the no-show for Desk 13 (${day(toUpholdQuietly.booking)}).` })

    // The email is the same title and body, one per notice, to the student, after the footer-less body.
    expect(sendMail).toHaveBeenCalledTimes(3)
    for (const [message] of sendMail.mock.calls) {
      const notice = [removed, kept, quiet].find((n) => message.subject === `SmartLib: ${n.title}` && message.text.startsWith(n.body))
      expect(notice, message.subject).toBeDefined()
    }
    expect(sendMail.mock.calls.map(([m]) => m.to).sort()).toEqual(['asha@example.org', 'ben@example.org', 'cara@example.org'])
    // The student's own notices list shows them (kind and text only).
    const mine = await request(app).get('/notices/me').set(auth(toOverturn.student.token))
    expect(mine.body).toEqual([expect.objectContaining({ kind: 'no_show_outcome', title: 'No-show removed', body: removed.body })])
  })

  it('the notice carries the student\'s score as it is after the restore, and prints a half point as it is', async () => {
    const { token: admin } = await seedUser('admin')
    const { student, dispute } = await seedDispute({ score: 40.5, delta: -10 })

    expect((await overturn(admin, dispute.id, { reason: 'Checked' })).status).toBe(200)

    expect(await scoreOf(student.user.id)).toBe(50.5)
    expect((await noticesOf(student.user.id))[0].body).toContain('restored your reliability score to 50.5.')
  })
})

describe('a second answer, and two answers at once', { timeout: 120_000 }, () => {
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a second answer is 409 and publishes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const overturned = await seedDispute({ score: 47, delta: -7 })
    const upheld = await seedDispute({ score: 80, delta: -10 })
    expect((await overturn(admin, overturned.dispute.id, { reason: 'First' })).status).toBe(200)
    expect((await uphold(admin, upheld.dispute.id, { note: 'First' })).status).toBe(200)
    const noticesBefore = await prisma.notice.count()
    const logsBefore = await logsOf(overturned.student.user.id)
    const sendMail = fakeTransport()
    recorder = recordEvents()

    const answers = [
      await overturn(admin, overturned.dispute.id, { reason: 'Second' }), // overturn again
      await uphold(admin, overturned.dispute.id, { note: 'Second' }), // uphold after an overturn
      await overturn(admin, upheld.dispute.id, { reason: 'Second' }), // overturn after an uphold
      await uphold(admin, upheld.dispute.id, { note: 'Second' }), // uphold again
    ]

    for (const res of answers) {
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: RESOLVED })
    }
    // The first answers stand, unchanged; nothing was restored twice.
    expect(await disputeOf(overturned.dispute.id)).toMatchObject({ status: 'overturned', resolutionNote: 'First' })
    expect(await disputeOf(upheld.dispute.id)).toMatchObject({ status: 'upheld', resolutionNote: 'First' })
    expect(await scoreOf(overturned.student.user.id)).toBe(54)
    expect(await logsOf(overturned.student.user.id)).toEqual(logsBefore)
    expect((await bookingOf(overturned.booking.id)).status).toBe('released')
    expect((await bookingOf(upheld.booking.id)).status).toBe('no_show')
    // And the refusals wrote, sent and published nothing.
    expect(await prisma.notice.count()).toBe(noticesBefore)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('overturn and uphold at once: one wins', async () => {
    const { token: admin } = await seedUser('admin')
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { student, dispute, booking } = await seedDispute({ score: 47, delta: -7 })
      const noticesBefore = await prisma.notice.count()
      const sendMail = fakeTransport()
      recorder = recordEvents()

      const [overturned, upheld] = await together(
        round,
        () => overturn(admin, dispute.id, { reason: 'Overturn' }),
        () => uphold(admin, dispute.id, { note: 'Uphold' }),
      )

      recorder.stop()
      setMailTransport(null)
      expect([overturned.status, upheld.status].sort(), `round ${round}`).toEqual([200, 409])
      const loser = overturned.status === 409 ? overturned : upheld
      expect(loser.body).toEqual({ error: RESOLVED })
      const row = await disputeOf(dispute.id)
      // One notice, one email, and the rows are those of the winner alone.
      expect(await prisma.notice.count()).toBe(noticesBefore + 1)
      expect(sendMail).toHaveBeenCalledTimes(1)
      if (overturned.status === 200) {
        expect(row).toMatchObject({ status: 'overturned', resolutionNote: 'Overturn' })
        expect((await bookingOf(booking.id)).status).toBe('released')
        expect(await scoreOf(student.user.id)).toBe(54)
        expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED, ATTENTION_CHANGED])
      } else {
        expect(row).toMatchObject({ status: 'upheld', resolutionNote: 'Uphold' })
        expect((await bookingOf(booking.id)).status).toBe('no_show')
        expect(await scoreOf(student.user.id)).toBe(47)
        expect(await logsOf(student.user.id)).toHaveLength(1)
        expect(recorder.events).toEqual([ATTENTION_CHANGED])
      }
    }
  })

  it('two overturns at once restore the points once', async () => {
    const { token: admin } = await seedUser('admin')
    await warmPool()

    for (let round = 0; round < ROUNDS; round++) {
      const { student, dispute } = await seedDispute({ score: 47, delta: -7 })
      recorder = recordEvents()

      const [first, second] = await together(
        round,
        () => overturn(admin, dispute.id, { reason: 'First' }),
        () => overturn(admin, dispute.id, { reason: 'Second' }),
      )

      recorder.stop()
      expect([first.status, second.status].sort(), `round ${round}`).toEqual([200, 409])
      // Restored once: 47 + 7, one history row for it, one notice, and the winner's reason is the note.
      expect(await scoreOf(student.user.id)).toBe(54)
      expect(await logsOf(student.user.id)).toHaveLength(2)
      expect(await noticesOf(student.user.id)).toHaveLength(1)
      expect((await disputeOf(dispute.id)).resolutionNote).toBe(first.status === 200 ? 'First' : 'Second')
      expect(recorder.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED, ATTENTION_CHANGED])
    }
  })

  it('the loser of two answers at once writes nothing: the winner lands while it waits on the booking row', async () => {
    const { user: librarian } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute({ score: 47, delta: -7 })
    const before = { event: await eventOf(booking.id), logs: await logsOf(student.user.id), booking: await bookingOf(booking.id) }
    recorder = recordEvents()
    const sendMail = fakeTransport()

    // The overturn reads the dispute, then waits for the booking row; an uphold that committed meanwhile
    // closes the dispute, so when the overturn gets the row its conditional update matches nothing.
    const settled = await bookingLockedThenCompete(
      booking.id,
      () => overturnNoShow(dispute.id, librarian.id, 'Too late'),
      (tx) =>
        tx.noShowDispute.update({ where: { id: dispute.id }, data: { status: 'upheld', resolutionNote: 'First', resolvedById: librarian.id, resolvedAt: new Date() } }),
    )

    expect(settled).toMatchObject({ status: 'rejected', reason: { status: 409, message: RESOLVED } })
    expect(await disputeOf(dispute.id)).toMatchObject({ status: 'upheld', resolutionNote: 'First' })
    expect(await bookingOf(booking.id)).toEqual(before.booking)
    expect(await eventOf(booking.id)).toEqual(before.event)
    expect(await scoreOf(student.user.id)).toBe(47)
    expect(await logsOf(student.user.id)).toEqual(before.logs)
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })
})

describe('the lock order: booking, dispute, event, then the student', { timeout: 60_000 }, () => {
  type Table = 'ResourceBooking' | 'NoShowDispute' | 'NoShowEvent' | 'User'
  type Mode = 'UPDATE' | 'NO KEY UPDATE' | 'KEY SHARE'

  /**
   * Whether another session holds a lock on the row that conflicts with `mode`. `SKIP LOCKED` answers no
   * row for a locked one instead of waiting, and the probe's own lock ends with its statement.
   */
  async function locked(table: Table, column: 'id' | 'resourceBookingId', value: string, mode: Mode = 'UPDATE'): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 AS present FROM "${table}" WHERE "${column}" = $1 FOR ${mode} SKIP LOCKED`, value)
    return rows.length === 0
  }

  /**
   * Holds one row lock in a transaction of the test's own, runs `answer`, waits until the answer is stuck behind
   * that lock, lets `whileBlocked` look at what the answer holds by then, and then releases. The answer must
   * still succeed once it is let through.
   */
  async function whileHeld(hold: Table, column: 'id' | 'resourceBookingId', value: string, answer: () => PromiseLike<request.Response>, whileBlocked: () => Promise<void>) {
    let pending: Promise<request.Response> | undefined
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM "${hold}" WHERE "${column}" = $1 FOR UPDATE`, value)
          pending = Promise.resolve(answer())
          await waitUntilAWriterIsBlocked()
          await whileBlocked()
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
    } finally {
      // Never leave the request running into the next test, even when the setup failed.
      await pending
    }
    return pending!
  }

  it('an overturn takes the booking row before it touches the dispute: held on the booking, the dispute row is still free', async () => {
    const { token: admin } = await seedUser('admin')
    const { dispute, booking } = await seedDispute()

    const res = await whileHeld(
      'ResourceBooking',
      'id',
      booking.id,
      () => overturn(admin, dispute.id, { reason: 'Checked' }),
      async () => {
        expect(await locked('NoShowDispute', 'id', dispute.id)).toBe(false)
      },
    )

    expect(res.status).toBe(200)
  })

  it('an uphold takes the booking row before it touches the dispute', async () => {
    const { token: admin } = await seedUser('admin')
    const { dispute, booking } = await seedDispute()

    const res = await whileHeld(
      'ResourceBooking',
      'id',
      booking.id,
      () => uphold(admin, dispute.id, { note: 'Checked' }),
      async () => {
        expect(await locked('NoShowDispute', 'id', dispute.id)).toBe(false)
      },
    )

    expect(res.status).toBe(200)
  })

  it('an overturn takes the dispute row before the event row: held on the event, the booking and the dispute are already its own, the student is not', async () => {
    const { token: admin } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute()

    const res = await whileHeld(
      'NoShowEvent',
      'resourceBookingId',
      booking.id,
      () => overturn(admin, dispute.id, { reason: 'Checked' }),
      async () => {
        expect(await locked('ResourceBooking', 'id', booking.id), 'booking').toBe(true)
        expect(await locked('NoShowDispute', 'id', dispute.id), 'dispute').toBe(true)
        expect(await locked('User', 'id', student.user.id), 'student').toBe(false)
      },
    )

    expect(res.status).toBe(200)
  })

  it('an overturn takes the event row before the student: held on the student, the booking, the dispute and the event are already its own', async () => {
    const { token: admin } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute()

    const res = await whileHeld(
      'User',
      'id',
      student.user.id,
      () => overturn(admin, dispute.id, { reason: 'Checked' }),
      async () => {
        expect(await locked('ResourceBooking', 'id', booking.id), 'booking').toBe(true)
        expect(await locked('NoShowDispute', 'id', dispute.id), 'dispute').toBe(true)
        expect(await locked('NoShowEvent', 'resourceBookingId', booking.id), 'event').toBe(true)
      },
    )

    expect(res.status).toBe(200)
  })

  it('the booking lock is FOR NO KEY UPDATE: a foreign-key check (a notice about the booking) is not blocked by an answer in progress', async () => {
    const { token: admin } = await seedUser('admin')
    const { dispute, booking } = await seedDispute()

    const res = await whileHeld(
      'NoShowEvent',
      'resourceBookingId',
      booking.id,
      () => overturn(admin, dispute.id, { reason: 'Checked' }),
      async () => {
        expect(await locked('ResourceBooking', 'id', booking.id, 'NO KEY UPDATE'), 'it holds the booking').toBe(true)
        // A FOR UPDATE (the strongest lock) would conflict with this; NO KEY UPDATE does not.
        expect(await locked('ResourceBooking', 'id', booking.id, 'KEY SHARE'), 'but not a stronger lock than NO KEY UPDATE').toBe(false)
      },
    )

    expect(res.status).toBe(200)
  })

  it('an answer to a dispute already closed takes neither the event nor the student: it is refused while both are held', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { student, dispute, booking } = await seedDispute({ status: 'upheld' })
    await prisma.noShowDispute.update({ where: { id: dispute.id }, data: { resolvedById: librarian.id, resolvedAt: new Date() } })

    // One test transaction holds the event row and the student's row; the loser must not wait for either.
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "NoShowEvent" WHERE "resourceBookingId" = ${booking.id} FOR UPDATE`
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${student.user.id} FOR UPDATE`
        const pending = Promise.resolve(overturn(admin, dispute.id, { reason: 'Too late' }))
        const first = await Promise.race([pending, new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 8_000))])
        return { pending, first }
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    const res = await outcome.pending

    expect(outcome.first).not.toBe('blocked')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: RESOLVED })
  })
})

describe('the guards', { timeout: 60_000 }, () => {
  it('unknown id 404, student 403, no token 401', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: other } = await seedUser()
    const { student, dispute, booking } = await seedDispute()
    const recorder = recordEvents()
    const sendMail = fakeTransport()

    for (const [what, call] of [
      ['overturn', (token: string | null, id: string, body: unknown) => overturnWith(token, id, body)],
      ['uphold', (token: string | null, id: string, body: unknown) => upholdWith(token, id, body)],
    ] as const) {
      const body = what === 'overturn' ? { reason: 'Checked' } : { note: 'Checked' }
      // No token, and a bad one: 401 before anything else, even before the body is read.
      expect((await call(null, dispute.id, body)).status, `${what} without a token`).toBe(401)
      expect((await call('not-a-token', dispute.id, body)).status, `${what} with a bad token`).toBe(401)
      expect((await call(null, dispute.id, {})).status, `${what} without a token and with a bad body`).toBe(401)
      // A student is refused: another student, and the very student whose dispute it is.
      expect((await call(other, dispute.id, body)).status, `${what} as another student`).toBe(403)
      expect((await call(student.token, dispute.id, body)).status, `${what} as the owner`).toBe(403)
      expect((await call(other, dispute.id, {})).status, `${what} as a student with a bad body`).toBe(403)
      // An id that is no dispute is a 404 with the contract's words, and so is a booking's id.
      for (const id of ['no-such-dispute', booking.id]) {
        const res = await call(admin, id, body)
        expect(res.status, `${what} ${id}`).toBe(404)
        expect(res.body, `${what} ${id}`).toEqual({ error: NOT_FOUND })
      }
    }
    recorder.stop()

    expect(await disputeOf(dispute.id)).toMatchObject({ status: 'open' })
    expect((await bookingOf(booking.id)).status).toBe('no_show')
    expect(await scoreOf(student.user.id)).toBe(90)
    expect(await prisma.notice.count()).toBe(0)
    expect(sendMail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('a fine dispute\'s id is no no-show dispute: 404', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const fine = await prisma.fine.create({ data: { userId: student.id, amount: 20, reason: 'overdue' } })
    const fineDispute = await prisma.fineDispute.create({ data: { fineId: fine.id, userId: student.id, reason: 'Wrong' } })

    const res = await overturn(admin, fineDispute.id, { reason: 'Checked' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: NOT_FOUND })
  })
})

// `send` with a token that may be missing, for the guard loop above.
function overturnWith(token: string | null, id: string, body: unknown) {
  const req = request(app).post(`/admin/no-show-disputes/${id}/overturn`)
  return send(token === null ? req : req.set(auth(token)), body)
}
function upholdWith(token: string | null, id: string, body: unknown) {
  const req = request(app).post(`/admin/no-show-disputes/${id}/uphold`)
  return send(token === null ? req : req.set(auth(token)), body)
}

describe('email for a no-show answer', { timeout: 60_000 }, () => {
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a failing email records failed and the answer stands', async () => {
    const { token: admin } = await seedUser('admin')
    const toOverturn = await seedDispute({ email: 'asha@example.org', score: 47, delta: -7 })
    const toUphold = await seedDispute({ email: 'ben@example.org' })

    // The provider refuses the first message and the transport throws on the second.
    setMailTransport({ send: async () => ({ ok: false }) })
    const removed = await overturn(admin, toOverturn.dispute.id, { reason: 'Checked' })
    setMailTransport({
      send: async () => {
        throw new Error('network down')
      },
    })
    const kept = await uphold(admin, toUphold.dispute.id)

    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ id: toOverturn.dispute.id })
    expect(kept.status).toBe(200)
    expect(kept.body).toEqual({ id: toUphold.dispute.id })
    // The answers stand: the rows changed, the points are back, and the notices are committed with the outcome recorded.
    expect(await disputeOf(toOverturn.dispute.id)).toMatchObject({ status: 'overturned' })
    expect((await bookingOf(toOverturn.booking.id)).status).toBe('released')
    expect(await scoreOf(toOverturn.student.user.id)).toBe(54)
    expect(await disputeOf(toUphold.dispute.id)).toMatchObject({ status: 'upheld' })
    for (const seeded of [toOverturn, toUphold]) {
      const [notice] = await noticesOf(seeded.student.user.id)
      expect(notice.emailStatus).toBe('failed')
      expect(notice.emailedAt).not.toBeNull()
    }
  })

  it('sends one email per answer, after the commit; a placeholder address or email not set up records skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const real = await seedDispute({ email: 'asha@example.org' })
    const demo = await seedDispute({ email: 'seed.student3@thapar.edu' })
    const quiet = await seedDispute({ email: 'cara@example.org' })
    const seenAtSend: Array<{ notices: Array<{ emailStatus: string }>; dispute: string; events: number }> = []
    const events = recordEvents()
    recorder = events
    const sendMail = vi.fn<MailTransport['send']>(async () => {
      // Read on another connection: only committed rows are visible, the outcome not yet written.
      seenAtSend.push({ notices: await prisma.notice.findMany(), dispute: (await disputeOf(real.dispute.id)).status, events: events.events.length })
      return { ok: true }
    })
    setMailTransport({ send: sendMail })

    expect((await overturn(admin, real.dispute.id, { reason: 'Checked' })).status).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(seenAtSend).toEqual([{ notices: [expect.objectContaining({ emailStatus: 'skipped' })], dispute: 'overturned', events: 0 }])
    expect((await noticesOf(real.student.user.id))[0].emailStatus).toBe('sent')

    // Demo accounts never receive mail.
    expect((await uphold(admin, demo.dispute.id)).status).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect((await noticesOf(demo.student.user.id))[0]).toMatchObject({ emailStatus: 'skipped', emailedAt: null })

    // Email not set up: the notice is still written and the answer still lands.
    setMailTransport(null)
    expect((await uphold(admin, quiet.dispute.id)).status).toBe(200)
    expect((await noticesOf(quiet.student.user.id))[0]).toMatchObject({ emailStatus: 'skipped', emailedAt: null })
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('events once, after the email outcome', async () => {
    const { token: admin } = await seedUser('admin')
    fakeTransport()
    const toOverturn = await seedDispute({ email: 'asha@example.org' })
    const toUphold = await seedDispute({ email: 'ben@example.org' })
    const events = recordEvents()
    recorder = events
    // What the notices look like in the database at the moment each event is published.
    const atPublish: Array<Promise<EmailStatus[]>> = []
    const stop = subscribe(() => {
      atPublish.push(prisma.notice.findMany({ orderBy: { createdAt: 'asc' } }).then((rows) => rows.map((n) => n.emailStatus)))
    })

    try {
      // Refusals first: nothing is published.
      expect((await overturn(admin, toOverturn.dispute.id, {})).status).toBe(400)
      expect((await overturn(admin, 'no-such-dispute', { reason: 'x' })).status).toBe(404)
      expect((await uphold(admin, 'no-such-dispute')).status).toBe(404)
      expect(events.events).toEqual([])

      // An overturn: the booking, the student and the queue, once each, in that order, and the email's outcome is
      // already stored (the row says `sent`) when each is published.
      expect((await overturn(admin, toOverturn.dispute.id, { reason: 'Checked' })).status).toBe(200)
      expect(events.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED, ATTENTION_CHANGED])
      expect(await Promise.all(atPublish)).toEqual([['sent'], ['sent'], ['sent']])

      // A second answer: refused, nothing more published.
      expect((await overturn(admin, toOverturn.dispute.id, { reason: 'Again' })).status).toBe(409)
      expect((await uphold(admin, toOverturn.dispute.id)).status).toBe(409)
      expect(events.events).toHaveLength(3)

      // An uphold moves only the queue.
      expect((await uphold(admin, toUphold.dispute.id)).status).toBe(200)
      expect(events.events).toEqual([BOOKING_CHANGED, STUDENT_CHANGED, ATTENTION_CHANGED, ATTENTION_CHANGED])
      expect(await Promise.all(atPublish)).toEqual([['sent'], ['sent'], ['sent'], ['sent', 'sent']])
      expect((await uphold(admin, toUphold.dispute.id)).status).toBe(409)
      expect(events.events).toHaveLength(4)
    } finally {
      stop()
    }
  })
})

// A no-show dispute answered by the service directly takes the clock as its last argument.
describe('the dates an answer records', { timeout: 60_000 }, () => {
  it('stamps the dispute with the instant it is given, and names the booking\'s own day, whatever the database session\'s time zone', async () => {
    const { user: librarian } = await seedUser('admin')
    // Both bookings started at 20:00 local time two days ago: read 5.5 hours late (a session on Kolkata time whose
    // offset was taken for UTC) they would fall on the next day, and the notice would name the wrong one.
    const evening = new Date()
    evening.setDate(evening.getDate() - 2)
    evening.setHours(20, 0, 0, 0)
    const toOverturn = await seedDispute({ startTime: evening })
    const toUphold = await seedDispute({ startTime: evening })
    const at = new Date(Date.now() - 3 * DAY_MS)
    // Every write runs in a transaction whose session is on Kolkata time (+5:30): a value that leaned on the
    // session zone, a cast or the database's own clock, would move by hours.
    type Work = (tx: Prisma.TransactionClient) => Promise<unknown>
    const realTransaction = prisma.$transaction.bind(prisma) as (fn: Work, options?: unknown) => Promise<unknown>
    vi.spyOn(prisma, '$transaction').mockImplementation(((fn: Work, options?: unknown) =>
      realTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`)
        return fn(tx)
      }, options)) as never)

    await overturnNoShow(toOverturn.dispute.id, librarian.id, 'Checked', at)
    await upholdNoShow(toUphold.dispute.id, librarian.id, null, at)
    vi.restoreAllMocks()

    expect((await disputeOf(toOverturn.dispute.id)).resolvedAt).toEqual(at)
    expect((await disputeOf(toUphold.dispute.id)).resolvedAt).toEqual(at)
    expect((await noticesOf(toOverturn.student.user.id))[0].body).toContain(`for ${toOverturn.name} (${dayLabel(evening)}) and restored`)
    expect((await noticesOf(toUphold.student.user.id))[0].body).toContain(`for ${toUphold.name} (${dayLabel(evening)}).`)
  })
})
