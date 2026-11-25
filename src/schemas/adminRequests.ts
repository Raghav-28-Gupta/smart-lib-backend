import { z } from 'zod'

export const adminRequestParamsSchema = z.object({
  kind: z.enum(['borrow', 'room']),
  id: z.string().min(1),
})

// How the list is ordered: 'suggested' (the default) puts room requests by their bounded priority,
// 'request' is plain request time. Anything else is a 400.
export const adminRequestsQuerySchema = z.object({
  order: z.enum(['suggested', 'request']).default('suggested'),
})

// Optional and trimmed; the route turns an empty reason into none. A decline
// with no body at all (Express 5 leaves req.body undefined) means no reason.
export const declineRequestSchema = z.object({ reason: z.string().trim().max(300).optional() }).default({})
