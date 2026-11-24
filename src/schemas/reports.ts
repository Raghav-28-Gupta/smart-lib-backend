import { z } from 'zod'

export const MAX_REPORT_NOTE_LENGTH = 300

// What the student says about the problem. Trimmed before the length check, so spaces
// around 300 characters do not count, and an empty (or null, or missing) note is none:
// the service and the database only ever see text or undefined.
export const reportNoteSchema = z
  .string()
  .trim()
  .max(MAX_REPORT_NOTE_LENGTH)
  .nullish()
  .transform((note) => note || undefined)

// `other` is the one category that says nothing by itself, so it needs a note. The same
// rule for a seat or room (below) and for a copy reported as it is returned (schemas/loans.ts).
export const otherNeedsANote = {
  check: (report: { category: string; note?: string }) => report.category !== 'other' || report.note !== undefined,
  params: { message: 'A note is required for the category "other".', path: ['note'] },
}

// A seat or room is reported as not working, dirty or something else (which needs a
// note). The copy categories (damaged, missing_pages) are for a book copy, reported
// as it is returned, so they are a 400 here. A resource id is a uuid, but any
// non-empty text is let through: the service answers 403 for one the student has not
// booked, which an unknown id is.
export const createResourceReportSchema = z
  .object({
    resourceId: z.string().min(1),
    category: z.enum(['not_working', 'dirty', 'other']),
    note: reportNoteSchema,
  })
  .refine(otherNeedsANote.check, otherNeedsANote.params)
