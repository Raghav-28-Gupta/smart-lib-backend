import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

async function seedUser(role: 'student' | 'admin' = 'student', name = `${role} ${Math.random()}`) {
  const user = await prisma.user.create({
    data: { name, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

async function seedBook(available: number, total = available) {
  const book = await prisma.book.create({
    data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: total },
  })
  await prisma.bookCopy.createMany({
    data: Array.from({ length: total }, (_, i) => ({ bookId: book.id, status: i < available ? ('available' as const) : ('borrowed' as const) })),
  })
  return book
}

function tomorrowAt(hour: number) {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d
}

async function askToBorrow(token: string, bookId: string): Promise<string> {
  const res = await request(app).post('/borrow-requests').set('Authorization', `Bearer ${token}`).send({ bookId })
  expect(res.status).toBe(201)
  return res.body.id
}

function requestRoom(token: string, resourceId: string, hour: number) {
  return request(app)
    .post('/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({ resourceId, startTime: tomorrowAt(hour).toISOString(), endTime: tomorrowAt(hour + 1).toISOString() })
}

async function askForRoom(token: string, resourceId: string, hour = 14): Promise<string> {
  const res = await requestRoom(token, resourceId, hour)
  expect(res.status).toBe(201)
  return res.body.id
}

const approve = (token: string, kind: string, id: string) =>
  request(app).post(`/admin/requests/${kind}/${id}/approve`).set('Authorization', `Bearer ${token}`)
const decline = (token: string, kind: string, id: string, body: object = {}) =>
  request(app).post(`/admin/requests/${kind}/${id}/decline`).set('Authorization', `Bearer ${token}`).send(body)

describe('GET /admin/requests', () => {
  beforeEach(resetDb)

  it('is for admins only', async () => {
    const { token } = await seedUser()
    expect((await request(app).get('/admin/requests')).status).toBe(401)
    expect((await request(app).get('/admin/requests').set('Authorization', `Bearer ${token}`)).status).toBe(403)
  })

  it('lists pending borrow and room requests, oldest first, with counts', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: aditi, token: aditiToken } = await seedUser('student', 'Aditi Sharma')
    const { user: rohan, token: rohanToken } = await seedUser('student', 'Rohan Verma')
    const book = await seedBook(2, 4)
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201', location: 'Group study rooms' } })
    const borrowId = await askToBorrow(aditiToken, book.id)
    const roomId = await askForRoom(rohanToken, room.id)

    const res = await request(app).get('/admin/requests').set('Authorization', `Bearer ${admin}`)

    expect(res.status).toBe(200)
    expect(res.body.counts).toEqual({ all: 2, borrow: 1, room: 1 })
    expect(res.body.requests[0]).toMatchObject({
      id: borrowId,
      kind: 'borrow',
      student: { id: aditi.id, name: 'Aditi Sharma', email: aditi.email },
      book: { id: book.id, title: 'Clean Code', author: 'Robert C. Martin', availableCopies: 1, totalCopies: 4 },
    })
    expect(res.body.requests[1]).toMatchObject({
      id: roomId,
      kind: 'room',
      student: { id: rohan.id, name: 'Rohan Verma' },
      expiresAt: new Date(tomorrowAt(14).getTime() + 15 * MINUTE_MS).toISOString(),
      room: {
        resourceId: room.id,
        name: 'Group Room 201',
        location: 'Group study rooms',
        startTime: tomorrowAt(14).toISOString(),
        endTime: tomorrowAt(15).toISOString(),
      },
    })
  })

  it("shows a request's book total from its copies that are not lost", async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    // The Book.totalCopies column says 99; the copies say 3 on the shelf plus 2 lost.
    const book = await prisma.book.create({
      data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Robert C. Martin', totalCopies: 99 },
    })
    await prisma.bookCopy.createMany({
      data: [...Array(3).fill('available'), ...Array(2).fill('lost')].map((status) => ({ bookId: book.id, status })),
    })
    await askToBorrow(student, book.id)

    const res = await request(app).get('/admin/requests').set('Authorization', `Bearer ${admin}`)

    expect(res.body.requests[0].book).toMatchObject({ availableCopies: 2, totalCopies: 3 })
  })
})

// Slice 7: a scored room request is listed up to 72 minutes later than its request time says (the
// bounded priority); nothing is hidden, declined or expired because of it. Rows are made directly so each
// one gets its own request time and score; scoring itself is off under test.
describe('GET /admin/requests: bounded priority', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
    vi.restoreAllMocks()
  })

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS)
  const list = (token: string, query = '') => request(app).get(`/admin/requests${query}`).set('Authorization', `Bearer ${token}`)
  const idsOf = (res: { body: { requests: { id: string }[] } }) => res.body.requests.map((r) => r.id)
  type Listed = { id: string; kind: string; expiresAt: string; room?: { priority?: { suggestedDelayMinutes: number; riskPercent: number | null } } }
  const byId = (res: { body: { requests: Listed[] } }) => Object.fromEntries(res.body.requests.map((r) => [r.id, r]))

  async function pendingBorrow(userId: string, requestedAt: Date) {
    const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Sapiens', author: 'Harari', totalCopies: 1 } })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'requested' } })
    return prisma.borrowRequest.create({
      data: { userId, bookId: book.id, bookCopyId: copy.id, requestedAt, expiresAt: new Date(Date.now() + 24 * HOUR_MS) },
    })
  }

  // `probability` undefined: no NoShowEvent at all; null or a number: an event with that predictedProbability.
  async function roomRequest(userId: string, requestedAt: Date, priorityScore: number | null, probability?: number | null) {
    const resource = await prisma.resource.create({ data: { type: 'room', name: `Room ${Math.random()}` } })
    const booking = await prisma.resourceBooking.create({
      data: { userId, resourceId: resource.id, startTime: tomorrowAt(14), endTime: tomorrowAt(15), status: 'requested', requestedAt, priorityScore },
    })
    if (probability !== undefined) {
      await prisma.noShowEvent.create({ data: { resourceBookingId: booking.id, userId, predictedProbability: probability } })
    }
    return booking
  }

  it('a room request with priorityScore 0.8 sits at most 72 minutes later than its request time says', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const penalised = await roomRequest(user.id, minutesAgo(100), 0.8) // sorts as if requested 28 minutes ago
    const before = await roomRequest(user.id, minutesAgo(60), null)
    const seventyAfter = await roomRequest(user.id, minutesAgo(30), null) // 70 minutes after it: now ahead of it
    const seventyFiveAfter = await roomRequest(user.id, minutesAgo(25), null) // 75 minutes after it: still behind it
    const last = await roomRequest(user.id, minutesAgo(10), null)

    const res = await list(admin)

    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual([before.id, seventyAfter.id, penalised.id, seventyFiveAfter.id, last.id])
    expect(byId(res)[penalised.id].room?.priority).toEqual({ suggestedDelayMinutes: 72, riskPercent: null })
  })

  it('a null score changes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const first = await roomRequest(user.id, minutesAgo(50), null)
    const borrow = await pendingBorrow(user.id, minutesAgo(35))
    const last = await roomRequest(user.id, minutesAgo(20), null, 0.4) // an event with no score does not count either

    const suggested = await list(admin)
    const plain = await list(admin, '?order=request')

    expect(idsOf(suggested)).toEqual([first.id, borrow.id, last.id])
    expect(idsOf(plain)).toEqual(idsOf(suggested))
    for (const entry of Object.values(byId(suggested))) expect(entry.room ?? {}).not.toHaveProperty('priority')
  })

  it('borrow requests are never reordered by priority', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const b1 = await pendingBorrow(user.id, minutesAgo(90))
    const b2 = await pendingBorrow(user.id, minutesAgo(60))
    const b3 = await pendingBorrow(user.id, minutesAgo(30))
    const penalised = await roomRequest(user.id, minutesAgo(80), 0.8) // sorts as if requested 8 minutes ago: after every borrow

    const suggested = await list(admin)

    expect(idsOf(suggested)).toEqual([b1.id, b2.id, b3.id, penalised.id])
    expect(idsOf(await list(admin, '?order=request'))).toEqual([b1.id, penalised.id, b2.id, b3.id])
    for (const id of [b1.id, b2.id, b3.id]) expect(byId(suggested)[id]).not.toHaveProperty('room')
  })

  it('order=request returns plain request-time order', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const penalised = await roomRequest(user.id, minutesAgo(100), 0.8)
    const other = await roomRequest(user.id, minutesAgo(60), null)

    expect(idsOf(await list(admin, '?order=suggested'))).toEqual([other.id, penalised.id])
    expect(idsOf(await list(admin))).toEqual([other.id, penalised.id]) // suggested is the default
    expect(idsOf(await list(admin, '?order=request'))).toEqual([penalised.id, other.id])
  })

  it('a priority never hides, declines or expires a request', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const borrow = await pendingBorrow(user.id, minutesAgo(30))
    const rooms = [
      await roomRequest(user.id, minutesAgo(100), 0.8, 0.9),
      await roomRequest(user.id, minutesAgo(90), 0.8, 0.9),
      await roomRequest(user.id, minutesAgo(80), 0.85, 0.5),
    ]
    recorder = recordEvents()

    for (const query of ['', '?order=suggested', '?order=request']) {
      const res = await list(admin, query)
      expect(res.body.counts).toEqual({ all: 4, borrow: 1, room: 3 })
      expect(idsOf(res).sort()).toEqual([borrow.id, ...rooms.map((r) => r.id)].sort())
    }
    // Still open, with the same deadline (start plus the 15-minute grace period), and nothing was published.
    const rows = await prisma.resourceBooking.findMany({ where: { id: { in: rooms.map((r) => r.id) } } })
    expect(rows.map((r) => [r.status, r.declineReason, r.decidedAt])).toEqual(rows.map(() => ['requested', null, null]))
    expect((await prisma.borrowRequest.findUniqueOrThrow({ where: { id: borrow.id } })).status).toBe('pending')
    const listed = byId(await list(admin))
    for (const room of rooms) expect(listed[room.id].expiresAt).toBe(new Date(tomorrowAt(14).getTime() + 15 * MINUTE_MS).toISOString())
    expect(recorder.events).toEqual([])
  })

  it('a score above 1 or below 0.8 in the database is clamped when read', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const high = await roomRequest(user.id, minutesAgo(40), 5)
    const low = await roomRequest(user.id, minutesAgo(100), -3) // sorts as if requested 28 minutes ago, not a day later
    const inRange = await roomRequest(user.id, minutesAgo(60), 0.9)
    const belowCap = await roomRequest(user.id, minutesAgo(90), 0.5)

    const res = await list(admin)

    const minutes = (id: string) => byId(res)[id].room?.priority?.suggestedDelayMinutes
    expect([minutes(high.id), minutes(low.id), minutes(inRange.id), minutes(belowCap.id)]).toEqual([0, 72, 36, 72])
    // keys: belowCap -18, high -40, low -28, inRange -24
    expect(idsOf(res)).toEqual([high.id, low.id, inRange.id, belowCap.id])
  })

  it('the order is stable and deterministic for equal keys', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const t = minutesAgo(100)
    const t36 = new Date(t.getTime() + 36 * MINUTE_MS)
    const earlier = await roomRequest(user.id, t, 0.9) // key t + 36 minutes
    const ties = [await roomRequest(user.id, t36, null), await roomRequest(user.id, t36, null), await roomRequest(user.id, t36, 1)]
    // Equal key: the earlier real request time first, then the id.
    const expected = [earlier.id, ...ties.map((r) => r.id).sort()]

    const first = await list(admin)
    const second = await list(admin)
    const plain = await list(admin, '?order=request')

    expect(idsOf(first)).toEqual(expected)
    expect(idsOf(second)).toEqual(expected)
    expect(idsOf(plain)).toEqual(expected) // the same tie-break in plain order
  })

  it('riskPercent comes from the NoShowEvent', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const scored = await roomRequest(user.id, minutesAgo(50), 0.9, 0.314)
    const rounded = await roomRequest(user.id, minutesAgo(49), 0.9, 0.375) // 37.5 rounds up
    const noProbability = await roomRequest(user.id, minutesAgo(48), 0.9, null)
    const noEvent = await roomRequest(user.id, minutesAgo(47), 0.9)
    const noScore = await roomRequest(user.id, minutesAgo(46), null, 0.5) // an event alone gives no priority

    const listed = byId(await list(admin))

    expect(listed[scored.id].room?.priority).toEqual({ suggestedDelayMinutes: 36, riskPercent: 31 })
    expect(listed[rounded.id].room?.priority).toEqual({ suggestedDelayMinutes: 36, riskPercent: 38 })
    expect(listed[noProbability.id].room?.priority).toEqual({ suggestedDelayMinutes: 36, riskPercent: null })
    expect(listed[noEvent.id].room?.priority).toEqual({ suggestedDelayMinutes: 36, riskPercent: null })
    expect(listed[noScore.id].room).not.toHaveProperty('priority')
  })

  it('loads the events with the room requests, not one query per request', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    for (let i = 0; i < 3; i++) await roomRequest(user.id, minutesAgo(50 + i), 0.9, 0.3)
    const spies = [
      vi.spyOn(prisma.noShowEvent, 'findUnique'),
      vi.spyOn(prisma.noShowEvent, 'findFirst'),
      vi.spyOn(prisma.noShowEvent, 'findMany'),
    ]

    const res = await list(admin)

    expect(res.body.requests.map((r: Listed) => r.room?.priority?.riskPercent)).toEqual([30, 30, 30])
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    // Control: the spies do see a call made through the same client.
    await prisma.noShowEvent.findMany()
    expect(spies[2]).toHaveBeenCalledTimes(1)
  })

  it('answers 400 for an unknown ?order=', async () => {
    const { token: admin } = await seedUser('admin')

    for (const query of ['?order=newest', '?order=', '?order=REQUEST', '?order=request&order=suggested']) {
      expect([query, (await list(admin, query)).status]).toEqual([query, 400])
    }
    expect((await list(admin, '?order=request')).status).toBe(200)
    expect((await list(admin, '?order=suggested')).status).toBe(200)
  })
})

describe('deciding requests', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('approving a borrow request starts the loan now and marks the copy borrowed', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const book = await seedBook(1)
    const id = await askToBorrow(student, book.id)
    recorder = recordEvents()

    const res = await approve(admin, 'borrow', id)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id, kind: 'borrow', status: 'approved' })
    const loans = await request(app).get('/loans/me').set('Authorization', `Bearer ${student}`)
    expect(loans.body).toHaveLength(1)
    expect(new Date(loans.body[0].dueAt).getTime() - Date.now()).toBeGreaterThan(13.9 * 24 * HOUR_MS)
    expect(await prisma.bookCopy.count({ where: { bookId: book.id, status: 'borrowed' } })).toBe(1)
    expect((await prisma.borrowRequest.findUniqueOrThrow({ where: { id } })).loanId).toBe(loans.body[0].id)
    expect(recorder.events).toEqual([{ type: 'request.decided', topics: ['requests', 'metrics'], kind: 'borrow' }])
    expect((await request(app).get('/admin/requests').set('Authorization', `Bearer ${admin}`)).body.counts.all).toBe(0)
  })

  it('declining a borrow request keeps the trimmed reason and passes the copy to the waitlist', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const { user: waiter } = await seedUser()
    const book = await seedBook(1)
    const id = await askToBorrow(student, book.id)
    await prisma.reservation.create({ data: { userId: waiter.id, bookId: book.id, status: 'waiting' } })
    recorder = recordEvents()

    const res = await decline(admin, 'borrow', id, { reason: '  Reserved for a course  ' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('declined')
    const mine = await request(app).get('/borrow-requests/me').set('Authorization', `Bearer ${student}`)
    expect(mine.body[0]).toMatchObject({ status: 'declined', declineReason: 'Reserved for a course' })
    expect((await prisma.reservation.findFirstOrThrow({ where: { userId: waiter.id } })).status).toBe('fulfilled')
    expect(recorder.events).toEqual([{ type: 'request.decided', topics: ['requests'], kind: 'borrow' }])
  })

  it('treats a blank reason as none, and refuses one over 300 characters', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const first = await askToBorrow(student, (await seedBook(1)).id)
    const second = await askToBorrow(student, (await seedBook(1)).id)

    expect((await decline(admin, 'borrow', first, { reason: '   ' })).status).toBe(200)
    expect((await prisma.borrowRequest.findUniqueOrThrow({ where: { id: first } })).declineReason).toBeNull()
    expect((await decline(admin, 'borrow', second, { reason: 'x'.repeat(301) })).status).toBe(400)
  })

  it('declines with no request body at all, keeping no reason', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const id = await askToBorrow(student, (await seedBook(1)).id)

    const res = await request(app).post(`/admin/requests/borrow/${id}/decline`).set('Authorization', `Bearer ${admin}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('declined')
    const row = await prisma.borrowRequest.findUniqueOrThrow({ where: { id } })
    expect([row.status, row.declineReason]).toEqual(['declined', null])
  })

  it('approving a room request books the slot; declining one frees it', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const { token: other } = await seedUser()
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201' } })
    const approvedId = await askForRoom(student, room.id, 10)
    const declinedId = await askForRoom(student, room.id, 14)

    expect((await approve(admin, 'room', approvedId)).status).toBe(200)
    expect((await decline(admin, 'room', declinedId)).status).toBe(200)

    const mine = await request(app).get('/bookings/me').set('Authorization', `Bearer ${student}`)
    expect(mine.body.map((b: { frontendStatus: string }) => b.frontendStatus)).toEqual(['upcomingFar', 'declined'])
    expect((await requestRoom(other, room.id, 14)).status).toBe(201)
    expect((await requestRoom(other, room.id, 10)).status).toBe(409)
  })

  it('approving a room request publishes request.decided with topics requests, metrics and bookings', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201' } })
    const id = await askForRoom(student, room.id, 10)
    recorder = recordEvents()

    expect((await approve(admin, 'room', id)).status).toBe(200)

    expect(recorder.events).toEqual([{ type: 'request.decided', topics: ['requests', 'metrics', 'bookings'], kind: 'room' }])
  })

  it('declining a room request publishes request.decided without the bookings topic', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201' } })
    const id = await askForRoom(student, room.id, 14)
    recorder = recordEvents()

    expect((await decline(admin, 'room', id)).status).toBe(200)

    expect(recorder.events).toEqual([{ type: 'request.decided', topics: ['requests'], kind: 'room' }])
  })

  it('two librarians approving at once: one wins, the other is told who', async () => {
    const { token: a } = await seedUser('admin', 'Librarian A')
    const { token: b } = await seedUser('admin', 'Librarian B')
    const { token: student } = await seedUser()
    const id = await askToBorrow(student, (await seedBook(1)).id)

    const results = await Promise.all([approve(a, 'borrow', id), approve(b, 'borrow', id)])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)!.body.error).toMatch(/^Already approved by Librarian (A|B)\.$/)
    expect(await prisma.loan.count()).toBe(1)
  })

  it('deciding a settled request says what happened', async () => {
    const { token: admin } = await seedUser('admin', 'Librarian One')
    const { token: student } = await seedUser()
    const approvedId = await askToBorrow(student, (await seedBook(1)).id)
    const declinedId = await askToBorrow(student, (await seedBook(1)).id)
    const withdrawnId = await askToBorrow(student, (await seedBook(1)).id)
    await approve(admin, 'borrow', approvedId)
    await decline(admin, 'borrow', declinedId)
    await request(app).post(`/borrow-requests/${withdrawnId}/cancel`).set('Authorization', `Bearer ${student}`)

    expect((await decline(admin, 'borrow', approvedId)).body.error).toBe('Already approved by Librarian One.')
    expect((await approve(admin, 'borrow', declinedId)).body.error).toBe('Already declined by Librarian One.')
    expect((await approve(admin, 'borrow', withdrawnId)).body.error).toBe('The student withdrew this request.')
  }, 30_000)

  it('approving after the deadline lapses the request instead', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Sapiens', author: 'Harari', totalCopies: 1 } })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'requested' } })
    const lapsed = await prisma.borrowRequest.create({
      data: { userId: user.id, bookId: book.id, bookCopyId: copy.id, requestedAt: new Date(Date.now() - 25 * HOUR_MS), expiresAt: new Date(Date.now() - HOUR_MS) },
    })
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Room 9' } })
    const start = new Date(Date.now() - 20 * MINUTE_MS)
    const lapsedRoom = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: room.id, startTime: start, endTime: new Date(start.getTime() + HOUR_MS), status: 'requested' },
    })

    const borrow = await approve(admin, 'borrow', lapsed.id)
    const roomRes = await approve(admin, 'room', lapsedRoom.id)

    expect([borrow.status, borrow.body.error]).toEqual([409, 'This request expired.'])
    expect([roomRes.status, roomRes.body.error]).toEqual([409, 'This request expired.'])
    expect((await prisma.bookCopy.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe('available')
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: lapsedRoom.id } })).status).toBe('expired')
    expect(await prisma.loan.count()).toBe(0)
  })

  it('answers 404 for an unknown request or a seat booking, and 400 for an unknown kind', async () => {
    const { token: admin } = await seedUser('admin')
    const { user } = await seedUser()
    const seat = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const seatBooking = await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: seat.id, startTime: tomorrowAt(9), endTime: tomorrowAt(10) },
    })

    const unknown = await approve(admin, 'borrow', 'no-such-request')
    expect([unknown.status, unknown.body.error]).toEqual([404, 'Request not found'])
    expect((await approve(admin, 'room', seatBooking.id)).status).toBe(404)
    expect((await approve(admin, 'loan', 'x')).status).toBe(400)
  })
})
