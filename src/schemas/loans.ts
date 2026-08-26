import { z } from 'zod'

export const createLoanSchema = z.object({ bookId: z.string().min(1) })

// Loan.id is a plain String @id (see books.ts for the same reasoning) —
// human-readable seed ids, not UUIDs, so route params accept any non-empty string.
export const loanIdParamsSchema = z.object({ id: z.string().min(1) })
