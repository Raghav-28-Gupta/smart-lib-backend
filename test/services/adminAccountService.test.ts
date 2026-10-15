import bcrypt from 'bcrypt'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { prisma } from '../../src/lib/prisma'
import { createOrPromoteAdmin } from '../../src/services/adminAccountService'
import { resetDb } from '../helpers/db'

const yes = async () => true
const no = async () => false

describe('createOrPromoteAdmin', () => {
  beforeEach(resetDb)

  it('creates an admin who can log in', async () => {
    expect(await createOrPromoteAdmin({ name: 'Librarian', email: 'lib@thapar.edu', password: 'correct horse' }, no)).toBe('created')
    const res = await request(app).post('/auth/login').send({ email: 'lib@thapar.edu', password: 'correct horse' })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ name: 'Librarian', role: 'admin' })
  })

  it('trims spaces around the name and email', async () => {
    await createOrPromoteAdmin({ name: '  Librarian ', email: ' lib@thapar.edu ', password: 'correct horse' }, no)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'lib@thapar.edu' } })
    expect(user.name).toBe('Librarian')
  })

  it('does not ask for confirmation when the email is new', async () => {
    let asked = false
    await createOrPromoteAdmin({ name: 'Librarian', email: 'lib@thapar.edu', password: 'correct horse' }, async () => {
      asked = true
      return true
    })
    expect(asked).toBe(false)
  })

  it('promotes an existing account after confirmation, keeping its name and setting the new password', async () => {
    await prisma.user.create({ data: { name: 'Aditi', email: 'a@thapar.edu', passwordHash: await bcrypt.hash('old password', 10) } })
    expect(await createOrPromoteAdmin({ name: 'Ignored', email: 'a@thapar.edu', password: 'new password' }, yes)).toBe('promoted')
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'a@thapar.edu' } })
    expect(user).toMatchObject({ name: 'Aditi', role: 'admin' })
    expect(await bcrypt.compare('new password', user.passwordHash)).toBe(true)
  })

  it('changes nothing when promotion is declined', async () => {
    await prisma.user.create({ data: { name: 'Aditi', email: 'a@thapar.edu', passwordHash: await bcrypt.hash('old password', 10) } })
    expect(await createOrPromoteAdmin({ name: 'Aditi', email: 'a@thapar.edu', password: 'new password' }, no)).toBe('declined')
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'a@thapar.edu' } })
    expect(user.role).toBe('student')
    expect(await bcrypt.compare('old password', user.passwordHash)).toBe(true)
  })

  it('rejects a short password and creates nothing', async () => {
    await expect(createOrPromoteAdmin({ name: 'L', email: 'lib@thapar.edu', password: 'short' }, yes)).rejects.toThrow(
      'Password must be at least 8 characters',
    )
    expect(await prisma.user.count()).toBe(0)
  })

  it('rejects an invalid email', async () => {
    await expect(createOrPromoteAdmin({ name: 'L', email: 'not-an-email', password: 'correct horse' }, yes)).rejects.toThrow()
    expect(await prisma.user.count()).toBe(0)
  })
})
