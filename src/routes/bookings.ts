import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { bookingIdParamsSchema, createBookingSchema } from '../schemas/bookings'
import { cancelBooking, checkInBooking, createBooking, listMyBookings } from '../services/bookingService'

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
