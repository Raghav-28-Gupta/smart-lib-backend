import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { NotFoundError } from '../lib/httpError'
import { requireAuth } from '../middleware/requireAuth'
import { validate } from '../middleware/validate'
import { loginSchema, registerSchema } from '../schemas/auth'
import { loginUser, registerUser, toAppUser } from '../services/authService'

export const authRouter = Router()

authRouter.post('/auth/register', validate({ body: registerSchema }), async (req, res) => {
  const result = await registerUser(req.body)
  res.status(201).json(result)
})

authRouter.post('/auth/login', validate({ body: loginSchema }), async (req, res) => {
  const result = await loginUser(req.body)
  res.json(result)
})

// Lets a client restore a session on app start once token persistence is
// wired up on the frontend — not consumed by anything yet.
authRouter.get('/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.sub } })
  if (!user) throw new NotFoundError('User')
  res.json(toAppUser(user))
})
