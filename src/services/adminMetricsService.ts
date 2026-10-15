// Loads the rows each admin metric needs, for its window only, and hands
// them to the pure functions in adminMetrics.ts.
import type { Prisma } from '../generated/prisma/client'
import { prisma } from '../lib/prisma'
import {
  addDays,
  computeCirculation,
  computeDemand,
  computeOverdue,
  computeUtilization,
  startOfDay,
  windowDays,
  type CirculationDto,
  type DemandDto,
  type LoanRow,
  type OverdueDto,
  type UtilizationDto,
} from './adminMetrics'

async function resourcesAndBookings(from: Date, to: Date) {
  const [resources, bookings] = await Promise.all([
    prisma.resource.findMany({ select: { id: true, type: true, location: true } }),
    prisma.resourceBooking.findMany({
      where: { status: { not: 'cancelled' }, startTime: { lt: to }, endTime: { gt: from } },
      select: { resourceId: true, startTime: true, endTime: true, status: true },
    }),
  ])
  return { resources, bookings }
}

async function loadLoans(where: Prisma.LoanWhereInput): Promise<LoanRow[]> {
  const rows = await prisma.loan.findMany({
    where,
    select: {
      borrowedAt: true,
      dueAt: true,
      returnedAt: true,
      bookCopy: { select: { book: { select: { id: true, title: true } } } },
    },
  })
  return rows.map((r) => ({
    bookId: r.bookCopy.book.id,
    title: r.bookCopy.book.title,
    borrowedAt: r.borrowedAt,
    dueAt: r.dueAt,
    returnedAt: r.returnedAt,
  }))
}

export async function getUtilization(now = new Date()): Promise<UtilizationDto> {
  // From the same weekday last week through the end of today.
  const today = startOfDay(now)
  const { resources, bookings } = await resourcesAndBookings(addDays(today, -7), addDays(today, 1))
  return computeUtilization(bookings, resources, now)
}

export async function getDemand(now = new Date()): Promise<DemandDto> {
  const { resources, bookings } = await resourcesAndBookings(windowDays(now)[0], addDays(startOfDay(now), 1))
  return computeDemand(bookings, resources, now)
}

export async function getCirculation(now = new Date()): Promise<CirculationDto> {
  const from = windowDays(now)[0]
  const loans = await loadLoans({ OR: [{ borrowedAt: { gte: from } }, { returnedAt: { gte: from } }] })
  return computeCirculation(loans, now)
}

export async function getOverdue(now = new Date()): Promise<OverdueDto> {
  // Anything overdue now or 24 hours ago was due before now, and was either
  // still out or returned after that earlier moment.
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const loans = await loadLoans({ dueAt: { lt: now }, OR: [{ returnedAt: null }, { returnedAt: { gt: dayAgo } }] })
  return computeOverdue(loans, now)
}
