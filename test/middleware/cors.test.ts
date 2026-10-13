import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

// app.ts reads CORS_ORIGINS when it's first imported, so each case sets the
// variable and imports a fresh copy of the app.
async function appWith(origins: string | undefined) {
  if (origins === undefined) delete process.env.CORS_ORIGINS
  else process.env.CORS_ORIGINS = origins
  vi.resetModules()
  return (await import('../../src/app')).app
}

describe('CORS', () => {
  afterEach(() => {
    delete process.env.CORS_ORIGINS
    vi.resetModules()
  })

  it('allows any origin when CORS_ORIGINS is unset, as in local development', async () => {
    const app = await appWith(undefined)
    const res = await request(app).get('/health').set('Origin', 'http://localhost:8080')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('treats an empty CORS_ORIGINS like an unset one', async () => {
    // What a copied .env.example gives you.
    const app = await appWith('')
    const res = await request(app).get('/health').set('Origin', 'http://localhost:8080')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('allows a listed origin', async () => {
    const app = await appWith('https://raghav-28-gupta.github.io, https://other.example')
    const res = await request(app).get('/health').set('Origin', 'https://raghav-28-gupta.github.io')
    expect(res.headers['access-control-allow-origin']).toBe('https://raghav-28-gupta.github.io')
  })

  it('gives an unlisted origin no CORS header, so the browser refuses the response', async () => {
    const app = await appWith('https://raghav-28-gupta.github.io')
    const res = await request(app).get('/health').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('still serves requests with no Origin -- the Android and Windows apps send none', async () => {
    const app = await appWith('https://raghav-28-gupta.github.io')
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
  })
})
