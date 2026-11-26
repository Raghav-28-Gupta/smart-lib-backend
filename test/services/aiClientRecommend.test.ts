// The AI client's recommender call (slice 8, spec section 3): `fetchRecommendationBatch` posts the
// catalog and the students' interactions to POST /recommend/batch with the shared secret, and
// checks the answer against what was sent before anyone writes it to the cache. `fetch` is stubbed
// (no network, no database): every test asserts what is SENT (URL, method, header `x-ai-token`,
// body, signal), not just that a call happened. The shared fixture (test/fixtures/
// recommend-batch-example.json, a byte-identical copy of ai-backend/tests/fixtures/
// recommend_batch_example.json) is the contract both sides agree on.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECOMMEND_TIMEOUT_MS } from '../../src/config/constants'
import {
  fetchRecommendationBatch,
  isRecommenderConfigured,
  predictNoShow,
  RecommendationBatchError,
  type NoShowFeatures,
  type RecommendBatchRequest,
  type RecommendBatchResponse,
} from '../../src/lib/aiClient'

const FIXTURE: { request: RecommendBatchRequest; response: RecommendBatchResponse } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/recommend-batch-example.json', import.meta.url)), 'utf8'),
)

const AI_URL = 'http://ai.test:8000'
const TOKEN = 'tok-9f2c71-not-a-real-secret'

const book = (id: string) => ({ id, title: `Title ${id}`, author: `Author ${id}`, genre: null, description: null })

// Four books, two students, a limit of 2: small enough to read, rich enough to break one rule at a time.
const PAYLOAD: RecommendBatchRequest = {
  books: [book('b1'), book('b2'), book('b3'), book('b4')],
  interactions: [
    { user_id: 'u1', book_id: 'b1', weight: 1 },
    { user_id: 'u2', book_id: 'b2', weight: 1.5 },
  ],
  limit: 2,
}

// The boundaries are legal on purpose: a score of exactly 0 and exactly 1, a user with a single result.
const GOOD: RecommendBatchResponse = {
  model_version: 'tfidf-1',
  users: [
    {
      user_id: 'u1',
      results: [
        { book_id: 'b2', score: 1, method: 'content' },
        { book_id: 'b3', score: 0.4, method: 'hybrid' },
      ],
    },
    { user_id: 'u2', results: [{ book_id: 'b4', score: 0, method: 'collaborative' }] },
  ],
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  // This machine's .env may set either variable for every test file: each test starts from known values.
  vi.stubEnv('AI_BACKEND_URL', AI_URL)
  vi.stubEnv('AI_TOKEN', TOKEN)
  fetchStub = vi.fn<typeof fetch>(async () => json(GOOD))
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** The message a rejection carries, after checking it is the client's own error type. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error, 'the call should have rejected').toBeInstanceOf(RecommendationBatchError)
  return (error as RecommendationBatchError).message
}

describe('fetchRecommendationBatch', () => {
  it('sends the token header, the JSON body and the path', async () => {
    // Trailing slashes (and stray spaces) of the base URL are trimmed, like the no-show call's.
    vi.stubEnv('AI_BACKEND_URL', `  ${AI_URL}///  `)

    const result = await fetchRecommendationBatch(PAYLOAD)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]
    expect(url).toBe('http://ai.test:8000/recommend/batch')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-ai-token')).toBe(TOKEN)
    expect(headers.get('content-type')).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify(PAYLOAD))
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual(GOOD)
  })

  it('uses a RECOMMEND_TIMEOUT_MS timeout unless the caller passes its own signal', async () => {
    expect(RECOMMEND_TIMEOUT_MS).toBe(90_000)
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await fetchRecommendationBatch(PAYLOAD)
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(90_000)
    expect(fetchStub.mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value)

    // A caller's signal replaces the default one: it is the very object fetch receives.
    timeout.mockClear()
    const own = new AbortController()
    await fetchRecommendationBatch(PAYLOAD, own.signal)
    expect(timeout).not.toHaveBeenCalled()
    expect(fetchStub.mock.calls[1][1]?.signal).toBe(own.signal)
  })

  it('refuses without AI_BACKEND_URL or AI_TOKEN and sends nothing', async () => {
    const cases: Array<{ name: string; value: string | undefined; message: string }> = [
      { name: 'AI_BACKEND_URL', value: undefined, message: 'AI_BACKEND_URL is not set' },
      { name: 'AI_BACKEND_URL', value: '   ', message: 'AI_BACKEND_URL is not set' },
      { name: 'AI_TOKEN', value: undefined, message: 'AI_TOKEN is not set' },
      { name: 'AI_TOKEN', value: ' \t ', message: 'AI_TOKEN is not set' },
    ]
    for (const { name, value, message } of cases) {
      vi.stubEnv('AI_BACKEND_URL', AI_URL)
      vi.stubEnv('AI_TOKEN', TOKEN)
      vi.stubEnv(name, value)
      expect(await messageOf(fetchRecommendationBatch(PAYLOAD)), `${name}=${JSON.stringify(value)}`).toBe(message)
    }
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('never lets the token into an error: a token that is not a valid header value is refused by a fixed message', async () => {
    // Node's own TypeError for such a value quotes it; a log line must not.
    vi.stubEnv('AI_TOKEN', 'first-line\nSECRET-SECOND-LINE')
    const message = await messageOf(fetchRecommendationBatch(PAYLOAD))
    expect(message).toBe('AI_TOKEN is not a valid header value')
    expect(message).not.toContain('SECRET')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('a non-2xx answer throws the fixed message', async () => {
    for (const status of [401, 404, 422, 500, 503]) {
      // The answer's body is never read into the message; it is cancelled so the connection is freed.
      let cancelled = false
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('BODY-DETAIL the service said this'))
        },
        cancel() {
          cancelled = true
        },
      })
      fetchStub.mockResolvedValueOnce(new Response(body, { status }))

      const message = await messageOf(fetchRecommendationBatch(PAYLOAD))
      expect(message).toBe(`AI backend recommendation batch failed: ${status}`)
      expect(message).not.toContain('BODY-DETAIL')
      expect(cancelled, `body of the ${status} answer was cancelled`).toBe(true)
    }
  })

  it('rejects an unknown user, an unknown book, a score outside [0, 1], an unknown method, a repeated pair, too many results for one user', async () => {
    const cases: Array<{ name: string; message: string; leaks?: string; change: (answer: RecommendBatchResponse) => void }> = [
      {
        name: 'a user that was not sent',
        message: 'AI backend recommendation batch answered for a user that was not sent',
        leaks: 'ghost-user',
        change: (a) => a.users.push({ user_id: 'ghost-user', results: [{ book_id: 'b1', score: 0.5, method: 'content' }] }),
      },
      {
        name: 'a book that was not sent',
        message: 'AI backend recommendation batch answered with a book that was not sent',
        leaks: 'ghost-book',
        change: (a) => (a.users[0].results[0].book_id = 'ghost-book'),
      },
      {
        name: 'a score below 0',
        message: 'AI backend recommendation batch answered with a score outside [0, 1]',
        change: (a) => (a.users[0].results[0].score = -0.0001),
      },
      {
        name: 'a score above 1',
        message: 'AI backend recommendation batch answered with a score outside [0, 1]',
        change: (a) => (a.users[0].results[0].score = 1.0000001),
      },
      {
        name: 'a score that is null (what JSON makes of NaN)',
        message: 'AI backend recommendation batch answered with a score outside [0, 1]',
        change: (a) => ((a.users[0].results[0] as { score: unknown }).score = null),
      },
      {
        name: 'a score sent as a string',
        message: 'AI backend recommendation batch answered with a score outside [0, 1]',
        change: (a) => ((a.users[0].results[0] as { score: unknown }).score = '0.5'),
      },
      {
        name: 'a method that does not exist',
        message: 'AI backend recommendation batch answered with an unknown method',
        leaks: 'popular',
        change: (a) => ((a.users[0].results[0] as { method: unknown }).method = 'popular'),
      },
      {
        name: 'no method at all',
        message: 'AI backend recommendation batch answered with an unknown method',
        change: (a) => delete (a.users[0].results[0] as { method?: unknown }).method,
      },
      {
        name: 'the same book twice for one user',
        message: 'AI backend recommendation batch answered with a book twice for one user',
        // Still two results (the limit): only the repeat is wrong.
        change: (a) => (a.users[0].results[1] = { ...a.users[0].results[0] }),
      },
      {
        name: 'a user listed in two entries',
        message: 'AI backend recommendation batch answered with a user twice',
        change: (a) => a.users.push({ user_id: 'u1', results: [{ ...a.users[0].results[0] }] }),
      },
      {
        name: 'more results than the limit for one user',
        message: 'AI backend recommendation batch answered with more results than the limit',
        // limit is 2: three distinct, otherwise valid books.
        change: (a) => a.users[0].results.push({ book_id: 'b4', score: 0.2, method: 'content' }),
      },
    ]
    for (const { name, message, leaks, change } of cases) {
      const answer = clone(GOOD)
      change(answer)
      fetchStub.mockResolvedValueOnce(json(answer))

      const actual = await messageOf(fetchRecommendationBatch(PAYLOAD))
      expect(actual, name).toBe(message)
      // Messages go to the log: they never carry a value the service answered with.
      if (leaks) expect(actual, name).not.toContain(leaks)
    }
  })

  it('rejects an answer that is not shaped like one', async () => {
    const cases: Array<{ name: string; body: unknown; message: string }> = [
      { name: 'null', body: null, message: 'AI backend recommendation batch answered with something other than an object' },
      { name: 'an array', body: [], message: 'AI backend recommendation batch answered with something other than an object' },
      { name: 'a string', body: 'ok', message: 'AI backend recommendation batch answered with something other than an object' },
      { name: 'no model_version', body: { users: [] }, message: 'AI backend recommendation batch answered without a model version' },
      { name: 'an empty model_version', body: { model_version: '', users: [] }, message: 'AI backend recommendation batch answered without a model version' },
      { name: 'a numeric model_version', body: { model_version: 1, users: [] }, message: 'AI backend recommendation batch answered without a model version' },
      { name: 'no users', body: { model_version: 'tfidf-1' }, message: 'AI backend recommendation batch answered without a users list' },
      { name: 'users as an object', body: { model_version: 'tfidf-1', users: {} }, message: 'AI backend recommendation batch answered without a users list' },
      { name: 'a user that is null', body: { model_version: 'tfidf-1', users: [null] }, message: 'AI backend recommendation batch answered with a malformed user' },
      {
        name: 'a user without a user_id',
        body: { model_version: 'tfidf-1', users: [{ results: [] }] },
        message: 'AI backend recommendation batch answered with a malformed user',
      },
      {
        name: 'results that are not a list',
        body: { model_version: 'tfidf-1', users: [{ user_id: 'u1', results: 'b2' }] },
        message: 'AI backend recommendation batch answered with a malformed user',
      },
      {
        name: 'a result that is null',
        body: { model_version: 'tfidf-1', users: [{ user_id: 'u1', results: [null] }] },
        message: 'AI backend recommendation batch answered with a malformed result',
      },
      {
        name: 'a result whose book_id is a number',
        body: { model_version: 'tfidf-1', users: [{ user_id: 'u1', results: [{ book_id: 2, score: 0.5, method: 'content' }] }] },
        message: 'AI backend recommendation batch answered with a malformed result',
      },
    ]
    for (const { name, body, message } of cases) {
      fetchStub.mockResolvedValueOnce(json(body))
      expect(await messageOf(fetchRecommendationBatch(PAYLOAD)), name).toBe(message)
    }
  })

  it('rejects a body that is not JSON by a fixed message that quotes nothing of it', async () => {
    fetchStub.mockResolvedValueOnce(new Response('<html>BODY-SNIPPET gateway error</html>', { status: 200 }))
    const message = await messageOf(fetchRecommendationBatch(PAYLOAD))
    expect(message).toBe('AI backend recommendation batch answered with invalid JSON')
    expect(message).not.toContain('BODY-SNIPPET')
  })

  it("accepts the fixture's response for the fixture's request", async () => {
    fetchStub.mockResolvedValueOnce(json(FIXTURE.response))

    const result = await fetchRecommendationBatch(FIXTURE.request)

    expect(JSON.parse(fetchStub.mock.calls[0][1]?.body as string)).toEqual(FIXTURE.request)
    expect(result).toEqual(FIXTURE.response)
  })

  it('accepts an answer for nobody, and returns only the fields it knows', async () => {
    fetchStub.mockResolvedValueOnce(json({ model_version: 'tfidf-1', users: [] }))
    expect(await fetchRecommendationBatch(PAYLOAD)).toEqual({ model_version: 'tfidf-1', users: [] })

    const answer = {
      model_version: 'tfidf-als-1',
      debug: 'extra',
      users: [{ user_id: 'u2', extra: 1, results: [{ book_id: 'b3', score: 0.5, method: 'hybrid', reason: 'extra' }] }],
    }
    fetchStub.mockResolvedValueOnce(json(answer))
    expect(await fetchRecommendationBatch(PAYLOAD)).toEqual({
      model_version: 'tfidf-als-1',
      users: [{ user_id: 'u2', results: [{ book_id: 'b3', score: 0.5, method: 'hybrid' }] }],
    })
  })

  it('an aborted signal rejects', async () => {
    // Like the real fetch: rejects with the signal's reason as soon as the signal aborts, before or during the call.
    fetchStub.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )

    const controller = new AbortController()
    const pending = fetchRecommendationBatch(PAYLOAD, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchStub.mock.calls[0][1]?.signal).toBe(controller.signal)

    await expect(fetchRecommendationBatch(PAYLOAD, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })
})

describe('isRecommenderConfigured', () => {
  it('isRecommenderConfigured is false while either variable is blank', () => {
    expect(isRecommenderConfigured()).toBe(true)

    for (const name of ['AI_BACKEND_URL', 'AI_TOKEN']) {
      for (const blank of [undefined, '', '   ']) {
        vi.stubEnv('AI_BACKEND_URL', AI_URL)
        vi.stubEnv('AI_TOKEN', TOKEN)
        vi.stubEnv(name, blank)
        expect(isRecommenderConfigured(), `${name}=${JSON.stringify(blank)}`).toBe(false)
      }
    }
  })

  it('reads the environment on every call, not once at import', () => {
    vi.stubEnv('AI_TOKEN', undefined)
    expect(isRecommenderConfigured()).toBe(false)
    vi.stubEnv('AI_TOKEN', TOKEN)
    expect(isRecommenderConfigured()).toBe(true)
  })
})

describe('the shared secret goes only on the recommender call', () => {
  it('the no-show call never carries x-ai-token', async () => {
    const features: NoShowFeatures = {
      hour_of_day: 10,
      day_of_week: 2,
      duration_minutes: 60,
      lead_time_hours: 24,
      resource_type: 'seat',
      past_attendance_ratio: 0.9,
      consecutive_attended_count: 3,
      recent_noshows_count: 0,
      reliability_score: 100,
      bookings_last_30d: 4,
    }
    fetchStub.mockResolvedValueOnce(json({ predicted_probability: 0.1, penalty_factor: 0, model_version: 'noshow-test' }))

    await predictNoShow(features)

    const [url, init] = fetchStub.mock.calls[0]
    expect(url).toBe('http://ai.test:8000/predict/no-show')
    expect(new Headers(init?.headers).get('x-ai-token')).toBeNull()
    expect(JSON.stringify(init)).not.toContain(TOKEN)
  })
})
