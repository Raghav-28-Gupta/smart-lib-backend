import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('approving a room request books the slot; declining one frees it', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const { token: other } = await seedUser()
    const room = await prisma.resource.create({ data: { type: 'room', name: 'Group Room 201' } })
    const approvedId = await askForRoom(student, room.id, 10)
    const declinedId = await askForRoom(student, room.id, 14)
    recorder = recordEvents()

    expect((await approve(admin, 'room', approvedId)).status).toBe(200)
    expect((await decline(admin, 'room', declinedId)).status).toBe(200)

    const mine = await request(app).get('/bookings/me').set('Authorization', `Bearer ${student}`)
    expect(mine.body.map((b: { frontendStatus: string }) => b.frontendStatus)).toEqual(['upcomingFar', 'declined'])
    expect((await requestRoom(other, room.id, 14)).status).toBe(201)
    expect((await requestRoom(other, room.id, 10)).status).toBe(409)
    expect(recorder.events.slice(0, 2)).toEqual([
      { type: 'request.decided', topics: ['requests', 'metrics'], kind: 'room' },
      { type: 'request.decided', topics: ['requests'], kind: 'room' },
    ])
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
