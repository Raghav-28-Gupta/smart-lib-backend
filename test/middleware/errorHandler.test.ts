import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '../../src/generated/prisma/client'
import { errorHandler } from '../../src/middleware/errorHandler'
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../src/lib/httpError'

// A minimal fake Response — just enough surface for errorHandler to call
// res.status(n).json(body) and for the test to inspect what was sent.
function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

const req = {} as Request
const next = vi.fn()

describe('errorHandler', () => {
  it('maps a plain AppError to its status and message', () => {
    const res = fakeRes()
    errorHandler(new AppError(418, "I'm a teapot"), req, res, next)
    expect(res.statusCode).toBe(418)
    expect(res.body).toEqual({ error: "I'm a teapot" })
  })

  it('includes details when the AppError carries them', () => {
    const res = fakeRes()
    errorHandler(new ValidationError('bad input', { field: 'email' }), req, res, next)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'bad input', details: { field: 'email' } })
  })

  it('maps NotFoundError to 404 with its generated message', () => {
    const res = fakeRes()
    errorHandler(new NotFoundError('Book'), req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'Book not found' })
  })

  it('maps ConflictError to 409', () => {
    const res = fakeRes()
    errorHandler(new ConflictError('slot taken', { alternatives: [] }), req, res, next)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'slot taken', details: { alternatives: [] } })
  })

  it('maps a Prisma P2002 unique-constraint error to 409 naming the field', () => {
    const res = fakeRes()
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    })
    errorHandler(err, req, res, next)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'A record with that email already exists.' })
  })

  it('maps a Prisma P2025 not-found error to 404', () => {
    const res = fakeRes()
    const err = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    })
    errorHandler(err, req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'Not found.' })
  })

  it('falls back to a generic 500 for an unrecognized Prisma error code, without leaking internals', () => {
    const res = fakeRes()
    const err = new Prisma.PrismaClientKnownRequestError('exclusion violation', {
      code: '23P01',
      clientVersion: 'test',
      meta: { table: 'ResourceBooking' },
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorHandler(err, req, res, next)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Something went wrong.' })
    consoleSpy.mockRestore()
  })

  it('falls back to a generic 500 for a totally unknown error, without leaking its message', () => {
    const res = fakeRes()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorHandler(new Error('super secret internal detail'), req, res, next)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Something went wrong.' })
    consoleSpy.mockRestore()
  })

  it('defers to next(err) instead of double-responding once headers are already sent', () => {
    const res = fakeRes()
    res.headersSent = true
    const err = new AppError(400, 'too late')
    errorHandler(err, req, res, next)
    expect(next).toHaveBeenCalledWith(err)
    expect(res.body).toBeUndefined()
  })
})
