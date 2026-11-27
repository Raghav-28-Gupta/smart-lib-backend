import { z } from 'zod'

const resourceType = z.enum(['seat', 'room'])
const name = z.string().trim().min(1).max(100)
// Optional; a blank location means none, so the console can clear the field.
const location = z
  .string()
  .trim()
  .max(100)
  .transform((value) => (value === '' ? null : value))
const capacity = z.number().int().min(1).max(100)
// A place on the seat map: a whole row or column number, 1 to 50. The rules that
// need the whole seat (both or neither, seats only, a location) are the
// service's, since a PATCH is checked against the stored seat.
const position = z.number().int().min(1).max(50)

export const adminResourcesQuerySchema = z.object({ type: resourceType.optional() })

export const adminResourceParamsSchema = z.object({ id: z.string().min(1) })

export const createResourceSchema = z.object({
  type: resourceType,
  name,
  location: location.nullish(),
  capacity,
  row: position.nullish(),
  column: position.nullish(),
})

// The type is locked after creation: a `type` in the body is not a field here,
// so zod drops it, and a body of only a type counts as no fields. A row or a
// column counts as a field, a null one included (it takes the seat off the map).
export const updateResourceSchema = z
  .object({
    name: name.optional(),
    location: location.nullish(),
    capacity: capacity.optional(),
    row: position.nullish(),
    column: position.nullish(),
  })
  .refine((fields) => Object.values(fields).some((value) => value !== undefined), { message: 'Send at least one field to change' })

// Optional and trimmed; the route turns an empty note into none. A request with
// no body at all (Express 5 leaves req.body undefined) means no note.
export const takeOfflineSchema = z.object({ note: z.string().trim().max(300).optional() }).default({})
