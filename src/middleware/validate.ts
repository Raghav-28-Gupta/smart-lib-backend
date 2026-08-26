import type { NextFunction, Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import { ValidationError } from '../lib/httpError'

// Express 5 made req.query a getter with no setter (the raw query string is
// re-parsed on every access), so validated/coerced query data can't replace
// req.query directly the way req.body/req.params still can — it goes here
// instead. A route that validates a query schema reads req.validatedQuery,
// not req.query, to see coercions (e.g. z.coerce.number()) actually applied.
declare module 'express-serve-static-core' {
  interface Request {
    validatedQuery?: Record<string, unknown>
  }
}

interface Schemas {
  body?: ZodType
  params?: ZodType
  query?: ZodType
}

// Validates the given parts of a request against zod schemas. On success,
// req.body/req.params are REPLACED with the parsed result (so defaults and
// coercions take effect for the route handler, not just the raw input) and
// req.validatedQuery is set. On failure, throws — Express 5 forwards the
// throw from this synchronous middleware to errorHandler.ts same as it would
// a rejected promise from an async one.
export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body)
      if (!result.success) throw new ValidationError('Invalid request body', z.flattenError(result.error))
      req.body = result.data
    }
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params)
      if (!result.success) throw new ValidationError('Invalid route parameters', z.flattenError(result.error))
      // req.params is typed as ParamsDictionary (Record<string, string>) by
      // Express, but a validated params schema may coerce to other types
      // (e.g. z.coerce.number()) — same reasoning as the Schemas type being
      // generic over any ZodType rather than one fixed output shape.
      req.params = result.data as Request['params']
    }
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query)
      if (!result.success) throw new ValidationError('Invalid query parameters', z.flattenError(result.error))
      req.validatedQuery = result.data as Record<string, unknown>
    }
    next()
  }
}
