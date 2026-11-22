import { Router } from 'express'
import { openLiveStream } from '../lib/liveStream'
import { requireAdmin, requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { adminBookingParamsSchema, adminBookingsQuerySchema, cancelBookingSchema, reassignBookingSchema } from '../schemas/adminBookings'
import {
  addCopiesSchema,
  adminBookParamsSchema,
  adminBooksQuerySchema,
  adminCopyParamsSchema,
  createBookSchema,
  markCopyLostSchema,
  restoreCopySchema,
  updateBookSchema,
} from '../schemas/adminCatalogue'
import { adjustFineSchema, adminFineParamsSchema, adminFinesQuerySchema, markFinePaidSchema } from '../schemas/adminFines'
import { adminRequestParamsSchema, declineRequestSchema } from '../schemas/adminRequests'
import {
  adminResourceParamsSchema,
  adminResourcesQuerySchema,
  createResourceSchema,
  takeOfflineSchema,
  updateResourceSchema,
} from '../schemas/adminResources'
import { adjustReliabilitySchema, adminStudentParamsSchema } from '../schemas/adminStudents'
import {
  cancelBookingAsLibrary,
  listBookings,
  listReassignOptions,
  reassignBooking,
  type AdminBookingListQuery,
} from '../services/adminBookingService'
import { addCopies, createBook, listBooks, updateBook, type AdminBookListQuery } from '../services/adminCatalogueService'
import { markCopyLost, markCopyMaintenance, restoreCopy } from '../services/adminCopyService'
import { adjustFine, listFines, markFinePaid, type AdminFineListQuery } from '../services/adminFineService'
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
import { adjustReliability, getStudent } from '../services/adminStudentService'

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

adminRouter.post(
  '/admin/bookings/:id/cancel',
  validate({ params: adminBookingParamsSchema, body: cancelBookingSchema }),
  async (req, res) => {
    const { reason } = req.body as { reason?: string }
    res.json(await cancelBookingAsLibrary(req.params.id as string, req.user!.sub, reason ? reason : null))
  },
)

adminRouter.get('/admin/bookings/:id/reassign-options', validate({ params: adminBookingParamsSchema }), async (req, res) => {
  res.json(await listReassignOptions(req.params.id as string))
})

adminRouter.post(
  '/admin/bookings/:id/reassign',
  validate({ params: adminBookingParamsSchema, body: reassignBookingSchema }),
  async (req, res) => {
    const { resourceId } = req.body as { resourceId: string }
    res.json(await reassignBooking(req.params.id as string, resourceId))
  },
)

adminRouter.get('/admin/fines', validate({ query: adminFinesQuerySchema }), async (req, res) => {
  res.json(await listFines(req.validatedQuery as AdminFineListQuery))
})

adminRouter.post(
  '/admin/fines/:id/paid',
  validate({ params: adminFineParamsSchema, body: markFinePaidSchema }),
  async (req, res) => {
    const { amount } = req.body as { amount: number }
    res.json(await markFinePaid(req.params.id as string, req.user!.sub, amount))
  },
)

adminRouter.post(
  '/admin/fines/:id/adjust',
  validate({ params: adminFineParamsSchema, body: adjustFineSchema }),
  async (req, res) => {
    const { amount, reason } = req.body as { amount: number; reason: string }
    res.json(await adjustFine(req.params.id as string, req.user!.sub, amount, reason))
  },
)

adminRouter.get('/admin/books', validate({ query: adminBooksQuerySchema }), async (req, res) => {
  res.json(await listBooks(req.validatedQuery as AdminBookListQuery))
})

adminRouter.post('/admin/books', validate({ body: createBookSchema }), async (req, res) => {
  res.status(201).json(await createBook(req.body as Parameters<typeof createBook>[0]))
})

adminRouter.patch('/admin/books/:id', validate({ params: adminBookParamsSchema, body: updateBookSchema }), async (req, res) => {
  res.json(await updateBook(req.params.id as string, req.body as Parameters<typeof updateBook>[1]))
})

adminRouter.post('/admin/books/:id/copies', validate({ params: adminBookParamsSchema, body: addCopiesSchema }), async (req, res) => {
  const { count } = req.body as { count: number }
  res.json(await addCopies(req.params.id as string, count))
})

adminRouter.post('/admin/copies/:id/maintenance', validate({ params: adminCopyParamsSchema }), async (req, res) => {
  res.json(await markCopyMaintenance(req.params.id as string))
})

adminRouter.post(
  '/admin/copies/:id/lost',
  validate({ params: adminCopyParamsSchema, body: markCopyLostSchema }),
  async (req, res) => {
    const { replacementCharge, borrowerId } = req.body as { replacementCharge?: number; borrowerId?: string }
    res.json(await markCopyLost(req.params.id as string, { replacementCharge, borrowerId }))
  },
)

adminRouter.post(
  '/admin/copies/:id/restore',
  validate({ params: adminCopyParamsSchema, body: restoreCopySchema }),
  async (req, res) => {
    const { waiveReplacementCharge } = req.body as { waiveReplacementCharge?: boolean }
    res.json(await restoreCopy(req.params.id as string, req.user!.sub, waiveReplacementCharge === true))
  },
)

adminRouter.get('/admin/students/:id', validate({ params: adminStudentParamsSchema }), async (req, res) => {
  res.json(await getStudent(req.params.id as string))
})

adminRouter.post(
  '/admin/students/:id/reliability',
  validate({ params: adminStudentParamsSchema, body: adjustReliabilitySchema }),
  async (req, res) => {
    const { delta, reason } = req.body as { delta: number; reason: string }
    res.json(await adjustReliability(req.params.id as string, req.user!.sub, delta, reason))
  },
)

// Live updates for the console, as Server-Sent Events (lib/liveStream.ts).
adminRouter.get('/admin/events', (req, res) => {
  openLiveStream(res)
})
