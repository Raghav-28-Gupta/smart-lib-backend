import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { borrowRequestIdParamsSchema, createBorrowRequestSchema } from '../schemas/borrowRequests'
import { cancelBorrowRequest, createBorrowRequest, listMyBorrowRequests } from '../services/borrowRequestService'

export const borrowRequestsRouter = Router()

borrowRequestsRouter.post('/borrow-requests', requireAuth, validate({ body: createBorrowRequestSchema }), async (req, res) => {
  const { bookId } = req.body as { bookId: string }
  res.status(201).json(await createBorrowRequest(req.user!.sub, bookId))
})

borrowRequestsRouter.get('/borrow-requests/me', requireAuth, async (req, res) => {
  res.json(await listMyBorrowRequests(req.user!.sub))
})

borrowRequestsRouter.post(
  '/borrow-requests/:id/cancel',
  requireAuth,
  validate({ params: borrowRequestIdParamsSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    res.json(await cancelBorrowRequest(req.user!.sub, id))
  },
)
