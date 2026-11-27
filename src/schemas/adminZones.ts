import { z } from 'zod'

// The zone's name is a seat location, matched by exact text. The console
// URL-encodes it, so it can hold spaces and slashes; Express decodes it before
// it gets here. Locations are stored trimmed (adminResources), so trimming the
// name never hides a real zone.
export const adminZoneParamsSchema = z.object({ name: z.string().trim().min(1).max(100) })

// The label of the zone's front ("Windows", "Entrance"). Trimmed, at most 40
// characters; a blank one is allowed and means none (the service stores it as
// null), so the console can clear the field.
export const setZoneFrontLabelSchema = z.object({ frontLabel: z.string().trim().max(40) })
