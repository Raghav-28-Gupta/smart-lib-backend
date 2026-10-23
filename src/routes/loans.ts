import { Router } from 'express'
import { ConflictError } from '../lib/httpError'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { createLoanSchema, loanIdParamsSchema } from '../schemas/loans'
import { listMyLoans, renewLoan, returnLoan } from '../services/loanService'

export const loansRouter = Router()

// Borrowing is a request now (POST /borrow-requests), approved by a librarian.
// Older app versions still call this route; the 409 tells their students to update.
loansRouter.post('/loans', requireAuth, validate({ body: createLoanSchema }), () => {
  throw new ConflictError("Borrowing now needs a librarian's approval. Update the SmartLib app to send a request.")
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
