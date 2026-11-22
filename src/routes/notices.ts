import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { listMyNotices } from '../services/noticeService'

export const noticesRouter = Router()

// The student's own library notices (reminders, dispute and report outcomes),
// for the section at the top of My Loans. Nothing here takes an id: a student can
// only ever see their own.
noticesRouter.get('/notices/me', requireAuth, async (req, res) => {
  res.json(await listMyNotices(req.user!.sub))
})
