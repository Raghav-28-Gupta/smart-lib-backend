import { z } from 'zod'

export const bookSearchQuerySchema = z.object({
  q: z.string().optional(),
  genre: z.string().optional(),
})

// Book.id is a plain String @id, not constrained to UUID format — the Phase 2
// seed script (mirroring the frontend's mock data) intentionally uses
// human-readable ids like 'b1'..'b12', so route validation accepts any
// non-empty string rather than z.uuid().
export const bookIdParamsSchema = z.object({ id: z.string().min(1) })
