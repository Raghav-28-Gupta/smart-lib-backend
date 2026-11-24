import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { createResourceReportSchema } from '../schemas/reports'
import { createResourceReport, type ResourceReportInput } from '../services/reportService'

export const reportsRouter = Router()

// The student reports a seat or room they have booked. The librarian's side is under
// /admin (routes/admin.ts); a copy is reported as it is returned (POST /loans/:id/return).
reportsRouter.post('/reports', requireAuth, validate({ body: createResourceReportSchema }), async (req, res) => {
  res.status(201).json(await createResourceReport(req.user!.sub, req.body as ResourceReportInput))
})
