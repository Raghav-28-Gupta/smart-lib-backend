import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '../generated/prisma/client'
import { AppError } from '../lib/httpError'

// Must be registered last, and must keep all four parameters (err, req, res,
// next) even though `next` is unused — Express only recognizes a handler as
// error-handling middleware when its arity is 4.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  // A handler that already started writing a response (e.g. streaming) can't
  // have its error turned into a fresh JSON body — hand it back to Express's
  // default handler instead of double-responding.
  if (res.headersSent) {
    next(err)
    return
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) })
    return
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field'
      res.status(409).json({ error: `A record with that ${target} already exists.` })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Not found.' })
      return
    }
    // Any other Prisma error — including a raw EXCLUDE-constraint violation
    // (SQLSTATE 23P01) that a route forgot to catch locally — falls through
    // to the generic 500 below. routes/bookings.ts is the one place that
    // SHOULD catch 23P01 itself, since only it has the context to compute
    // alternative-slot suggestions for the 409 body.
  }

  // eslint-disable-next-line no-console
  console.error(err)
  res.status(500).json({ error: 'Something went wrong.' })
}
