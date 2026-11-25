import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { bookingIdParamsSchema, createBookingSchema } from '../schemas/bookings'
import { createNoShowDisputeSchema, noShowDisputeParamsSchema } from '../schemas/noShowDisputes'
import { cancelBooking, checkInBooking, createBooking, listMyBookings } from '../services/bookingService'
import { createNoShowDispute } from '../services/noShowDisputeService'

export const bookingsRouter = Router()

bookingsRouter.post('/bookings', requireAuth, validate({ body: createBookingSchema }), async (req, res) => {
  const { resourceId, startTime, endTime } = req.body as { resourceId: string; startTime: string; endTime: string }
  const booking = await createBooking(req.user!.sub, resourceId, new Date(startTime), new Date(endTime))
  res.status(201).json(booking)
})

bookingsRouter.get('/bookings/me', requireAuth, async (req, res) => {
  res.json(await listMyBookings(req.user!.sub))
})

bookingsRouter.post('/bookings/:id/checkin', requireAuth, validate({ params: bookingIdParamsSchema }), async (req, res) => {
  const { id } = req.params as { id: string }
  res.json(await checkInBooking(req.user!.sub, id))
})

bookingsRouter.post('/bookings/:id/cancel', requireAuth, validate({ params: bookingIdParamsSchema }), async (req, res) => {
  const { id } = req.params as { id: string }
  res.json(await cancelBooking(req.user!.sub, id))
})

// The student disputes one of their own recorded no-shows, once. Another student's booking answers 404
// like an unknown id (not the 403 that check-in and cancel use). The student then sees the dispute as
// `noShow.dispute` on the booking in GET /bookings/me.
bookingsRouter.post(
  '/bookings/:id/dispute',
  requireAuth,
  validate({ params: noShowDisputeParamsSchema, body: createNoShowDisputeSchema }),
  async (req, res) => {
    const { id } = req.params as { id: string }
    const { reason } = req.body as { reason: string }
    res.status(201).json(await createNoShowDispute(req.user!.sub, id, reason))
  },
)
