// The background refresh of RecommendationCache (slice 8, spec section 3, "Refresh"): the 60-second timer
// calls `refreshRecommendationsIfDue(now)`, which asks the AI service for every student's picks and replaces
// the table in one transaction. `fetch` is stubbed (the real client, with its validation, still runs, so an
// invalid answer is refused by the code that would refuse it in production) and every test asserts what the
// table holds afterwards. Time is injected through `now`: nothing here sleeps or reads the wall clock.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECOMMEND_REFRESH_MS, RECOMMEND_RETRY_MS, RECOMMEND_TIMEOUT_MS } from '../../src/config/constants'
import type { CopyStatus, RecommendationMethod } from '../../src/generated/prisma/client'
import { RecommendationBatchError, type RecommendBatchRequest, type RecommendBatchResponse } from '../../src/lib/aiClient'
import { prisma } from '../../src/lib/prisma'
import {
  describeRefreshFailure,
  logRecommendationRefresh,
  refreshRecommendationsIfDue,
  resetRecommendationRefreshForTests,
} from '../../src/services/recommendationRefresh'
import { resetDb } from '../helpers/db'

// Each case seeds and reads through a remote database.
vi.setConfig({ testTimeout: 60_000 })

const AI_URL = 'http://ai.test:8000'
const TOKEN = 'tok-5d1e83-not-a-real-secret'

// A fixed base, far from "now": every instant below is an offset from it.
const T0 = new Date('2026-06-01T09:00:00.123Z')
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const MINUTE_MS = 60_000

beforeEach(async () => {
  // This machine's .env may set either variable for every test file: each test starts from known values.
  vi.stubEnv('AI_BACKEND_URL', AI_URL)
  vi.stubEnv('AI_TOKEN', TOKEN)
  resetRecommendationRefreshForTests()
  await resetDb()
})

afterEach(() => {
  resetRecommendationRefreshForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// --- Seeding ----------------------------------------------------------------------------------

async function seedStudent(label = 'Student') {
  return prisma.user.create({ data: { name: `${label} ${randomUUID()}`, email: `${randomUUID()}@example.com`, passwordHash: 'x', role: 'student' } })
}

/** A book with one copy (available unless `copy` says otherwise): sendable unless that copy is lost. */
async function seedBook(title: string, copy: CopyStatus = 'available') {
  return prisma.book.create({
    data: { isbn: `isbn-${randomUUID()}`, title, author: `Author of ${title}`, genre: 'Computing', description: `About ${title}`, publishedYear: 1999, copies: { create: [{ status: copy }] } },
  })
}

/** A returned loan: one interaction of the student with the book. */
async function seedLoan(userId: string, bookId: string) {
  const borrowedAt = at(-30 * 24 * 60 * MINUTE_MS)
  await prisma.loan.create({
    data: {
      user: { connect: { id: userId } },
      borrowedAt,
      dueAt: at(-16 * 24 * 60 * MINUTE_MS),
      returnedAt: at(-20 * 24 * 60 * MINUTE_MS),
      status: 'returned',
      bookCopy: { create: { book: { connect: { id: bookId } }, status: 'available' } },
    },
  })
}

interface Row {
  userId: string
  bookId: string
  score: number
  method: RecommendationMethod
  generatedAt: Date
}

const seedRows = (rows: Row[]) => prisma.recommendationCache.createMany({ data: rows })
const readRows = () => prisma.recommendationCache.findMany({ orderBy: [{ userId: 'asc' }, { bookId: 'asc' }] })

/** One student ("read" borrowed), two more books, and old cache rows for them: the state a refresh replaces. */
async function seedWorld() {
  const student = await seedStudent()
  const read = await seedBook('Read')
  const next = await seedBook('Next')
  const other = await seedBook('Other')
  await seedLoan(student.id, read.id)
  const old = { userId: student.id, generatedAt: at(-2 * 24 * 60 * MINUTE_MS) }
  await seedRows([
    { ...old, bookId: next.id, score: 0.11, method: 'content' },
    { ...old, bookId: other.id, score: 0.22, method: 'hybrid' },
  ])
  return { student, read, next, other, oldRows: await readRows() }
}

// --- The AI service, stubbed ---------------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const answer = (users: RecommendBatchResponse['users'], modelVersion = 'tfidf-1'): RecommendBatchResponse => ({ model_version: modelVersion, users })

/** A stub for `fetch`: the callback gets the payload the backend sent and answers with a body or a Response. */
function stubAi(respond: (sent: RecommendBatchRequest) => RecommendBatchResponse | Response | Promise<RecommendBatchResponse | Response>) {
  const stub = vi.fn<typeof fetch>(async (_url, init) => {
    const reply = await respond(JSON.parse(String(init?.body)) as RecommendBatchRequest)
    return reply instanceof Response ? reply : json(reply)
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The rejection of a call (the test fails if it resolved instead). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => ({ rejected: error }),
  )
  expect(outcome, 'the call should have rejected').toHaveProperty('rejected')
  return (outcome as { rejected: unknown }).rejected
}

describe('refreshRecommendationsIfDue', () => {
  it('does nothing while AI_BACKEND_URL or AI_TOKEN is unset or blank', async () => {
    const stub = stubAi(() => answer([]))
    const { oldRows } = await seedWorld()
    const cases: Array<[string, string | undefined, string | undefined]> = [
      ['url unset', undefined, TOKEN],
      ['url blank', '   ', TOKEN],
      ['token unset', AI_URL, undefined],
      ['token blank', AI_URL, ' \t '],
      ['both unset', undefined, undefined],
    ]

    for (const [label, url, token] of cases) {
      vi.stubEnv('AI_BACKEND_URL', url)
      vi.stubEnv('AI_TOKEN', token)
      expect(await refreshRecommendationsIfDue(T0), label).toBeNull()
    }
    expect(stub).not.toHaveBeenCalled()
    expect(await readRows()).toEqual(oldRows)

    // "Not configured" is not an attempt: nothing was stamped, so the first configured call at once is not held back.
    vi.stubEnv('AI_BACKEND_URL', AI_URL)
    vi.stubEnv('AI_TOKEN', TOKEN)
    expect(await refreshRecommendationsIfDue(T0)).not.toBeNull()
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('is due when no row exists', async () => {
    const student = await seedStudent()
    const read = await seedBook('Read')
    const next = await seedBook('Next')
    await seedLoan(student.id, read.id)
    stubAi(() => answer([{ user_id: student.id, results: [{ book_id: next.id, score: 0.5, method: 'content' }] }]))

    expect(await refreshRecommendationsIfDue(T0)).toEqual({ students: 1, rows: 1, modelVersion: 'tfidf-1' })
  })

  it('is not due while the newest row is under a day old and is due after', async () => {
    const { student, next, other } = await seedWorld()
    const stub = stubAi((sent) => answer([{ user_id: sent.interactions[0].user_id, results: [{ book_id: next.id, score: 0.5, method: 'content' }] }]))
    // The NEWEST row decides: an older one beside it changes nothing.
    await prisma.recommendationCache.deleteMany()
    await seedRows([
      { userId: student.id, bookId: next.id, score: 0.3, method: 'content', generatedAt: at(-3 * 24 * 60 * MINUTE_MS) },
      { userId: student.id, bookId: other.id, score: 0.3, method: 'content', generatedAt: T0 },
    ])

    expect(await refreshRecommendationsIfDue(at(RECOMMEND_REFRESH_MS - 1))).toBeNull()
    // "Older than a day" is strict: exactly a day old is not yet due.
    expect(await refreshRecommendationsIfDue(at(RECOMMEND_REFRESH_MS))).toBeNull()
    expect(stub).not.toHaveBeenCalled()

    // A call that found nothing due is not an attempt, so the very next millisecond may refresh.
    const result = await refreshRecommendationsIfDue(at(RECOMMEND_REFRESH_MS + 1))
    expect(result).toEqual({ students: 1, rows: 1, modelVersion: 'tfidf-1' })
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('a failed attempt is not repeated inside 15 minutes and is after', async () => {
    await seedWorld()
    const stub = stubAi(() => new Response('upstream down', { status: 503 }))

    const first = await rejectionOf(refreshRecommendationsIfDue(T0))
    expect(first).toBeInstanceOf(RecommendationBatchError)
    expect((first as Error).message).toBe('AI backend recommendation batch failed: 503')
    expect(stub).toHaveBeenCalledTimes(1)

    // Inside the window, whatever the number of beats: nothing is sent.
    expect(await refreshRecommendationsIfDue(at(MINUTE_MS))).toBeNull()
    expect(await refreshRecommendationsIfDue(at(RECOMMEND_RETRY_MS - 1))).toBeNull()
    expect(stub).toHaveBeenCalledTimes(1)

    // Exactly 15 minutes after the attempt it tries again (so the failure also cleared the single-flight guard) ...
    await rejectionOf(refreshRecommendationsIfDue(at(RECOMMEND_RETRY_MS)))
    expect(stub).toHaveBeenCalledTimes(2)
    // ... and that attempt moved the window: 15 minutes are counted from it, not from the first.
    expect(await refreshRecommendationsIfDue(at(2 * RECOMMEND_RETRY_MS - 1))).toBeNull()
    expect(stub).toHaveBeenCalledTimes(2)
    await rejectionOf(refreshRecommendationsIfDue(at(2 * RECOMMEND_RETRY_MS)))
    expect(stub).toHaveBeenCalledTimes(3)
  })

  it('two overlapping calls make one request', async () => {
    const { student, next } = await seedWorld()
    const gate = deferred()
    const stub = stubAi(async () => {
      await gate.promise
      return answer([{ user_id: student.id, results: [{ book_id: next.id, score: 0.5, method: 'content' }] }])
    })

    const running = refreshRecommendationsIfDue(T0)
    // A later beat finds the refresh still running (the AI call is parked on the gate). Its clock is far past the
    // retry window, so only the single-flight guard can be what turns it away.
    await vi.waitFor(() => expect(stub).toHaveBeenCalledTimes(1), { timeout: 30_000, interval: 20 })
    expect(await refreshRecommendationsIfDue(at(RECOMMEND_RETRY_MS * 4))).toBeNull()
    expect(await refreshRecommendationsIfDue(at(RECOMMEND_RETRY_MS * 8))).toBeNull()
    expect(stub).toHaveBeenCalledTimes(1)

    gate.resolve()
    expect(await running).toEqual({ students: 1, rows: 1, modelVersion: 'tfidf-1' })
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('two calls that start in the same tick make one request too (the guard is taken before anything is awaited)', async () => {
    const { student, next } = await seedWorld()
    const stub = stubAi(() => answer([{ user_id: student.id, results: [{ book_id: next.id, score: 0.5, method: 'content' }] }]))

    const results = await Promise.all([refreshRecommendationsIfDue(T0), refreshRecommendationsIfDue(T0)])

    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('a good answer replaces every row and sets generatedAt to now', async () => {
    const { student, read, next, other, oldRows } = await seedWorld()
    // A second student, and an old row of a third that the new answer does not mention: every old row must go.
    const second = await seedStudent()
    const third = await seedStudent()
    await seedLoan(second.id, next.id)
    await seedRows([{ userId: third.id, bookId: read.id, score: 0.9, method: 'collaborative', generatedAt: at(-3 * 24 * 60 * MINUTE_MS) }])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stub = stubAi(() =>
      answer(
        [
          {
            user_id: student.id,
            results: [
              { book_id: next.id, score: 0.9, method: 'hybrid' },
              { book_id: other.id, score: 0.4, method: 'content' },
            ],
          },
          { user_id: second.id, results: [{ book_id: other.id, score: 0.5, method: 'collaborative' }] },
        ],
        'tfidf-als-1',
      ),
    )
    expect(oldRows).toHaveLength(2)

    const result = await refreshRecommendationsIfDue(T0)

    expect(result).toEqual({ students: 2, rows: 3, modelVersion: 'tfidf-als-1' })
    const rows = await readRows()
    expect(rows.map(({ userId, bookId, score, method }) => ({ userId, bookId, score, method })).sort((a, b) => a.userId.localeCompare(b.userId) || a.bookId.localeCompare(b.bookId))).toEqual(
      [
        { userId: student.id, bookId: next.id, score: 0.9, method: 'hybrid' },
        { userId: student.id, bookId: other.id, score: 0.4, method: 'content' },
        { userId: second.id, bookId: other.id, score: 0.5, method: 'collaborative' },
      ].sort((a, b) => a.userId.localeCompare(b.userId) || a.bookId.localeCompare(b.bookId)),
    )
    // Passed explicitly from JavaScript, to the millisecond: the column is a plain timestamp.
    expect(rows.map((r) => r.generatedAt.toISOString())).toEqual([T0.toISOString(), T0.toISOString(), T0.toISOString()])
    expect(rows.some((r) => r.userId === third.id)).toBe(false)
    // The refresh itself is silent: the timer logs its result (runScheduledSweeps).
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()

    // What it asked: the shared secret, the path, the catalog and the interactions, ids only.
    expect(stub).toHaveBeenCalledTimes(1)
    const [url, init] = stub.mock.calls[0]
    expect(url).toBe(`${AI_URL}/recommend/batch`)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-ai-token')).toBe(TOKEN)
    const sent = JSON.parse(String(init?.body)) as RecommendBatchRequest
    expect(Object.keys(sent).sort()).toEqual(['books', 'interactions', 'limit'])
    expect(sent.books.map((b) => b.id).sort()).toEqual([next.id, other.id, read.id].sort())
    expect(sent.interactions.map((i) => `${i.user_id}|${i.book_id}|${i.weight}`).sort()).toEqual(
      [`${student.id}|${read.id}|1`, `${second.id}|${next.id}|1`].sort(),
    )
  })

  it('an answer naming a book that was not sent leaves the old rows and rejects', async () => {
    const { student, oldRows } = await seedWorld()
    // A real book, with a lost copy only: it exists (so the database would take the row) but was not sent.
    const gone = await seedBook('Lost for good', 'lost')
    stubAi((sent) => {
      expect(sent.books.map((b) => b.id)).not.toContain(gone.id)
      return answer([{ user_id: student.id, results: [{ book_id: gone.id, score: 0.8, method: 'content' }] }])
    })

    const failure = await rejectionOf(refreshRecommendationsIfDue(T0))

    expect(failure).toBeInstanceOf(RecommendationBatchError)
    expect((failure as Error).message).toBe('AI backend recommendation batch answered with a book that was not sent')
    expect(await readRows()).toEqual(oldRows)
  })

  it('an answer for a student that was not sent leaves the old rows and rejects', async () => {
    const { oldRows, next } = await seedWorld()
    // A real student with no loan or reservation: not in the payload, so not in any valid answer.
    const bystander = await seedStudent()
    stubAi(() => answer([{ user_id: bystander.id, results: [{ book_id: next.id, score: 0.8, method: 'content' }] }]))

    const failure = await rejectionOf(refreshRecommendationsIfDue(T0))

    expect((failure as Error).message).toBe('AI backend recommendation batch answered for a user that was not sent')
    expect(await readRows()).toEqual(oldRows)
  })

  it('an HTTP error or a timeout leaves the old rows', async () => {
    const { oldRows } = await seedWorld()
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20))
    // A fetch that honours its signal, like the real one: the timeout aborts it with the signal's reason.
    const hang = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            }),
        ),
      )
    const cases: Array<[string, () => void]> = [
      ['an HTTP 500', () => void stubAi(() => new Response('boom', { status: 500 }))],
      ['an HTTP 401', () => void stubAi(() => new Response('no', { status: 401 }))],
      ['an unreachable service', () => vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))],
      ['a timeout', hang],
    ]

    for (const [label, install] of cases) {
      resetRecommendationRefreshForTests() // each case is a fresh process as far as the retry window goes
      install()
      await rejectionOf(refreshRecommendationsIfDue(T0))
      expect(await readRows(), label).toEqual(oldRows)
    }
    // The call's own timeout is the 90-second one (the spy above only shortened what the stub waits for).
    expect(timeout).toHaveBeenCalledWith(RECOMMEND_TIMEOUT_MS)
  })

  it('an answer with no users empties the table', async () => {
    const { oldRows } = await seedWorld()
    stubAi(() => answer([], 'tfidf-1'))
    expect(oldRows.length).toBeGreaterThan(0)

    const result = await refreshRecommendationsIfDue(T0)

    expect(result).toEqual({ students: 0, rows: 0, modelVersion: 'tfidf-1' })
    expect(await readRows()).toEqual([])
  })

  it('nothing to send makes no request and returns null', async () => {
    // Books, a student and old rows, but nobody has borrowed or reserved anything.
    const student = await seedStudent()
    const next = await seedBook('Next')
    await seedRows([{ userId: student.id, bookId: next.id, score: 0.3, method: 'content', generatedAt: at(-2 * 24 * 60 * MINUTE_MS) }])
    const oldRows = await readRows()
    const stub = stubAi(() => answer([]))

    expect(await refreshRecommendationsIfDue(T0)).toBeNull()
    expect(stub).not.toHaveBeenCalled()
    expect(await readRows()).toEqual(oldRows)

    // It counted as an attempt: a student borrows a minute later, but the window is not over ...
    const read = await seedBook('Read')
    await seedLoan(student.id, read.id)
    expect(await refreshRecommendationsIfDue(at(MINUTE_MS))).toBeNull()
    expect(stub).not.toHaveBeenCalled()
    // ... and when it is, the refresh asks.
    expect(await refreshRecommendationsIfDue(at(RECOMMEND_RETRY_MS))).toEqual({ students: 0, rows: 0, modelVersion: 'tfidf-1' })
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('a store failure rolls the whole replacement back and rejects with a loggable error', async () => {
    const { student, read, next, other, oldRows } = await seedWorld()
    // A second student, who will vanish while the AI service is working (removed with their only loan).
    const leaver = await seedStudent()
    await seedLoan(leaver.id, read.id)
    stubAi(async () => {
      await prisma.loan.deleteMany({ where: { userId: leaver.id } })
      await prisma.user.delete({ where: { id: leaver.id } })
      return answer([
        { user_id: student.id, results: [{ book_id: next.id, score: 0.9, method: 'content' }] },
        { user_id: leaver.id, results: [{ book_id: other.id, score: 0.9, method: 'content' }] },
      ])
    })

    const failure = await rejectionOf(refreshRecommendationsIfDue(T0))

    // The delete of the old rows and the first student's new row were in the same transaction as the failing insert.
    expect(await readRows()).toEqual(oldRows)
    expect(failure).toBeInstanceOf(Error)
    expect(describeRefreshFailure(failure)).toMatch(/^PrismaClientKnownRequestError P\d{4}$/)
  })

  it('writes more than one chunk of rows without losing or doubling any', async () => {
    // 101 students, ten picks each: 1,010 rows, so one chunk of 1,000 and a second of 10.
    const books = await Promise.all(Array.from({ length: 11 }, (_, i) => seedBook(`Book ${String(i).padStart(2, '0')}`)))
    const ids = Array.from({ length: 101 }, () => randomUUID())
    await prisma.user.createMany({ data: ids.map((id) => ({ id, name: `Student ${id}`, email: `${id}@example.com`, passwordHash: 'x', role: 'student' as const })) })
    await prisma.reservation.createMany({ data: ids.map((userId) => ({ userId, bookId: books[0].id })) })
    stubAi((sent) =>
      answer(
        [...new Set(sent.interactions.map((i) => i.user_id))].map((user_id) => ({
          user_id,
          results: books.slice(1).map((book, i) => ({ book_id: book.id, score: 1 - i / 100, method: 'content' as const })),
        })),
      ),
    )

    const result = await refreshRecommendationsIfDue(T0)

    expect(result).toEqual({ students: 101, rows: 1010, modelVersion: 'tfidf-1' })
    const perStudent = await prisma.recommendationCache.groupBy({ by: ['userId'], _count: { _all: true } })
    expect(perStudent).toHaveLength(101)
    expect(new Set(perStudent.map((g) => g._count._all))).toEqual(new Set([10]))
  })

  it('resetRecommendationRefreshForTests puts the retry window back', async () => {
    await seedWorld()
    const stub = stubAi(() => new Response('down', { status: 500 }))
    await rejectionOf(refreshRecommendationsIfDue(T0))
    expect(await refreshRecommendationsIfDue(at(MINUTE_MS))).toBeNull()

    resetRecommendationRefreshForTests()

    await rejectionOf(refreshRecommendationsIfDue(at(MINUTE_MS)))
    expect(stub).toHaveBeenCalledTimes(2)
  })
})

describe('logRecommendationRefresh', () => {
  it('the log line carries counts and the model version only', async () => {
    // A real refresh over data with recognisable names, titles and ids: none of it may reach the line.
    const student = await seedStudent('Aditi Distinctive')
    const read = await seedBook('Secret Title Alpha')
    const next = await seedBook('Secret Title Beta')
    await seedLoan(student.id, read.id)
    stubAi(() => answer([{ user_id: student.id, results: [{ book_id: next.id, score: 0.5, method: 'hybrid' }] }], 'tfidf-als-1'))
    const result = await refreshRecommendationsIfDue(T0)
    expect(result).toEqual({ students: 1, rows: 1, modelVersion: 'tfidf-als-1' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logRecommendationRefresh(result!)

    expect(error).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]).toEqual(['recommendation refresh: students=1 rows=1 model=tfidf-als-1'])
    const printed = log.mock.calls.flat().join(' | ')
    const user = await prisma.user.findUniqueOrThrow({ where: { id: student.id } })
    for (const secret of [user.name, user.email, 'Distinctive', 'Secret Title', student.id, read.id, next.id, TOKEN, AI_URL]) {
      expect(printed).not.toContain(secret)
    }
  })

  it('prints a model version that is not a plain token as a harmless one-line string', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    logRecommendationRefresh({ students: 3, rows: 21, modelVersion: 'tfidf-1\nrecommendation refresh: students=999 http://user:pw@host/x' })

    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0][0])
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).not.toContain('user:pw')
    expect(line.startsWith('recommendation refresh: students=3 rows=21 model=tfidf-1')).toBe(true)
  })
})

describe('describeRefreshFailure (the only text a failed refresh may log)', () => {
  const FAKE_URL = 'http://svc-user:p4ssw0rd@10.9.8.7:8000/recommend/batch'
  const FAKE_TOKEN = 'tok-SECRET-123'

  it("keeps a RecommendationBatchError's own message (fixed strings, written to be logged)", () => {
    expect(describeRefreshFailure(new RecommendationBatchError('AI backend recommendation batch failed: 503'))).toBe('AI backend recommendation batch failed: 503')
    expect(describeRefreshFailure(new RecommendationBatchError('AI_TOKEN is not set'))).toBe('AI_TOKEN is not set')
  })

  it('says only the class for any other error, never its message or its cause', () => {
    const unreachable = new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ECONNREFUSED 10.9.8.7:8000 for ${FAKE_URL} with ${FAKE_TOKEN}`), { code: 'ECONNREFUSED' }),
    })
    const malformedUrl = new TypeError(`Failed to parse URL from ${FAKE_URL}`, { cause: new Error(`Invalid URL ${FAKE_URL}`) })
    const quotesToken = new TypeError(`Headers.append: "${FAKE_TOKEN}" is an invalid header value.`)

    for (const error of [malformedUrl, quotesToken]) {
      const text = describeRefreshFailure(error)
      expect(text).toBe('TypeError')
      for (const secret of [FAKE_URL, FAKE_TOKEN, 'p4ssw0rd', '10.9.8.7', 'ECONNREFUSED']) expect(text).not.toContain(secret)
    }
    // The one TypeError that says more is the unreachable service, and only its cause's code: never the cause's message.
    const text = describeRefreshFailure(unreachable)
    expect(text).toBe('ECONNREFUSED')
    for (const secret of [FAKE_URL, FAKE_TOKEN, 'p4ssw0rd', '10.9.8.7']) expect(text).not.toContain(secret)
  })

  // What fetch rejects with when it cannot reach the service: TypeError('fetch failed'), the socket error in its `cause`.
  const unreachableWith = (cause?: unknown) => new TypeError('fetch failed', cause === undefined ? undefined : { cause })
  const causeWithCode = (code: unknown) => Object.assign(new Error(`connect failed to ${FAKE_URL} with ${FAKE_TOKEN}`), { code })

  it("an unreachable service logs the cause's code", () => {
    // What Node's network layer puts in the cause: a refused connection, an unknown host, a connect timeout, a TLS failure.
    const longest = `E${'X'.repeat(39)}` // the longest shape allowed: 40 characters
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', longest]) {
      const text = describeRefreshFailure(unreachableWith(causeWithCode(code)))
      expect(text).toBe(code)
      // Only the code: the cause's message (an address, the credentialed URL, a token) stays out.
      for (const secret of [FAKE_URL, FAKE_TOKEN, 'p4ssw0rd']) expect(text).not.toContain(secret)
    }
  })

  it('an unreachable service whose cause has no usable code logs AI service unreachable', () => {
    const causes: Array<[string, unknown]> = [
      ['no cause', undefined],
      ['a null cause', null],
      ['a cause that is a string', `connect ECONNREFUSED ${FAKE_URL}`],
      ['a cause with no code', new Error(`connect ECONNREFUSED ${FAKE_URL} with ${FAKE_TOKEN}`)],
      ['a numeric code', causeWithCode(111)],
      ['a lower-case code', causeWithCode('econnrefused')],
      ['a code that is a URL', causeWithCode(FAKE_URL)],
      ['a code carrying a URL', causeWithCode(`ECONNREFUSED ${FAKE_URL}`)],
      ['a code that is a token', causeWithCode(FAKE_TOKEN)],
      ['a code carrying a token', causeWithCode(`ECONNREFUSED_${FAKE_TOKEN}`)],
      ['a code with a line break', causeWithCode('ECONNREFUSED\nrecommendation refresh: students=999')],
      ['a code of one character', causeWithCode('E')],
      ['a code of 41 characters', causeWithCode(`E${'X'.repeat(40)}`)],
    ]

    for (const [label, cause] of causes) {
      const text = describeRefreshFailure(unreachableWith(cause))
      expect(text, label).toBe('AI service unreachable')
      for (const secret of [FAKE_URL, FAKE_TOKEN, 'p4ssw0rd', '10.9.8.7']) expect(text, label).not.toContain(secret)
    }
  })

  it('a malformed-URL TypeError logs only TypeError', () => {
    // What fetch throws for an AI_BACKEND_URL it cannot use: a TypeError whose message quotes the URL, credentials included.
    // It is not "fetch failed", so nothing of it is logged but its class, even when its cause carries a system code.
    const credentialed = new TypeError(`Request cannot be constructed from a URL that includes credentials: https://user:secret@host/recommend/batch ${FAKE_TOKEN}`)
    const withCauseCode = new TypeError(`Failed to parse URL from https://user:secret@host ${FAKE_TOKEN}`, {
      cause: Object.assign(new Error('Invalid URL https://user:secret@host'), { code: 'ERR_INVALID_URL' }),
    })

    for (const error of [credentialed, withCauseCode]) {
      const text = describeRefreshFailure(error)
      expect(text).toBe('TypeError')
      for (const secret of ['https://user:secret@host', 'user:secret', 'secret', FAKE_TOKEN, 'ERR_INVALID_URL']) expect(text).not.toContain(secret)
    }
  })

  it('adds the code when it is a string, so a database error says which one', () => {
    const prismaError = Object.assign(new Error(`Unique constraint failed on the fields: (userId,bookId) ${FAKE_TOKEN}`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['userId', 'bookId'] },
    })

    expect(describeRefreshFailure(prismaError)).toBe('PrismaClientKnownRequestError P2002')
    expect(describeRefreshFailure(Object.assign(new Error('x'), { code: 42 }))).toBe('Error')
  })

  it('says "timed out" for a timeout or an abort, whatever it carries', () => {
    expect(describeRefreshFailure(new DOMException(`The operation was aborted due to timeout ${FAKE_URL}`, 'TimeoutError'))).toBe('timed out')
    expect(describeRefreshFailure(new DOMException(`This operation was aborted ${FAKE_TOKEN}`, 'AbortError'))).toBe('timed out')
    expect(describeRefreshFailure(AbortSignal.abort().reason)).toBe('timed out')
  })

  it('says "unknown error" for anything that is not an error object', () => {
    expect(describeRefreshFailure(`thrown string with ${FAKE_URL}`)).toBe('unknown error')
    expect(describeRefreshFailure(null)).toBe('unknown error')
    expect(describeRefreshFailure({ message: FAKE_TOKEN })).toBe('unknown error')
  })
})
