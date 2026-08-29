import { z } from 'zod'

export const createBookingSchema = z.object({
  resourceId: z.string().min(1),
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
})

// Same non-UUID reasoning as books.ts / loans.ts / reservations.ts.
export const bookingIdParamsSchema = z.object({ id: z.string().min(1) })
