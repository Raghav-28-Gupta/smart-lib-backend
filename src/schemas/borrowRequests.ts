import { z } from 'zod'

export const createBorrowRequestSchema = z.object({ bookId: z.string().min(1) })

// Same non-UUID reasoning as loans.ts.
export const borrowRequestIdParamsSchema = z.object({ id: z.string().min(1) })
