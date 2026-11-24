import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { createDisputeSchema, disputeParamsSchema } from '../schemas/disputes'
import { createDispute } from '../services/disputeService'
import { listMyFines } from '../services/fineService'

export const finesRouter = Router()

// The student's own fines. The librarian's side is under /admin (routes/admin.ts).
finesRouter.get('/fines/me', requireAuth, async (req, res) => {
  res.json(await listMyFines(req.user!.sub))
})

// The student disputes one of their own outstanding or adjusted fines, once.
// Another student's fine answers 404 like an unknown id.
finesRouter.post(
  '/fines/:id/dispute',
  requireAuth,
  validate({ params: disputeParamsSchema, body: createDisputeSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { reason } = req.body as { reason: string }
    res.status(201).json(await createDispute(req.user!.sub, id, reason))
  },
)
