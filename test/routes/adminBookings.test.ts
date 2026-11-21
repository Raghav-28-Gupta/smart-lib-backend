import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { BookingStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { listBookings } from '../../src/services/adminBookingService'
import { resetDb } from '../helpers/db'

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
function seedResource(name = `Desk ${++resourceCounter}`, type: 'seat' | 'room' = 'seat') {
  return prisma.resource.create({ data: { type, name, capacity: 1 } })
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
