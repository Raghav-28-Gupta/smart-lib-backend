import { z } from 'zod'

export const availabilityQuerySchema = z.object({
  type: z.enum(['seat', 'room']),
  date: z.iso.date(),
  // Opt-in: also return the resources a librarian took offline. Installed apps never send it.
  includeOffline: z.enum(['true', 'false']).optional(),
})
