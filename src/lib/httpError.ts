// A typed error carrying the HTTP status it should map to, so route handlers
// can `throw` instead of manually shaping res.status().json() at every call
// site. Express 5 forwards a rejected promise from an async handler straight
// to the error-handling middleware, so `throw` inside an async route works
// without a try/catch or a manual asyncHandler wrapper. middleware/errorHandler.ts
// is the only place that translates these into responses.
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, details)
    this.name = 'ValidationError'
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message)
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, `${what} not found`)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, message, details)
    this.name = 'ConflictError'
  }
}
