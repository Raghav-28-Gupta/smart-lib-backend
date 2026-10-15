import { Router } from 'express'
import { requireAdmin, requireAuth } from '../middleware/requireAuth'
import { getCirculation, getDemand, getOverdue, getUtilization } from '../services/adminMetricsService'

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
