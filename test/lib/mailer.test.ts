import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_TIMEOUT_MS } from '../../src/config/constants'
import {
  isEmailConfigured,
  sendEmail,
  setMailTransport,
  type MailMessage,
  type MailTransport,
} from '../../src/lib/mailer'

const ENV_KEYS = [
  'BREVO_API_KEY',
  'MAIL_FROM',
  'MAIL_FROM_NAME',
  'MAIL_ALLOWED_DOMAINS',
  'NODE_ENV',
  'VITEST',
] as const

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'

const message: MailMessage = {
  to: 'student@example.org',
  subject: 'SmartLib: Overdue book reminder',
  text: 'Your copy of Clean Code is 3 days overdue.',
}

const saved: Record<string, string | undefined> = {}

// The real path only runs outside a test run (NODE_ENV=test or VITEST set), so a
// test that exercises it switches to 'production' and clears VITEST (afterEach
// puts both back).
function leaveTestRun() {
  process.env.NODE_ENV = 'production'
  delete process.env.VITEST
}

function useRealPath(env: Record<string, string> = {}) {
  leaveTestRun()
  process.env.BREVO_API_KEY = 'xkeysib-test-key'
  process.env.MAIL_FROM = 'library@example.org'
  Object.assign(process.env, env)
}

function stubFetch(response: (init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => response(init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fakeTransport(ok = true) {
  const send = vi.fn<MailTransport['send']>(async () => ({ ok }))
  const transport: MailTransport = { send }
  return { transport, send }
}

function silenceConsole() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  )
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    if (key !== 'NODE_ENV' && key !== 'VITEST') delete process.env[key]
  }
  setMailTransport(null)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  setMailTransport(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sendEmail', () => {
  it('is skipped, with no request, when BREVO_API_KEY or MAIL_FROM is unset', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }))
    leaveTestRun()

    expect(await sendEmail(message)).toBe('skipped')

    process.env.BREVO_API_KEY = 'xkeysib-test-key'
    expect(await sendEmail(message)).toBe('skipped')

    delete process.env.BREVO_API_KEY
    process.env.MAIL_FROM = 'library@example.org'
    expect(await sendEmail(message)).toBe('skipped')

    process.env.BREVO_API_KEY = '   '
    expect(await sendEmail(message)).toBe('skipped')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is skipped under NODE_ENV=test with no injected transport', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }))
    // NODE_ENV alone (VITEST cleared): a key in a developer's .env must still not send.
    process.env.NODE_ENV = 'test'
    delete process.env.VITEST
    process.env.BREVO_API_KEY = 'xkeysib-test-key'
    process.env.MAIL_FROM = 'library@example.org'

    expect(await sendEmail(message)).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is skipped when Vitest is running even if NODE_ENV is not "test", with a key configured', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }))
    const before = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST }
    try {
      // Vitest only sets NODE_ENV when the shell left it unset, and the .env loaded by
      // test/setup.ts may hold a live key: VITEST alone must keep the real transport off.
      process.env.NODE_ENV = 'development'
      process.env.VITEST = 'true'
      process.env.BREVO_API_KEY = 'xkeysib-test-key'
      process.env.MAIL_FROM = 'library@example.org'

      expect(isEmailConfigured()).toBe(false)
      expect(await sendEmail(message)).toBe('skipped')
      expect(fetchMock).not.toHaveBeenCalled()

      // An injected transport is still the way a test sends.
      const { transport, send } = fakeTransport()
      setMailTransport(transport)
      expect(isEmailConfigured()).toBe(true)
      expect(await sendEmail(message)).toBe('sent')
      expect(send).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('skips the placeholder demo addresses', async () => {
    const { transport, send } = fakeTransport()
    setMailTransport(transport)

    for (const to of [
      'aditi.sharma@thapar.edu',
      'seed.student7@thapar.edu',
      'SEED.Student120@Thapar.EDU',
    ]) {
      expect(await sendEmail({ ...message, to })).toBe('skipped')
    }
    expect(send).not.toHaveBeenCalled()

    // Near misses are real addresses.
    for (const to of [
      'seed.student@thapar.edu',
      'aditi.sharma@example.org',
      'someone.seed.student7@thapar.edu',
    ]) {
      expect(await sendEmail({ ...message, to })).toBe('sent')
    }
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('skips an address outside MAIL_ALLOWED_DOMAINS and sends inside it, case-insensitively', async () => {
    const { transport, send } = fakeTransport()
    setMailTransport(transport)
    process.env.MAIL_ALLOWED_DOMAINS = ' Thapar.edu , example.org ,, '

    for (const to of ['a@thapar.edu', 'a@THAPAR.EDU', 'A@Example.Org']) {
      expect(await sendEmail({ ...message, to })).toBe('sent')
    }
    expect(send).toHaveBeenCalledTimes(3)

    send.mockClear()
    for (const to of [
      'a@gmail.com',
      'a@mail.thapar.edu',
      'a@thapar.edu.evil.com',
      'not-an-address',
    ]) {
      expect(await sendEmail({ ...message, to })).toBe('skipped')
    }
    expect(send).not.toHaveBeenCalled()

    // Unset (or only separators) means every address except the placeholders.
    delete process.env.MAIL_ALLOWED_DOMAINS
    expect(await sendEmail({ ...message, to: 'a@gmail.com' })).toBe('sent')
    process.env.MAIL_ALLOWED_DOMAINS = ' , '
    expect(await sendEmail({ ...message, to: 'a@gmail.com' })).toBe('sent')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends one request with the api-key header, the sender name and address, the recipient, subject and text', async () => {
    useRealPath({ MAIL_FROM_NAME: 'Thapar Library' })
    const fetchMock = stubFetch(
      () => new Response('{"messageId":"<1@relay.example>"}', { status: 201 }),
    )

    expect(await sendEmail(message)).toBe('sent')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(BREVO_URL)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('api-key')).toBe('xkeysib-test-key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({
      sender: { name: 'Thapar Library', email: 'library@example.org' },
      to: [{ email: 'student@example.org' }],
      subject: message.subject,
      textContent: message.text,
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses "SmartLib" when MAIL_FROM_NAME is unset', async () => {
    useRealPath()
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }))

    expect(await sendEmail(message)).toBe('sent')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).sender).toEqual({
      name: 'SmartLib',
      email: 'library@example.org',
    })

    process.env.MAIL_FROM_NAME = '  '
    expect(await sendEmail(message)).toBe('sent')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).sender.name).toBe('SmartLib')
  })

  it('answers failed on a non-2xx answer, on a network error and on a timeout, and never throws', async () => {
    silenceConsole()
    useRealPath()

    // A non-2xx answer, once each, with no retry.
    for (const status of [400, 401, 429, 500]) {
      const fetchMock = stubFetch(() => new Response('{"message":"no"}', { status }))
      await expect(sendEmail(message)).resolves.toBe('failed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }

    // A network error.
    const networkError = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    await expect(sendEmail(message)).resolves.toBe('failed')
    expect(networkError).toHaveBeenCalledTimes(1)

    // A timeout: the call asks for MAIL_TIMEOUT_MS and hands the signal to
    // fetch; a short stand-in keeps the test fast, and fetch rejects when the
    // signal aborts, as the real one does.
    expect(MAIL_TIMEOUT_MS).toBe(5000)
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20))
    const hanging = stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    await expect(sendEmail(message)).resolves.toBe('failed')
    expect(timeoutSpy).toHaveBeenCalledWith(MAIL_TIMEOUT_MS)
    expect(hanging).toHaveBeenCalledTimes(1)

    // An injected transport that throws or answers not ok is failed too.
    setMailTransport({
      send: async () => {
        throw new Error('transport exploded')
      },
    })
    await expect(sendEmail(message)).resolves.toBe('failed')
    setMailTransport(fakeTransport(false).transport)
    await expect(sendEmail(message)).resolves.toBe('failed')
  })

  it('never passes the message text or the key to console.*', async () => {
    const spies = silenceConsole()
    const secretKey = 'xkeysib-SECRET-KEY-123'
    const secretText = 'TOPSECRET-BODY-TEXT'
    const secret: MailMessage = {
      to: 'private.person@example.org',
      subject: `SmartLib: ${secretText}`,
      text: secretText,
    }
    useRealPath({ BREVO_API_KEY: secretKey })

    // Every outcome, including failures whose error text names the secrets.
    stubFetch(() => new Response(`{"message":"${secretText}"}`, { status: 201 }))
    expect(await sendEmail(secret)).toBe('sent')
    stubFetch(() => new Response(`{"message":"${secretText} ${secretKey}"}`, { status: 401 }))
    expect(await sendEmail(secret)).toBe('failed')
    stubFetch(() =>
      Promise.reject(new Error(`failed for ${secret.to} with ${secretKey}: ${secretText}`)),
    )
    expect(await sendEmail(secret)).toBe('failed')
    setMailTransport({
      send: async () => {
        throw new Error(`${secretKey} ${secretText} ${secret.to}`)
      },
    })
    expect(await sendEmail(secret)).toBe('failed')
    setMailTransport(null)
    process.env.MAIL_ALLOWED_DOMAINS = 'thapar.edu'
    expect(await sendEmail(secret)).toBe('skipped')

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
    for (const value of [secretText, secretKey, secret.to, secret.subject]) {
      expect(logged).not.toContain(value)
    }
  })
})

describe('sendEmail with an injected transport', () => {
  it('counts as configured, with the fixed test sender when MAIL_FROM is unset', async () => {
    const { transport, send } = fakeTransport()
    setMailTransport(transport)

    expect(await sendEmail(message)).toBe('sent')

    expect(send).toHaveBeenCalledTimes(1)
    const [sent, signal] = send.mock.calls[0]
    expect(sent).toEqual({
      from: { email: 'noreply@test.invalid', name: 'SmartLib' },
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('uses the configured sender when MAIL_FROM is set, and setMailTransport(null) restores the real one', async () => {
    const { transport, send } = fakeTransport()
    setMailTransport(transport)
    process.env.MAIL_FROM = 'library@example.org'
    process.env.MAIL_FROM_NAME = 'Thapar Library'

    expect(await sendEmail(message)).toBe('sent')
    expect(send.mock.calls[0][0].from).toEqual({
      email: 'library@example.org',
      name: 'Thapar Library',
    })

    setMailTransport(null)
    expect(await sendEmail(message)).toBe('skipped')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('isEmailConfigured', () => {
  it('needs both BREVO_API_KEY and MAIL_FROM outside a test run', () => {
    leaveTestRun()
    expect(isEmailConfigured()).toBe(false)

    process.env.BREVO_API_KEY = 'xkeysib-test-key'
    expect(isEmailConfigured()).toBe(false)

    process.env.MAIL_FROM = 'library@example.org'
    expect(isEmailConfigured()).toBe(true)

    delete process.env.BREVO_API_KEY
    expect(isEmailConfigured()).toBe(false)
  })

  it('is true with an injected transport and false under NODE_ENV=test without one', () => {
    process.env.BREVO_API_KEY = 'xkeysib-test-key'
    process.env.MAIL_FROM = 'library@example.org'
    process.env.NODE_ENV = 'test'
    expect(isEmailConfigured()).toBe(false)

    setMailTransport(fakeTransport().transport)
    expect(isEmailConfigured()).toBe(true)

    setMailTransport(null)
    expect(isEmailConfigured()).toBe(false)
  })
})
