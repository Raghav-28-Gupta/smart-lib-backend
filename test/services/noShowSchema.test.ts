// Slice 7, Task 1: the no-show schema, its constants and the migration's backfill.
// The sweep, the reminders and the disputes themselves are tested in their own files.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PENALTY_CAP,
  NO_SHOW_DISPUTE_DAYS,
  NO_SHOW_PRIOR_ATTENDANCE,
  PREDICT_TIMEOUT_MS,
  PRIORITY_WINDOW_HOURS,
  REMINDER_LEAD_MINUTES,
  RELIABILITY_NOSHOW_PENALTY,
  SWEEP_BATCH,
  SWEEP_LOOKBACK_HOURS,
} from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { createNotice } from '../../src/services/noticeService'
import { resetDb } from '../helpers/db'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations')

/** The slice's migration file: read from disk so the test runs the SQL that ships, not a copy of it. */
function noShowMigrationSql(): string {
  const folders = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('_no_show_handling'))
  expect(folders, 'exactly one migration folder ends in _no_show_handling').toHaveLength(1)
  return readFileSync(path.join(MIGRATIONS_DIR, folders[0], 'migration.sql'), 'utf8')
}

/** The migration's statements, comments removed, in order. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

async function seedUser(role: 'student' | 'admin' = 'student') {
  return prisma.user.create({ data: { name: `User ${Math.random()}`, email: `user${Math.random()}@example.org`, passwordHash: 'x', role } })
}

function seedResource(type: 'seat' | 'room' = 'seat') {
  return prisma.resource.create({ data: { type, name: `Desk ${Math.random()}`, capacity: 1 } })
}

/** A booking starting `startsInMs` from now (negative: that long ago) and lasting an hour. */
function seedBooking(
  userId: string,
  resourceId: string,
  startsInMs: number,
  overrides: Partial<{ status: 'booked' | 'checked_in' | 'no_show' | 'released'; gracePeriodMinutes: number }> = {},
) {
  const startTime = new Date(Date.now() + startsInMs)
  return prisma.resourceBooking.create({
    data: { userId, resourceId, startTime, endTime: new Date(startTime.getTime() + HOUR_MS), ...overrides },
  })
}

beforeEach(resetDb)

describe('NoShowEvent', () => {
  it('a NoShowEvent can be created with no predicted probability', async () => {
    const student = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, -3 * HOUR_MS)

    const event = await prisma.noShowEvent.create({
      data: { resourceBookingId: booking.id, userId: student.id, actualNoShow: true, reliabilityDelta: -10 },
    })

    expect(await prisma.noShowEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      predictedProbability: null,
      actualNoShow: true,
      reliabilityDelta: -10,
    })
  })

  it('still stores a probability, and a delta of null when nothing was taken', async () => {
    const student = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, 2 * HOUR_MS)

    const event = await prisma.noShowEvent.create({
      data: { resourceBookingId: booking.id, userId: student.id, predictedProbability: 0.37 },
    })

    expect(await prisma.noShowEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      predictedProbability: 0.37,
      actualNoShow: null,
      reliabilityDelta: null,
    })
  })
})

describe('Notice.bookingId', () => {
  it('a notice can link to a booking and the link is cleared when the booking is deleted', async () => {
    const student = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, -3 * HOUR_MS)
    const notice = await prisma.notice.create({
      data: { userId: student.id, kind: 'no_show', title: 'Missed booking', body: 'You did not check in.', bookingId: booking.id },
    })
    expect((await prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).bookingId).toBe(booking.id)
    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id }, include: { notices: true } })).notices.map((n) => n.id)).toEqual([notice.id])

    await prisma.resourceBooking.delete({ where: { id: booking.id } })

    // The text was rendered when the notice was written, so the notice stays and only loses its link.
    expect(await prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({
      userId: student.id,
      kind: 'no_show',
      title: 'Missed booking',
      body: 'You did not check in.',
      bookingId: null,
    })
  })

  it('createNotice writes the booking link, and leaves it null when none is given', async () => {
    const student = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, 20 * MINUTE_MS)

    const linked = await prisma.$transaction((tx) =>
      createNotice(tx, { userId: student.id, kind: 'booking_reminder', title: 'Your booking starts soon', body: 'Desk, 3:00 PM.', bookingId: booking.id }),
    )
    const plain = await prisma.$transaction((tx) =>
      createNotice(tx, { userId: student.id, kind: 'dispute_outcome', title: 'Your fine stands', body: 'The library kept your fine.' }),
    )

    expect(await prisma.notice.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ kind: 'booking_reminder', bookingId: booking.id })
    expect((await prisma.notice.findUniqueOrThrow({ where: { id: plain.id } })).bookingId).toBeNull()
  })

  it('the three new notice kinds can be stored', async () => {
    const student = await seedUser()
    for (const kind of ['booking_reminder', 'no_show', 'no_show_outcome'] as const) {
      await prisma.notice.create({ data: { userId: student.id, kind, title: kind, body: kind } })
    }
    const kinds = (await prisma.notice.findMany({ where: { userId: student.id } })).map((n) => n.kind).sort()
    expect(kinds).toEqual(['booking_reminder', 'no_show', 'no_show_outcome'])
  })
})

describe('ResourceBooking.reminderSentAt', () => {
  it('a booking keeps a reminderSentAt, and starts without one', async () => {
    const student = await seedUser()
    const resource = await seedResource('room')
    const booking = await seedBooking(student.id, resource.id, 20 * MINUTE_MS)
    expect(booking.reminderSentAt).toBeNull()

    const sentAt = new Date(Date.now() - 5 * MINUTE_MS)
    await prisma.resourceBooking.update({ where: { id: booking.id }, data: { reminderSentAt: sentAt } })

    expect((await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id } })).reminderSentAt?.getTime()).toBe(sentAt.getTime())
  })
})

describe('NoShowDispute', () => {
  it('a booking has at most one dispute, and it starts open', async () => {
    const student = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, -3 * HOUR_MS, { status: 'no_show' })

    const dispute = await prisma.noShowDispute.create({ data: { bookingId: booking.id, userId: student.id, reason: 'I was there.' } })

    expect(dispute).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
    await expect(
      prisma.noShowDispute.create({ data: { bookingId: booking.id, userId: student.id, reason: 'Again.' } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^P2002$|^P2039$/) })
    const withBooking = await prisma.resourceBooking.findUniqueOrThrow({ where: { id: booking.id }, include: { noShowDispute: true } })
    expect(withBooking.noShowDispute?.id).toBe(dispute.id)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id }, include: { noShowDisputes: true } })).noShowDisputes.map((d) => d.id)).toEqual([dispute.id])
  })

  it("is answered by a librarian, and the answer stays when that librarian's account goes", async () => {
    const student = await seedUser()
    const librarian = await seedUser('admin')
    const resource = await seedResource()
    const booking = await seedBooking(student.id, resource.id, -3 * HOUR_MS, { status: 'no_show' })
    const dispute = await prisma.noShowDispute.create({
      data: { bookingId: booking.id, userId: student.id, reason: 'I was there.', status: 'overturned', resolutionNote: 'The desk log agrees.', resolvedById: librarian.id, resolvedAt: new Date() },
    })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: librarian.id }, include: { resolvedNoShowDisputes: true } })).resolvedNoShowDisputes.map((d) => d.id)).toEqual([dispute.id])

    await prisma.user.delete({ where: { id: librarian.id } })

    expect(await prisma.noShowDispute.findUniqueOrThrow({ where: { id: dispute.id } })).toMatchObject({
      status: 'overturned',
      resolutionNote: 'The desk log agrees.',
      resolvedById: null,
    })
  })

  it('cannot outlive its booking or its student: both deletes are refused', async () => {
    const owner = await seedUser()
    // A student with no booking of their own, so only the dispute stands between them and a delete.
    const disputer = await seedUser()
    const resource = await seedResource()
    const booking = await seedBooking(owner.id, resource.id, -3 * HOUR_MS, { status: 'no_show' })
    await prisma.noShowDispute.create({ data: { bookingId: booking.id, userId: disputer.id, reason: 'I was there.' } })

    await expect(prisma.resourceBooking.delete({ where: { id: booking.id } })).rejects.toThrow()
    await expect(prisma.user.delete({ where: { id: disputer.id } })).rejects.toThrow()
    expect(await prisma.noShowDispute.count()).toBe(1)
  })
})

describe('the no-show constants', () => {
  it('carry the values the spec gives', () => {
    expect({
      RELIABILITY_NOSHOW_PENALTY,
      SWEEP_LOOKBACK_HOURS,
      REMINDER_LEAD_MINUTES,
      SWEEP_BATCH,
      NO_SHOW_DISPUTE_DAYS,
      MAX_PENALTY_CAP,
      PRIORITY_WINDOW_HOURS,
      PREDICT_TIMEOUT_MS,
      NO_SHOW_PRIOR_ATTENDANCE,
    }).toEqual({
      RELIABILITY_NOSHOW_PENALTY: 10,
      SWEEP_LOOKBACK_HOURS: 24,
      REMINDER_LEAD_MINUTES: 30,
      SWEEP_BATCH: 200,
      NO_SHOW_DISPUTE_DAYS: 7,
      MAX_PENALTY_CAP: 0.2,
      PRIORITY_WINDOW_HOURS: 6,
      PREDICT_TIMEOUT_MS: 2000,
      NO_SHOW_PRIOR_ATTENDANCE: 0.85,
    })
  })
})

describe('the no_show_handling migration', () => {
  it('the backfill statement, read from the migration file and run on rows, turns past booked rows into released and leaves future booked, checked_in and no_show rows alone', async () => {
    const statements = statementsOf(noShowMigrationSql())
    const backfill = statements[statements.length - 1]
    expect(backfill, 'the backfill is the migration\'s last statement').toMatch(/^UPDATE "ResourceBooking"\s+SET status = 'released'/)

    const student = await seedUser()
    // One resource per booking, so none of them can collide on the overlap constraint.
    const book = async (startsInMs: number, overrides: Parameters<typeof seedBooking>[3] = {}) =>
      seedBooking(student.id, (await seedResource()).id, startsInMs, overrides)
    const pastBooked = await book(-3 * HOUR_MS)
    const longPastBooked = await book(-30 * DAY_MS)
    // A longer grace period that is still running: it started 40 minutes ago with an hour's grace.
    const longGraceStillOpen = await book(-40 * MINUTE_MS, { gracePeriodMinutes: 60 })
    // A longer grace period that has ended: it started 2 hours ago with half an hour's grace.
    const longGraceEnded = await book(-2 * HOUR_MS, { gracePeriodMinutes: 30 })
    const inGrace = await book(-5 * MINUTE_MS)
    const futureBooked = await book(3 * HOUR_MS)
    const pastCheckedIn = await book(-3 * HOUR_MS, { status: 'checked_in' })
    const pastNoShow = await book(-3 * HOUR_MS, { status: 'no_show' })
    const pastReleased = await book(-3 * HOUR_MS, { status: 'released' })

    await prisma.$executeRawUnsafe(backfill)

    const status = async (id: string) => (await prisma.resourceBooking.findUniqueOrThrow({ where: { id } })).status
    expect(await status(pastBooked.id)).toBe('released')
    expect(await status(longPastBooked.id)).toBe('released')
    expect(await status(longGraceEnded.id)).toBe('released')
    expect(await status(longGraceStillOpen.id)).toBe('booked')
    expect(await status(inGrace.id)).toBe('booked')
    expect(await status(futureBooked.id)).toBe('booked')
    expect(await status(pastCheckedIn.id)).toBe('checked_in')
    expect(await status(pastNoShow.id)).toBe('no_show')
    expect(await status(pastReleased.id)).toBe('released')
    // A pure status change: no penalty, no no-show record, no notice, nothing else on the row.
    expect(await prisma.noShowEvent.count()).toBe(0)
    expect(await prisma.notice.count()).toBe(0)
    expect(await prisma.reliabilityScoreLog.count()).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).reliabilityScore).toBe(100)
  })

  it("drops none of the hand-written constraints and leaves the copy barcodes alone", () => {
    const sql = noShowMigrationSql()
    for (const name of [
      'no_overlapping_bookings',
      'BorrowRequest_one_pending_per_title',
      'IssueReport_exactly_one_target',
      'IssueReport_one_open_per_copy',
      'IssueReport_one_open_per_resource',
    ]) {
      expect(sql, `the migration never mentions ${name}`).not.toContain(name)
    }
    expect(sql).not.toMatch(/\bDROP\s+(CONSTRAINT|INDEX)\b/i)
    expect(sql).not.toMatch(/barcode|next_copy_barcode/i)
    // New enum values are added in place; nothing is dropped or recreated.
    expect(sql).not.toMatch(/\bDROP\s+TYPE\b/i)
  })

  it('the hand-written constraints are still there', async () => {
    const constraints = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conname IN ('no_overlapping_bookings', 'IssueReport_exactly_one_target')`
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('BorrowRequest_one_pending_per_title', 'IssueReport_one_open_per_copy', 'IssueReport_one_open_per_resource')`

    expect(constraints.map((c) => c.conname).sort()).toEqual(['IssueReport_exactly_one_target', 'no_overlapping_bookings'])
    expect(indexes.map((i) => i.indexname).sort()).toEqual([
      'BorrowRequest_one_pending_per_title',
      'IssueReport_one_open_per_copy',
      'IssueReport_one_open_per_resource',
    ])
  })
})
