import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { validate } from '../../src/middleware/validate'
import { ValidationError } from '../../src/lib/httpError'

const res = {} as Response
const next = vi.fn()

describe('validate', () => {
  it('replaces req.body with the parsed result, applying schema defaults', () => {
    const schema = z.object({ email: z.string(), role: z.enum(['student', 'admin']).default('student') })
    const req = { body: { email: 'a@b.com' } } as unknown as Request
    validate({ body: schema })(req, res, next)
    expect(req.body).toEqual({ email: 'a@b.com', role: 'student' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('throws ValidationError with flattened field errors when the body is invalid', () => {
    const schema = z.object({ email: z.email() })
    const req = { body: { email: 'not-an-email' } } as unknown as Request
    expect(() => validate({ body: schema })(req, res, next)).toThrow(ValidationError)
    try {
      validate({ body: schema })(req, res, next)
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const validationErr = err as ValidationError
      expect(validationErr.status).toBe(400)
      expect(validationErr.details).toMatchObject({ fieldErrors: { email: expect.any(Array) } })
    }
  })

  it('replaces req.params with the parsed result', () => {
    // zod 4: z.uuid() is the current top-level form; z.string().uuid() is
    // deprecated. Use z.uuid() consistently in real route schemas too.
    const schema = z.object({ id: z.uuid() })
    const id = '1c309bf1-0dd2-4e65-9000-bb354a718d8c'
    const req = { params: { id } } as unknown as Request
    validate({ params: schema })(req, res, next)
    expect(req.params).toEqual({ id })
  })

  it('coerces query params into req.validatedQuery without touching req.query itself', () => {
    // Express 5 makes req.query a getter with no setter, so validated query
    // data can never live on req.query — this is the behavior that guards
    // against silently regressing back to `req.query = result.data`.
    const schema = z.object({ limit: z.coerce.number().default(10) })
    const req = { query: { limit: '25' } } as unknown as Request
    validate({ query: schema })(req, res, next)
    expect(req.validatedQuery).toEqual({ limit: 25 })
    expect(req.query).toEqual({ limit: '25' })
  })

  it('throws ValidationError for an invalid query param', () => {
    const schema = z.object({ date: z.iso.date() })
    const req = { query: { date: 'not-a-date' } } as unknown as Request
    expect(() => validate({ query: schema })(req, res, next)).toThrow(ValidationError)
  })

  it('validates multiple parts in one call', () => {
    const req = {
      body: { name: 'Clean Code' },
      params: { id: 'b1' },
    } as unknown as Request
    validate({ body: z.object({ name: z.string() }), params: z.object({ id: z.string() }) })(req, res, next)
    expect(req.body).toEqual({ name: 'Clean Code' })
    expect(req.params).toEqual({ id: 'b1' })
  })
})
