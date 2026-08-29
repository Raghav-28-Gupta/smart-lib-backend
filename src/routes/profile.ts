import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { getReliability } from '../services/reliabilityService'

export const profileRouter = Router()

profileRouter.get('/profile/reliability', requireAuth, async (req, res) => {
  res.json(await getReliability(req.user!.sub))
})
