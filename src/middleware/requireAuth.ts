import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../config/constants'
import type { Role } from '../generated/prisma/client'
import { ForbiddenError, UnauthorizedError } from '../lib/httpError'

export interface AuthPayload {
  sub: string
  role: Role
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload
  }
}

// Verifies the Bearer token and attaches its payload to req.user. Route
// modules put this before any handler that needs to know who's calling.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header')
  }
  const token = header.slice('Bearer '.length)
  try {
    req.user = jwt.verify(token, JWT_SECRET) as AuthPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
  next()
}

// Must run after requireAuth in the chain — it reads req.user, which only
// requireAuth sets. Reserved for the /admin/metrics/* routes (Phase 4).
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    throw new ForbiddenError('Admin access required')
  }
  next()
}
