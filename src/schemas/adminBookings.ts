import { z } from 'zod'

// What the console shows and filters by, worked out at read time (see
// adminBookingService). Raw no_show, requested, declined and expired rows are
// never listed, so none of them is a valid filter.
export const adminBookingStatuses = ['booked', 'released', 'checked_in', 'completed', 'cancelled'] as const

export const MAX_BOOKING_PAGE_SIZE = 100
export const MAX_BOOKING_SEARCH_LENGTH = 100

// A cap that no real list reaches, so a huge page number is a 400 and never
// an OFFSET that overflows the database's integer.
const MAX_BOOKING_PAGE = 100_000

export const adminBookingsQuerySchema = z.object({
  // Trimmed before the length check; a search of only spaces comes out empty,
  // which the service ignores.
  search: z.string().trim().max(MAX_BOOKING_SEARCH_LENGTH).optional(),
  status: z.enum(adminBookingStatuses).optional(),
  page: z.coerce.number().int().min(1).max(MAX_BOOKING_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_BOOKING_PAGE_SIZE).default(25),
})

export const adminBookingParamsSchema = z.object({ id: z.string().min(1) })

// Optional and trimmed; the route turns an empty reason into none. A cancel with
// no body at all (Express 5 leaves req.body undefined) means no reason.
export const cancelBookingSchema = z.object({ reason: z.string().trim().max(300).optional() }).default({})

export const reassignBookingSchema = z.object({ resourceId: z.string().min(1) })
