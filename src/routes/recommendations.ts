import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { getRecommendations } from '../services/recommendationService'

export const recommendationsRouter = Router()

recommendationsRouter.get('/recommendations/me', requireAuth, async (req, res) => {
  res.json(await getRecommendations(req.user!.sub))
})
