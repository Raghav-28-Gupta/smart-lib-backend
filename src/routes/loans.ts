import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { createLoanSchema, loanIdParamsSchema } from '../schemas/loans'
import { borrowBook, listMyLoans, renewLoan, returnLoan } from '../services/loanService'

export const loansRouter = Router()

loansRouter.post('/loans', requireAuth, validate({ body: createLoanSchema }), async (req, res) => {
  const { bookId } = req.body as { bookId: string }
  const loan = await borrowBook(req.user!.sub, bookId)
  res.status(201).json(loan)
})

loansRouter.get('/loans/me', requireAuth, async (req, res) => {
  res.json(await listMyLoans(req.user!.sub))
})

loansRouter.post('/loans/:id/renew', requireAuth, validate({ params: loanIdParamsSchema }), async (req, res) => {
  const { id } = req.params as { id: string }
  res.json(await renewLoan(req.user!.sub, id))
})

loansRouter.post('/loans/:id/return', requireAuth, validate({ params: loanIdParamsSchema }), async (req, res) => {
  const { id } = req.params as { id: string }
  res.json(await returnLoan(req.user!.sub, id))
})
