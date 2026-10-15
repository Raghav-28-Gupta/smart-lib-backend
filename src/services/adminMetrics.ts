// Pure arithmetic behind the admin Dashboard (GET /admin/metrics/*). Each
// function takes rows already loaded for its window plus "now", and returns
// a response body. Everything uses library time: the server's local time
// zone, which production sets with TZ=Asia/Kolkata (config/timezone.ts).
import { TIME_SLOTS } from '../config/constants'

export interface ResourceRow {
  id: string
  type: 'seat' | 'room'
  location: string | null
}

export interface BookingRow {
  resourceId: string
  startTime: Date
  endTime: Date
  status: string
}

export interface UtilizationDto {
  today: { date: string; percent: number; lastWeekPercent: number }
  days: { date: string; seatPercent: number; roomPercent: number }[]
}

export interface DemandDto {
  areas: { area: string; percent: number; busiestSlot: string | null }[]
}

const HOUR_MS = 60 * 60 * 1000
export const WINDOW_DAYS = 7

/** Midnight at the start of `d`'s day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Midnight of the day `offset` days from `d`'s day (negative goes back). */
export function addDays(d: Date, offset: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset)
}

/** 'YYYY-MM-DD' for `d`'s day. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The 7 days ending on `now`'s day, oldest first. */
export function windowDays(now: Date): Date[] {
  const today = startOfDay(now)
  return Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i - (WINDOW_DAYS - 1)))
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((100 * part) / whole)) : 0
}

function overlapHours(b: BookingRow, from: Date, to: Date): number {
  const ms = Math.min(b.endTime.getTime(), to.getTime()) - Math.max(b.startTime.getTime(), from.getTime())
  return ms > 0 ? ms / HOUR_MS : 0
}

/**
 * Booked hours per slot label for these resources over these days. Cancelled
 * bookings don't count; anything outside the open slots never counts.
 */
function bookedHoursBySlot(bookings: BookingRow[], resourceIds: Set<string>, days: Date[]): Map<string, number> {
  const bySlot = new Map<string, number>(TIME_SLOTS.map((s) => [s.label, 0]))
  for (const b of bookings) {
    if (b.status === 'cancelled' || !resourceIds.has(b.resourceId)) continue
    for (const day of days) {
      for (const slot of TIME_SLOTS) {
        const from = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour)
        const to = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour + 1)
        const hours = overlapHours(b, from, to)
        if (hours > 0) bySlot.set(slot.label, (bySlot.get(slot.label) ?? 0) + hours)
      }
    }
  }
  return bySlot
}

function total(bySlot: Map<string, number>): number {
  let sum = 0
  for (const hours of bySlot.values()) sum += hours
  return sum
}

/** Booked share (0-100) of these resources' open hours over these days. */
export function bookedPercent(bookings: BookingRow[], resources: ResourceRow[], days: Date[]): number {
  const bySlot = bookedHoursBySlot(bookings, new Set(resources.map((r) => r.id)), days)
  return percent(total(bySlot), resources.length * TIME_SLOTS.length * days.length)
}

export function computeUtilization(bookings: BookingRow[], resources: ResourceRow[], now: Date): UtilizationDto {
  const today = startOfDay(now)
  const seats = resources.filter((r) => r.type === 'seat')
  const rooms = resources.filter((r) => r.type === 'room')
  return {
    today: {
      date: isoDate(today),
      percent: bookedPercent(bookings, resources, [today]),
      lastWeekPercent: bookedPercent(bookings, resources, [addDays(today, -WINDOW_DAYS)]),
    },
    days: windowDays(now).map((day) => ({
      date: isoDate(day),
      seatPercent: bookedPercent(bookings, seats, [day]),
      roomPercent: bookedPercent(bookings, rooms, [day]),
    })),
  }
}

/** The area a resource belongs to on the demand chart. */
export function areaOf(r: ResourceRow): string {
  return r.location ?? (r.type === 'seat' ? 'Seats' : 'Rooms')
}

export function computeDemand(bookings: BookingRow[], resources: ResourceRow[], now: Date): DemandDto {
  const days = windowDays(now)
  const byArea = new Map<string, ResourceRow[]>()
  for (const r of resources) byArea.set(areaOf(r), [...(byArea.get(areaOf(r)) ?? []), r])

  const areas = [...byArea].map(([area, members]) => {
    const bySlot = bookedHoursBySlot(bookings, new Set(members.map((r) => r.id)), days)
    let busiestSlot: string | null = null
    let busiestHours = 0
    // TIME_SLOTS is in time order, so a tie keeps the earliest slot.
    for (const slot of TIME_SLOTS) {
      const hours = bySlot.get(slot.label) ?? 0
      if (hours > busiestHours) {
        busiestSlot = slot.label
        busiestHours = hours
      }
    }
    return { area, percent: percent(total(bySlot), members.length * TIME_SLOTS.length * days.length), busiestSlot }
  })
  areas.sort((a, b) => b.percent - a.percent || a.area.localeCompare(b.area))
  return { areas }
}

export interface LoanRow {
  bookId: string
  title: string
  borrowedAt: Date
  dueAt: Date
  returnedAt: Date | null
}

export interface CirculationDto {
  borrows: number
  returns: number
  topTitles: { bookId: string; title: string; borrows: number }[]
}

export interface OverdueDto {
  count: number
  countYesterday: number
}

const TOP_TITLES = 5

export function computeCirculation(loans: LoanRow[], now: Date): CirculationDto {
  const from = windowDays(now)[0]
  const inWindow = (d: Date | null) => d !== null && d >= from && d <= now
  const byBook = new Map<string, { bookId: string; title: string; borrows: number }>()
  let borrows = 0
  let returns = 0
  for (const l of loans) {
    if (inWindow(l.borrowedAt)) {
      borrows++
      const entry = byBook.get(l.bookId) ?? { bookId: l.bookId, title: l.title, borrows: 0 }
      entry.borrows++
      byBook.set(l.bookId, entry)
    }
    if (inWindow(l.returnedAt)) returns++
  }
  const topTitles = [...byBook.values()]
    .sort((a, b) => b.borrows - a.borrows || a.title.localeCompare(b.title))
    .slice(0, TOP_TITLES)
  return { borrows, returns, topTitles }
}

/** Loans that were out and past due at the moment `t`. */
export function overdueAt(loans: LoanRow[], t: Date): number {
  return loans.filter((l) => l.borrowedAt <= t && (l.returnedAt === null || l.returnedAt > t) && l.dueAt < t).length
}

export function computeOverdue(loans: LoanRow[], now: Date): OverdueDto {
  return { count: overdueAt(loans, now), countYesterday: overdueAt(loans, new Date(now.getTime() - 24 * HOUR_MS)) }
}
