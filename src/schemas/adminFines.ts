import { z } from 'zod'

// What the console shows and filters by. A stored `pending` fine is listed as
// `outstanding`, `accruing` rows are computed from loans still out, and a fine
// with an open dispute is listed as `disputed` instead of outstanding or adjusted
// (see adminFineService), so the raw word `pending` is not a valid filter.
export const adminFineStatuses = ['accruing', 'outstanding', 'adjusted', 'disputed', 'paid', 'waived'] as const

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

// A fine's id is a uuid, but an accruing row's id (a loan's) is on the same list;
// any non-empty text is let through and the service answers 404 for one that is
// not a stored fine.
export const adminFineParamsSchema = z.object({ id: z.string().min(1) })

export const MAX_FINE_REASON_LENGTH = 300

// The amount the librarian saw and collected, in whole rupees. The payment is
// recorded only if the fine is still exactly that amount (see markFinePaid), so
// one that a colleague lowered a moment ago is not recorded as paid in full.
export const markFinePaidSchema = z.object({ amount: z.number().int().min(0) })

// Whole rupees, never below 0. That the amount is LOWER than the fine's current
// one depends on the stored row, so the service checks it. The reason is
// required: it is what the student sees as the library's note.
//
// `disputeId` is the id of the open dispute the librarian saw with the fine, or
// absent (or null) when the fine showed none, the way mark-paid carries the amount
// it saw. Whether it is the fine's open dispute depends on the stored rows, so the
// service checks it (see adjustFine).
export const adjustFineSchema = z.object({
  amount: z.number().int().min(0),
  reason: z.string().trim().min(1).max(MAX_FINE_REASON_LENGTH),
  disputeId: z.string().min(1).nullish(),
})
