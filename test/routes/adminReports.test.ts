// A librarian settling a student's problem report from the Needs attention queue:
// confirming it (a copy goes to maintenance or is marked lost, a resource goes
// offline) or dismissing it. Covers what each outcome does to the target, the notice
// the student gets and its email, every refusal (and that a refusal writes, sends and
// publishes nothing), idempotency on the target's state, the live events, and the
// races: two resolutions of one report, a refusal that is re-read after a competing
// change, and the closing write holding no loan, copy or book lock. The queue itself
// is in test/routes/adminAttention.test.ts; filing a report is in reports.test.ts.
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { CopyStatus, EmailStatus, IssueCategory, Prisma, ResourceStatus } from '../../src/generated/prisma/client'
import { subscribe } from '../../src/lib/events'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

// Several tests here make a dozen requests, each several round trips to the remote test database; one
// of them took 15 s once, the default limit. The race tests state their own limits below.
vi.setConfig({ testTimeout: 60_000 })

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const ROUNDS = 4

const RESOLVED = 'This report was already resolved.'
const CHOOSE = 'Choose what to do with the copy.'
const NOW_ON_LOAN = 'This copy is now on loan.'
const WAITLIST = 'This copy is set aside for a student on the waitlist.'
const ALREADY_LOST = 'This copy is already lost.'
const HELD = 'This copy is held for a borrow request.'
const ATTENTION_CHANGED = { type: 'attention.changed', topics: ['attention'] }

// The wording of spec 5.3, spelled out here and not taken from the service.
const CONFIRMED_TITLE = 'Thanks for the report'
const DISMISSED_TITLE = 'About your report'
const confirmedBody = (target: string) => `Thanks for reporting a problem with ${target}. The library has taken it out of use for now.`
const dismissedBody = (target: string) => `The library looked at your report about ${target} and no action was needed.`
const withNote = (body: string, note: string) => `${body}\n\nNote from the library: ${note}`

async function seedUser(role: 'student' | 'admin' = 'student', extra: { name?: string; email?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      name: extra.name ?? `${role} ${Math.random()}`,
      email: extra.email ?? `${role}${Math.random()}@test.com`,
      passwordHash: 'x',
      role,
    },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

async function seedBookWithCopy(title: string, status: CopyStatus) {
  const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Some Author', totalCopies: 1 } })
  const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status } })
  return { book, copy }
}

interface ReportSeed {
  title?: string
  copyStatus?: CopyStatus
  category?: IssueCategory
  note?: string | null
}

/** An open report of a new book's only copy, as a student's return leaves it. */
async function seedCopyReport(studentId: string, o: ReportSeed = {}) {
  const { book, copy } = await seedBookWithCopy(o.title ?? 'Clean Code', o.copyStatus ?? 'available')
  const report = await prisma.issueReport.create({
    data: {
      userId: studentId,
      bookCopyId: copy.id,
      category: o.category ?? 'damaged',
      note: o.note === undefined ? 'The cover is torn' : o.note,
    },
  })
  return { book, copy, report }
}

interface ResourceReportSeed {
  name?: string
  status?: ResourceStatus
  statusNote?: string
  category?: IssueCategory
  note?: string | null
}

/** An open report of a new seat. */
async function seedResourceReport(studentId: string, o: ResourceReportSeed = {}) {
  const resource = await prisma.resource.create({
    data: { type: 'seat', name: o.name ?? 'Reading Room A · Desk 12', status: o.status ?? 'available', statusNote: o.statusNote },
  })
  const report = await prisma.issueReport.create({
    data: {
      userId: studentId,
      resourceId: resource.id,
      category: o.category ?? 'not_working',
      note: o.note === undefined ? 'The lamp is dead' : o.note,
    },
  })
  return { resource, report }
}

/** Injects a fake mail transport (cleared in afterEach); email is then configured, and nothing leaves the process. */
function fakeTransport(ok = true) {
  const send = vi.fn<MailTransport['send']>(async () => ({ ok }))
  setMailTransport({ send })
  return send
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const send = (req: request.Test, body?: unknown) => (body === undefined ? req : req.send(body as object))
const confirm = (token: string, id: string, body?: unknown) => send(request(app).post(`/admin/reports/${id}/confirm`).set(auth(token)), body)
const dismiss = (token: string, id: string, body?: unknown) => send(request(app).post(`/admin/reports/${id}/dismiss`).set(auth(token)), body)

const reportRow = (id: string) => prisma.issueReport.findUniqueOrThrow({ where: { id } })
const copyStatus = (id: string) => prisma.bookCopy.findUniqueOrThrow({ where: { id } }).then((c) => c.status)
const resourceRow = (id: string) => prisma.resource.findUniqueOrThrow({ where: { id } })
const allNotices = () => prisma.notice.findMany({ orderBy: { createdAt: 'asc' } })
const attentionEvents = (events: Array<{ type: string }>) => events.filter((e) => e.type === 'attention.changed')

// A race needs both requests to get a database connection at once. A fresh pool has
// one warm connection and opens the next on demand (slow on a remote database), which
// would queue the second request behind the first and hide the race.
const warmPool = () => Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`SELECT 1`))

/** Sends both requests at once; on odd rounds the second is started first, so each order gets hit. */
async function together(round: number, first: () => PromiseLike<request.Response>, second: () => PromiseLike<request.Response>) {
  if (round % 2 === 0) return Promise.all([first(), second()])
  const [secondRes, firstRes] = await Promise.all([second(), first()])
  return [firstRes, secondRes] as const
}

/** Polls until some other session is stuck waiting for a lock (the action under test, on the row the test holds). */
async function waitUntilAWriterIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the row the test holds')
}

/**
 * Takes the lock `lock` names, starts `action`, waits until it is blocked on it, lets
 * `competitor` change the rows in the locking transaction and commits. The action then
 * runs against the changed rows, exactly as if the competitor had landed just before
 * its own write, and after everything the request read first (a plain read is not
 * blocked by the lock, so it sees the old rows).
 */
async function blockedThenCompete(
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await lock(tx)
        pending = Promise.resolve(action())
        await waitUntilAWriterIsBlocked()
        await competitor(tx)
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
  } finally {
    // Never leave the request running into the next test, even when the setup failed.
    await pending
  }
  return pending!
}

// A developer's .env may set an allowed-domains list; these tests use their own addresses.
let savedAllowedDomains: string | undefined
let recorder: ReturnType<typeof recordEvents> | undefined

beforeEach(async () => {
  savedAllowedDomains = process.env.MAIL_ALLOWED_DOMAINS
  delete process.env.MAIL_ALLOWED_DOMAINS
  setMailTransport(null)
  await resetDb()
})

afterEach(() => {
  recorder?.stop()
  recorder = undefined
  setMailTransport(null)
  if (savedAllowedDomains === undefined) delete process.env.MAIL_ALLOWED_DOMAINS
  else process.env.MAIL_ALLOWED_DOMAINS = savedAllowedDomains
  vi.restoreAllMocks()
})

describe('POST /admin/reports/:id/confirm and /dismiss: access', () => {
  it('both are for admins only', async () => {
    const { token: student } = await seedUser()

    for (const path of ['/admin/reports/some-report/confirm', '/admin/reports/some-report/dismiss']) {
      const anonymous = await request(app).post(path)
      const asStudent = await request(app).post(path).set(auth(student))
      expect(anonymous.status, `${path} without a token`).toBe(401)
      expect(asStudent.status, `${path} as a student`).toBe(403)
    }
  })
})

describe('POST /admin/reports/:id/confirm: a copy report', () => {
  it('confirming a copy report as maintenance puts the copy in maintenance, closes the report and notifies the reporter', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: student, token: studentToken } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const mail = fakeTransport()
    const { copy, report } = await seedCopyReport(student.id, { title: 'Clean Code', note: 'The cover is torn' })
    const before = Date.now()

    const res = await confirm(admin, report.id, { outcome: 'maintenance', note: '  Sent for repair  ' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: report.id })
    expect(await copyStatus(copy.id)).toBe('maintenance')
    const closed = await reportRow(report.id)
    expect(closed).toMatchObject({
      status: 'confirmed',
      resolutionNote: 'Sent for repair',
      resolvedById: librarian.id,
      // What the student wrote is left as it was.
      userId: student.id,
      bookCopyId: copy.id,
      category: 'damaged',
      note: 'The cover is torn',
    })
    expect(closed.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(closed.resolvedAt!.getTime()).toBeLessThanOrEqual(Date.now())

    const [notice, ...rest] = await allNotices()
    expect(rest).toEqual([])
    expect(notice).toMatchObject({
      userId: student.id,
      kind: 'report_outcome',
      title: CONFIRMED_TITLE,
      body: withNote(confirmedBody('Clean Code'), 'Sent for repair'),
      loanId: null,
      fineId: null,
      createdById: librarian.id,
      emailStatus: 'sent',
    })
    expect(notice.emailedAt).not.toBeNull()
    expect(mail).toHaveBeenCalledTimes(1)
    const [message] = mail.mock.calls[0]
    expect(message.to).toBe('asha@example.org')
    expect(message.subject).toBe(`SmartLib: ${CONFIRMED_TITLE}`)
    expect(message.text.startsWith(notice.body)).toBe(true)

    // The student sees the same notice in the app.
    const seen = await request(app).get('/notices/me').set(auth(studentToken))
    expect((seen.body as Array<{ kind: string; title: string; body: string }>).map((n) => [n.kind, n.title, n.body])).toEqual([
      ['report_outcome', CONFIRMED_TITLE, notice.body],
    ])
  })

  it('a confirmation with no note says nothing more than the sentence, and the confirmed report leaves the queue', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const kept = await seedCopyReport(student.id, { title: 'Dune' })
    const other = await seedCopyReport(student.id, { title: 'Emma' })

    expect((await request(app).get('/admin/attention?kind=report').set(auth(admin))).body.counts.report).toBe(2)
    const res = await confirm(admin, kept.report.id, { outcome: 'maintenance', note: '   ' })

    expect(res.status).toBe(200)
    expect((await allNotices()).map((n) => n.body)).toEqual([confirmedBody('Dune')])
    expect((await reportRow(kept.report.id)).resolutionNote).toBeNull()
    const queue = await request(app).get('/admin/attention?kind=report').set(auth(admin))
    expect(queue.body.counts).toMatchObject({ all: 1, report: 1 })
    expect((queue.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([other.report.id])
  })

  it('as lost works for a shelf copy and never creates a fine', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { email: 'asha@example.org' })
    const { user: ben } = await seedUser('student', { email: 'ben@example.org' })
    fakeTransport()
    const onShelf = await seedCopyReport(asha.id, { title: 'Dune', copyStatus: 'available' })
    const inMaintenance = await seedCopyReport(ben.id, { title: 'Emma', copyStatus: 'maintenance' })

    const first = await confirm(admin, onShelf.report.id, { outcome: 'lost' })
    const second = await confirm(admin, inMaintenance.report.id, { outcome: 'lost', note: 'Not on the shelf' })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await copyStatus(onShelf.copy.id)).toBe('lost')
    expect(await copyStatus(inMaintenance.copy.id)).toBe('lost')
    expect((await reportRow(onShelf.report.id)).status).toBe('confirmed')
    expect((await reportRow(inMaintenance.report.id)).status).toBe('confirmed')
    // A report never charges anyone: no fine, and no loan was touched.
    expect(await prisma.fine.count()).toBe(0)
    expect(await prisma.loan.count()).toBe(0)
    const notices = await allNotices()
    expect(notices.find((n) => n.userId === asha.id)!.body).toBe(confirmedBody('Dune'))
    expect(notices.find((n) => n.userId === ben.id)!.body).toBe(withNote(confirmedBody('Emma'), 'Not on the shelf'))
  })

  it('a copy that was lent again is refused with "This copy is now on loan." and the report stays open', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: reporter } = await seedUser()
    const { user: borrower } = await seedUser()
    const mail = fakeTransport()
    const { copy, report } = await seedCopyReport(reporter.id, { title: 'Refactoring', copyStatus: 'borrowed' })
    // Lent to another student after the reporter returned it, and three days late: a loss with a charge would fine them.
    const dueAt = new Date(Date.now() - (3 * DAY_MS + HOUR_MS))
    const loan = await prisma.loan.create({
      data: { userId: borrower.id, bookCopyId: copy.id, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), dueAt },
    })
    recorder = recordEvents()

    for (const outcome of ['lost', 'maintenance'] as const) {
      const res = await confirm(admin, report.id, { outcome, note: 'Please check it' })
      expect(res.status, outcome).toBe(409)
      expect(res.body, outcome).toEqual({ error: NOW_ON_LOAN })
    }

    // Nothing changed: the copy is still out, the loan is untouched, nobody was fined.
    expect(await copyStatus(copy.id)).toBe('borrowed')
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({
      userId: borrower.id,
      status: 'active',
      lostAt: null,
      returnedAt: null,
      dueAt,
    })
    expect(await prisma.fine.count()).toBe(0)
    expect(await reportRow(report.id)).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('a waitlist refusal keeps the report open', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: reporter } = await seedUser()
    const { user: waiting } = await seedUser()
    const mail = fakeTransport()
    const { book, copy, report } = await seedCopyReport(reporter.id, { title: 'Dune' })
    // The only copy is set aside for a student whose claim is still running.
    const claim = await prisma.reservation.create({
      data: {
        userId: waiting.id,
        bookId: book.id,
        status: 'fulfilled',
        requestedAt: new Date(Date.now() - 2 * DAY_MS),
        claimExpiresAt: new Date(Date.now() + HOUR_MS),
      },
    })
    recorder = recordEvents()

    for (const outcome of ['maintenance', 'lost'] as const) {
      const res = await confirm(admin, report.id, { outcome })
      expect(res.status, outcome).toBe(409)
      expect(res.body, outcome).toEqual({ error: WAITLIST })
    }

    expect(await copyStatus(copy.id)).toBe('available')
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('fulfilled')
    expect((await reportRow(report.id)).status).toBe('open')
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('a copy already in maintenance closes the report without error (and so does one already lost, confirmed as lost)', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser()
    const { user: ben } = await seedUser()
    fakeTransport()
    const inMaintenance = await seedCopyReport(asha.id, { title: 'Dune', copyStatus: 'maintenance' })
    const alreadyLost = await seedCopyReport(ben.id, { title: 'Emma', copyStatus: 'lost' })
    recorder = recordEvents()
    // The copy action starts by reading the copy (adminCopyService.bookOf), and nothing else here reads
    // a BookCopy row on its own: a copy already where it should be is never handed to the action.
    const copyRead = vi.spyOn(prisma.bookCopy, 'findUnique')

    const first = await confirm(admin, inMaintenance.report.id, { outcome: 'maintenance' })
    const second = await confirm(admin, alreadyLost.report.id, { outcome: 'lost' })

    expect(copyRead).not.toHaveBeenCalled()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await reportRow(inMaintenance.report.id)).status).toBe('confirmed')
    expect((await reportRow(alreadyLost.report.id)).status).toBe('confirmed')
    expect(await copyStatus(inMaintenance.copy.id)).toBe('maintenance')
    expect(await copyStatus(alreadyLost.copy.id)).toBe('lost')
    expect(await prisma.notice.count()).toBe(2)
    // The copy action was not run again (it would have published catalogue.changed): only the queue changed.
    expect(recorder.events).toEqual([ATTENTION_CHANGED, ATTENTION_CHANGED])
  })

  it('a copy in a different state than the one asked for is refused as the copy action says, and the report stays open', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: asha } = await seedUser()
    const { user: ben } = await seedUser()
    const { user: cara } = await seedUser()
    const mail = fakeTransport()
    const lostCopy = await seedCopyReport(asha.id, { title: 'Dune', copyStatus: 'lost' })
    const heldForRequest = await seedCopyReport(ben.id, { title: 'Emma', copyStatus: 'requested' })
    const heldAgain = await seedCopyReport(cara.id, { title: 'Ulysses', copyStatus: 'requested' })
    recorder = recordEvents()

    // Lost, and maintenance is asked: it is not in maintenance, so the refusal stands.
    const lostAsMaintenance = await confirm(admin, lostCopy.report.id, { outcome: 'maintenance' })
    const heldAsMaintenance = await confirm(admin, heldForRequest.report.id, { outcome: 'maintenance' })
    const heldAsLost = await confirm(admin, heldAgain.report.id, { outcome: 'lost' })

    expect([lostAsMaintenance.status, lostAsMaintenance.body]).toEqual([409, { error: ALREADY_LOST }])
    expect([heldAsMaintenance.status, heldAsMaintenance.body]).toEqual([409, { error: HELD }])
    expect([heldAsLost.status, heldAsLost.body]).toEqual([409, { error: HELD }])
    for (const { report } of [lostCopy, heldForRequest, heldAgain]) expect((await reportRow(report.id)).status).toBe('open')
    expect(await copyStatus(lostCopy.copy.id)).toBe('lost')
    expect(await copyStatus(heldForRequest.copy.id)).toBe('requested')
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })

  it('a copy report with no outcome is 400, and an unknown outcome too, and nothing changes', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    const { copy, report } = await seedCopyReport(student.id)
    recorder = recordEvents()

    // No body at all (Express 5 leaves req.body undefined), an empty one, and one with only a note.
    for (const body of [undefined, {}, { note: 'Please look at it' }]) {
      const res = await confirm(admin, report.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body, JSON.stringify(body)).toEqual({ error: CHOOSE })
    }
    // A word that is neither choice, or not text, never reaches the service.
    for (const outcome of ['repair', '', null, 5]) {
      const res = await confirm(admin, report.id, { outcome })
      expect(res.status, JSON.stringify(outcome)).toBe(400)
    }
    expect((await confirm(admin, report.id, { outcome: 'maintenance', note: 'x'.repeat(301) })).status).toBe(400)

    expect(await copyStatus(copy.id)).toBe('available')
    expect((await reportRow(report.id)).status).toBe('open')
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])
  })
})

describe('POST /admin/reports/:id/confirm: a resource report', () => {
  it('confirming a resource report takes it offline with the note, and an already-offline resource closes it', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { name: 'Asha Rao', email: 'asha@example.org' })
    const { user: ben } = await seedUser()
    const mail = fakeTransport()
    const working = await seedResourceReport(asha.id, { name: 'Desk 12', note: 'The lamp is dead' })
    const alreadyOffline = await seedResourceReport(ben.id, { name: 'Desk 14', status: 'offline', statusNote: 'Floor wet', note: 'The desk wobbles' })
    recorder = recordEvents()

    const taken = await confirm(admin, working.report.id, { note: 'Lamp replaced on Friday' })

    expect(taken.status).toBe(200)
    expect(taken.body).toEqual({ id: working.report.id })
    // The librarian's note is the resource's offline note.
    expect(await resourceRow(working.resource.id)).toMatchObject({ status: 'offline', statusNote: 'Lamp replaced on Friday' })
    expect(await reportRow(working.report.id)).toMatchObject({
      status: 'confirmed',
      resolutionNote: 'Lamp replaced on Friday',
      resolvedById: librarian.id,
      bookCopyId: null,
    })
    const [notice, ...rest] = await allNotices()
    expect(rest).toEqual([])
    expect(notice).toMatchObject({
      userId: asha.id,
      kind: 'report_outcome',
      title: CONFIRMED_TITLE,
      body: withNote(confirmedBody('Desk 12'), 'Lamp replaced on Friday'),
      createdById: librarian.id,
      emailStatus: 'sent',
    })
    expect(mail).toHaveBeenCalledTimes(1)
    expect(recorder.events.map((e) => e.type)).toEqual(['resource.changed', 'attention.changed'])

    // A resource somebody already took offline closes its report without error, and is left as it was.
    recorder.events.length = 0
    // takeOffline starts by reading the resource (findResource); an offline one is never handed to it.
    const resourceRead = vi.spyOn(prisma.resource, 'findUnique')
    const closed = await confirm(admin, alreadyOffline.report.id, { note: 'Thanks for telling us' })

    expect(resourceRead).not.toHaveBeenCalled()
    expect(closed.status).toBe(200)
    expect(await resourceRow(alreadyOffline.resource.id)).toMatchObject({ status: 'offline', statusNote: 'Floor wet' })
    expect(await reportRow(alreadyOffline.report.id)).toMatchObject({ status: 'confirmed', resolutionNote: 'Thanks for telling us' })
    const benNotice = (await allNotices()).find((n) => n.userId === ben.id)!
    expect(benNotice.body).toBe(withNote(confirmedBody('Desk 14'), 'Thanks for telling us'))
    // The offline action was not run again: only the queue changed.
    expect(recorder.events).toEqual([ATTENTION_CHANGED])
  })

  it("a resource confirm with the student's own text unchanged does not echo it in the notice; an edited note does", async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const own = 'The lamp is dead'
    // A seat for each case, all reported by the same student, each with the same words.
    const cases = {
      unchanged: await seedResourceReport(student.id, { name: 'Desk 1', note: own }),
      padded: await seedResourceReport(student.id, { name: 'Desk 2', note: own }),
      edited: await seedResourceReport(student.id, { name: 'Desk 3', note: own }),
      noOwnNote: await seedResourceReport(student.id, { name: 'Desk 4', category: 'dirty', note: null }),
      none: await seedResourceReport(student.id, { name: 'Desk 5', note: own }),
      blank: await seedResourceReport(student.id, { name: 'Desk 6', note: own }),
      // A stored note with stray spaces (written by something other than today's route) is still the student's own.
      paddedStored: await seedResourceReport(student.id, { name: 'Desk 7', note: `  ${own}  ` }),
    }
    const bodyFor = async (name: string) => (await allNotices()).find((n) => n.body.includes(`with ${name}.`))!.body

    // The console prefills the student's words and sends them back untouched.
    expect((await confirm(admin, cases.unchanged.report.id, { note: own })).status).toBe(200)
    expect(await bodyFor('Desk 1')).toBe(confirmedBody('Desk 1'))
    expect((await resourceRow(cases.unchanged.resource.id)).statusNote).toBe(own)

    // The same words with spaces around them are still the student's own.
    expect((await confirm(admin, cases.padded.report.id, { note: `  ${own} \n` })).status).toBe(200)
    expect(await bodyFor('Desk 2')).toBe(confirmedBody('Desk 2'))
    expect((await resourceRow(cases.padded.resource.id)).statusNote).toBe(own)

    expect((await confirm(admin, cases.paddedStored.report.id, { note: own })).status).toBe(200)
    expect(await bodyFor('Desk 7')).toBe(confirmedBody('Desk 7'))

    // An edited note is the librarian's own and goes to the student.
    expect((await confirm(admin, cases.edited.report.id, { note: `${own}. Replacing it.` })).status).toBe(200)
    expect(await bodyFor('Desk 3')).toBe(withNote(confirmedBody('Desk 3'), `${own}. Replacing it.`))
    expect((await resourceRow(cases.edited.resource.id)).statusNote).toBe(`${own}. Replacing it.`)

    // A report with no words of its own: any note is the librarian's.
    expect((await confirm(admin, cases.noOwnNote.report.id, { note: 'Taken off for cleaning' })).status).toBe(200)
    expect(await bodyFor('Desk 4')).toBe(withNote(confirmedBody('Desk 4'), 'Taken off for cleaning'))

    // No note, a bare POST, or a blank note: no offline note and nothing appended.
    expect((await confirm(admin, cases.none.report.id)).status).toBe(200)
    expect((await confirm(admin, cases.blank.report.id, { note: '   ' })).status).toBe(200)
    expect(await bodyFor('Desk 5')).toBe(confirmedBody('Desk 5'))
    expect(await bodyFor('Desk 6')).toBe(confirmedBody('Desk 6'))
    expect((await resourceRow(cases.none.resource.id)).statusNote).toBeNull()
    expect((await resourceRow(cases.blank.resource.id)).statusNote).toBeNull()
    expect((await resourceRow(cases.blank.resource.id)).status).toBe('offline')
  })

  it('an outcome sent for a resource report is ignored: the resource goes offline', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const { resource, report } = await seedResourceReport(student.id)

    const res = await confirm(admin, report.id, { outcome: 'lost' })

    expect(res.status).toBe(200)
    expect((await resourceRow(resource.id)).status).toBe('offline')
    expect((await reportRow(report.id)).status).toBe('confirmed')
  })
})

describe('POST /admin/reports/:id/dismiss', () => {
  it('dismiss closes with the note and the notice says no action was needed', async () => {
    const { token: admin, user: librarian } = await seedUser('admin')
    const { user: asha } = await seedUser('student', { email: 'asha@example.org' })
    const { user: ben } = await seedUser('student', { email: 'ben@example.org' })
    const mail = fakeTransport()
    const copyReport = await seedCopyReport(asha.id, { title: 'Clean Code' })
    const resourceReport = await seedResourceReport(ben.id, { name: 'Desk 12' })
    recorder = recordEvents()
    const before = Date.now()

    const withNoteRes = await dismiss(admin, copyReport.report.id, { note: '  Looks fine to me  ' })
    // A bare POST (no body at all) is a dismissal with no note.
    const bare = await dismiss(admin, resourceReport.report.id)

    expect(withNoteRes.status).toBe(200)
    expect(withNoteRes.body).toEqual({ id: copyReport.report.id })
    expect(bare.status).toBe(200)
    const closed = await reportRow(copyReport.report.id)
    expect(closed).toMatchObject({ status: 'dismissed', resolutionNote: 'Looks fine to me', resolvedById: librarian.id })
    expect(closed.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(await reportRow(resourceReport.report.id)).toMatchObject({ status: 'dismissed', resolutionNote: null, resolvedById: librarian.id })
    // Nothing was done to the copy or the resource.
    expect(await copyStatus(copyReport.copy.id)).toBe('available')
    expect((await resourceRow(resourceReport.resource.id)).status).toBe('available')

    const notices = await allNotices()
    expect(notices).toHaveLength(2)
    expect(notices.find((n) => n.userId === asha.id)).toMatchObject({
      kind: 'report_outcome',
      title: DISMISSED_TITLE,
      body: withNote(dismissedBody('Clean Code'), 'Looks fine to me'),
      loanId: null,
      fineId: null,
      createdById: librarian.id,
      emailStatus: 'sent',
    })
    expect(notices.find((n) => n.userId === ben.id)).toMatchObject({ title: DISMISSED_TITLE, body: dismissedBody('Desk 12') })
    expect(mail).toHaveBeenCalledTimes(2)
    expect(mail.mock.calls.map(([m]) => m.subject)).toEqual([`SmartLib: ${DISMISSED_TITLE}`, `SmartLib: ${DISMISSED_TITLE}`])
    // Only the queue changed: no catalogue or resource event, since nothing was acted on.
    expect(recorder.events).toEqual([ATTENTION_CHANGED, ATTENTION_CHANGED])
  })

  it('takes the note trimmed, at most 300 characters, and a blank note means none', async () => {
    const { token: admin } = await seedUser('admin')
    fakeTransport()
    // A student for each case, so each notice is found by who it went to.
    const students = { spaced: await seedUser(), blank: await seedUser(), longest: await seedUser(), tooLong: await seedUser() }
    const reports = {
      spaced: await seedCopyReport(students.spaced.user.id, { title: 'Dune' }),
      blank: await seedCopyReport(students.blank.user.id, { title: 'Dune' }),
      longest: await seedCopyReport(students.longest.user.id, { title: 'Dune' }),
      tooLong: await seedCopyReport(students.tooLong.user.id, { title: 'Dune' }),
    }
    const base = dismissedBody('Dune')
    const bodyFor = async (userId: string) => (await prisma.notice.findFirstOrThrow({ where: { userId } })).body

    expect((await dismiss(admin, reports.spaced.report.id, { note: '  See the desk  ' })).status).toBe(200)
    expect(await bodyFor(students.spaced.user.id)).toBe(withNote(base, 'See the desk'))

    expect((await dismiss(admin, reports.blank.report.id, { note: '   ' })).status).toBe(200)
    expect(await bodyFor(students.blank.user.id)).toBe(base)
    expect((await reportRow(reports.blank.report.id)).resolutionNote).toBeNull()

    // 300 characters is the most; the limit counts the trimmed text.
    const max = 'x'.repeat(300)
    expect((await dismiss(admin, reports.longest.report.id, { note: ` ${max} ` })).status).toBe(200)
    expect(await bodyFor(students.longest.user.id)).toBe(withNote(base, max))
    expect((await reportRow(reports.longest.report.id)).resolutionNote).toBe(max)

    // Longer than that, or not text, is refused and leaves the report open and unannounced.
    expect((await dismiss(admin, reports.tooLong.report.id, { note: 'x'.repeat(301) })).status).toBe(400)
    expect((await dismiss(admin, reports.tooLong.report.id, { note: 5 })).status).toBe(400)
    expect(await prisma.notice.count({ where: { userId: students.tooLong.user.id } })).toBe(0)
    expect((await reportRow(reports.tooLong.report.id)).status).toBe('open')
  })
})

describe('closing a report that is closed, or not there', () => {
  it('closing twice is 409; unknown id is 404', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    const confirmed = await seedCopyReport(student.id, { title: 'Dune' })
    const dismissed = await seedCopyReport(student.id, { title: 'Emma' })
    expect((await confirm(admin, confirmed.report.id, { outcome: 'maintenance', note: 'First' })).status).toBe(200)
    expect((await dismiss(admin, dismissed.report.id, { note: 'First' })).status).toBe(200)
    recorder = recordEvents()

    // Every second attempt, in either direction, is the same 409.
    const attempts = {
      'confirm a confirmed report': () => confirm(admin, confirmed.report.id, { outcome: 'maintenance', note: 'Second' }),
      'dismiss a confirmed report': () => dismiss(admin, confirmed.report.id, { note: 'Second' }),
      'dismiss a dismissed report': () => dismiss(admin, dismissed.report.id, { note: 'Second' }),
      'confirm a dismissed report': () => confirm(admin, dismissed.report.id, { outcome: 'lost', note: 'Second' }),
    }
    for (const [name, attempt] of Object.entries(attempts)) {
      const res = await attempt()
      expect(res.status, name).toBe(409)
      expect(res.body, name).toEqual({ error: RESOLVED })
    }

    // A dismissed report never triggers an action: its copy was not marked lost.
    expect(await copyStatus(dismissed.copy.id)).toBe('available')
    // The first answer is kept: nothing was overwritten, sent or published.
    expect(await reportRow(confirmed.report.id)).toMatchObject({ status: 'confirmed', resolutionNote: 'First' })
    expect(await reportRow(dismissed.report.id)).toMatchObject({ status: 'dismissed', resolutionNote: 'First' })
    expect(await prisma.notice.count()).toBe(2)
    expect(mail).toHaveBeenCalledTimes(2)
    expect(recorder.events).toEqual([])

    for (const [name, res] of [
      ['confirm', await confirm(admin, 'no-such-report', { outcome: 'maintenance' })],
      ['dismiss', await dismiss(admin, 'no-such-report')],
    ] as const) {
      expect(res.status, name).toBe(404)
      expect(res.body, name).toEqual({ error: 'Report not found' })
    }
    expect(recorder.events).toEqual([])
  })

  it('a closed report never runs the copy action again: a copy brought back after the first confirm stays on the shelf', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const { copy, report } = await seedCopyReport(student.id)
    expect((await confirm(admin, report.id, { outcome: 'maintenance' })).status).toBe(200)
    await prisma.bookCopy.update({ where: { id: copy.id }, data: { status: 'available' } })

    const again = await confirm(admin, report.id, { outcome: 'maintenance' })

    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: RESOLVED })
    expect(await copyStatus(copy.id)).toBe('available')
  })
})

describe('the closing transaction', () => {
  it('the report update and the notice commit or roll back together: a notice that cannot be written leaves the report open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    const { report } = await seedCopyReport(student.id)
    recorder = recordEvents()

    // The notice insert fails for real, inside the closing transaction, after the report row was updated;
    // what the transaction held at that moment is read from inside it, so the test cannot pass merely
    // because the update never ran.
    let closedInside: string | undefined
    const real = prisma.$transaction.bind(prisma) as unknown as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
      real(
        (tx) =>
          fn(
            new Proxy(tx, {
              get: (target, key) =>
                key === 'notice'
                  ? {
                      create: async () => {
                        closedInside = (await tx.issueReport.findUniqueOrThrow({ where: { id: report.id } })).status
                        throw new Error('The notice could not be written')
                      },
                    }
                  : Reflect.get(target, key),
            }),
          ),
        options,
      )) as never)

    const failed = await dismiss(admin, report.id, { note: 'Looks fine' })
    spy.mockRestore()

    expect(closedInside).toBe('dismissed')
    expect(failed.status).toBe(500)
    expect(await reportRow(report.id)).toMatchObject({ status: 'open', resolutionNote: null, resolvedById: null, resolvedAt: null })
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
    expect(recorder.events).toEqual([])

    // The same dismissal goes through once the notice can be written.
    const again = await dismiss(admin, report.id, { note: 'Looks fine' })
    expect(again.status).toBe(200)
    expect(await prisma.notice.count()).toBe(1)
    expect(attentionEvents(recorder.events)).toHaveLength(1)
  })
})

describe('the email', () => {
  it('a failing email records failed and the action stands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const copyReport = await seedCopyReport(student.id, { title: 'Dune' })
    const resourceReport = await seedResourceReport(student.id)
    const dismissedReport = await seedCopyReport(student.id, { title: 'Emma' })
    recorder = recordEvents()

    // The provider answers not ok.
    const notOk = fakeTransport(false)
    const confirmed = await confirm(admin, copyReport.report.id, { outcome: 'maintenance' })
    expect(confirmed.status).toBe(200)
    expect(notOk).toHaveBeenCalledTimes(1)
    expect(await copyStatus(copyReport.copy.id)).toBe('maintenance')
    expect((await reportRow(copyReport.report.id)).status).toBe('confirmed')

    // The transport itself throws.
    setMailTransport({
      send: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const offline = await confirm(admin, resourceReport.report.id, { note: 'Fixing it' })
    expect(offline.status).toBe(200)
    expect((await resourceRow(resourceReport.resource.id)).status).toBe('offline')
    const dismissed = await dismiss(admin, dismissedReport.report.id)
    expect(dismissed.status).toBe(200)
    expect((await reportRow(dismissedReport.report.id)).status).toBe('dismissed')

    const notices = await allNotices()
    expect(notices.map((n) => n.emailStatus)).toEqual(['failed', 'failed', 'failed'])
    for (const notice of notices) expect(notice.emailedAt).not.toBeNull()
    // Each action still announced itself once.
    expect(attentionEvents(recorder.events)).toHaveLength(3)
  })

  it('with email not set up the notice is still written and records skipped', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { report } = await seedCopyReport(student.id)

    const res = await confirm(admin, report.id, { outcome: 'maintenance' })

    expect(res.status).toBe(200)
    expect(await allNotices()).toMatchObject([{ kind: 'report_outcome', emailStatus: 'skipped', emailedAt: null }])
  })
})

describe('the live event', () => {
  it('events once, after the email outcome, none on a refusal', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: reporter } = await seedUser()
    const { user: borrower } = await seedUser()
    fakeTransport()
    const copyReport = await seedCopyReport(reporter.id, { title: 'Dune' })
    const resourceReport = await seedResourceReport(reporter.id)
    const toDismiss = await seedCopyReport(reporter.id, { title: 'Emma' })
    const lentAgain = await seedCopyReport(reporter.id, { title: 'Ulysses', copyStatus: 'borrowed' })
    await prisma.loan.create({
      data: { userId: borrower.id, bookCopyId: lentAgain.copy.id, borrowedAt: new Date(), dueAt: new Date(Date.now() + 14 * DAY_MS) },
    })
    const open = await seedCopyReport(reporter.id, { title: 'Hamlet' })
    recorder = recordEvents()
    // What the notices look like in the database at the moment each attention event is published.
    const atPublish: Array<Promise<EmailStatus[]>> = []
    const stop = subscribe((event) => {
      if (event.type === 'attention.changed') {
        atPublish.push(prisma.notice.findMany({ orderBy: { createdAt: 'asc' } }).then((rows) => rows.map((n) => n.emailStatus)))
      }
    })

    try {
      expect((await confirm(admin, copyReport.report.id, { outcome: 'maintenance' })).status).toBe(200)
      expect(attentionEvents(recorder.events)).toHaveLength(1)
      expect((await confirm(admin, resourceReport.report.id)).status).toBe(200)
      expect(attentionEvents(recorder.events)).toHaveLength(2)
      expect((await dismiss(admin, toDismiss.report.id)).status).toBe(200)
      expect(attentionEvents(recorder.events)).toHaveLength(3)
      // Published after deliverNotice stored the outcome: every row read at publish time already says sent.
      expect(await Promise.all(atPublish)).toEqual([['sent'], ['sent', 'sent'], ['sent', 'sent', 'sent']])

      // Refusals publish nothing at all, not even the copy or resource event of an action.
      const seen = recorder.events.length
      expect((await confirm(admin, 'no-such-report', { outcome: 'lost' })).status).toBe(404)
      expect((await dismiss(admin, 'no-such-report')).status).toBe(404)
      expect((await confirm(admin, copyReport.report.id, { outcome: 'maintenance' })).status).toBe(409)
      expect((await dismiss(admin, toDismiss.report.id)).status).toBe(409)
      expect((await confirm(admin, open.report.id)).status).toBe(400)
      expect((await confirm(admin, lentAgain.report.id, { outcome: 'lost' })).status).toBe(409)
      expect((await confirm(admin, lentAgain.report.id, { outcome: 'maintenance' })).status).toBe(409)
      expect(recorder.events).toHaveLength(seen)
    } finally {
      stop()
    }
  })
})

describe('races', () => {
  it('two simultaneous confirms of one copy report: one 200, one 409, one notice, one email, one attention.changed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    await warmPool()
    recorder = recordEvents()

    for (let round = 0; round < ROUNDS; round++) {
      const { copy, report } = await seedCopyReport(student.id, { title: `Dune ${round}` })

      const results = await together(
        round,
        () => confirm(admin, report.id, { outcome: 'maintenance' }),
        () => confirm(admin, report.id, { outcome: 'maintenance' }),
      )

      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409])
      expect(results.find((r) => r.status === 409)!.body, `round ${round}`).toEqual({ error: RESOLVED })
      expect(await copyStatus(copy.id), `round ${round}`).toBe('maintenance')
      expect((await reportRow(report.id)).status, `round ${round}`).toBe('confirmed')
      expect(await prisma.notice.count(), `round ${round}`).toBe(round + 1)
      expect(mail, `round ${round}`).toHaveBeenCalledTimes(round + 1)
      expect(attentionEvents(recorder.events), `round ${round}`).toHaveLength(round + 1)
    }
  }, 180_000)

  it('two simultaneous confirms of one resource report: one 200, one 409, one notice, one email, one attention.changed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    await warmPool()
    recorder = recordEvents()

    for (let round = 0; round < ROUNDS; round++) {
      const { resource, report } = await seedResourceReport(student.id, { name: `Desk ${round}` })

      const results = await together(
        round,
        () => confirm(admin, report.id, { note: 'Fixing it' }),
        () => confirm(admin, report.id, { note: 'Fixing it' }),
      )

      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409])
      expect(results.find((r) => r.status === 409)!.body, `round ${round}`).toEqual({ error: RESOLVED })
      expect((await resourceRow(resource.id)).status, `round ${round}`).toBe('offline')
      expect(await prisma.notice.count(), `round ${round}`).toBe(round + 1)
      expect(mail, `round ${round}`).toHaveBeenCalledTimes(round + 1)
      expect(attentionEvents(recorder.events), `round ${round}`).toHaveLength(round + 1)
    }
  }, 180_000)

  it('a confirm racing a dismiss: one 200, one 409, one notice (the winner\'s), one email, one attention.changed', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const mail = fakeTransport()
    await warmPool()
    recorder = recordEvents()

    for (let round = 0; round < ROUNDS; round++) {
      const { report } = await seedCopyReport(student.id, { title: `Dune ${round}` })

      const [confirmRes, dismissRes] = await together(
        round,
        () => confirm(admin, report.id, { outcome: 'maintenance' }),
        () => dismiss(admin, report.id),
      )

      expect([confirmRes.status, dismissRes.status].sort(), `round ${round}`).toEqual([200, 409])
      const loser = confirmRes.status === 409 ? confirmRes : dismissRes
      expect(loser.body, `round ${round}`).toEqual({ error: RESOLVED })
      const confirmedWon = confirmRes.status === 200
      expect((await reportRow(report.id)).status, `round ${round}`).toBe(confirmedWon ? 'confirmed' : 'dismissed')
      const notices = await allNotices()
      expect(notices, `round ${round}`).toHaveLength(round + 1)
      expect(notices[round].title, `round ${round}`).toBe(confirmedWon ? CONFIRMED_TITLE : DISMISSED_TITLE)
      expect(mail, `round ${round}`).toHaveBeenCalledTimes(round + 1)
      expect(attentionEvents(recorder.events), `round ${round}`).toHaveLength(round + 1)
    }
  }, 180_000)

  it('a copy that reached the requested state while the action waited closes the report: the refusal is re-read, not matched by its text', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()

    for (const outcome of ['maintenance', 'lost'] as const) {
      const { book, copy, report } = await seedCopyReport(student.id, { title: `Dune ${outcome}` })

      // Another librarian puts the copy in the same state first: the request read it as available, the
      // copy action then finds it already there and refuses, and the report is closed all the same.
      const res = await blockedThenCompete(
        (tx) => tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${book.id} FOR UPDATE`,
        () => confirm(admin, report.id, { outcome }),
        (tx) => tx.bookCopy.update({ where: { id: copy.id }, data: { status: outcome } }),
      )

      expect(res.status, outcome).toBe(200)
      expect(await copyStatus(copy.id), outcome).toBe(outcome)
      expect((await reportRow(report.id)).status, outcome).toBe('confirmed')
    }
    expect(await prisma.notice.count()).toBe(2)
  }, 60_000)

  it('a copy that was lent out while the action waited is refused as on loan, and the report stays open', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    const { user: borrower } = await seedUser()
    const mail = fakeTransport()

    for (const outcome of ['maintenance', 'lost'] as const) {
      const { book, copy, report } = await seedCopyReport(student.id, { title: `Dune ${outcome}` })
      const dueAt = new Date(Date.now() - (3 * DAY_MS + HOUR_MS))
      recorder = recordEvents()

      const res = await blockedThenCompete(
        (tx) => tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${book.id} FOR UPDATE`,
        () => confirm(admin, report.id, { outcome }),
        async (tx) => {
          await tx.bookCopy.update({ where: { id: copy.id }, data: { status: 'borrowed' } })
          await tx.loan.create({ data: { userId: borrower.id, bookCopyId: copy.id, borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS), dueAt } })
        },
      )
      recorder.stop()

      expect(res.status, outcome).toBe(409)
      expect(res.body, outcome).toEqual({ error: NOW_ON_LOAN })
      expect(await copyStatus(copy.id), outcome).toBe('borrowed')
      expect((await prisma.loan.findMany({ where: { bookCopyId: copy.id } })).map((l) => l.status), outcome).toEqual(['active'])
      expect((await reportRow(report.id)).status, outcome).toBe('open')
      expect(recorder.events, outcome).toEqual([])
    }
    expect(await prisma.fine.count()).toBe(0)
    expect(await prisma.notice.count()).toBe(0)
    expect(mail).not.toHaveBeenCalled()
  }, 60_000)

  it('a resource taken offline while the action waited closes the report', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    const { resource, report } = await seedResourceReport(student.id, { name: 'Desk 12' })

    const res = await blockedThenCompete(
      (tx) => tx.$queryRaw`SELECT id FROM "Resource" WHERE id = ${resource.id} FOR UPDATE`,
      () => confirm(admin, report.id, { note: 'Fixing it' }),
      (tx) => tx.resource.update({ where: { id: resource.id }, data: { status: 'offline', statusNote: 'Taken offline by another librarian' } }),
    )

    expect(res.status).toBe(200)
    // The other librarian's note stands: this action changed nothing.
    expect(await resourceRow(resource.id)).toMatchObject({ status: 'offline', statusNote: 'Taken offline by another librarian' })
    expect((await reportRow(report.id)).status).toBe('confirmed')
    expect(await prisma.notice.count()).toBe(1)
  }, 60_000)

  it('the closing write takes no loan, copy or book lock (a return holds the loan lock and then writes a report)', async () => {
    const { token: admin } = await seedUser('admin')
    const { user: student } = await seedUser()
    fakeTransport()
    // The copy is already in the requested state, so the confirm closes the report without any copy action.
    const { book, copy, report } = await seedCopyReport(student.id, { copyStatus: 'maintenance' })
    const loan = await prisma.loan.create({
      data: {
        userId: student.id,
        bookCopyId: copy.id,
        borrowedAt: new Date(Date.now() - 20 * DAY_MS),
        dueAt: new Date(Date.now() - 6 * DAY_MS),
        status: 'returned',
        returnedAt: new Date(Date.now() - HOUR_MS),
      },
    })

    let res: request.Response | undefined
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loan.id} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "BookCopy" WHERE id = ${copy.id} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${book.id} FOR UPDATE`
        // Settled while all three rows are locked: a lock taken on any of them would wait for this transaction.
        res = await Promise.race([
          confirm(admin, report.id, { outcome: 'maintenance' }).then((r) => r),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The confirm waited for a loan, copy or book lock')), 8000)),
        ])
      },
      { timeout: 30_000, maxWait: 30_000 },
    )

    expect(res!.status).toBe(200)
    expect((await reportRow(report.id)).status).toBe('confirmed')
  }, 60_000)
})
