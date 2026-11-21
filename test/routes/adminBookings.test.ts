import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { BookingStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { cancelBookingAsLibrary, listBookings } from '../../src/services/adminBookingService'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

async function seedUser(role: 'student' | 'admin' = 'student', extra: { name?: string; email?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@test.com`,
      passwordHash: 'x',
      role,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

let resourceCounter = 0
function seedResource(
  name = `Desk ${++resourceCounter}`,
  type: 'seat' | 'room' = 'seat',
  extra: { status?: 'available' | 'offline'; location?: string; capacity?: number } = {},
) {
  return prisma.resource.create({ data: { type, name, capacity: extra.capacity ?? 1, status: extra.status, location: extra.location } })
}

interface BookingSeed {
  userId: string
  /** Times are offsets in ms from `base`. */
  start: number
  end: number
  status?: BookingStatus
  graceMinutes?: number
  resourceId?: string
  cancelledById?: string
  cancelReason?: string
  movedFromName?: string
}

// Each booking gets a resource of its own unless one is given, so seeding never
// trips the no_overlapping_bookings constraint.
async function seedBooking(base: number, seed: BookingSeed) {
  const resourceId = seed.resourceId ?? (await seedResource()).id
  return prisma.resourceBooking.create({
    data: {
      userId: seed.userId,
      resourceId,
      startTime: new Date(base + seed.start),
      endTime: new Date(base + seed.end),
      status: seed.status ?? 'booked',
      ...(seed.graceMinutes !== undefined && { gracePeriodMinutes: seed.graceMinutes }),
      ...(seed.cancelledById && { cancelledById: seed.cancelledById, cancelledAt: new Date(base) }),
      ...(seed.cancelReason && { cancelReason: seed.cancelReason }),
      ...(seed.movedFromName && { movedFromName: seed.movedFromName, movedAt: new Date(base) }),
    },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const list = (token: string, query = '') => request(app).get(`/admin/bookings${query}`).set(auth(token))

interface ListedBooking {
  id: string
  resource: { id: string; name: string; type: string }
  student: { id: string; name: string; email: string }
  startTime: string
  endTime: string
  status: string
  cancelledBy: string | null
  cancelReason: string | null
  movedFromName: string | null
  canManage: boolean
}

const ids = (res: request.Response) => (res.body.bookings as ListedBooking[]).map((b) => b.id)

describe('admin bookings list', () => {
  beforeEach(resetDb)

  it('is for admins only', async () => {
    const { token: student } = await seedUser()

    const anonymous = await request(app).get('/admin/bookings')
    const asStudent = await list(student)

    expect(anonymous.status).toBe(401)
    expect(asStudent.status).toBe(403)
  })

  it('returns the booking with its resource and student in the documented shape', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const room = await seedResource('Group Room 201', 'room')
    const now = Date.now()
    const booking = await seedBooking(now, { userId: student.id, resourceId: room.id, start: HOUR_MS, end: 2 * HOUR_MS, movedFromName: 'Group Room 101' })

    const res = await list(admin)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      bookings: [
        {
          id: booking.id,
          resource: { id: room.id, name: 'Group Room 201', type: 'room' },
          student: { id: student.id, name: 'Asha Rao', email: 'asha@test.com' },
          startTime: new Date(now + HOUR_MS).toISOString(),
          endTime: new Date(now + 2 * HOUR_MS).toISOString(),
          status: 'booked',
          cancelledBy: null,
          cancelReason: null,
          movedFromName: 'Group Room 101',
          canManage: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    })
  })

  it('excludes room requests, declined and expired rows', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const shown = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    for (const status of ['requested', 'declined', 'expired', 'no_show'] as const) {
      await seedBooking(now, { userId: student.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS, status })
    }

    const res = await list(admin)

    expect(ids(res)).toEqual([shown.id])
    expect(res.body.total).toBe(1)
  })

  it('derives booked, released, checked_in and completed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const seeds: Array<[string, BookingSeed]> = [
      ['booked, starts later', { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS }],
      ['booked, inside its grace period', { userId: student.id, start: -5 * MINUTE_MS, end: 55 * MINUTE_MS }],
      ['booked, grace period over', { userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS }],
      ['stored released', { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'released' }],
      ['checked in, still running', { userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' }],
      ['checked in, over', { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'checked_in' }],
      ['stored completed', { userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' }],
    ]
    const byId = new Map<string, string>()
    for (const [label, seed] of seeds) byId.set((await seedBooking(now, seed)).id, label)

    const res = await list(admin)

    const statusByLabel = Object.fromEntries((res.body.bookings as ListedBooking[]).map((b) => [byId.get(b.id), b.status]))
    expect(statusByLabel).toEqual({
      'booked, starts later': 'booked',
      'booked, inside its grace period': 'booked',
      'booked, grace period over': 'released',
      'stored released': 'released',
      'checked in, still running': 'checked_in',
      'checked in, over': 'completed',
      'stored completed': 'completed',
    })
  })

  it('a booking exactly at the end of its grace period is still booked and one millisecond later is released', async () => {
    const { user: student } = await seedUser()
    const start = Date.now() + HOUR_MS
    const booking = await seedBooking(start, { userId: student.id, start: 0, end: HOUR_MS, graceMinutes: 20 })
    const graceEnd = start + 20 * MINUTE_MS

    const atEnd = await listBookings({ page: 1, pageSize: 25 }, new Date(graceEnd))
    const justAfter = await listBookings({ page: 1, pageSize: 25 }, new Date(graceEnd + 1))
    const justBefore = await listBookings({ page: 1, pageSize: 25 }, new Date(graceEnd - 1))

    expect(atEnd.bookings.map((b) => [b.id, b.status, b.canManage])).toEqual([[booking.id, 'booked', true]])
    expect(justBefore.bookings[0].status).toBe('booked')
    expect(justAfter.bookings.map((b) => [b.id, b.status, b.canManage])).toEqual([[booking.id, 'released', false]])
  })

  it('a checked-in booking exactly at its end is completed', async () => {
    const { user: student } = await seedUser()
    const start = Date.now() - 30 * MINUTE_MS
    const booking = await seedBooking(start, { userId: student.id, start: 0, end: HOUR_MS, status: 'checked_in' })
    const end = start + HOUR_MS

    const atEnd = await listBookings({ page: 1, pageSize: 25 }, new Date(end))
    const justBefore = await listBookings({ page: 1, pageSize: 25 }, new Date(end - 1))

    expect(atEnd.bookings.map((b) => [b.id, b.status])).toEqual([[booking.id, 'completed']])
    expect(justBefore.bookings.map((b) => [b.id, b.status])).toEqual([[booking.id, 'checked_in']])
  })

  it('shows who cancelled: student or library, with the reason', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const own = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled' })
    const withReason = await seedBooking(now, {
      userId: student.id,
      start: 3 * HOUR_MS,
      end: 4 * HOUR_MS,
      status: 'cancelled',
      cancelledById: librarian.id,
      cancelReason: 'Room closed for repairs',
    })
    const noReason = await seedBooking(now, { userId: student.id, start: 5 * HOUR_MS, end: 6 * HOUR_MS, status: 'cancelled', cancelledById: librarian.id })

    const res = await list(admin)

    const byId = new Map((res.body.bookings as ListedBooking[]).map((b) => [b.id, b]))
    expect(byId.get(own.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'student', cancelReason: null, canManage: false })
    expect(byId.get(withReason.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'library', cancelReason: 'Room closed for repairs', canManage: false })
    expect(byId.get(noReason.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'library', cancelReason: null })
  })

  it('status filter works on the derived status', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const booked = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const released = await seedBooking(now, { userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS })
    const checkedIn = await seedBooking(now, { userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' })
    const finished = await seedBooking(now, { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'checked_in' })
    const completed = await seedBooking(now, { userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' })
    const cancelled = await seedBooking(now, { userId: student.id, start: 4 * HOUR_MS, end: 5 * HOUR_MS, status: 'cancelled' })

    const byStatus = async (status: string) => {
      const res = await list(admin, `?status=${status}`)
      expect(res.status).toBe(200)
      return { ids: ids(res).sort(), total: res.body.total }
    }

    expect(await byStatus('booked')).toEqual({ ids: [booked.id], total: 1 })
    expect(await byStatus('released')).toEqual({ ids: [released.id], total: 1 })
    expect(await byStatus('checked_in')).toEqual({ ids: [checkedIn.id], total: 1 })
    expect(await byStatus('completed')).toEqual({ ids: [finished.id, completed.id].sort(), total: 2 })
    expect(await byStatus('cancelled')).toEqual({ ids: [cancelled.id], total: 1 })
    expect((await list(admin, '?status=no_show')).status).toBe(400)
    expect((await list(admin, '?status=requested')).status).toBe(400)
  })

  it('search matches student, email and resource names, ignoring case', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao', email: 'asha.rao@test.com' })
    const { user: ben } = await seedUser('student', { name: 'Ben Carter', email: 'bcarter@mail.example' })
    const { user: dev } = await seedUser('student', { name: 'Dev Patel', email: 'dev@test.com' })
    const now = Date.now()
    const deskA = await seedResource('Quiet Desk 7')
    const roomB = await seedResource('Group Room 201', 'room')
    const ashaBooking = await seedBooking(now, { userId: asha.id, resourceId: deskA.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const benBooking = await seedBooking(now, { userId: ben.id, resourceId: roomB.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS })
    const devBooking = await seedBooking(now, { userId: dev.id, start: 5 * HOUR_MS, end: 6 * HOUR_MS })

    expect(ids(await list(admin, '?search=ASHA%20RAO'))).toEqual([ashaBooking.id])
    expect(ids(await list(admin, '?search=BCARTER@MAIL'))).toEqual([benBooking.id])
    expect(ids(await list(admin, '?search=group%20room'))).toEqual([benBooking.id])
    expect(ids(await list(admin, '?search=quiet'))).toEqual([ashaBooking.id])
    // A substring match: "test.com" is in two emails.
    expect(ids(await list(admin, '?search=TEST.COM')).sort()).toEqual([ashaBooking.id, devBooking.id].sort())
    const none = await list(admin, '?search=nobody')
    expect(none.status).toBe(200)
    expect(none.body).toMatchObject({ bookings: [], total: 0 })
  })

  it('search is trimmed and capped at 100 characters', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao' })
    const booking = await seedBooking(Date.now(), { userId: asha.id, start: HOUR_MS, end: 2 * HOUR_MS })

    expect(ids(await list(admin, '?search=%20%20asha%20%20'))).toEqual([booking.id])
    expect((await list(admin, `?search=${'a'.repeat(100)}`)).status).toBe(200)
    expect((await list(admin, `?search=${'a'.repeat(101)}`)).status).toBe(400)
    // Spaces around a 100-character search do not count against the cap.
    expect((await list(admin, `?search=%20${'a'.repeat(100)}%20`)).status).toBe(200)
  })

  it('search treats % and _ literally', async () => {
    const { token: admin } = await seedUser('admin')
    const now = Date.now()
    const { user: percent } = await seedUser('student', { name: '50% Club', email: 'percent@test.com' })
    const { user: underscore } = await seedUser('student', { name: 'Lab_Tech', email: 'underscore@test.com' })
    const { user: plain } = await seedUser('student', { name: 'Labxtech Plain', email: 'plain@test.com' })
    const { user: slash } = await seedUser('student', { name: 'Back\\slash', email: 'slash@test.com' })
    const percentBooking = await seedBooking(now, { userId: percent.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const underscoreBooking = await seedBooking(now, { userId: underscore.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS })
    await seedBooking(now, { userId: plain.id, start: 5 * HOUR_MS, end: 6 * HOUR_MS })
    const slashBooking = await seedBooking(now, { userId: slash.id, start: 7 * HOUR_MS, end: 8 * HOUR_MS })

    // A wildcard would match every row; literal text matches only the one that contains it.
    expect(ids(await list(admin, `?search=${encodeURIComponent('%')}`))).toEqual([percentBooking.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('50%')}`))).toEqual([percentBooking.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('_')}`)).sort()).toEqual([underscoreBooking.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('lab_tech')}`))).toEqual([underscoreBooking.id])
    // Backslash is the escape character, and is literal too.
    expect(ids(await list(admin, `?search=${encodeURIComponent('\\')}`))).toEqual([slashBooking.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('back\\slash')}`))).toEqual([slashBooking.id])
    expect(ids(await list(admin, `?search=${encodeURIComponent('%\\')}`))).toEqual([])
  })

  it('a quote in the search is safe', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: obrien } = await seedUser('student', { name: "Fiona O'Brien", email: 'fiona@test.com' })
    const { user: other } = await seedUser('student', { name: 'Someone Else' })
    const now = Date.now()
    const booking = await seedBooking(now, { userId: obrien.id, start: HOUR_MS, end: 2 * HOUR_MS })
    await seedBooking(now, { userId: other.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS })

    const quoted = await list(admin, `?search=${encodeURIComponent("o'brien")}`)
    const injection = await list(admin, `?search=${encodeURIComponent(`'; DROP TABLE "ResourceBooking"; --`)}`)
    const tautology = await list(admin, `?search=${encodeURIComponent("' OR '1'='1")}`)

    expect(quoted.status).toBe(200)
    expect(ids(quoted)).toEqual([booking.id])
    expect(injection.status).toBe(200)
    expect(injection.body.bookings).toEqual([])
    expect(tautology.status).toBe(200)
    expect(tautology.body.bookings).toEqual([])
    expect(await prisma.resourceBooking.count()).toBe(2)
  })

  it('a search of only spaces is ignored', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const first = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const second = await seedBooking(now, { userId: student.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS })

    const spaces = await list(admin, '?search=%20%20%20')
    const empty = await list(admin, '?search=')

    expect(ids(spaces)).toEqual([second.id, first.id])
    expect(spaces.body.total).toBe(2)
    expect(ids(empty)).toEqual([second.id, first.id])
  })

  it('pages: second page, a page past the end returns an empty list with the right total', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    // Seven bookings; newest start first means start 7h down to 1h.
    const seeded = []
    for (let i = 1; i <= 7; i++) seeded.push(await seedBooking(now, { userId: student.id, start: i * HOUR_MS, end: i * HOUR_MS + 30 * MINUTE_MS }))
    const newestFirst = [...seeded].reverse().map((b) => b.id)

    const first = await list(admin, '?pageSize=3')
    const second = await list(admin, '?page=2&pageSize=3')
    const third = await list(admin, '?page=3&pageSize=3')
    const past = await list(admin, '?page=4&pageSize=3')
    const wayPast = await list(admin, '?page=50&pageSize=3')

    expect(ids(first)).toEqual(newestFirst.slice(0, 3))
    expect(first.body).toMatchObject({ total: 7, page: 1, pageSize: 3 })
    expect(ids(second)).toEqual(newestFirst.slice(3, 6))
    expect(second.body).toMatchObject({ total: 7, page: 2, pageSize: 3 })
    expect(ids(third)).toEqual(newestFirst.slice(6))
    expect(third.body.total).toBe(7)
    expect(past.status).toBe(200)
    expect(past.body).toEqual({ bookings: [], total: 7, page: 4, pageSize: 3 })
    expect(wayPast.body).toEqual({ bookings: [], total: 7, page: 50, pageSize: 3 })
  })

  it('a page past the end keeps the filtered total, and an empty first page has total 0', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao' })
    const { user: other } = await seedUser('student', { name: 'Ben Carter' })
    const now = Date.now()
    for (let i = 1; i <= 4; i++) await seedBooking(now, { userId: student.id, start: i * HOUR_MS, end: i * HOUR_MS + 30 * MINUTE_MS })
    await seedBooking(now, { userId: other.id, start: 9 * HOUR_MS, end: 10 * HOUR_MS })
    await seedBooking(now, { userId: other.id, start: 11 * HOUR_MS, end: 12 * HOUR_MS, status: 'cancelled' })

    const searched = await list(admin, '?search=asha&page=5&pageSize=2')
    const filtered = await list(admin, '?status=cancelled&page=3&pageSize=1')
    const nothing = await list(admin, '?search=zzz')

    expect(searched.body).toEqual({ bookings: [], total: 4, page: 5, pageSize: 2 })
    expect(filtered.body).toEqual({ bookings: [], total: 1, page: 3, pageSize: 1 })
    expect(nothing.body).toEqual({ bookings: [], total: 0, page: 1, pageSize: 25 })
  })

  it('pageSize 101 is rejected with 400', async () => {
    const { token: admin } = await seedUser('admin')

    expect((await list(admin, '?pageSize=101')).status).toBe(400)
    expect((await list(admin, '?pageSize=100')).status).toBe(200)
    expect((await list(admin, '?pageSize=0')).status).toBe(400)
    expect((await list(admin, '?page=0')).status).toBe(400)
    expect((await list(admin, '?page=-1')).status).toBe(400)
    expect((await list(admin, '?page=1.5')).status).toBe(400)
    expect((await list(admin, '?page=abc')).status).toBe(400)
    expect((await list(admin, '?pageSize=')).status).toBe(400)
    expect((await list(admin, '?status=booked&status=released')).status).toBe(400)
  })

  it('orders newest start first', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const middle = await seedBooking(now, { userId: student.id, start: 2 * HOUR_MS, end: 3 * HOUR_MS })
    const oldest = await seedBooking(now, { userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' })
    const newest = await seedBooking(now, { userId: student.id, start: 9 * HOUR_MS, end: 10 * HOUR_MS, status: 'cancelled' })
    // Two with the same start (different resources): ties go by id.
    const tieA = await seedBooking(now, { userId: student.id, start: 6 * HOUR_MS, end: 7 * HOUR_MS })
    const tieB = await seedBooking(now, { userId: student.id, start: 6 * HOUR_MS, end: 7 * HOUR_MS })
    const tied = [tieA.id, tieB.id].sort()

    const res = await list(admin)

    expect(ids(res)).toEqual([newest.id, ...tied, middle.id, oldest.id])
  })

  it('canManage is true only for booked', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    await seedBooking(now, { userId: student.id, start: -5 * MINUTE_MS, end: 55 * MINUTE_MS })
    await seedBooking(now, { userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS })
    await seedBooking(now, { userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' })
    await seedBooking(now, { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'checked_in' })
    await seedBooking(now, { userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' })
    await seedBooking(now, { userId: student.id, start: 4 * HOUR_MS, end: 5 * HOUR_MS, status: 'cancelled' })
    await seedBooking(now, { userId: student.id, start: -8 * HOUR_MS, end: -7 * HOUR_MS, status: 'released' })

    const res = await list(admin)

    const rows = res.body.bookings as ListedBooking[]
    expect(rows).toHaveLength(8)
    for (const row of rows) expect(row.canManage).toBe(row.status === 'booked')
    expect(rows.filter((r) => r.canManage)).toHaveLength(2)
  })
})

// --- Cancel and reassign ------------------------------------------------------

const post = (token: string, path: string, body?: object) => {
  const req = request(app).post(path).set(auth(token))
  return body === undefined ? req : req.send(body)
}
const cancel = (token: string, id: string, body?: object) => post(token, `/admin/bookings/${id}/cancel`, body)
const reassign = (token: string, id: string, resourceId: string) => post(token, `/admin/bookings/${id}/reassign`, { resourceId })
const reassignOptions = (token: string, id: string) => request(app).get(`/admin/bookings/${id}/reassign-options`).set(auth(token))
const storedBooking = (id: string) => prisma.resourceBooking.findUniqueOrThrow({ where: { id } })

interface ReassignOption {
  id: string
  name: string
  location: string | null
  capacity: number
}

describe('admin booking cancel', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('is for admins only', async () => {
    const { token: student } = await seedUser()

    const anonymous = await request(app).post('/admin/bookings/some-id/cancel')
    const asStudent = await cancel(student, 'some-id')

    expect(anonymous.status).toBe(401)
    expect(asStudent.status).toBe(403)
  })

  it('cancel frees the slot (a student can then book it) and records who, when and why', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: owner } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const { token: other } = await seedUser()
    const desk = await seedResource('Desk 9')
    const now = Date.now()
    const booking = await seedBooking(now, { userId: owner.id, resourceId: desk.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const slot = { resourceId: desk.id, startTime: new Date(now + HOUR_MS).toISOString(), endTime: new Date(now + 2 * HOUR_MS).toISOString() }
    const bookIt = () => request(app).post('/bookings').set(auth(other)).send(slot)

    // The booking holds the slot until it is cancelled.
    expect((await bookIt()).status).toBe(409)
    const before = Date.now()
    const res = await cancel(admin, booking.id, { reason: '  Desk is being repaired  ' })
    const after = Date.now()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: booking.id,
      resource: { id: desk.id, name: 'Desk 9', type: 'seat' },
      student: { id: owner.id, name: 'Asha Rao', email: 'asha@test.com' },
      startTime: new Date(now + HOUR_MS).toISOString(),
      endTime: new Date(now + 2 * HOUR_MS).toISOString(),
      status: 'cancelled',
      cancelledBy: 'library',
      cancelReason: 'Desk is being repaired',
      movedFromName: null,
      canManage: false,
    })
    const stored = await storedBooking(booking.id)
    expect(stored).toMatchObject({ status: 'cancelled', cancelledById: librarian.id, cancelReason: 'Desk is being repaired' })
    expect(stored.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(stored.cancelledAt!.getTime()).toBeLessThanOrEqual(after)
    expect((await bookIt()).status).toBe(201)
  })

  it('cancel without a body or reason succeeds with a null reason', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const noBody = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const emptyBody = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const blankReason = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })

    const responses = [
      await cancel(admin, noBody.id),
      await cancel(admin, emptyBody.id, {}),
      await cancel(admin, blankReason.id, { reason: '   ' }),
    ]

    for (const res of responses) {
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ status: 'cancelled', cancelledBy: 'library', cancelReason: null, canManage: false })
    }
    for (const { id } of [noBody, emptyBody, blankReason]) {
      expect(await storedBooking(id)).toMatchObject({ status: 'cancelled', cancelledById: librarian.id, cancelReason: null })
    }
  })

  it('a reason over 300 characters is rejected', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedBooking(Date.now(), { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })

    const tooLong = await cancel(admin, booking.id, { reason: 'x'.repeat(301) })
    const notText = await cancel(admin, booking.id, { reason: 5 })

    expect(tooLong.status).toBe(400)
    expect(notText.status).toBe(400)
    expect(await storedBooking(booking.id)).toMatchObject({ status: 'booked', cancelledById: null, cancelReason: null })

    // 300 characters is fine, and the spaces around it do not count.
    const atLimit = await cancel(admin, booking.id, { reason: ` ${'x'.repeat(300)} ` })
    expect(atLimit.status).toBe(200)
    expect(atLimit.body.cancelReason).toBe('x'.repeat(300))
  })

  it('cancel of an unknown booking is 404', async () => {
    const { token: admin } = await seedUser('admin')

    const res = await cancel(admin, 'no-such-booking')

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Booking not found')
  })

  it('cancel refuses a booking the library already cancelled: "Already cancelled by the library."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: otherLibrarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedBooking(Date.now(), {
      userId: student.id,
      start: HOUR_MS,
      end: 2 * HOUR_MS,
      status: 'cancelled',
      cancelledById: otherLibrarian.id,
      cancelReason: 'First reason',
    })

    const res = await cancel(admin, booking.id, { reason: 'Second reason' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Already cancelled by the library.')
    expect(await storedBooking(booking.id)).toMatchObject({ cancelledById: otherLibrarian.id, cancelReason: 'First reason' })
  })

  it('cancel refuses a booking the student already cancelled: "The student already cancelled this booking."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedBooking(Date.now(), { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled' })

    const res = await cancel(admin, booking.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The student already cancelled this booking.')
    expect((await storedBooking(booking.id)).cancelledById).toBeNull()
  })

  it('cancel refuses a booking the student checked in to: "The student already checked in."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedBooking(Date.now(), { userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' })

    const res = await cancel(admin, booking.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The student already checked in.')
    expect((await storedBooking(booking.id)).status).toBe('checked_in')
  })

  it('cancel refuses a booking the clock released: "This booking has already been released."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    // Booked, but its grace period is over; and one stored as released.
    const lapsed = await seedBooking(now, { userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS })
    const stored = await seedBooking(now, { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'released' })

    for (const { id } of [lapsed, stored]) {
      const res = await cancel(admin, id)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('This booking has already been released.')
    }
    expect((await storedBooking(lapsed.id)).status).toBe('booked')
  })

  it('cancel refuses a booking that is over: "This booking has already finished."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const completed = await seedBooking(now, { userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' })
    // Checked in and past its end: the list shows it as completed, so the message agrees.
    const ranOut = await seedBooking(now, { userId: student.id, start: -3 * HOUR_MS, end: -2 * HOUR_MS, status: 'checked_in' })

    for (const { id } of [completed, ranOut]) {
      const res = await cancel(admin, id)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('This booking has already finished.')
    }
  })

  it('cancel refuses a room request: "This is a room request. Decide it on the Requests page."', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const room = await seedResource('Group Room 101', 'room')
    const pendingRequest = await seedBooking(Date.now(), { userId: student.id, resourceId: room.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'requested' })

    const res = await cancel(admin, pendingRequest.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This is a room request. Decide it on the Requests page.')
    expect((await storedBooking(pendingRequest.id)).status).toBe('requested')
  })

  it('declined, expired and no_show rows are not found, as the list never shows them', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()

    for (const status of ['declined', 'expired', 'no_show'] as const) {
      const booking = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status })
      expect((await cancel(admin, booking.id)).status).toBe(404)
      expect((await reassignOptions(admin, booking.id)).status).toBe(404)
    }
  })

  it('a booking can still be cancelled exactly at the end of its grace period, but not one millisecond later', async () => {
    const { user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const start = Date.now() + HOUR_MS
    const atEnd = await seedBooking(start, { userId: student.id, start: 0, end: HOUR_MS, graceMinutes: 20 })
    const late = await seedBooking(start, { userId: student.id, start: 0, end: HOUR_MS, graceMinutes: 20 })
    const graceEnd = start + 20 * MINUTE_MS

    const cancelled = await cancelBookingAsLibrary(atEnd.id, librarian.id, null, new Date(graceEnd))
    const refused = cancelBookingAsLibrary(late.id, librarian.id, null, new Date(graceEnd + 1))

    expect(cancelled.status).toBe('cancelled')
    await expect(refused).rejects.toMatchObject({ status: 409, message: 'This booking has already been released.' })
    expect((await storedBooking(late.id)).status).toBe('booked')
  })

  it('cancel publishes booking.changed once, a refused cancel publishes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const booking = await seedBooking(Date.now(), { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    recorder = recordEvents()

    const first = await cancel(admin, booking.id)
    expect(first.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'booking.changed', topics: ['bookings', 'metrics'] }])

    const again = await cancel(admin, booking.id)
    const unknown = await cancel(admin, 'no-such-booking')
    const tooLong = await cancel(admin, booking.id, { reason: 'x'.repeat(301) })

    expect([again.status, unknown.status, tooLong.status]).toEqual([409, 404, 400])
    expect(recorder.events).toHaveLength(1)
  })

  it("neither action changes the student's reliability score", async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    await prisma.user.update({ where: { id: student.id }, data: { reliabilityScore: 60 } })
    const now = Date.now()
    const toCancel = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const toMove = await seedBooking(now, { userId: student.id, start: 3 * HOUR_MS, end: 4 * HOUR_MS })
    const elsewhere = await seedResource('Desk elsewhere')

    expect((await cancel(admin, toCancel.id, { reason: 'Closed' })).status).toBe(200)
    expect((await reassign(admin, toMove.id, elsewhere.id)).status).toBe(200)

    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(60)
    expect(await prisma.reliabilityScoreLog.count({ where: { userId: student.id } })).toBe(0)
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(await prisma.fine.count()).toBe(0)
  })

  it('a student can no longer check in to or cancel a library-cancelled booking', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser()
    // Inside its check-in window, so only the cancel stops the student.
    const booking = await seedBooking(Date.now(), { userId: student.id, start: -5 * MINUTE_MS, end: 55 * MINUTE_MS })
    expect((await cancel(admin, booking.id)).status).toBe(200)

    const checkIn = await request(app).post(`/bookings/${booking.id}/checkin`).set(auth(studentToken))
    const studentCancel = await request(app).post(`/bookings/${booking.id}/cancel`).set(auth(studentToken))

    expect(checkIn.status).toBe(409)
    expect(checkIn.body.error).toBe('This booking cannot be checked into.')
    expect(studentCancel.status).toBe(409)
    expect(studentCancel.body.error).toBe('This booking cannot be cancelled.')
    expect(await storedBooking(booking.id)).toMatchObject({ status: 'cancelled', cancelledById: librarian.id, checkedInAt: null })
  })
})

describe('admin booking reassign', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('the options and reassign routes are for admins only', async () => {
    const { token: student } = await seedUser()

    const anonymousOptions = await request(app).get('/admin/bookings/some-id/reassign-options')
    const studentOptions = await reassignOptions(student, 'some-id')
    const anonymousReassign = await request(app).post('/admin/bookings/some-id/reassign').send({ resourceId: 'r' })
    const studentReassign = await reassign(student, 'some-id', 'r')

    expect([anonymousOptions.status, anonymousReassign.status]).toEqual([401, 401])
    expect([studentOptions.status, studentReassign.status]).toEqual([403, 403])
  })

  it('reassign options exclude the current resource, offline ones, other types and busy ones', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { user: other } = await seedUser()
    const now = Date.now()
    const current = await seedResource('Seat C')
    const free = await seedResource('Seat B', 'seat', { location: 'Floor 2', capacity: 2 })
    const alsoFree = await seedResource('Seat A')
    const cancelledThere = await seedResource('Seat G')
    const adjacent = await seedResource('Seat H')
    const offline = await seedResource('Seat D', 'seat', { status: 'offline' })
    const room = await seedResource('Room A', 'room')
    const overlapping = await seedResource('Seat E')
    const holding = await seedResource('Seat F')
    const requested = await seedResource('Seat I')
    const booking = await seedBooking(now, { userId: student.id, resourceId: current.id, start: HOUR_MS, end: 2 * HOUR_MS })
    // Busy: a holding booking overlaps in part, in full, or is only a pending request.
    await seedBooking(now, { userId: other.id, resourceId: overlapping.id, start: HOUR_MS + 30 * MINUTE_MS, end: 3 * HOUR_MS })
    await seedBooking(now, { userId: other.id, resourceId: holding.id, start: 0, end: 3 * HOUR_MS, status: 'checked_in' })
    await seedBooking(now, { userId: other.id, resourceId: requested.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'requested' })
    // Not busy: a cancelled booking in the same slot, and one that ends the moment ours starts.
    await seedBooking(now, { userId: other.id, resourceId: cancelledThere.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled' })
    await seedBooking(now, { userId: other.id, resourceId: adjacent.id, start: 0, end: HOUR_MS })

    const res = await reassignOptions(admin, booking.id)

    expect(res.status).toBe(200)
    // A bare array, in name order, with exactly these four fields.
    expect(res.body).toEqual([
      { id: alsoFree.id, name: 'Seat A', location: null, capacity: 1 },
      { id: free.id, name: 'Seat B', location: 'Floor 2', capacity: 2 },
      { id: cancelledThere.id, name: 'Seat G', location: null, capacity: 1 },
      { id: adjacent.id, name: 'Seat H', location: null, capacity: 1 },
    ] satisfies ReassignOption[])
    expect(JSON.stringify(res.body)).not.toContain(offline.id)
    expect(JSON.stringify(res.body)).not.toContain(room.id)
  })

  it('options for a booking that cannot be managed answer the same refusal', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const cases: Array<[BookingSeed, string]> = [
      [{ userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled', cancelledById: librarian.id }, 'Already cancelled by the library.'],
      [{ userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled' }, 'The student already cancelled this booking.'],
      [{ userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' }, 'The student already checked in.'],
      [{ userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS }, 'This booking has already been released.'],
      [{ userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' }, 'This booking has already finished.'],
    ]

    for (const [seed, message] of cases) {
      const booking = await seedBooking(now, seed)
      const res = await reassignOptions(admin, booking.id)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(message)
    }
    const room = await seedResource('Group Room 101', 'room')
    const pending = await seedBooking(now, { userId: student.id, resourceId: room.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'requested' })
    const requestRefusal = await reassignOptions(admin, pending.id)
    expect(requestRefusal.status).toBe(409)
    expect(requestRefusal.body.error).toBe('This is a room request. Decide it on the Requests page.')
    expect((await reassignOptions(admin, 'no-such-booking')).status).toBe(404)
  })

  it('reassign moves the booking and records movedFromName and movedAt', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser('student', { name: 'Asha Rao', email: 'asha@test.com' })
    const from = await seedResource('Group Room 101', 'room')
    const to = await seedResource('Group Room 201', 'room', { location: 'Floor 2', capacity: 8 })
    const now = Date.now()
    const booking = await seedBooking(now, { userId: student.id, resourceId: from.id, start: HOUR_MS, end: 2 * HOUR_MS })

    const before = Date.now()
    const res = await reassign(admin, booking.id, to.id)
    const after = Date.now()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: booking.id,
      resource: { id: to.id, name: 'Group Room 201', type: 'room' },
      student: { id: student.id, name: 'Asha Rao', email: 'asha@test.com' },
      startTime: new Date(now + HOUR_MS).toISOString(),
      endTime: new Date(now + 2 * HOUR_MS).toISOString(),
      status: 'booked',
      cancelledBy: null,
      cancelReason: null,
      movedFromName: 'Group Room 101',
      canManage: true,
    })
    const stored = await storedBooking(booking.id)
    expect(stored).toMatchObject({ resourceId: to.id, status: 'booked', movedFromName: 'Group Room 101' })
    expect(stored.movedAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(stored.movedAt!.getTime()).toBeLessThanOrEqual(after)
    // The list shows the move too.
    expect((await list(admin)).body.bookings[0]).toMatchObject({ id: booking.id, resource: { name: 'Group Room 201' }, movedFromName: 'Group Room 101' })

    // The old resource is free again, and a second move records the latest one it left.
    const back = await reassign(admin, booking.id, from.id)
    expect(back.status).toBe(200)
    expect(back.body).toMatchObject({ resource: { id: from.id }, movedFromName: 'Group Room 201' })
  })

  it('reassign to a resource of the other type is 400', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const seat = await seedResource('Desk 1')
    const room = await seedResource('Group Room 101', 'room')
    const booking = await seedBooking(Date.now(), { userId: student.id, resourceId: seat.id, start: HOUR_MS, end: 2 * HOUR_MS })

    const res = await reassign(admin, booking.id, room.id)

    expect(res.status).toBe(400)
    expect(await storedBooking(booking.id)).toMatchObject({ resourceId: seat.id, movedFromName: null, movedAt: null })
  })

  it('reassign to an offline resource is 409', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const offline = await seedResource('Desk 2', 'seat', { status: 'offline' })
    const booking = await seedBooking(Date.now(), { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const sourceId = (await storedBooking(booking.id)).resourceId

    const res = await reassign(admin, booking.id, offline.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That resource is offline.')
    expect(await storedBooking(booking.id)).toMatchObject({ resourceId: sourceId, movedFromName: null, movedAt: null })
  })

  it('reassign to a busy resource is 409 "That resource is taken at this time." and the booking is unchanged', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { user: other } = await seedUser()
    const now = Date.now()
    const busy = await seedResource('Desk 3')
    const booking = await seedBooking(now, { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    const sourceId = (await storedBooking(booking.id)).resourceId
    await seedBooking(now, { userId: other.id, resourceId: busy.id, start: HOUR_MS + 30 * MINUTE_MS, end: 3 * HOUR_MS })
    recorder = recordEvents()

    const res = await reassign(admin, booking.id, busy.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That resource is taken at this time.')
    expect(await storedBooking(booking.id)).toMatchObject({ resourceId: sourceId, status: 'booked', movedFromName: null, movedAt: null })
    expect(recorder.events).toEqual([])
  })

  it('reassign refuses what cancel refuses, with the same messages', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: librarian } = await seedUser('admin')
    const { user: student } = await seedUser()
    const now = Date.now()
    const target = await seedResource('Target desk')
    const cases: Array<[BookingSeed, string]> = [
      [{ userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled', cancelledById: librarian.id }, 'Already cancelled by the library.'],
      [{ userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS, status: 'cancelled' }, 'The student already cancelled this booking.'],
      [{ userId: student.id, start: -10 * MINUTE_MS, end: 50 * MINUTE_MS, status: 'checked_in' }, 'The student already checked in.'],
      [{ userId: student.id, start: -20 * MINUTE_MS, end: 40 * MINUTE_MS }, 'This booking has already been released.'],
      [{ userId: student.id, start: -5 * HOUR_MS, end: -4 * HOUR_MS, status: 'completed' }, 'This booking has already finished.'],
    ]
    recorder = recordEvents()

    for (const [seed, message] of cases) {
      const booking = await seedBooking(now, seed)
      const res = await reassign(admin, booking.id, target.id)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(message)
      expect((await storedBooking(booking.id)).movedAt).toBeNull()
    }
    expect((await reassign(admin, 'no-such-booking', target.id)).status).toBe(404)
    expect(recorder.events).toEqual([])
  })

  it('reassign rejects an unknown or same resource and a body without a resourceId', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const current = await seedResource('Desk 4')
    const booking = await seedBooking(Date.now(), { userId: student.id, resourceId: current.id, start: HOUR_MS, end: 2 * HOUR_MS })

    const unknown = await reassign(admin, booking.id, 'no-such-resource')
    const same = await reassign(admin, booking.id, current.id)
    const noBody = await post(admin, `/admin/bookings/${booking.id}/reassign`)
    const blank = await reassign(admin, booking.id, '')

    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Resource not found')
    expect(same.status).toBe(400)
    expect(same.body.error).toBe('That booking is already on that resource.')
    expect(noBody.status).toBe(400)
    expect(blank.status).toBe(400)
    expect(await storedBooking(booking.id)).toMatchObject({ resourceId: current.id, movedFromName: null, movedAt: null })
  })

  it('reassign publishes booking.changed once, a refused reassign publishes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const target = await seedResource('Desk 5')
    const offline = await seedResource('Desk 6', 'seat', { status: 'offline' })
    const booking = await seedBooking(Date.now(), { userId: student.id, start: HOUR_MS, end: 2 * HOUR_MS })
    recorder = recordEvents()

    const refused = await reassign(admin, booking.id, offline.id)
    expect(refused.status).toBe(409)
    expect(recorder.events).toEqual([])

    const moved = await reassign(admin, booking.id, target.id)
    expect(moved.status).toBe(200)
    expect(recorder.events).toEqual([{ type: 'booking.changed', topics: ['bookings', 'metrics'] }])
  })
})
