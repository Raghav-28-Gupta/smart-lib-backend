import bcrypt from 'bcrypt'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

describe('POST /auth/register', () => {
  beforeEach(resetDb)

  it('creates a new user and returns a token', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ name: 'Aditi Sharma', email: 'aditi@test.com', password: 'password123' })

    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({ name: 'Aditi Sharma', email: 'aditi@test.com', roll: 'Pending', role: 'student' })
    expect(res.body.user.id).toBeTypeOf('string')
    expect(res.body.token).toBeTypeOf('string')
  })

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/auth/register').send({ name: 'A', email: 'dup@test.com', password: 'password123' })
    const res = await request(app).post('/auth/register').send({ name: 'B', email: 'dup@test.com', password: 'password456' })
    expect(res.status).toBe(409)
  })

  it('rejects an invalid body with 400', async () => {
    const res = await request(app).post('/auth/register').send({ name: '', email: 'not-an-email', password: '123' })
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/login', () => {
  beforeEach(resetDb)

  it('logs in with correct credentials', async () => {
    await request(app).post('/auth/register').send({ name: 'Aditi', email: 'aditi@test.com', password: 'password123' })
    const res = await request(app).post('/auth/login').send({ email: 'aditi@test.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('aditi@test.com')
    expect(res.body.user.role).toBe('student')
    expect(res.body.token).toBeTypeOf('string')
  })

  it('reports the admin role for an admin account', async () => {
    // Admins can't self-register, so create one directly -- this is what
    // proves role is read from the row rather than hardcoded to 'student'.
    await prisma.user.create({
      data: { name: 'Librarian', email: 'admin@test.com', passwordHash: await bcrypt.hash('password123', 10), role: 'admin' },
    })
    const res = await request(app).post('/auth/login').send({ email: 'admin@test.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('admin')
  })

  it('rejects the wrong password with 401', async () => {
    await request(app).post('/auth/register').send({ name: 'Aditi', email: 'aditi@test.com', password: 'password123' })
    const res = await request(app).post('/auth/login').send({ email: 'aditi@test.com', password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown email with 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'nobody@test.com', password: 'password123' })
    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  beforeEach(resetDb)

  it('returns the current user when authenticated', async () => {
    const reg = await request(app)
      .post('/auth/register')
      .send({ name: 'Aditi', email: 'aditi@test.com', password: 'password123' })
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${reg.body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.email).toBe('aditi@test.com')
    expect(res.body.role).toBe('student')
  })

  it('rejects a request with no token with 401', async () => {
    const res = await request(app).get('/auth/me')
    expect(res.status).toBe(401)
  })

  it('rejects a garbage token with 401', async () => {
    const res = await request(app).get('/auth/me').set('Authorization', 'Bearer garbage')
    expect(res.status).toBe(401)
  })
})
