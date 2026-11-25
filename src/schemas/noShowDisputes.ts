import { z } from 'zod'
import { MAX_DISPUTE_REASON_LENGTH } from './disputes'

// A booking's id is a uuid, but any non-empty text is let through: the service answers
// 404 for one that is not the caller's own stored booking (as for a fine's id).
export const noShowDisputeParamsSchema = z.object({ id: z.string().min(1) })

// Why the student thinks the no-show is wrong. Trimmed before the length check, so spaces
// alone are blank and spaces around 300 characters do not count (the same rules and the
// same limit as a fine dispute's reason).
export const createNoShowDisputeSchema = z.object({
  reason: z.string().trim().min(1).max(MAX_DISPUTE_REASON_LENGTH),
})

// A no-show dispute's id is a uuid, but any non-empty text is let through: the service answers
// 404 for one that is no dispute (an admin route, as slice 6's `adminDisputeParamsSchema`).
export const adminNoShowDisputeParamsSchema = z.object({ id: z.string().min(1) })

// The librarian's reason for removing a no-show: required, trimmed before the length check (spaces
// alone are blank), 1 to 300 characters. The student reads it back as the note on the outcome.
// No body at all (Express 5 leaves req.body undefined) fails like a missing reason: 400.
export const overturnNoShowSchema = z.object({
  reason: z.string().trim().min(1).max(MAX_DISPUTE_REASON_LENGTH),
})

// The librarian's optional note on a no-show that stands: trimmed first (the limit counts the
// trimmed text); the route turns an empty note into none. An uphold with no body at all means no
// note, like a fine dispute's.
export const upholdNoShowSchema = z.object({ note: z.string().trim().max(MAX_DISPUTE_REASON_LENGTH).optional() }).default({})
