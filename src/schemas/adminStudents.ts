import { z } from 'zod'

// A student's id is a uuid, but any non-empty text is let through and the
// service answers 404 for one that is not a student (an admin's id included).
export const adminStudentParamsSchema = z.object({ id: z.string().min(1) })

export const MAX_RELIABILITY_ADJUSTMENT = 10
export const MAX_RELIABILITY_REASON_LENGTH = 300

// A whole number of points from -10 to 10, never 0 (nothing to apply). Whether
// the clamp to 0-100 would leave the score unchanged depends on the stored score,
// so the service checks that. The reason is required: it is what the student sees
// on their reliability card, after "Library adjustment: ".
export const adjustReliabilitySchema = z.object({
  delta: z
    .number()
    .int()
    .min(-MAX_RELIABILITY_ADJUSTMENT)
    .max(MAX_RELIABILITY_ADJUSTMENT)
    .refine((delta) => delta !== 0, 'delta must not be 0'),
  reason: z.string().trim().min(1).max(MAX_RELIABILITY_REASON_LENGTH),
})
