import { z } from 'zod'

// What the console shows and filters by. A stored `pending` fine is listed as
// `outstanding`, and `accruing` rows are computed from loans still out (see
// adminFineService), so the raw word `pending` is not a valid filter.
export const adminFineStatuses = ['accruing', 'outstanding', 'adjusted', 'paid', 'waived'] as const

export const MAX_FINE_PAGE_SIZE = 100
export const MAX_FINE_SEARCH_LENGTH = 100

// A cap that no real list reaches, so a huge page number is a 400 and never
// an OFFSET that overflows the database's integer.
const MAX_FINE_PAGE = 100_000

export const adminFinesQuerySchema = z.object({
  // Trimmed before the length check; a search of only spaces comes out empty,
  // which the service ignores.
  search: z.string().trim().max(MAX_FINE_SEARCH_LENGTH).optional(),
  status: z.enum(adminFineStatuses).optional(),
  page: z.coerce.number().int().min(1).max(MAX_FINE_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_FINE_PAGE_SIZE).default(25),
})
