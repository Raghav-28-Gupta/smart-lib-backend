import { z } from 'zod'
import { reportNoteSchema } from './reports'

// What a queue item is about. The same three words name the console's chips and
// `?kind=` on the list; an unknown word is a 400, never a silently empty list.
export const attentionKinds = ['overdue', 'fine_dispute', 'report'] as const

export const adminAttentionQuerySchema = z.object({ kind: z.enum(attentionKinds).optional() })

// A loan's id is a plain text id (see loans.ts); any non-empty text is let
// through and the service answers 404 for one that is not a loan.
export const adminLoanParamsSchema = z.object({ id: z.string().min(1) })

export const MAX_ESCALATION_NOTE_LENGTH = 300

// Optional and trimmed (the limit counts the trimmed text); the route turns an
// empty note into none. An escalation with no body at all (Express 5 leaves
// req.body undefined) means no note. A reminder takes no body.
export const escalateLoanSchema = z.object({ note: z.string().trim().max(MAX_ESCALATION_NOTE_LENGTH).optional() }).default({})

// A report's id is a plain text id (the queue's `report` items carry it as their `id`); any
// non-empty text is let through and the service answers 404 for one that is not a report.
export const adminReportParamsSchema = z.object({ id: z.string().min(1) })

// Confirming a report. `outcome` is what to do with a copy (a resource report is always taken
// offline and ignores it; the service answers 400 "Choose what to do with the copy." for a copy
// report without one). The note is the report note's rule (trimmed, at most 300, blank means
// none). A confirm with no body at all (Express 5 leaves req.body undefined) means no outcome
// and no note, which is a complete request for a resource report.
export const confirmReportSchema = z.object({ outcome: z.enum(['maintenance', 'lost']).optional(), note: reportNoteSchema }).prefault({})

// Dismissing takes only the optional note; no body at all means no note.
export const dismissReportSchema = z.object({ note: reportNoteSchema }).prefault({})
