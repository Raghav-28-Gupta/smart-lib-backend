import type { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import { publish, subscriberCount } from '../../src/lib/events'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function tokenFor(role: 'student' | 'admin') {
  const user = await prisma.user.create({
    data: { name: role, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
}

describe('GET /admin/events', () => {
  beforeEach(resetDb)

  it('refuses a request without a token (401) and a student (403)', async () => {
    expect((await request(app).get('/admin/events')).status).toBe(401)
    expect((await request(app).get('/admin/events').set('Authorization', `Bearer ${await tokenFor('student')}`)).status).toBe(403)
  })

  it('streams published events to an admin until the console disconnects', async () => {
    const token = await tokenFor('admin')
    const server = app.listen(0)
    const { port } = server.address() as AddressInfo
    const controller = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      const readUntil = async (marker: string) => {
        while (!text.includes(marker)) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`The stream ended before "${marker}"`)
          text += decoder.decode(value, { stream: true })
        }
      }

      await readUntil('event: ready')
      publish({ type: 'request.created', topics: ['requests'], kind: 'room', summary: 'Rohan Verma wants Group Room 201' })
      await readUntil('Rohan Verma')
      expect(text).toContain(
        'event: request.created\ndata: {"topics":["requests"],"kind":"room","summary":"Rohan Verma wants Group Room 201"}\n\n',
      )

      controller.abort()
      await vi.waitFor(() => expect(subscriberCount()).toBe(0))
    } finally {
      controller.abort()
      server.closeAllConnections()
      server.close()
    }
  })
})
