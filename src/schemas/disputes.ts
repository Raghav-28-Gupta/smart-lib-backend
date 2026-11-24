import { z } from 'zod'

export const MAX_DISPUTE_REASON_LENGTH = 300

// A fine's id is a uuid, but any non-empty text is let through: the service
// answers 404 for one that is not the caller's own stored fine.
export const disputeParamsSchema = z.object({ id: z.string().min(1) })

// Why the student thinks the fine is wrong. Trimmed before the length check, so
// spaces alone are blank and spaces around 300 characters do not count.
export const createDisputeSchema = z.object({
  reason: z.string().trim().min(1).max(MAX_DISPUTE_REASON_LENGTH),
})

export const MAX_RESOLUTION_NOTE_LENGTH = 300

// A dispute's id is a uuid, but any non-empty text is let through: the service
// answers 404 for one that is not a dispute.
export const adminDisputeParamsSchema = z.object({ id: z.string().min(1) })

// The librarian's optional note to the student, trimmed first (the limit counts the
// trimmed text); the route turns an empty note into none. An uphold with no body at
// all (Express 5 leaves req.body undefined) means no note.
export const upholdDisputeSchema = z.object({ note: z.string().trim().max(MAX_RESOLUTION_NOTE_LENGTH).optional() }).default({})
