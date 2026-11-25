// A student reporting a seat or a room from the app: who may report (a booking of
// that resource in the window), one open report per student and resource, the
// validation, the live event, and the schema's own guards (the CHECK that a report
// has exactly one target, and the two partial unique indexes). What the student's
// own booking list says about reports (canReport, reportOpen) is in
// test/routes/bookings.test.ts; the librarian's side comes with the queue.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { BookingStatus } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 8

const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

const NOT_BOOKED = 'You can only report a seat or room you have booked.'
const ALREADY_REPORTED = 'You already reported this. The library is looking into it.'

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

function seedResource(type: 'seat' | 'room' = 'seat', name = `Desk ${Math.random()}`) {
  return prisma.resource.create({ data: { type, name } })
}

/** A book with one copy, for the rows that point at a copy. */
async function seedCopy() {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Refactoring', author: 'Someone', totalCopies: 1 } })
  return prisma.bookCopy.create({ data: { bookId: book.id } })
}

/** A booking of the resource that starts `offsetMs` from now (negative: that long ago) and lasts an hour. */
function seedBooking(userId: string, resourceId: string, offsetMs: number, status: BookingStatus = 'booked') {
  const startTime = new Date(Date.now() + offsetMs)
  return prisma.resourceBooking.create({
    data: {
      userId,
      resourceId,
      startTime,
      endTime: new Date(startTime.getTime() + HOUR_MS),
      status,
      checkedInAt: status === 'checked_in' || status === 'completed' ? startTime : null,
    },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const report = (token: string, body?: unknown) => {
  const req = request(app).post('/reports').set(auth(token))
  return body === undefined ? req : req.send(body as object)
}
const reportsOf = (userId: string) => prisma.issueReport.findMany({ where: { userId } })

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

/** Polls until the report's insert is stuck waiting for a lock (here: on a unique key another transaction has written but not committed). */
async function waitUntilTheInsertIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%IssueReport%' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The report never blocked on the unique index')
}

describe('POST /reports', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('a student reports a resource they booked (201)', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Reading Room A · Desk 12')
    const room = await seedResource('room', 'Group Room 201')
    await seedBooking(user.id, seat.id, -2 * HOUR_MS, 'checked_in')
    await seedBooking(user.id, room.id, -HOUR_MS) // an approved room booking is stored as `booked`
    const before = Date.now()

    const seatRes = await report(token, { resourceId: seat.id, category: 'not_working', note: '  The lamp is dead \n' })
    const roomRes = await report(token, { resourceId: room.id, category: 'dirty' })

    expect(seatRes.status).toBe(201)
    expect(seatRes.body).toEqual({ id: expect.any(String) })
    expect(roomRes.status).toBe(201)
    const [seatRow] = await prisma.issueReport.findMany({ where: { id: seatRes.body.id } })
    expect(seatRow).toMatchObject({
      userId: user.id,
      resourceId: seat.id,
      bookCopyId: null,
      category: 'not_working',
      note: 'The lamp is dead',
      status: 'open',
      resolutionNote: null,
      resolvedById: null,
      resolvedAt: null,
    })
    expect(seatRow.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(seatRow.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await prisma.issueReport.findUniqueOrThrow({ where: { id: roomRes.body.id } })).toMatchObject({
      resourceId: room.id,
      bookCopyId: null,
      category: 'dirty',
      note: null,
      status: 'open',
    })
    // Nothing about the booking or the resource changed.
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe('available')
  })

  it('a booking that started 6 days ago, one starting in 23 hours, a checked-in one and one never checked into all qualify', async () => {
    const { user, token } = await seedUser()
    // Each case gets a resource of its own, so no case is refused as a second report.
    // The two edge cases are a minute inside the 7-day and the 24-hour limits.
    const cases: Array<[string, number, BookingStatus]> = [
      ['started 6 days ago', -6 * DAY_MS, 'completed'],
      ['starts in 23 hours', 23 * HOUR_MS, 'booked'],
      ['checked in an hour ago', -HOUR_MS, 'checked_in'],
      ['never checked into, long past its grace period', -2 * DAY_MS, 'booked'],
      ['started a minute inside 7 days ago', -(7 * DAY_MS - MINUTE_MS), 'booked'],
      ['starts a minute inside 24 hours from now', 24 * HOUR_MS - MINUTE_MS, 'booked'],
    ]
    const resources = []
    for (const [, offset, status] of cases) {
      const resource = await seedResource()
      await seedBooking(user.id, resource.id, offset, status)
      resources.push(resource)
    }
    recorder = recordEvents()

    for (const [i, [what]] of cases.entries()) {
      const res = await report(token, { resourceId: resources[i].id, category: 'dirty' })
      expect(res.status, what).toBe(201)
    }

    expect(await prisma.issueReport.count({ where: { userId: user.id, status: 'open' } })).toBe(cases.length)
    expect(recorder.events).toEqual(cases.map(() => ATTENTION_CHANGED))
  })

  it('a booking 8 days ago, one starting in 25 hours, a cancelled booking and a room request do not (403)', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    // Every case is a booking of the student's own on a resource of its own. The two edge cases are
    // a minute outside the limits; the rest are statuses the rule leaves out (a request, a refused
    // or lapsed request, a cancel). A no-show and a release are NOT among them: they entitle (see
    // the two tests below), and so does a booking that was never checked into.
    const cases: Array<[string, number, BookingStatus]> = [
      ['started 8 days ago', -8 * DAY_MS, 'completed'],
      ['started a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'booked'],
      ['starts in 25 hours', 25 * HOUR_MS, 'booked'],
      ['starts a minute outside 24 hours from now', 24 * HOUR_MS + MINUTE_MS, 'booked'],
      ['cancelled', -HOUR_MS, 'cancelled'],
      ['a room request waiting for a librarian', 2 * HOUR_MS, 'requested'],
      ['a declined request', -HOUR_MS, 'declined'],
      ['an expired request', -HOUR_MS, 'expired'],
    ]
    const targets: Array<[string, string]> = []
    for (const [what, offset, status] of cases) {
      const resource = await seedResource(status === 'requested' ? 'room' : 'seat')
      await seedBooking(user.id, resource.id, offset, status)
      targets.push([what, resource.id])
    }
    const neverBooked = await seedResource()
    const theirs = await seedResource()
    await seedBooking(other.id, theirs.id, -HOUR_MS, 'checked_in')
    targets.push(['no booking at all', neverBooked.id], ["only another student's booking", theirs.id], ['an unknown resource id', 'no-such-resource'])
    recorder = recordEvents()

    for (const [what, resourceId] of targets) {
      const res = await report(token, { resourceId, category: 'not_working', note: 'Broken' })
      expect(res.status, what).toBe(403)
      expect(res.body.error, what).toBe(NOT_BOOKED)
    }

    expect(await prisma.issueReport.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  // The sweep turns a booking that was never checked into from `booked` into `no_show` within
  // minutes, so the student who found the seat broken and left must still be able to report it.
  it('a student with a no-show booking can still report its seat', async () => {
    const { user, token } = await seedUser()
    const seat = await seedResource('seat', 'Reading Room A · Desk 3')
    const booking = await seedBooking(user.id, seat.id, -2 * HOUR_MS, 'no_show')
    await prisma.user.update({ where: { id: user.id }, data: { reliabilityScore: 60 } })
    recorder = recordEvents()

    const res = await report(token, { resourceId: seat.id, category: 'not_working', note: 'The lamp is dead' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: expect.any(String) })
    expect(await prisma.issueReport.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({
      userId: user.id,
      resourceId: seat.id,
      category: 'not_working',
      note: 'The lamp is dead',
      status: 'open',
    })
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
    // A report never charges or penalizes anyone: the miss stands as it was, and nothing was taken.
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('no_show')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).reliabilityScore).toBe(60)
    expect(await prisma.reliabilityScoreLog.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.fine.count()).toBe(0)
    expect(await prisma.noShowEvent.count()).toBe(0)
  })

  it('a released booking can still be reported', async () => {
    const { user, token } = await seedUser()
    const room = await seedResource('room', 'Group Room 201')
    const booking = await seedBooking(user.id, room.id, -2 * HOUR_MS, 'released')
    recorder = recordEvents()

    const res = await report(token, { resourceId: room.id, category: 'dirty' })

    expect(res.status).toBe(201)
    expect(await prisma.issueReport.count({ where: { userId: user.id, resourceId: room.id, status: 'open' } })).toBe(1)
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('released')
  })

  it('a no-show or released booking entitles only inside the same time window as any other', async () => {
    const { user, token } = await seedUser()
    const cases: Array<[string, number, BookingStatus, number]> = [
      ['a no-show a minute inside 7 days ago', -(7 * DAY_MS - MINUTE_MS), 'no_show', 201],
      ['a release a minute inside 7 days ago', -(7 * DAY_MS - MINUTE_MS), 'released', 201],
      ['a no-show a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'no_show', 403],
      ['a release a minute outside 7 days ago', -(7 * DAY_MS + MINUTE_MS), 'released', 403],
      ['a no-show 8 days ago', -8 * DAY_MS, 'no_show', 403],
    ]
    const targets: Array<[string, string, number]> = []
    for (const [what, offset, status, expected] of cases) {
      const resource = await seedResource()
      await seedBooking(user.id, resource.id, offset, status)
      targets.push([what, resource.id, expected])
    }

    for (const [what, resourceId, expected] of targets) {
      const res = await report(token, { resourceId, category: 'dirty' })
      expect(res.status, what).toBe(expected)
      if (expected === 403) expect(res.body.error, what).toBe(NOT_BOOKED)
    }
    expect(await prisma.issueReport.count({ where: { userId: user.id } })).toBe(2)
  })

  it('an open report on the same resource is 409, also under two simultaneous requests', async () => {
    const { user, token } = await seedUser()
    const { user: other, token: otherToken } = await seedUser()
    const desk = await seedResource()
    const elsewhere = await seedResource()
    await seedBooking(user.id, desk.id, -2 * HOUR_MS, 'checked_in')
    await seedBooking(user.id, elsewhere.id, -2 * HOUR_MS, 'checked_in')
    await seedBooking(other.id, desk.id, -4 * HOUR_MS, 'checked_in')
    const first = await report(token, { resourceId: desk.id, category: 'dirty', note: 'Crumbs everywhere' })
    expect(first.status).toBe(201)
    recorder = recordEvents()

    const again = await report(token, { resourceId: desk.id, category: 'not_working', note: 'And the lamp is dead' })

    expect(again.status).toBe(409)
    expect(again.body.error).toBe(ALREADY_REPORTED)
    // The first report stands unchanged, and no second one was written.
    expect(await reportsOf(user.id)).toEqual([expect.objectContaining({ id: first.body.id, category: 'dirty', note: 'Crumbs everywhere', status: 'open' })])
    expect(recorder.events).toEqual([])
    // It is the student's own open report on that resource that blocks: another student, or the same one on another desk, are free to report.
    expect((await report(otherToken, { resourceId: desk.id, category: 'dirty' })).status).toBe(201)
    expect((await report(token, { resourceId: elsewhere.id, category: 'dirty' })).status).toBe(201)

    // Two requests at once, from a student with no open report: exactly one is created.
    const { user: racer, token: racerToken } = await seedUser()
    for (let round = 0; round < ROUNDS; round++) {
      const seat = await seedResource()
      await seedBooking(racer.id, seat.id, -HOUR_MS, 'checked_in')
      recorder.stop()
      recorder = recordEvents()

      const [one, two] = await together(
        round,
        () => report(racerToken, { resourceId: seat.id, category: 'dirty', note: 'First' }),
        () => report(racerToken, { resourceId: seat.id, category: 'not_working', note: 'Second' }),
      )

      expect([one.status, two.status].sort(), `round ${round}`).toEqual([201, 409])
      const loser = one.status === 409 ? one : two
      expect(loser.body.error).toBe(ALREADY_REPORTED)
      const winner = one.status === 201 ? 'First' : 'Second'
      expect(await prisma.issueReport.findMany({ where: { userId: racer.id, resourceId: seat.id } })).toEqual([expect.objectContaining({ note: winner })])
      expect(recorder.events).toEqual([ATTENTION_CHANGED])
    }
  }, 90_000)

  it('a request that loses the unique index to a report committing at the same moment is 409 too, and publishes nothing', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource()
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')
    recorder = recordEvents()

    // The competing report is written but not committed, so the request cannot see it
    // and goes on to insert its own: that insert waits on the unique key, and when the
    // other transaction commits the database refuses it (SQLSTATE 23505).
    let pending: Promise<request.Response> | undefined
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.issueReport.create({ data: { userId: user.id, resourceId: desk.id, category: 'dirty', note: 'Landed first' } })
          pending = Promise.resolve(report(token, { resourceId: desk.id, category: 'not_working', note: 'Landed second' }))
          await waitUntilTheInsertIsBlocked()
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
    } finally {
      await pending
    }
    const res = await pending!

    expect(res.status).toBe(409)
    expect(res.body.error).toBe(ALREADY_REPORTED)
    expect(await reportsOf(user.id)).toEqual([expect.objectContaining({ note: 'Landed first' })])
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('a closed report no longer blocks a new one', async () => {
    const { user, token } = await seedUser()
    const { user: librarian } = await seedUser('admin')
    const confirmed = await seedResource()
    const dismissed = await seedResource()
    await seedBooking(user.id, confirmed.id, -HOUR_MS, 'checked_in')
    await seedBooking(user.id, dismissed.id, -HOUR_MS, 'checked_in')
    const resolved = { resolvedById: librarian.id, resolvedAt: new Date(), resolutionNote: 'Checked' }
    await prisma.issueReport.create({ data: { userId: user.id, resourceId: confirmed.id, category: 'dirty', status: 'confirmed', ...resolved } })
    await prisma.issueReport.create({ data: { userId: user.id, resourceId: dismissed.id, category: 'dirty', status: 'dismissed', ...resolved } })

    const afterConfirmed = await report(token, { resourceId: confirmed.id, category: 'dirty' })
    const afterDismissed = await report(token, { resourceId: dismissed.id, category: 'dirty' })

    expect(afterConfirmed.status).toBe(201)
    expect(afterDismissed.status).toBe(201)
    expect(await prisma.issueReport.count({ where: { userId: user.id, status: 'open' } })).toBe(2)
  })

  it('a student with an open report whose booking has aged out is told they have no booking (403), not that they already reported', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource()
    await seedBooking(user.id, desk.id, -8 * DAY_MS, 'completed')
    await prisma.issueReport.create({ data: { userId: user.id, resourceId: desk.id, category: 'dirty' } })

    const res = await report(token, { resourceId: desk.id, category: 'dirty' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe(NOT_BOOKED)
  })

  it('category other without a note, a copy category and an unknown category are 400', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource()
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')
    const resourceId = desk.id
    const invalid: Array<[string, unknown]> = [
      ['no body', undefined],
      ['an empty body', {}],
      ['other without a note', { resourceId, category: 'other' }],
      ['other with an empty note', { resourceId, category: 'other', note: '' }],
      ['other with a blank note', { resourceId, category: 'other', note: '   \n ' }],
      ['other with a null note', { resourceId, category: 'other', note: null }],
      ['a copy category: damaged', { resourceId, category: 'damaged', note: 'Torn' }],
      ['a copy category: missing_pages', { resourceId, category: 'missing_pages' }],
      ['an unknown category', { resourceId, category: 'broken' }],
      ['no category', { resourceId, note: 'Broken' }],
      ['a number for the category', { resourceId, category: 3 }],
      ['no resource', { category: 'dirty' }],
      ['a blank resource id', { resourceId: '', category: 'dirty' }],
      ['a number for the resource id', { resourceId: 7, category: 'dirty' }],
      ['a note of 301 characters', { resourceId, category: 'dirty', note: 'x'.repeat(301) }],
      ['a note of 301 characters between spaces', { resourceId, category: 'dirty', note: ` ${'x'.repeat(301)} ` }],
      ['a note that is not text', { resourceId, category: 'dirty', note: 12 }],
    ]
    recorder = recordEvents()

    for (const [what, body] of invalid) {
      const res = await report(token, body)
      expect(res.status, what).toBe(400)
    }

    expect(await prisma.issueReport.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('the note is trimmed, at most 300 characters, and an empty one is none', async () => {
    const { user, token } = await seedUser()
    const resources = []
    for (let i = 0; i < 5; i++) {
      const resource = await seedResource()
      await seedBooking(user.id, resource.id, -HOUR_MS, 'checked_in')
      resources.push(resource.id)
    }

    const longest = await report(token, { resourceId: resources[0], category: 'dirty', note: ` ${'x'.repeat(300)} ` })
    const padded = await report(token, { resourceId: resources[1], category: 'other', note: '  Wobbly desk\n' })
    const empty = await report(token, { resourceId: resources[2], category: 'dirty', note: '   ' })
    const none = await report(token, { resourceId: resources[3], category: 'not_working' })
    const nullNote = await report(token, { resourceId: resources[4], category: 'not_working', note: null })

    for (const res of [longest, padded, empty, none, nullNote]) expect(res.status).toBe(201)
    const noteOf = async (resourceId: string) => (await prisma.issueReport.findFirstOrThrow({ where: { resourceId } })).note
    expect(await noteOf(resources[0])).toBe('x'.repeat(300))
    expect(await noteOf(resources[1])).toBe('Wobbly desk')
    expect(await noteOf(resources[2])).toBeNull()
    expect(await noteOf(resources[3])).toBeNull()
    expect(await noteOf(resources[4])).toBeNull()
  })

  it('401 without a token', async () => {
    const { user } = await seedUser()
    const desk = await seedResource()
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')
    const body = { resourceId: desk.id, category: 'dirty' }

    const anonymous = await request(app).post('/reports').send(body)
    const garbage = await request(app).post('/reports').set('Authorization', 'Bearer not-a-token').send(body)

    expect(anonymous.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(await prisma.issueReport.count()).toBe(0)
  })

  it('publishes attention.changed once, none on a refusal', async () => {
    const { user, token } = await seedUser()
    const desk = await seedResource()
    const unbooked = await seedResource()
    await seedBooking(user.id, desk.id, -HOUR_MS, 'checked_in')
    recorder = recordEvents()

    await report(token, { resourceId: unbooked.id, category: 'dirty' }) // 403
    await report(token, { resourceId: desk.id, category: 'other' }) // 400
    await request(app).post('/reports').send({ resourceId: desk.id, category: 'dirty' }) // 401
    expect(recorder.events).toEqual([])

    expect((await report(token, { resourceId: desk.id, category: 'dirty' })).status).toBe(201)
    expect(recorder.events).toEqual([ATTENTION_CHANGED])

    expect((await report(token, { resourceId: desk.id, category: 'dirty' })).status).toBe(409) // already reported
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
  })
})

// A copy is reported as it is returned: POST /loans/:id/return takes an optional
// `report`. The return itself (the loan, the fine, the copy) is covered in
// test/routes/loans.test.ts, and its races in test/services/lostLoanRaces.test.ts;
// here are the report's own rules.
describe('a copy reported as it is returned (POST /loans/:id/return)', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  const LOAN_CHANGED = { type: 'loan.changed', topics: ['metrics', 'catalogue'] }

  /** A copy of a new book out on loan to the student (the copy marked borrowed, as lending leaves it). */
  async function lendTo(userId: string, dueAt = new Date(Date.now() + 5 * DAY_MS)) {
    const copy = await seedCopy()
    await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
    const loan = await prisma.loan.create({ data: { userId, bookCopyId: copy.id, dueAt } })
    return { copy, loan }
  }
  /** The same copy lent to the student again, after it came back. */
  async function lendAgain(userId: string, copyId: string) {
    await prisma.bookCopy.update({ where: { id: copyId }, data: { status: 'borrowed' } })
    return prisma.loan.create({ data: { userId, bookCopyId: copyId, dueAt: new Date(Date.now() + 5 * DAY_MS) } })
  }
  const returnIt = (token: string, loanId: string, body?: object) => {
    const req = request(app).post(`/loans/${loanId}/return`).set(auth(token))
    return body === undefined ? req : req.send(body)
  }
  const reportsOnCopy = (copyId: string) => prisma.issueReport.findMany({ where: { bookCopyId: copyId } })

  it('category other without a note, a seat category, an unknown category and a 301-character note are 400', async () => {
    const { user, token } = await seedUser()
    const { copy, loan } = await lendTo(user.id)
    const invalid: Array<[string, unknown]> = [
      ['other without a note', { category: 'other' }],
      ['other with an empty note', { category: 'other', note: '' }],
      ['other with a blank note', { category: 'other', note: '   \n ' }],
      ['other with a null note', { category: 'other', note: null }],
      ['a seat category: not_working', { category: 'not_working', note: 'Broken' }],
      ['a seat category: dirty', { category: 'dirty' }],
      ['an unknown category', { category: 'torn' }],
      ['no category', { note: 'Torn' }],
      ['a number for the category', { category: 3 }],
      ['an empty report', {}],
      ['a report that is not an object', 'damaged'],
      ['a note of 301 characters', { category: 'damaged', note: 'x'.repeat(301) }],
      ['a note of 301 characters between spaces', { category: 'damaged', note: ` ${'x'.repeat(301)} ` }],
      ['a note that is not text', { category: 'damaged', note: 12 }],
    ]
    recorder = recordEvents()

    for (const [what, report] of invalid) {
      const res = await returnIt(token, loan.id, { report })
      expect(res.status, what).toBe(400)
    }

    // A refused body returns nothing: the loan is still out, the copy borrowed, no report, nothing announced.
    expect(await prisma.issueReport.count()).toBe(0)
    expect(recorder.events).toEqual([])
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ status: 'active', returnedAt: null })
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('borrowed')
    // The loan was never consumed: a valid body returns it.
    expect((await returnIt(token, loan.id, { report: { category: 'other', note: 'Water damage' } })).status).toBe(200)
    expect(await reportsOnCopy(copy.id)).toEqual([expect.objectContaining({ category: 'other', note: 'Water damage' })])
  }, 60_000)

  it('the note is trimmed, at most 300 characters, and an empty one is none', async () => {
    const { user, token } = await seedUser()
    const cases: Array<[string, { category: string; note?: string | null }, string | null]> = [
      ['300 characters between spaces', { category: 'damaged', note: ` ${'x'.repeat(300)} ` }, 'x'.repeat(300)],
      ['other with a padded note', { category: 'other', note: '  Water damage\n' }, 'Water damage'],
      ['a blank note', { category: 'damaged', note: '   ' }, null],
      ['no note', { category: 'missing_pages' }, null],
      ['a null note', { category: 'missing_pages', note: null }, null],
    ]
    const lent = []
    for (const _ of cases) lent.push(await lendTo(user.id))

    for (const [i, [what, report]] of cases.entries()) {
      const res = await returnIt(token, lent[i].loan.id, { report })
      expect(res.status, what).toBe(200)
    }

    for (const [i, [what, report, stored]] of cases.entries()) {
      const [row] = await reportsOnCopy(lent[i].copy.id)
      expect(row.note, what).toBe(stored)
      expect(row.category, what).toBe(report.category)
    }
  }, 60_000)

  it('an existing open report by the same student on the copy is kept and the return succeeds', async () => {
    const { user, token } = await seedUser()
    const { copy, loan } = await lendTo(user.id)
    expect((await returnIt(token, loan.id, { report: { category: 'damaged', note: 'First time' } })).status).toBe(200)
    const [first] = await reportsOnCopy(copy.id)
    // The copy goes out to the same student again, still with their report open (the librarian has not looked yet).
    const again = await lendAgain(user.id, copy.id)
    recorder = recordEvents()

    const res = await returnIt(token, again.id, { report: { category: 'other', note: 'Second time' } })

    // The return went through whole: the loan, the copy, and the answer.
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: again.id, status: 'returned' })
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('returned')
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
    // The first report stands unchanged, and no second row was written.
    expect(await reportsOnCopy(copy.id)).toEqual([first])
    // The return is announced; no report was created, so nothing is said about one.
    expect(recorder.events).toEqual([LOAN_CHANGED])
  }, 60_000)

  it('another student\'s open report, the same student\'s closed ones and their open one on another copy do not stop a report', async () => {
    const { user, token } = await seedUser()
    const { user: other } = await seedUser()
    const { user: librarian } = await seedUser('admin')
    const sharedCopy = await lendTo(user.id)
    await prisma.issueReport.create({ data: { userId: other.id, bookCopyId: sharedCopy.copy.id, category: 'damaged' } })
    const confirmedCopy = await lendTo(user.id)
    const dismissedCopy = await lendTo(user.id)
    const resolved = { resolvedById: librarian.id, resolvedAt: new Date(), resolutionNote: 'Checked' }
    await prisma.issueReport.create({ data: { userId: user.id, bookCopyId: confirmedCopy.copy.id, category: 'damaged', status: 'confirmed', ...resolved } })
    await prisma.issueReport.create({ data: { userId: user.id, bookCopyId: dismissedCopy.copy.id, category: 'damaged', status: 'dismissed', ...resolved } })
    const elsewhere = await lendTo(user.id)
    const withOpenElsewhere = await lendTo(user.id)
    await prisma.issueReport.create({ data: { userId: user.id, bookCopyId: elsewhere.copy.id, category: 'damaged' } })
    recorder = recordEvents()

    for (const { loan } of [sharedCopy, confirmedCopy, dismissedCopy, withOpenElsewhere]) {
      const res = await returnIt(token, loan.id, { report: { category: 'missing_pages' } })
      expect(res.status).toBe(200)
    }

    // Each return added its own open report beside whatever was there.
    expect(await prisma.issueReport.count({ where: { bookCopyId: sharedCopy.copy.id } })).toBe(2)
    expect(await prisma.issueReport.count({ where: { bookCopyId: confirmedCopy.copy.id, status: 'open' } })).toBe(1)
    expect(await prisma.issueReport.count({ where: { bookCopyId: dismissedCopy.copy.id, status: 'open' } })).toBe(1)
    expect(await prisma.issueReport.count({ where: { bookCopyId: withOpenElsewhere.copy.id, status: 'open' } })).toBe(1)
    expect(await prisma.issueReport.count({ where: { userId: user.id, status: 'open' } })).toBe(5) // 4 new + the one on another copy
    expect(recorder.events.filter((e) => e.type === 'attention.changed')).toEqual([ATTENTION_CHANGED, ATTENTION_CHANGED, ATTENTION_CHANGED, ATTENTION_CHANGED])
  }, 60_000)

  it('attention.changed is published once after a report, none otherwise', async () => {
    const { user, token } = await seedUser()
    const onTime = await lendTo(user.id)
    const withoutReport = await lendTo(user.id)
    const pastDue = await lendTo(user.id, new Date(Date.now() - 3 * DAY_MS - HOUR_MS))
    const refused = await lendTo(user.id)
    const types = () => (recorder?.events ?? []).map((e) => e.type).sort()

    // A report: one loan.changed and one attention.changed.
    recorder = recordEvents()
    expect((await returnIt(token, onTime.loan.id, { report: { category: 'damaged', note: 'Torn' } })).status).toBe(200)
    expect(types()).toEqual(['attention.changed', 'loan.changed'])
    expect(recorder.events).toContainEqual(ATTENTION_CHANGED)
    expect(recorder.events).toContainEqual(LOAN_CHANGED)
    recorder.stop()

    // No report: only the return.
    recorder = recordEvents()
    expect((await returnIt(token, withoutReport.loan.id)).status).toBe(200)
    expect(recorder.events).toEqual([LOAN_CHANGED])
    recorder.stop()

    // A past-due return with a report: still one of each (loan.changed carries its own topics for the fine).
    recorder = recordEvents()
    expect((await returnIt(token, pastDue.loan.id, { report: { category: 'missing_pages' } })).status).toBe(200)
    expect(types()).toEqual(['attention.changed', 'loan.changed'])
    expect(recorder.events).toContainEqual(ATTENTION_CHANGED)
    recorder.stop()

    // The same copy again with its report still open: the return is announced, no report is.
    const again = await lendAgain(user.id, onTime.copy.id)
    recorder = recordEvents()
    expect((await returnIt(token, again.id, { report: { category: 'damaged' } })).status).toBe(200)
    expect(recorder.events).toEqual([LOAN_CHANGED])
    recorder.stop()

    // Refusals announce nothing: an invalid report, a loan already returned, someone else's loan, an unknown one.
    const { token: strangerToken } = await seedUser()
    recorder = recordEvents()
    expect((await returnIt(token, refused.loan.id, { report: { category: 'other' } })).status).toBe(400)
    expect((await returnIt(token, onTime.loan.id, { report: { category: 'damaged' } })).status).toBe(409)
    expect((await returnIt(strangerToken, refused.loan.id, { report: { category: 'damaged' } })).status).toBe(403)
    expect((await returnIt(token, 'no-such-loan', { report: { category: 'damaged' } })).status).toBe(404)
    expect(recorder.events).toEqual([])
  }, 60_000)

  it('attention.changed is published after the report has committed', async () => {
    const { user, token } = await seedUser()
    const { copy, loan } = await lendTo(user.id)
    // Look at the database from another connection at the very moment the event is published.
    const seen: Array<Promise<{ reports: number; loan: string }>> = []
    const stop = subscribe((event) => {
      if (event.type !== 'attention.changed') return
      seen.push(
        Promise.all([prisma.issueReport.count({ where: { bookCopyId: copy.id } }), prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })]).then(
          ([reports, row]) => ({ reports, loan: row.status }),
        ),
      )
    })
    try {
      expect((await returnIt(token, loan.id, { report: { category: 'damaged' } })).status).toBe(200)
    } finally {
      stop()
    }

    expect(await Promise.all(seen)).toEqual([{ reports: 1, loan: 'returned' }])
  })
})

describe('the IssueReport table', () => {
  beforeEach(resetDb)

  it('the CHECK rejects a report with no target or two targets', async () => {
    const { user } = await seedUser()
    const desk = await seedResource()
    const copy = await seedCopy()

    const none = prisma.issueReport.create({ data: { userId: user.id, category: 'other', note: 'Aimless' } })
    const both = prisma.issueReport.create({ data: { userId: user.id, category: 'dirty', resourceId: desk.id, bookCopyId: copy.id } })

    await expect(none).rejects.toThrow(/IssueReport_exactly_one_target/)
    await expect(both).rejects.toThrow(/IssueReport_exactly_one_target/)
    expect(await prisma.issueReport.count()).toBe(0)
    // One target of either kind is fine.
    await prisma.issueReport.create({ data: { userId: user.id, category: 'dirty', resourceId: desk.id } })
    await prisma.issueReport.create({ data: { userId: user.id, category: 'damaged', bookCopyId: copy.id } })
    expect(await prisma.issueReport.count()).toBe(2)
  })

  it('a student has one open report per copy and one per resource, and a closed one does not count', async () => {
    const { user } = await seedUser()
    const { user: other } = await seedUser()
    const { user: librarian } = await seedUser('admin')
    const desk = await seedResource()
    const copy = await seedCopy()
    const open = (userId: string, target: { resourceId: string } | { bookCopyId: string }) =>
      prisma.issueReport.create({ data: { userId, category: 'resourceId' in target ? 'dirty' : 'damaged', ...target } })
    await open(user.id, { resourceId: desk.id })
    await open(user.id, { bookCopyId: copy.id })

    // Prisma names the fields of the violated unique index, which tells the two indexes apart.
    await expect(open(user.id, { resourceId: desk.id })).rejects.toThrow(/Unique constraint failed on the fields: \(.*userId.*resourceId.*\)/)
    await expect(open(user.id, { bookCopyId: copy.id })).rejects.toThrow(/Unique constraint failed on the fields: \(.*userId.*bookCopyId.*\)/)

    // Another student's open report on the same target is no obstacle...
    await open(other.id, { resourceId: desk.id })
    await open(other.id, { bookCopyId: copy.id })
    // ...and once the student's own is closed, a new one may be opened (and then closed again, any number of times).
    const resolved = { resolvedById: librarian.id, resolvedAt: new Date() }
    await prisma.issueReport.updateMany({ where: { userId: user.id }, data: { status: 'dismissed', ...resolved } })
    await open(user.id, { resourceId: desk.id })
    await open(user.id, { bookCopyId: copy.id })
    await prisma.issueReport.updateMany({ where: { userId: user.id, status: 'open' }, data: { status: 'confirmed', ...resolved } })
    await open(user.id, { resourceId: desk.id })
    await open(user.id, { bookCopyId: copy.id })

    expect(await prisma.issueReport.count({ where: { userId: user.id } })).toBe(6)
    expect(await prisma.issueReport.count({ where: { userId: user.id, status: 'open' } })).toBe(2)
  })

  it('deleting the librarian who resolved a report keeps the report', async () => {
    const { user } = await seedUser()
    const { user: librarian } = await seedUser('admin')
    const desk = await seedResource()
    const row = await prisma.issueReport.create({
      data: { userId: user.id, resourceId: desk.id, category: 'dirty', status: 'dismissed', resolvedById: librarian.id, resolvedAt: new Date() },
    })

    await prisma.user.delete({ where: { id: librarian.id } })

    expect(await prisma.issueReport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'dismissed', resolvedById: null })
  })
})
