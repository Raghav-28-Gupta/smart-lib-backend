import { z } from 'zod'

export const createReservationSchema = z.object({ bookId: z.string().min(1) })

// Same non-UUID reasoning as books.ts / loans.ts.
export const reservationIdParamsSchema = z.object({ id: z.string().min(1) })
