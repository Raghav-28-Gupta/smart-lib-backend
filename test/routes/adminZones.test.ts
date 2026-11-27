import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

async function seedUser(role: 'student' | 'admin' = 'student') {
  const user = await prisma.user.create({
    data: { name: `${role} ${Math.random()}`, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

function seedSeat(name: string, location: string | null, extra: { row?: number; column?: number; status?: 'available' | 'offline' } = {}) {
  return prisma.resource.create({
    data: { type: 'seat', name, location, capacity: 1, row: extra.row ?? null, column: extra.column ?? null, status: extra.status ?? 'available' },
  })
}

function seedRoom(name: string, location: string | null) {
  return prisma.resource.create({ data: { type: 'room', name, location, capacity: 6 } })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const listZones = (token: string) => request(app).get('/admin/zones').set(auth(token))
// The console URL-encodes the zone name, so the tests do too.
const putZone = (token: string, name: string, body: unknown) =>
  request(app).put(`/admin/zones/${encodeURIComponent(name)}`).set(auth(token)).send(body as object)

function withToken(req: request.Test, token?: string): request.Test {
  return token ? req.set(auth(token)) : req
}

const RESOURCE_CHANGED = { type: 'resource.changed', topics: ['resources', 'metrics'] }

describe('admin seat zones', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
  })

  it("lists each seat location once with its seat and placed counts, sorted by name, and leaves out rooms' locations", async () => {
    const { token: admin } = await seedUser('admin')
    // Inserted out of name order; an offline seat still counts, and a placed one is counted as placed.
    await seedSeat('Desk 2', 'Silent Zone', { row: 1, column: 2 })
    await seedSeat('Desk 1', 'Silent Zone', { row: 1, column: 1, status: 'offline' })
    await seedSeat('Desk 3', 'Silent Zone')
    await seedSeat('Desk 4', 'Reading Room A')
    await seedSeat('Desk 5', 'Alpha Wing', { row: 3, column: 3 })
    // Not zones: a seat with no location, a seat whose location is only blanks, and rooms.
    await seedSeat('Desk 6', null)
    await seedSeat('Desk 7', '   ')
    await seedRoom('Group Room 201', 'Group study rooms')
    // A room sharing a seat zone's text does not add to that zone's counts.
    await seedRoom('Group Room 305', 'Silent Zone')

    const res = await listZones(admin)

    expect(res.status).toBe(200)
    // A bare array, not an object wrapper.
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toEqual([
      { name: 'Alpha Wing', frontLabel: null, seats: 1, placed: 1 },
      { name: 'Reading Room A', frontLabel: null, seats: 1, placed: 0 },
      { name: 'Silent Zone', frontLabel: null, seats: 3, placed: 2 },
    ])
  })

  it('a zone with a saved label shows it', async () => {
    const { token: admin } = await seedUser('admin')
    await seedSeat('Desk 1', 'Reading Room A', { row: 1, column: 1 })
    await seedSeat('Desk 2', 'Silent Zone')
    await prisma.seatZone.create({ data: { name: 'Reading Room A', frontLabel: 'Windows' } })
    // A label whose seats moved away is kept but not listed: the list is the seat locations.
    await prisma.seatZone.create({ data: { name: 'Old Zone', frontLabel: 'Door' } })

    const res = await listZones(admin)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { name: 'Reading Room A', frontLabel: 'Windows', seats: 1, placed: 1 },
      { name: 'Silent Zone', frontLabel: null, seats: 1, placed: 0 },
    ])
  })

  it('PUT saves a trimmed label, answers the zone and publishes resource.changed', async () => {
    const { token: admin } = await seedUser('admin')
    await seedSeat('Desk 1', 'Reading Room A', { row: 1, column: 1 })
    await seedSeat('Desk 2', 'Reading Room A')
    recorder = recordEvents()

    const res = await putZone(admin, 'Reading Room A', { frontLabel: '  Windows  ' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ name: 'Reading Room A', frontLabel: 'Windows', seats: 2, placed: 1 })
    expect(await prisma.seatZone.findUnique({ where: { name: 'Reading Room A' } })).toEqual({ name: 'Reading Room A', frontLabel: 'Windows' })
    expect(recorder.events).toEqual([RESOURCE_CHANGED])

    // A second save replaces the label (an update, not a second row).
    const again = await putZone(admin, 'Reading Room A', { frontLabel: 'Entrance' })
    expect(again.status).toBe(200)
    expect(again.body.frontLabel).toBe('Entrance')
    expect(await prisma.seatZone.count()).toBe(1)
    expect(recorder.events).toEqual([RESOURCE_CHANGED, RESOURCE_CHANGED])

    // And the list shows it.
    expect((await listZones(admin)).body).toEqual([{ name: 'Reading Room A', frontLabel: 'Entrance', seats: 2, placed: 1 }])
  })

  it('PUT with a blank label clears it', async () => {
    const { token: admin } = await seedUser('admin')
    await seedSeat('Desk 1', 'Reading Room A')
    await seedSeat('Desk 2', 'Silent Zone')
    await prisma.seatZone.create({ data: { name: 'Reading Room A', frontLabel: 'Windows' } })

    const cleared = await putZone(admin, 'Reading Room A', { frontLabel: '   ' })
    // A zone that never had a label: a blank is stored as null, never as an empty string.
    const neverSet = await putZone(admin, 'Silent Zone', { frontLabel: '' })

    expect(cleared.status).toBe(200)
    expect(cleared.body).toEqual({ name: 'Reading Room A', frontLabel: null, seats: 1, placed: 0 })
    expect(neverSet.status).toBe(200)
    expect(neverSet.body.frontLabel).toBeNull()
    expect(await prisma.seatZone.findUnique({ where: { name: 'Reading Room A' } })).toEqual({ name: 'Reading Room A', frontLabel: null })
    expect(await prisma.seatZone.findUnique({ where: { name: 'Silent Zone' } })).toEqual({ name: 'Silent Zone', frontLabel: null })
  })

  it('PUT for a location no seat has is a 404 and publishes nothing', async () => {
    const { token: admin } = await seedUser('admin')
    await seedSeat('Desk 1', 'Silent Zone')
    await seedRoom('Group Room 201', 'Group study rooms')
    recorder = recordEvents()

    const unknown = await putZone(admin, 'Nowhere', { frontLabel: 'Windows' })
    // A room's location is not a zone.
    const roomsLocation = await putZone(admin, 'Group study rooms', { frontLabel: 'Windows' })

    expect(unknown.status).toBe(404)
    expect(unknown.body).toEqual({ error: 'Zone not found' })
    expect(roomsLocation.status).toBe(404)
    expect(roomsLocation.body).toEqual({ error: 'Zone not found' })
    expect(await prisma.seatZone.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('a label over 40 characters is a 400', async () => {
    const { token: admin } = await seedUser('admin')
    await seedSeat('Desk 1', 'Reading Room A')
    recorder = recordEvents()

    const rejected = [
      await putZone(admin, 'Reading Room A', { frontLabel: 'x'.repeat(41) }),
      // The limit is on the trimmed text, so 41 characters plus spaces is still too long.
      await putZone(admin, 'Reading Room A', { frontLabel: `  ${'x'.repeat(41)}  ` }),
      await putZone(admin, 'Reading Room A', {}),
      await putZone(admin, 'Reading Room A', { frontLabel: null }),
      await putZone(admin, 'Reading Room A', { frontLabel: 7 }),
      // The zone name is 1-100 characters once trimmed.
      await putZone(admin, '   ', { frontLabel: 'Windows' }),
      await putZone(admin, 'z'.repeat(101), { frontLabel: 'Windows' }),
    ]

    expect(rejected.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400])
    expect(await prisma.seatZone.count()).toBe(0)
    expect(recorder.events).toEqual([])

    // Exactly 40 is fine.
    const edge = await putZone(admin, 'Reading Room A', { frontLabel: 'x'.repeat(40) })
    expect(edge.status).toBe(200)
    expect(edge.body.frontLabel).toHaveLength(40)
  })

  it('a zone name with a space and a slash round-trips URL-encoded', async () => {
    const { token: admin } = await seedUser('admin')
    const zone = 'Floor 2 / East'
    await seedSeat('Desk 1', zone, { row: 1, column: 1 })
    await seedSeat('Desk 2', zone)
    expect(encodeURIComponent(zone)).toBe('Floor%202%20%2F%20East')

    const saved = await putZone(admin, zone, { frontLabel: 'Windows' })

    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({ name: zone, frontLabel: 'Windows', seats: 2, placed: 1 })
    expect(await prisma.seatZone.findUnique({ where: { name: zone } })).toEqual({ name: zone, frontLabel: 'Windows' })
    expect((await listZones(admin)).body).toEqual([{ name: zone, frontLabel: 'Windows', seats: 2, placed: 1 }])
  })

  it('locations that differ only in case are two zones', async () => {
    const { token: admin } = await seedUser('admin')
    // A librarian typed the location two ways: the console must show both, so the typo is visible.
    await seedSeat('Desk 1', 'Reading Room A', { row: 1, column: 1 })
    await seedSeat('Desk 2', 'Reading room A', { row: 1, column: 1 })
    await seedSeat('Desk 3', 'Reading room A')

    const before = await listZones(admin)
    expect(before.status).toBe(200)
    expect(before.body).toEqual([
      { name: 'Reading Room A', frontLabel: null, seats: 1, placed: 1 },
      { name: 'Reading room A', frontLabel: null, seats: 2, placed: 1 },
    ])

    // A label goes to the one zone it was saved for, matched by exact text.
    const saved = await putZone(admin, 'Reading room A', { frontLabel: 'Windows' })
    expect(saved.body).toEqual({ name: 'Reading room A', frontLabel: 'Windows', seats: 2, placed: 1 })
    expect((await listZones(admin)).body.map((z: { name: string; frontLabel: string | null }) => [z.name, z.frontLabel])).toEqual([
      ['Reading Room A', null],
      ['Reading room A', 'Windows'],
    ])
  })

  it('both routes answer 401 without a token and 403 for a student', async () => {
    const { token: student } = await seedUser()
    await seedSeat('Desk 1', 'Reading Room A')
    recorder = recordEvents()
    const calls: Array<(token?: string) => request.Test> = [
      (token) => withToken(request(app).get('/admin/zones'), token),
      (token) => withToken(request(app).put('/admin/zones/Reading%20Room%20A'), token).send({ frontLabel: 'Windows' }),
    ]

    for (const call of calls) {
      expect((await call()).status).toBe(401)
      expect((await call(student)).status).toBe(403)
    }
    // Nothing was written or published by any of the refused calls.
    expect(await prisma.seatZone.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })
})
