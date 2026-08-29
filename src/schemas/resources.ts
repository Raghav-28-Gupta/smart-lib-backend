import { z } from 'zod'

export const availabilityQuerySchema = z.object({
  type: z.enum(['seat', 'room']),
  date: z.iso.date(),
})
