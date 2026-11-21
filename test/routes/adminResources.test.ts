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

function seedResource(name: string, type: 'seat' | 'room' = 'seat', extra: { location?: string; capacity?: number } = {}) {
  return prisma.resource.create({ data: { type, name, location: extra.location ?? null, capacity: extra.capacity ?? 1 } })
}

function seedBooking(
  userId: string,
  resourceId: string,
  startOffsetMs: number,
  endOffsetMs: number,
  status: 'booked' | 'checked_in' | 'requested' | 'cancelled' | 'completed' = 'booked',
) {
  const now = Date.now()
  return prisma.resourceBooking.create({
    data: { userId, resourceId, startTime: new Date(now + startOffsetMs), endTime: new Date(now + endOffsetMs), status },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const list = (token: string, query = '') => request(app).get(`/admin/resources${query}`).set(auth(token))
const create = (token: string, body: object) => request(app).post('/admin/resources').set(auth(token)).send(body)
const edit = (token: string, id: string, body: object) => request(app).patch(`/admin/resources/${id}`).set(auth(token)).send(body)
const takeOffline = (token: string, id: string, body?: object) => {
  const req = request(app).post(`/admin/resources/${id}/offline`).set(auth(token))
  return body === undefined ? req : req.send(body)
}
const bringOnline = (token: string, id: string) => request(app).post(`/admin/resources/${id}/online`).set(auth(token))

describe('admin resources', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it('is for admins only', async () => {
    const { token: student } = await seedUser()
    const resource = await seedResource('Desk 1')
    const calls: Array<(token?: string) => request.Test> = [
      (token) => withToken(request(app).get('/admin/resources'), token),
      (token) => withToken(request(app).post('/admin/resources'), token).send({ type: 'seat', name: 'Desk 9', capacity: 1 }),
      (token) => withToken(request(app).patch(`/admin/resources/${resource.id}`), token).send({ name: 'Desk 9' }),
      (token) => withToken(request(app).post(`/admin/resources/${resource.id}/offline`), token).send({}),
      (token) => withToken(request(app).post(`/admin/resources/${resource.id}/online`), token),
    ]

    for (const call of calls) {
      expect((await call()).status).toBe(401)
      expect((await call(student)).status).toBe(403)
    }
    // Nothing was written by any of the refused calls.
    expect(await prisma.resource.count()).toBe(1)
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } })).name).toBe('Desk 1')
  })

  it('lists resources in name order with status and upcoming count', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const desk2 = await seedResource('Desk 2', 'seat', { location: 'Silent Zone' })
    const desk1 = await seedResource('Desk 1', 'seat', { location: 'Silent Zone' })
    const room = await seedResource('Group Room 201', 'room', { location: 'Group study rooms', capacity: 6 })
    await prisma.resource.update({ where: { id: desk2.id }, data: { status: 'offline', statusNote: 'Broken lamp' } })
    // Desk 1: one in progress, one later today, one past, one cancelled, one finished early.
    await seedBooking(student.id, desk1.id, -30 * MINUTE_MS, 30 * MINUTE_MS)
    await seedBooking(student.id, desk1.id, 2 * HOUR_MS, 3 * HOUR_MS)
    await seedBooking(student.id, desk1.id, -3 * HOUR_MS, -2 * HOUR_MS)
    await seedBooking(student.id, desk1.id, 4 * HOUR_MS, 5 * HOUR_MS, 'cancelled')
    await seedBooking(student.id, desk1.id, 6 * HOUR_MS, 7 * HOUR_MS, 'completed')
    // The room: a pending request holds its slot, so it counts.
    await seedBooking(student.id, room.id, 24 * HOUR_MS, 25 * HOUR_MS, 'requested')

    const res = await list(admin)

    expect(res.status).toBe(200)
    // A bare array, not an object wrapper.
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toEqual([
      { id: desk1.id, type: 'seat', name: 'Desk 1', location: 'Silent Zone', capacity: 1, status: 'available', statusNote: null, upcomingBookings: 2 },
      { id: desk2.id, type: 'seat', name: 'Desk 2', location: 'Silent Zone', capacity: 1, status: 'offline', statusNote: 'Broken lamp', upcomingBookings: 0 },
      { id: room.id, type: 'room', name: 'Group Room 201', location: 'Group study rooms', capacity: 6, status: 'available', statusNote: null, upcomingBookings: 1 },
    ])
  })

  it('filters by type', async () => {
    const { token: admin } = await seedUser('admin')
    await seedResource('Desk 1', 'seat')
    await seedResource('Group Room 201', 'room')

    const seats = await list(admin, '?type=seat')
    const rooms = await list(admin, '?type=room')
    const bad = await list(admin, '?type=table')

    expect(seats.body.map((r: { name: string }) => r.name)).toEqual(['Desk 1'])
    expect(rooms.body.map((r: { name: string }) => r.name)).toEqual(['Group Room 201'])
    expect(bad.status).toBe(400)
  })

  it('creates a resource', async () => {
    const { token: admin } = await seedUser('admin')

    const res = await create(admin, { type: 'room', name: '  Group Room 305  ', location: 'Level 3', capacity: 8 })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      id: expect.any(String),
      type: 'room',
      name: 'Group Room 305',
      location: 'Level 3',
      capacity: 8,
      status: 'available',
      statusNote: null,
      upcomingBookings: 0,
    })
    expect(await prisma.resource.findUnique({ where: { id: res.body.id } })).toMatchObject({ name: 'Group Room 305', status: 'available' })
  })

  it('creates a resource with no location', async () => {
    const { token: admin } = await seedUser('admin')

    const omitted = await create(admin, { type: 'seat', name: 'Desk 7', capacity: 1 })
    const blank = await create(admin, { type: 'seat', name: 'Desk 8', location: '   ', capacity: 1 })

    expect(omitted.status).toBe(201)
    expect(omitted.body.location).toBeNull()
    expect(blank.status).toBe(201)
    expect(blank.body.location).toBeNull()
  })

  it('an empty location is stored as null on create and on edit', async () => {
    const { token: admin } = await seedUser('admin')

    // The console sends '' when the field is blank.
    const created = await create(admin, { type: 'seat', name: 'Desk 1', location: '', capacity: 1 })
    expect(created.status).toBe(201)
    expect(created.body.location).toBeNull()
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: created.body.id } })).location).toBeNull()

    const located = await seedResource('Desk 2', 'seat', { location: 'Silent Zone' })
    const edited = await edit(admin, located.id, { name: 'Desk 2A', location: '' })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ name: 'Desk 2A', location: null })
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: located.id } })).location).toBeNull()

    // Still capped at 100 characters otherwise.
    expect((await create(admin, { type: 'seat', name: 'Desk 3', location: 'x'.repeat(101), capacity: 1 })).status).toBe(400)
    expect((await edit(admin, located.id, { location: 'x'.repeat(101) })).status).toBe(400)
    expect((await edit(admin, located.id, { location: 'x'.repeat(100) })).body.location).toHaveLength(100)
  })

  it('rejects a blank name, a 101-character name, capacity 0 and capacity 101', async () => {
    const { token: admin } = await seedUser('admin')
    const valid = { type: 'seat', name: 'Desk 1', location: 'Silent Zone', capacity: 1 }

    const rejected = [
      await create(admin, { ...valid, name: '   ' }),
      await create(admin, { ...valid, name: 'x'.repeat(101) }),
      await create(admin, { ...valid, capacity: 0 }),
      await create(admin, { ...valid, capacity: 101 }),
      await create(admin, { ...valid, capacity: 2.5 }),
      await create(admin, { ...valid, location: 'x'.repeat(101) }),
      await create(admin, { ...valid, type: 'table' }),
      await create(admin, { name: 'Desk 1', capacity: 1 }),
    ]
    const edges = [await create(admin, { ...valid, name: 'x'.repeat(100), capacity: 100 }), await create(admin, { ...valid, name: 'Desk 2', capacity: 1 })]

    expect(rejected.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400])
    expect(edges.map((r) => r.status)).toEqual([201, 201])
    expect(await prisma.resource.count()).toBe(2)
  })

  it('edits name, location and capacity but ignores a type in the body', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1', 'seat', { location: 'Silent Zone' })

    const res = await edit(admin, desk.id, { type: 'room', name: ' Desk One ', location: 'Level 2', capacity: 2 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: desk.id, type: 'seat', name: 'Desk One', location: 'Level 2', capacity: 2, status: 'available' })
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: desk.id } })).toMatchObject({ type: 'seat', name: 'Desk One', location: 'Level 2', capacity: 2 })
  })

  it('edits one field at a time and clears the location with null', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1', 'seat', { location: 'Silent Zone', capacity: 2 })

    const renamed = await edit(admin, desk.id, { name: 'Desk 1A' })
    expect(renamed.body).toMatchObject({ name: 'Desk 1A', location: 'Silent Zone', capacity: 2 })

    const cleared = await edit(admin, desk.id, { location: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toMatchObject({ name: 'Desk 1A', location: null, capacity: 2 })

    const rejected = [
      await edit(admin, desk.id, { name: '  ' }),
      await edit(admin, desk.id, { name: 'x'.repeat(101) }),
      await edit(admin, desk.id, { capacity: 0 }),
      await edit(admin, desk.id, { capacity: 101 }),
      await edit(admin, desk.id, { location: 'x'.repeat(101) }),
    ]
    expect(rejected.map((r) => r.status)).toEqual([400, 400, 400, 400, 400])
  })

  it('PATCH with no fields is rejected', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')

    const empty = await edit(admin, desk.id, {})
    const onlyType = await edit(admin, desk.id, { type: 'room' })

    expect(empty.status).toBe(400)
    expect(onlyType.status).toBe(400)
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: desk.id } })).toMatchObject({ type: 'seat', name: 'Desk 1' })
  })

  it('takes a resource offline with a note and shows it in the list', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const desk = await seedResource('Desk 1')
    await seedBooking(student.id, desk.id, HOUR_MS, 2 * HOUR_MS)

    const res = await takeOffline(admin, desk.id, { note: '  Broken lamp  ' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: desk.id, status: 'offline', statusNote: 'Broken lamp', upcomingBookings: 1 })
    const listed = await list(admin)
    expect(listed.body).toEqual([expect.objectContaining({ id: desk.id, status: 'offline', statusNote: 'Broken lamp', upcomingBookings: 1 })])
    // The existing booking stays.
    expect(await prisma.resourceBooking.count({ where: { resourceId: desk.id, status: 'booked' } })).toBe(1)
  })

  it('takes a resource offline with no body, a blank note or a note of exactly 300 characters', async () => {
    const { token: admin } = await seedUser('admin')
    const a = await seedResource('Desk A')
    const b = await seedResource('Desk B')
    const c = await seedResource('Desk C')
    const d = await seedResource('Desk D')

    const noBody = await takeOffline(admin, a.id)
    const blank = await takeOffline(admin, b.id, { note: '   ' })
    const max = await takeOffline(admin, c.id, { note: 'n'.repeat(300) })
    const tooLong = await takeOffline(admin, d.id, { note: 'n'.repeat(301) })

    expect(noBody.status).toBe(200)
    expect(noBody.body).toMatchObject({ status: 'offline', statusNote: null })
    expect(blank.body).toMatchObject({ status: 'offline', statusNote: null })
    expect(max.body.statusNote).toHaveLength(300)
    expect(tooLong.status).toBe(400)
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('available')
  })

  it('brings an offline resource back online and clears its note', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')
    await takeOffline(admin, desk.id, { note: 'Broken lamp' })

    const res = await bringOnline(admin, desk.id)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: desk.id, status: 'available', statusNote: null })
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: desk.id } })).toMatchObject({ status: 'available', statusNote: null })
  })

  it('taking an offline resource offline again answers 409 "This resource is already offline."', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')
    await takeOffline(admin, desk.id, { note: 'Broken lamp' })

    const res = await takeOffline(admin, desk.id, { note: 'A different note' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This resource is already offline.')
    // The refused call did not overwrite the first librarian's note.
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: desk.id } })).statusNote).toBe('Broken lamp')
  })

  it('bringing an available resource online answers 409 "This resource is already online."', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')

    const res = await bringOnline(admin, desk.id)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This resource is already online.')
  })

  it('unknown id answers 404', async () => {
    const { token: admin } = await seedUser('admin')
    const missing = 'does-not-exist'

    const responses = [
      await edit(admin, missing, { name: 'Desk 9' }),
      await takeOffline(admin, missing, {}),
      await bringOnline(admin, missing),
    ]

    expect(responses.map((r) => r.status)).toEqual([404, 404, 404])
    expect(responses[0].body.error).toBe('Resource not found')
  })

  it('two librarians taking the same resource offline at once: one wins, one gets the 409', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')
    recorder = recordEvents()

    const responses = await Promise.all([takeOffline(admin, desk.id, { note: 'one' }), takeOffline(admin, desk.id, { note: 'two' })])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(responses.find((r) => r.status === 409)?.body.error).toBe('This resource is already offline.')
    expect(recorder.events).toHaveLength(1)
  })

  it('a status change that loses the race after the read is refused, not applied twice', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')
    await prisma.resource.update({ where: { id: desk.id }, data: { status: 'offline', statusNote: 'First librarian' } })
    recorder = recordEvents()

    // This request read the row while it was still available; the other librarian's write landed after.
    const stale = { ...desk, status: 'available' as const, statusNote: null }
    const spy = vi.spyOn(prisma.resource, 'findUnique').mockResolvedValueOnce(stale)
    const offline = await takeOffline(admin, desk.id, { note: 'Second librarian' })
    spy.mockRestore()

    expect(offline.status).toBe(409)
    expect(offline.body.error).toBe('This resource is already offline.')
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: desk.id } })).toMatchObject({ status: 'offline', statusNote: 'First librarian' })

    await prisma.resource.update({ where: { id: desk.id }, data: { status: 'available', statusNote: null } })
    const staleOffline = { ...desk, status: 'offline' as const, statusNote: 'First librarian' }
    const spyOnline = vi.spyOn(prisma.resource, 'findUnique').mockResolvedValueOnce(staleOffline)
    const online = await bringOnline(admin, desk.id)
    spyOnline.mockRestore()

    expect(online.status).toBe(409)
    expect(online.body.error).toBe('This resource is already online.')
    expect(recorder.events).toEqual([])
  })

  it('every write publishes resource.changed once, and refused writes publish nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const desk = await seedResource('Desk 1')
    recorder = recordEvents()
    const expected = { type: 'resource.changed', topics: ['resources', 'metrics'] }

    const created = await create(admin, { type: 'seat', name: 'Desk 2', capacity: 1 })
    expect(created.status).toBe(201)
    expect(recorder.events).toEqual([expected])

    expect((await edit(admin, desk.id, { name: 'Desk One' })).status).toBe(200)
    expect(recorder.events).toHaveLength(2)

    expect((await takeOffline(admin, desk.id, { note: 'Broken lamp' })).status).toBe(200)
    expect(recorder.events).toHaveLength(3)

    expect((await bringOnline(admin, desk.id)).status).toBe(200)
    expect(recorder.events).toEqual([expected, expected, expected, expected])

    // Reads and refused writes add nothing.
    await list(admin)
    await create(admin, { type: 'seat', name: '', capacity: 1 })
    await edit(admin, desk.id, {})
    await edit(admin, 'does-not-exist', { name: 'x' })
    await takeOffline(admin, 'does-not-exist', {})
    await bringOnline(admin, desk.id) // already online
    await takeOffline(admin, desk.id, {})
    await takeOffline(admin, desk.id, {}) // already offline
    await bringOnline(admin, 'does-not-exist')
    // Only the one successful takeOffline above published.
    expect(recorder.events).toHaveLength(5)
  })
})

function withToken(req: request.Test, token?: string): request.Test {
  return token ? req.set(auth(token)) : req
}
