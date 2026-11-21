import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { listMyFines } from '../services/fineService'

export const finesRouter = Router()

// The student's own fines. The librarian's side is under /admin (routes/admin.ts).
finesRouter.get('/fines/me', requireAuth, async (req, res) => {
  res.json(await listMyFines(req.user!.sub))
})
