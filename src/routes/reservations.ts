import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { createReservationSchema, reservationIdParamsSchema } from '../schemas/reservations'
import { cancelReservation, joinWaitlist, listMyReservations } from '../services/reservationService'

export const reservationsRouter = Router()

reservationsRouter.post('/reservations', requireAuth, validate({ body: createReservationSchema }), async (req, res) => {
  const { bookId } = req.body as { bookId: string }
  const reservation = await joinWaitlist(req.user!.sub, bookId)
  res.status(201).json(reservation)
})

reservationsRouter.get('/reservations/me', requireAuth, async (req, res) => {
  res.json(await listMyReservations(req.user!.sub))
})

reservationsRouter.delete(
  '/reservations/:id',
  requireAuth,
  validate({ params: reservationIdParamsSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    res.json(await cancelReservation(req.user!.sub, id))
  },
)
