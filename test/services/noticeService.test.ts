import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_TIMEOUT_MS, REQUEST_OUTCOME_VISIBLE_DAYS } from '../../src/config/constants'
import type { Notice } from '../../src/generated/prisma/client'
import { setMailTransport, type MailTransport } from '../../src/lib/mailer'
import { prisma } from '../../src/lib/prisma'
import { NOTICE_EMAIL_FOOTER, createNotice, deliverNotice, listMyNotices } from '../../src/services/noticeService'
import { resetDb } from '../helpers/db'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

async function seedUser(email = `student${Math.random()}@example.org`, role: 'student' | 'admin' = 'student') {
  return prisma.user.create({ data: { name: `User ${Math.random()}`, email, passwordHash: 'x', role } })
}

function fakeTransport(ok = true) {
  const send = vi.fn<MailTransport['send']>(async () => ({ ok }))
  const transport: MailTransport = { send }
  return { transport, send }
}

/** A notice committed the way an action commits one: inside a transaction. */
function seedNotice(userId: string, overrides: Partial<Parameters<typeof createNotice>[1]> = {}) {
  return prisma.$transaction((tx) =>
    createNotice(tx, {
      userId,
      kind: 'overdue_reminder',
      title: 'Overdue book reminder',
      body: 'Your copy of Clean Code is 3 days overdue.',
      ...overrides,
    }),
  )
}

const stored = (id: string) => prisma.notice.findUniqueOrThrow({ where: { id } })

beforeEach(async () => {
  await resetDb()
  setMailTransport(null)
})

afterEach(() => {
  setMailTransport(null)
  vi.restoreAllMocks()
})

describe('createNotice', () => {
  it('writes the notice inside the caller\'s transaction: committed with it, gone with a rollback', async () => {
    const student = await seedUser()
    const librarian = await seedUser(undefined, 'admin')

    const kept = await seedNotice(student.id, { createdById: librarian.id })
    expect(await stored(kept.id)).toMatchObject({
      userId: student.id,
      kind: 'overdue_reminder',
      title: 'Overdue book reminder',
      body: 'Your copy of Clean Code is 3 days overdue.',
      loanId: null,
      fineId: null,
      createdById: librarian.id,
      emailStatus: 'skipped',
      emailedAt: null,
    })

    await expect(
      prisma.$transaction(async (tx) => {
        await createNotice(tx, { userId: student.id, kind: 'dispute_outcome', title: 'Your fine stands', body: 'The library kept your fine.' })
        throw new Error('the action was refused')
      }),
    ).rejects.toThrow('the action was refused')
    expect(await prisma.notice.count()).toBe(1)
  })

  it('clears the loan, fine and librarian links, not the notice, when those rows are deleted', async () => {
    const student = await seedUser()
    const librarian = await seedUser(undefined, 'admin')
    const book = await prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title: 'Clean Code', author: 'Someone' } })
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id } })
    const loan = await prisma.loan.create({ data: { userId: student.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 2 * DAY_MS) } })
    const fine = await prisma.fine.create({ data: { userId: student.id, amount: 20, reason: 'overdue', relatedLoanId: loan.id } })
    const notice = await seedNotice(student.id, { loanId: loan.id, fineId: fine.id, createdById: librarian.id })
    expect(await stored(notice.id)).toMatchObject({ loanId: loan.id, fineId: fine.id, createdById: librarian.id })

    await prisma.fine.delete({ where: { id: fine.id } })
    await prisma.loan.delete({ where: { id: loan.id } })
    await prisma.user.delete({ where: { id: librarian.id } })

    expect(await stored(notice.id)).toMatchObject({
      loanId: null,
      fineId: null,
      createdById: null,
      body: 'Your copy of Clean Code is 3 days overdue.',
    })
  })
})

describe('deliverNotice', () => {
  it('emails the student with the title as subject and records sent', async () => {
    const student = await seedUser('asha@example.org')
    const { transport, send } = fakeTransport()
    setMailTransport(transport)
    const notice = await seedNotice(student.id)
    expect(notice.emailStatus).toBe('skipped')

    const before = Date.now()
    const outcome = await deliverNotice(notice)

    expect(outcome).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    const [message, signal] = send.mock.calls[0]
    expect(message.to).toBe('asha@example.org')
    expect(message.subject).toBe('SmartLib: Overdue book reminder')
    expect(message.text).toBe(`${notice.body}\n\n--\n${NOTICE_EMAIL_FOOTER}`)
    expect(signal).toBeInstanceOf(AbortSignal)
    const row = await stored(notice.id)
    expect(row.emailStatus).toBe('sent')
    expect(row.emailedAt).not.toBeNull()
    expect(row.emailedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row.emailedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('records failed when the transport fails or times out, skipped when email is unconfigured or the address is a placeholder', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const student = await seedUser('asha@example.org')

    // The provider answers not ok.
    setMailTransport(fakeTransport(false).transport)
    const refused = await seedNotice(student.id)
    expect(await deliverNotice(refused)).toBe('failed')
    const refusedRow = await stored(refused.id)
    expect(refusedRow.emailStatus).toBe('failed')
    expect(refusedRow.emailedAt).not.toBeNull()

    // The transport throws.
    setMailTransport({
      send: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const thrown = await seedNotice(student.id)
    expect(await deliverNotice(thrown)).toBe('failed')
    expect((await stored(thrown.id)).emailStatus).toBe('failed')

    // The transport never answers: the mailer's 5-second signal fires (a short stand-in keeps the test fast).
    expect(MAIL_TIMEOUT_MS).toBe(5000)
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20))
    setMailTransport({
      send: (_message, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    const slow = await seedNotice(student.id)
    expect(await deliverNotice(slow)).toBe('failed')
    expect(timeoutSpy).toHaveBeenCalledWith(MAIL_TIMEOUT_MS)
    const slowRow = await stored(slow.id)
    expect(slowRow.emailStatus).toBe('failed')
    expect(slowRow.emailedAt).not.toBeNull()
    timeoutSpy.mockRestore()

    // Email is not configured (no transport, and tests never read a real key): nothing is attempted.
    setMailTransport(null)
    const unconfigured = await seedNotice(student.id)
    expect(await deliverNotice(unconfigured)).toBe('skipped')
    const unconfiguredRow = await stored(unconfigured.id)
    expect(unconfiguredRow.emailStatus).toBe('skipped')
    expect(unconfiguredRow.emailedAt).toBeNull()

    // A placeholder demo address never receives mail, whatever the transport.
    const placeholder = await seedUser('aditi.sharma@thapar.edu')
    const { transport, send } = fakeTransport()
    setMailTransport(transport)
    const demo = await seedNotice(placeholder.id)
    expect(await deliverNotice(demo)).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
    const demoRow = await stored(demo.id)
    expect(demoRow.emailStatus).toBe('skipped')
    expect(demoRow.emailedAt).toBeNull()
  })

  it('never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const student = await seedUser('asha@example.org')
    const { transport, send } = fakeTransport()
    setMailTransport(transport)

    // A notice whose student cannot be found: nothing is sent, nothing is thrown.
    const orphan: Notice = { ...(await seedNotice(student.id)), id: 'no-such-notice', userId: 'no-such-user' }
    await expect(deliverNotice(orphan)).resolves.toBe('skipped')
    expect(send).not.toHaveBeenCalled()

    // The database fails while the outcome is written: the email did go, and the answer says so.
    const notice = await seedNotice(student.id)
    vi.spyOn(prisma.notice, 'update').mockRejectedValueOnce(new Error('connection lost'))
    await expect(deliverNotice(notice)).resolves.toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)

    // The database fails while the address is read: no email, no throw.
    const another = await seedNotice(student.id)
    vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('connection lost'))
    await expect(deliverNotice(another)).resolves.toBe('failed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('logs neither the notice text nor the address', async () => {
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    )
    const student = await seedUser('private.person@example.org')
    setMailTransport({
      send: async () => {
        throw new Error('private.person@example.org rejected: Your copy of Clean Code is 3 days overdue.')
      },
    })
    const notice = await seedNotice(student.id, { body: 'A private message about Clean Code.' })

    expect(await deliverNotice(notice)).toBe('failed')

    const logged = consoles.flatMap((spy) => spy.mock.calls.flat()).join(' ')
    expect(logged).not.toContain('private.person@example.org')
    expect(logged).not.toContain('private message')
    expect(logged).not.toContain('Clean Code')
  })
})

describe('listMyNotices', () => {
  it('returns only that student\'s notices from the last 7 days, newest first, at most 20', async () => {
    const now = new Date()
    const student = await seedUser()
    const other = await seedUser()
    const at = (ageMs: number) => new Date(now.getTime() - ageMs)

    // 22 recent notices a minute apart, so 2 of them fall off the 20-notice cap.
    const recent = []
    for (let i = 0; i < 22; i += 1) {
      recent.push(await seedNotice(student.id, { title: `Notice ${i}` }))
      await prisma.notice.update({ where: { id: recent[i].id }, data: { createdAt: at(i * 60 * 1000 + HOUR_MS) } })
    }
    // Just inside the window, just outside it, and another student's.
    const inside = await seedNotice(student.id, { title: 'Inside the window' })
    await prisma.notice.update({ where: { id: inside.id }, data: { createdAt: at(REQUEST_OUTCOME_VISIBLE_DAYS * DAY_MS - HOUR_MS) } })
    const outside = await seedNotice(student.id, { title: 'Outside the window' })
    await prisma.notice.update({ where: { id: outside.id }, data: { createdAt: at(REQUEST_OUTCOME_VISIBLE_DAYS * DAY_MS + HOUR_MS) } })
    const foreign = await seedNotice(other.id, { title: 'Someone else' })
    await prisma.notice.update({ where: { id: foreign.id }, data: { createdAt: at(5 * 60 * 1000) } })

    const listed = await listMyNotices(student.id, now)

    expect(listed).toHaveLength(20)
    expect(listed.map((n) => n.title)).toEqual(Array.from({ length: 20 }, (_, i) => `Notice ${i}`))
    expect(listed.map((n) => n.title)).not.toContain('Someone else')
    expect(listed.map((n) => n.title)).not.toContain('Outside the window')

    // With the recent ones gone the window itself shows: the one 7 days less an hour old is in, the older one out.
    await prisma.notice.deleteMany({ where: { id: { in: recent.map((n) => n.id) } } })
    const quiet = await listMyNotices(student.id, now)
    expect(quiet.map((n) => n.title)).toEqual(['Inside the window'])

    // Another student sees only theirs.
    expect((await listMyNotices(other.id, now)).map((n) => n.title)).toEqual(['Someone else'])
  })

  it('shows each notice as id, kind, title, body and date, and nothing else', async () => {
    const student = await seedUser()
    const notice = await seedNotice(student.id, { kind: 'overdue_escalation', title: 'Formal overdue notice', body: 'Return it now.' })

    const [listed] = await listMyNotices(student.id)

    expect(listed).toEqual({
      id: notice.id,
      kind: 'overdue_escalation',
      title: 'Formal overdue notice',
      body: 'Return it now.',
      createdAt: notice.createdAt,
    })
  })

  it('breaks a tie on equal dates by id, so a refetch never reorders', async () => {
    const student = await seedUser()
    const sameInstant = new Date(Date.now() - HOUR_MS)
    const a = await seedNotice(student.id, { title: 'A' })
    const b = await seedNotice(student.id, { title: 'B' })
    await prisma.notice.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { createdAt: sameInstant } })

    const first = await listMyNotices(student.id)
    const second = await listMyNotices(student.id)

    expect(first.map((n) => n.id)).toEqual(second.map((n) => n.id))
    expect(first.map((n) => n.id)).toEqual([a.id, b.id].sort())
  })
})
