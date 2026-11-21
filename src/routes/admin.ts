import { Router } from 'express'
import { openLiveStream } from '../lib/liveStream'
import { requireAdmin, requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { adminBookingsQuerySchema } from '../schemas/adminBookings'
import { adminRequestParamsSchema, declineRequestSchema } from '../schemas/adminRequests'
import {
  adminResourceParamsSchema,
  adminResourcesQuerySchema,
  createResourceSchema,
  takeOfflineSchema,
  updateResourceSchema,
} from '../schemas/adminResources'
import { listBookings, type AdminBookingListQuery } from '../services/adminBookingService'
import { getCirculation, getDemand, getOverdue, getUtilization } from '../services/adminMetricsService'
import { approveRequest, declineRequest, listPendingRequests, type RequestKind } from '../services/adminRequestService'
import {
  bringOnline,
  createResource,
  listResources,
  takeOffline,
  updateResource,
  type AdminResourceType,
} from '../services/adminResourceService'

export const adminRouter = Router()

// Every /admin route needs a valid token (401) and the admin role (403).
// Guarding the prefix once means a later admin route can't forget it.
adminRouter.use('/admin', requireAuth, requireAdmin)

adminRouter.get('/admin/metrics/utilization', async (req, res) => {
  res.json(await getUtilization())
})

adminRouter.get('/admin/metrics/circulation', async (req, res) => {
  res.json(await getCirculation())
})

adminRouter.get('/admin/metrics/overdue', async (req, res) => {
  res.json(await getOverdue())
})

adminRouter.get('/admin/metrics/demand', async (req, res) => {
  res.json(await getDemand())
})

adminRouter.get('/admin/requests', async (req, res) => {
  res.json(await listPendingRequests())
})

adminRouter.post('/admin/requests/:kind/:id/approve', validate({ params: adminRequestParamsSchema }), async (req, res) => {
  const { kind, id } = req.params as { kind: RequestKind; id: string }
  res.json(await approveRequest(kind, id, req.user!.sub))
})

adminRouter.post(
  '/admin/requests/:kind/:id/decline',
  validate({ params: adminRequestParamsSchema, body: declineRequestSchema }),
  async (req, res) => {
    const { kind, id } = req.params as { kind: RequestKind; id: string }
    const { reason } = req.body as { reason?: string }
    res.json(await declineRequest(kind, id, req.user!.sub, reason ? reason : null))
  },
)

adminRouter.get('/admin/resources', validate({ query: adminResourcesQuerySchema }), async (req, res) => {
  const { type } = req.validatedQuery as { type?: AdminResourceType }
  res.json(await listResources(type))
})

adminRouter.post('/admin/resources', validate({ body: createResourceSchema }), async (req, res) => {
  res.status(201).json(await createResource(req.body as Parameters<typeof createResource>[0]))
})

adminRouter.patch(
  '/admin/resources/:id',
  validate({ params: adminResourceParamsSchema, body: updateResourceSchema }),
  async (req, res) => {
    res.json(await updateResource(req.params.id as string, req.body as Parameters<typeof updateResource>[1]))
  },
)

adminRouter.post(
  '/admin/resources/:id/offline',
  validate({ params: adminResourceParamsSchema, body: takeOfflineSchema }),
  async (req, res) => {
    const { note } = req.body as { note?: string }
    res.json(await takeOffline(req.params.id as string, note ? note : null))
  },
)

adminRouter.post('/admin/resources/:id/online', validate({ params: adminResourceParamsSchema }), async (req, res) => {
  res.json(await bringOnline(req.params.id as string))
})

adminRouter.get('/admin/bookings', validate({ query: adminBookingsQuerySchema }), async (req, res) => {
  res.json(await listBookings(req.validatedQuery as AdminBookingListQuery))
})

// Live updates for the console, as Server-Sent Events (lib/liveStream.ts).
adminRouter.get('/admin/events', (req, res) => {
  openLiveStream(res)
})
