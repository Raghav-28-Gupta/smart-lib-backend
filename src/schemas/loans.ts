import { z } from 'zod'
import { otherNeedsANote, reportNoteSchema } from './reports'

export const createLoanSchema = z.object({ bookId: z.string().min(1) })

// Loan.id is a plain String @id (see books.ts for the same reasoning) —
// human-readable seed ids, not UUIDs, so route params accept any non-empty string.
export const loanIdParamsSchema = z.object({ id: z.string().min(1) })

// A copy is reported as it is returned: damaged, missing pages or something else (which
// needs a note). The seat and room categories are for POST /reports, so they are a 400
// here. The note's rules (trimmed, at most 300 characters, blank is none) are the
// resource report's, from schemas/reports.ts.
const returnReportSchema = z
  .object({
    category: z.enum(['damaged', 'missing_pages', 'other']),
    note: reportNoteSchema,
  })
  .refine(otherNeedsANote.check, otherNeedsANote.params)

// The body of a return is optional: the older app sends none (Express leaves req.body
// undefined, which the default turns into an empty object) and a return without a
// `report` is just a return.
export const returnLoanSchema = z.object({ report: returnReportSchema.optional() }).default({})
