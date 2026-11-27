import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedUser() {
  return prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x' },
  })
}

function atLocalHour(dateStr: string, hour: number) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, hour, 0, 0)
}

describe('GET /resources/availability', () => {
  beforeEach(resetDb)

  const DATE = '2026-09-01'

  it('lists only resources of the requested type', async () => {
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resource.create({ data: { type: 'room', name: 'Room 201' } })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].type).toBe('seat')
  })

  it('marks a slot taken when an active booking overlaps it', async () => {
    const user = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: atLocalHour(DATE, 11),
        endTime: atLocalHour(DATE, 12),
        status: 'booked',
      },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.body[0].takenSlotsToday).toEqual(['11:00 AM'])
  })

  it('does not mark slots taken by a booking on a different date', async () => {
    const user = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: atLocalHour('2026-09-02', 11),
        endTime: atLocalHour('2026-09-02', 12),
        status: 'booked',
      },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.body[0].takenSlotsToday).toEqual([])
  })

  it('ignores cancelled and released bookings', async () => {
    const user = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resourceBooking.createMany({
      data: [
        { userId: user.id, resourceId: resource.id, startTime: atLocalHour(DATE, 9), endTime: atLocalHour(DATE, 10), status: 'cancelled' },
        { userId: user.id, resourceId: resource.id, startTime: atLocalHour(DATE, 10), endTime: atLocalHour(DATE, 11), status: 'released' },
      ],
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.body[0].takenSlotsToday).toEqual([])
  })

  it('counts a checked_in booking as taken', async () => {
    const user = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: atLocalHour(DATE, 9),
        endTime: atLocalHour(DATE, 10),
        status: 'checked_in',
      },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.body[0].takenSlotsToday).toEqual(['9:00 AM'])
  })

  it('keeps each resource\'s taken slots independent', async () => {
    const user = await seedUser()
    const r1 = await prisma.resource.create({ data: { type: 'room', name: 'Room 201' } })
    const r2 = await prisma.resource.create({ data: { type: 'room', name: 'Room 202' } })
    await prisma.resourceBooking.create({
      data: { userId: user.id, resourceId: r1.id, startTime: atLocalHour(DATE, 14), endTime: atLocalHour(DATE, 15), status: 'booked' },
    })

    const res = await request(app).get(`/resources/availability?type=room&date=${DATE}`)
    const byName = Object.fromEntries(res.body.map((r: { name: string; takenSlotsToday: string[] }) => [r.name, r.takenSlotsToday]))
    expect(byName['Room 201']).toEqual(['2:00 PM'])
    expect(byName['Room 202']).toEqual([])
  })

  it('returns 400 for an invalid type', async () => {
    const res = await request(app).get(`/resources/availability?type=hammock&date=${DATE}`)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a malformed date', async () => {
    const res = await request(app).get('/resources/availability?type=seat&date=not-a-date')
    expect(res.status).toBe(400)
  })

  it('does not require authentication', async () => {
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(res.status).toBe(200)
  })

  it('marks a slot taken while a room request holds it', async () => {
    const user = await seedUser()
    const resource = await prisma.resource.create({ data: { type: 'room', name: 'Room 201' } })
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: resource.id,
        startTime: atLocalHour(DATE, 14),
        endTime: atLocalHour(DATE, 15),
        status: 'requested',
      },
    })

    const res = await request(app).get(`/resources/availability?type=room&date=${DATE}`)
    expect(res.body[0].takenSlotsToday).toEqual(['2:00 PM'])
  })

  it('availability leaves out offline resources', async () => {
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1' } })
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 2', status: 'offline', statusNote: 'Wobbly leg' } })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)

    expect(res.status).toBe(200)
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Desk 1'])
  })
})

describe('seat map fields', () => {
  beforeEach(resetDb)

  const DATE = '2026-09-01'

  it('each seat carries its row, column, status and its zone\'s front label', async () => {
    await prisma.seatZone.create({ data: { name: 'Reading Room A', frontLabel: 'Windows' } })
    await prisma.resource.create({
      data: { type: 'seat', name: 'Desk 14', location: 'Reading Room A', row: 2, column: 5 },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      name: 'Desk 14',
      location: 'Reading Room A',
      row: 2,
      column: 5,
      status: 'available',
      zoneFront: 'Windows',
    })
  })

  it('an unplaced seat and a room have null row and column, and zoneFront is null when the zone has no label', async () => {
    await prisma.seatZone.create({ data: { name: 'Silent Zone', frontLabel: null } })
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1', location: 'Silent Zone' } })
    await prisma.resource.create({ data: { type: 'room', name: 'Room 201', location: 'Second floor' } })

    const seats = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)
    expect(seats.body).toHaveLength(1)
    expect(seats.body[0]).toMatchObject({ row: null, column: null, status: 'available', zoneFront: null })

    const rooms = await request(app).get(`/resources/availability?type=room&date=${DATE}`)
    expect(rooms.body).toHaveLength(1)
    expect(rooms.body[0]).toMatchObject({ row: null, column: null, status: 'available', zoneFront: null })
  })

  it('without includeOffline an offline seat is left out, and each item has exactly the old keys plus the four new ones', async () => {
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1', location: 'Reading Room A', row: 1, column: 1 } })
    await prisma.resource.create({
      data: { type: 'seat', name: 'Desk 2', location: 'Reading Room A', row: 1, column: 2, status: 'offline' },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}`)

    expect(res.status).toBe(200)
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Desk 1'])
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'capacity',
      'column',
      'id',
      'location',
      'name',
      'row',
      'status',
      'takenSlotsToday',
      'type',
      'zoneFront',
    ])

    const explicitFalse = await request(app).get(`/resources/availability?type=seat&date=${DATE}&includeOffline=false`)
    expect(explicitFalse.status).toBe(200)
    expect(explicitFalse.body.map((r: { name: string }) => r.name)).toEqual(['Desk 1'])
  })

  it('includeOffline=true returns the offline seat with status offline and no taken slots, even when it has a booking that day', async () => {
    const user = await seedUser()
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1', location: 'Reading Room A', row: 1, column: 1 } })
    const offline = await prisma.resource.create({
      data: { type: 'seat', name: 'Desk 2', location: 'Reading Room A', row: 1, column: 2, status: 'offline' },
    })
    await prisma.resourceBooking.create({
      data: {
        userId: user.id,
        resourceId: offline.id,
        startTime: atLocalHour(DATE, 11),
        endTime: atLocalHour(DATE, 12),
        status: 'booked',
      },
    })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}&includeOffline=true`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    const byName = Object.fromEntries(res.body.map((r: { name: string }) => [r.name, r]))
    expect(byName['Desk 1']).toMatchObject({ status: 'available', row: 1, column: 1 })
    expect(byName['Desk 2']).toMatchObject({ status: 'offline', row: 1, column: 2, takenSlotsToday: [] })
  })

  it('includeOffline=yes is a 400', async () => {
    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}&includeOffline=yes`)
    expect(res.status).toBe(400)
  })

  it('items stay in name order with includeOffline=true', async () => {
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 3' } })
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 1', status: 'offline' } })
    await prisma.resource.create({ data: { type: 'seat', name: 'Desk 2' } })

    const res = await request(app).get(`/resources/availability?type=seat&date=${DATE}&includeOffline=true`)

    expect(res.status).toBe(200)
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Desk 1', 'Desk 2', 'Desk 3'])
  })
})
