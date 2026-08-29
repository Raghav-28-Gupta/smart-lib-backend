import { Router } from 'express'
import { validate } from '../middleware/validate'
import { availabilityQuerySchema } from '../schemas/resources'
import { getAvailability } from '../services/resourceService'

export const resourcesRouter = Router()

resourcesRouter.get('/resources/availability', validate({ query: availabilityQuerySchema }), async (req, res) => {
  const { type, date } = req.validatedQuery as { type: 'seat' | 'room'; date: string }
  res.json(await getAvailability(type, date))
})
