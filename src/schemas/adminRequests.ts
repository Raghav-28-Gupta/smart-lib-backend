import { z } from 'zod'

export const adminRequestParamsSchema = z.object({
  kind: z.enum(['borrow', 'room']),
  id: z.string().min(1),
})

// Optional and trimmed; the route turns an empty reason into none. A decline
// with no body at all (Express 5 leaves req.body undefined) means no reason.
export const declineRequestSchema = z.object({ reason: z.string().trim().max(300).optional() }).default({})
