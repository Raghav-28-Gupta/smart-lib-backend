import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import {
  JWT_SECRET,
  RECOMMEND_LIMIT,
  RECOMMEND_LOAN_WEIGHT,
  RECOMMEND_MAX_AGE_MS,
  RECOMMEND_MAX_BOOKS,
  RECOMMEND_MAX_INTERACTIONS,
  RECOMMEND_MAX_PAIR_WEIGHT,
  RECOMMEND_REFRESH_MS,
  RECOMMEND_RENEWAL_BONUS,
  RECOMMEND_RESERVATION_WEIGHT,
  RECOMMEND_RETRY_MS,
  RECOMMEND_TIMEOUT_MS,
} from '../../src/config/constants'
import type { BorrowRequestStatus, LoanStatus, RecommendationMethod, ReservationStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import * as bookServiceModule from '../../src/services/bookService'
import { getRecommendations } from '../../src/services/recommendationService'
import { resetDb } from '../helpers/db'

const DAY_MS = 24 * 60 * 60 * 1000

const PERSONAL_NOTE = 'Based on your recent activity.'
const PERSONAL_TITLE = 'Recommended for you'
const CONTENT_CAPTION = "Similar to books you've borrowed"
const COLLABORATIVE_CAPTION = "Similar to books you've borrowed, and what similar students borrow"

async function seedUser() {
  const user = await prisma.user.create({
    data: { name: `User ${Math.random()}`, email: `user${Math.random()}@test.com`, passwordHash: 'x' },
  })
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
  return { user, token }
}

async function seedBook(title: string) {
  return prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Author', totalCopies: 1 } })
}

async function seedLoan(userId: string, bookId: string, borrowedAt: Date, status: LoanStatus = 'active') {
  const copyStatus = status === 'lost' ? 'lost' : status === 'returned' ? 'available' : 'borrowed'
  const copy = await prisma.bookCopy.create({ data: { bookId, status: copyStatus } })
  await prisma.loan.create({
    data: {
      userId,
      bookCopyId: copy.id,
      borrowedAt,
      dueAt: new Date(borrowedAt.getTime() + 14 * DAY_MS),
      status,
      ...(status === 'returned' ? { returnedAt: new Date(borrowedAt.getTime() + DAY_MS) } : {}),
      ...(status === 'lost' ? { lostAt: new Date(borrowedAt.getTime() + DAY_MS) } : {}),
    },
  })
}

async function seedReservation(userId: string, bookId: string, status: ReservationStatus) {
  await prisma.reservation.create({ data: { userId, bookId, status } })
}

// A borrow request holds one copy of the book (set aside as `requested` while it is pending), so each request gets its own copy.
async function seedBorrowRequest(userId: string, bookId: string, status: BorrowRequestStatus) {
  const copy = await prisma.bookCopy.create({ data: { bookId, status: status === 'pending' ? 'requested' : 'available' } })
  await prisma.borrowRequest.create({ data: { userId, bookId, bookCopyId: copy.id, status, expiresAt: new Date(Date.now() + DAY_MS) } })
}

// The cache is written by the background refresh (not built yet in this task), so the tests seed its rows directly.
async function seedCache(userId: string, bookId: string, score: number, method: RecommendationMethod = 'content', generatedAt = new Date()) {
  await prisma.recommendationCache.create({ data: { userId, bookId, score, method, generatedAt } })
}

// A cache row cannot outlive its book in the database: the foreign key refuses the delete (the app never deletes a book,
// and the seed's reset deletes the cache rows first), and the test database's role may not switch the foreign-key
// triggers off (`session_replication_role` is refused, 42501). So "deleted since the refresh" is simulated one layer up:
// `getBooksByIds`, which the service loads the picks with, stops resolving that book, as it does for an id it cannot find
// (on the popular-list path too, as a real deletion would).
function pretendBookWasDeleted(bookId: string) {
  const real = bookServiceModule.getBooksByIds
  vi.spyOn(bookServiceModule, 'getBooksByIds').mockImplementation((ids) => real(ids.filter((id) => id !== bookId)))
}

const getAs = (token: string) => request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
const titlesOf = (res: { body: { sections: Array<{ books: Array<{ title: string }> }> } }) => res.body.sections[0].books.map((b) => b.title)

describe('GET /recommendations/me', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    return resetDb()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/recommendations/me')
    expect(res.status).toBe(401)
  })

  it('returns an empty-but-valid shape when the library has no books', async () => {
    const { token } = await seedUser()
    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.sections).toEqual([])
    expect(typeof res.body.note).toBe('string')
  })

  it('falls back to an alphabetical list when no books have been borrowed recently', async () => {
    const { token } = await seedUser()
    await seedBook('Zebra Book')
    await seedBook('Aardvark Book')

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    expect(res.body.sections).toHaveLength(1)
    expect(res.body.sections[0].title).toBe('Trending in the library')
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles).toEqual(['Aardvark Book', 'Zebra Book'])
  })

  it('ranks the most-borrowed-in-the-last-30-days book first', async () => {
    const { user, token } = await seedUser()
    const popular = await seedBook('Popular Book')
    const quiet = await seedBook('Quiet Book')
    const now = new Date()

    const { user: user2 } = await seedUser()
    await seedLoan(user.id, popular.id, now)
    await seedLoan(user2.id, popular.id, now)
    await seedLoan(user.id, quiet.id, now)

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles[0]).toBe('Popular Book')
  })

  it('ignores loans older than 30 days when ranking popularity', async () => {
    const { user, token } = await seedUser()
    const oldPopular = await seedBook('Old Popular Book')
    const recent = await seedBook('Recently Borrowed Book')

    await seedLoan(user.id, oldPopular.id, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000))
    await seedLoan(user.id, recent.id, new Date())

    const res = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${token}`)
    const titles = res.body.sections[0].books.map((b: { title: string }) => b.title)
    expect(titles).toContain('Recently Borrowed Book')
    expect(titles).not.toContain('Old Popular Book')
  })

  it('a loan closed because its copy was marked lost is not one the student still has out', async () => {
    const { user: holder, token: holderToken } = await seedUser()
    const { user: loser, token: loserToken } = await seedUser()
    const book = await seedBook('Popular Book')
    await seedLoan(holder.id, book.id, new Date())
    const copy = await prisma.bookCopy.create({ data: { bookId: book.id, status: 'lost' } })
    await prisma.loan.create({
      data: { userId: loser.id, bookCopyId: copy.id, dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000), status: 'lost', lostAt: new Date() },
    })

    const holding = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${holderToken}`)
    expect(holding.body.note).toBe("Personalized picks are on the way — for now, here's what's popular in the library.")

    const lost = await request(app).get('/recommendations/me').set('Authorization', `Bearer ${loserToken}`)
    expect(lost.body.note).toBe("You haven't borrowed anything yet — here's what's popular right now.")
  })

  describe('from the recommendation cache', () => {
    it("serves a student's cached picks best score first with the content caption", async () => {
      const { user, token } = await seedUser()
      const low = await seedBook('Low Pick')
      const top = await seedBook('Top Pick')
      const mid = await seedBook('Mid Pick')
      await seedBook('Not Cached')
      await seedCache(user.id, low.id, 0.4)
      await seedCache(user.id, top.id, 0.9)
      await seedCache(user.id, mid.id, 0.6)

      const res = await getAs(token)

      expect(res.status).toBe(200)
      expect(res.body.note).toBe(PERSONAL_NOTE)
      expect(res.body.sections).toHaveLength(1)
      expect(res.body.sections[0].title).toBe(PERSONAL_TITLE)
      expect(res.body.sections[0].caption).toBe(CONTENT_CAPTION)
      expect(titlesOf(res)).toEqual(['Top Pick', 'Mid Pick', 'Low Pick'])
      // The same book shape the popularity list carries, so the Flutter app needs nothing new.
      expect(res.body.sections[0].books[0]).toMatchObject({ id: top.id, title: 'Top Pick', author: 'Author', availableCopies: 0, waitlistCount: 0 })
    })

    it('uses the collaborative caption when any pick is collaborative or hybrid', async () => {
      const { user: withHybrid, token: hybridToken } = await seedUser()
      const { user: withCollaborative, token: collaborativeToken } = await seedUser()
      const { user: contentOnly, token: contentToken } = await seedUser()
      const a = await seedBook('Book A')
      const b = await seedBook('Book B')
      await seedCache(withHybrid.id, a.id, 0.9, 'content')
      await seedCache(withHybrid.id, b.id, 0.5, 'hybrid')
      await seedCache(withCollaborative.id, a.id, 0.9, 'collaborative')
      await seedCache(withCollaborative.id, b.id, 0.5, 'content')
      await seedCache(contentOnly.id, a.id, 0.9, 'content')
      await seedCache(contentOnly.id, b.id, 0.5, 'content')

      const hybrid = await getAs(hybridToken)
      const collaborative = await getAs(collaborativeToken)
      const content = await getAs(contentToken)

      expect(hybrid.body.sections[0].caption).toBe(COLLABORATIVE_CAPTION)
      expect(collaborative.body.sections[0].caption).toBe(COLLABORATIVE_CAPTION)
      expect(content.body.sections[0].caption).toBe(CONTENT_CAPTION)
      for (const res of [hybrid, collaborative, content]) {
        expect(res.body.note).toBe(PERSONAL_NOTE)
        expect(res.body.sections).toHaveLength(1)
        expect(res.body.sections[0].title).toBe(PERSONAL_TITLE)
      }
    })

    it('ignores cache rows older than 14 days and shows the popular list', async () => {
      const { user, token } = await seedUser()
      const stale = await seedBook('Stale Pick')
      const stalest = await seedBook('Stalest Pick')
      const base = Date.now()
      await seedCache(user.id, stale.id, 0.9, 'content', new Date(base - 15 * DAY_MS))
      await seedCache(user.id, stalest.id, 0.8, 'hybrid', new Date(base - 40 * DAY_MS))

      const res = await getAs(token)

      expect(res.body.sections).toHaveLength(1)
      expect(res.body.sections[0].title).toBe('Trending in the library')
      expect(res.body.note).toBe("You haven't borrowed anything yet — here's what's popular right now.")

      // The cut-off is measured from the `now` the service is given, not from the machine's clock.
      const earlier = await getRecommendations(user.id, new Date(base - 2 * DAY_MS)) // the 15-day row is 13 days old then
      expect(earlier.note).toBe(PERSONAL_NOTE)
      expect(earlier.sections[0].books.map((b) => b.title)).toEqual(['Stale Pick'])
      const later = await getRecommendations(user.id, new Date(base))
      expect(later.sections[0].title).toBe('Trending in the library')
    })

    it('serves the fresh rows and skips the stale ones when a student has both', async () => {
      const { user, token } = await seedUser()
      const fresh = await seedBook('Fresh Pick')
      const stale = await seedBook('Stale Pick')
      await seedCache(user.id, fresh.id, 0.2, 'content', new Date(Date.now() - 2 * DAY_MS))
      await seedCache(user.id, stale.id, 0.9, 'content', new Date(Date.now() - 20 * DAY_MS))

      const res = await getAs(token)

      expect(res.body.sections[0].title).toBe(PERSONAL_TITLE)
      expect(titlesOf(res)).toEqual(['Fresh Pick'])
    })

    it('drops a book the student has out now or holds a waiting or fulfilled reservation on', async () => {
      const { user, token } = await seedUser()
      const { user: other } = await seedUser()
      const out = await seedBook('Out On Loan')
      const overdue = await seedBook('Overdue Loan')
      const waiting = await seedBook('Waiting Reservation')
      const fulfilled = await seedBook('Fulfilled Reservation')
      const returned = await seedBook('Returned Loan')
      const lost = await seedBook('Lost Loan')
      const cancelled = await seedBook('Cancelled Reservation')
      const expired = await seedBook('Expired Reservation')
      const heldByOther = await seedBook('Held By Someone Else')
      const plain = await seedBook('Plain Pick')
      const picks = [out, overdue, waiting, fulfilled, returned, lost, cancelled, expired, heldByOther, plain]
      // Best score first: the five held books outrank every book that stays.
      for (const [i, book] of picks.entries()) await seedCache(user.id, book.id, 0.99 - i * 0.05)
      await seedLoan(user.id, out.id, new Date(), 'active')
      await seedLoan(user.id, overdue.id, new Date(Date.now() - 30 * DAY_MS), 'overdue')
      await seedReservation(user.id, waiting.id, 'waiting')
      await seedReservation(user.id, fulfilled.id, 'fulfilled')
      await seedLoan(user.id, returned.id, new Date(Date.now() - 20 * DAY_MS), 'returned')
      await seedLoan(user.id, lost.id, new Date(Date.now() - 20 * DAY_MS), 'lost')
      await seedReservation(user.id, cancelled.id, 'cancelled')
      await seedReservation(user.id, expired.id, 'expired')
      await seedLoan(other.id, heldByOther.id, new Date(), 'active')
      await seedReservation(other.id, heldByOther.id, 'waiting')

      const res = await getAs(token)

      expect(res.body.note).toBe(PERSONAL_NOTE)
      expect(titlesOf(res)).toEqual(['Returned Loan', 'Lost Loan', 'Cancelled Reservation', 'Expired Reservation', 'Held By Someone Else', 'Plain Pick'])
    })

    it('drops a book the student has a pending borrow request on', async () => {
      const { user, token } = await seedUser()
      const requested = await seedBook('Requested Book')
      const plain = await seedBook('Plain Pick')
      await seedCache(user.id, requested.id, 0.9)
      await seedCache(user.id, plain.id, 0.5)
      await seedBorrowRequest(user.id, requested.id, 'pending')

      const res = await getAs(token)

      expect(res.body.note).toBe(PERSONAL_NOTE)
      expect(titlesOf(res)).toEqual(['Plain Pick'])
    })

    it('keeps a book whose borrow request was declined, expired, cancelled or approved', async () => {
      const { user, token } = await seedUser()
      const declined = await seedBook('Declined Request')
      const expired = await seedBook('Expired Request')
      const cancelled = await seedBook('Cancelled Request')
      const approved = await seedBook('Approved Request')
      // Best score first, in this order. The approved request has no loan row here, so only its status can matter: an
      // approved request becomes a loan, and the loan rule (not this one) judges whether the book is held.
      await seedCache(user.id, declined.id, 0.9)
      await seedCache(user.id, expired.id, 0.8)
      await seedCache(user.id, cancelled.id, 0.7)
      await seedCache(user.id, approved.id, 0.6)
      await seedBorrowRequest(user.id, declined.id, 'declined')
      await seedBorrowRequest(user.id, expired.id, 'expired')
      await seedBorrowRequest(user.id, cancelled.id, 'cancelled')
      await seedBorrowRequest(user.id, approved.id, 'approved')

      const res = await getAs(token)

      expect(res.body.note).toBe(PERSONAL_NOTE)
      expect(titlesOf(res)).toEqual(['Declined Request', 'Expired Request', 'Cancelled Request', 'Approved Request'])
    })

    it("another student's pending request does not hide it", async () => {
      const { user, token } = await seedUser()
      const { user: other } = await seedUser()
      const book = await seedBook('Requested By Someone Else')
      await seedCache(user.id, book.id, 0.9)
      await seedBorrowRequest(other.id, book.id, 'pending')

      const res = await getAs(token)

      expect(res.body.note).toBe(PERSONAL_NOTE)
      expect(titlesOf(res)).toEqual(['Requested By Someone Else'])
    })

    it('shows at most ten picks after the held books are dropped, best first', async () => {
      const { user, token } = await seedUser()
      const books = []
      for (let i = 0; i < 13; i += 1) books.push(await seedBook(`Pick ${String(i).padStart(2, '0')}`))
      // Pick 00 has the best score, Pick 12 the worst; the two best are held, so Picks 02 to 11 are the ten shown.
      for (const [i, book] of books.entries()) await seedCache(user.id, book.id, 0.9 - i * 0.05)
      await seedLoan(user.id, books[0].id, new Date())
      await seedReservation(user.id, books[1].id, 'waiting')

      const res = await getAs(token)

      expect(RECOMMEND_LIMIT).toBe(10)
      expect(titlesOf(res)).toEqual(books.slice(2, 12).map((b) => b.title))
    })

    it('breaks equal scores on book id, ascending', async () => {
      const { user, token } = await seedUser()
      const books = [await seedBook('Tie One'), await seedBook('Tie Two'), await seedBook('Tie Three')]
      for (const book of books) await seedCache(user.id, book.id, 0.5)

      const res = await getAs(token)

      const expected = [...books].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => b.title)
      expect(titlesOf(res)).toEqual(expected)
    })

    it('falls back to the popular list when every cached book is held', async () => {
      const { user, token } = await seedUser()
      const out = await seedBook('Out On Loan')
      const waiting = await seedBook('Waiting Reservation')
      await seedBook('Not Cached')
      await seedCache(user.id, out.id, 0.9, 'hybrid')
      await seedCache(user.id, waiting.id, 0.8, 'collaborative')
      await seedLoan(user.id, out.id, new Date())
      await seedReservation(user.id, waiting.id, 'waiting')

      const res = await getAs(token)

      expect(res.status).toBe(200)
      expect(res.body.sections).toHaveLength(1)
      expect(res.body.sections[0].title).toBe('Trending in the library')
      expect(res.body.sections[0].caption).toBe('Most borrowed in the last 30 days')
      expect(res.body.note).toBe("Personalized picks are on the way — for now, here's what's popular in the library.")
      expect(res.body.sections[0].books.length).toBeGreaterThan(0)
    })

    it('falls back to the popular list when a cached book was deleted and nothing else is left', async () => {
      const { user, token } = await seedUser()
      const gone = await seedBook('Deleted Book')
      await seedBook('Still Here')
      await seedCache(user.id, gone.id, 0.9)
      pretendBookWasDeleted(gone.id)

      const res = await getAs(token)

      expect(res.status).toBe(200)
      expect(res.body.sections).toHaveLength(1)
      expect(res.body.sections[0].title).toBe('Trending in the library')
      expect(titlesOf(res)).toEqual(['Still Here'])
    })

    it('drops a cached book that was deleted and keeps the others', async () => {
      const { user, token } = await seedUser()
      const gone = await seedBook('Deleted Book')
      const kept = await seedBook('Kept Book')
      await seedCache(user.id, gone.id, 0.9, 'hybrid')
      await seedCache(user.id, kept.id, 0.5, 'content')
      pretendBookWasDeleted(gone.id)

      const res = await getAs(token)

      expect(res.body.sections[0].title).toBe(PERSONAL_TITLE)
      expect(titlesOf(res)).toEqual(['Kept Book'])
      // The caption describes the picks on the screen: the deleted hybrid pick no longer makes it the collaborative one.
      expect(res.body.sections[0].caption).toBe(CONTENT_CAPTION)
    })

    it('a student with no rows gets the popular list with the unchanged wording', async () => {
      const { user: other } = await seedUser()
      const { token: newcomer } = await seedUser()
      const { user: borrower, token: borrowerToken } = await seedUser()
      const book = await seedBook('Some Book')
      await seedCache(other.id, book.id, 0.9)
      await seedLoan(borrower.id, book.id, new Date())

      const none = await getAs(newcomer)
      expect(none.body.note).toBe("You haven't borrowed anything yet — here's what's popular right now.")
      expect(none.body.sections).toHaveLength(1)
      expect(none.body.sections[0].title).toBe('Trending in the library')
      expect(none.body.sections[0].caption).toBe('Most borrowed in the last 30 days')

      const holding = await getAs(borrowerToken)
      expect(holding.body.note).toBe("Personalized picks are on the way — for now, here's what's popular in the library.")
      expect(holding.body.sections[0].title).toBe('Trending in the library')
    })

    it('keeps rows of another student out of the answer', async () => {
      const { user: mine, token: myToken } = await seedUser()
      const { user: theirs, token: theirToken } = await seedUser()
      const mineBook = await seedBook('My Pick')
      const theirBook = await seedBook('Their Pick')
      await seedCache(mine.id, mineBook.id, 0.3, 'content')
      await seedCache(theirs.id, theirBook.id, 0.9, 'hybrid')
      await seedCache(theirs.id, mineBook.id, 0.8, 'collaborative')

      const mineRes = await getAs(myToken)
      expect(titlesOf(mineRes)).toEqual(['My Pick'])
      expect(mineRes.body.sections[0].caption).toBe(CONTENT_CAPTION)

      const theirRes = await getAs(theirToken)
      expect(titlesOf(theirRes)).toEqual(['Their Pick', 'My Pick'])
      expect(theirRes.body.sections[0].caption).toBe(COLLABORATIVE_CAPTION)
    })

    it('never calls the AI service', async () => {
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      const { user, token } = await seedUser()
      const { token: newcomer } = await seedUser()
      const a = await seedBook('Book A')
      await seedBook('Book B')
      await seedCache(user.id, a.id, 0.9)

      const served = await getAs(token)
      const popular = await getAs(newcomer)

      expect(served.body.sections[0].title).toBe(PERSONAL_TITLE)
      expect(popular.body.sections[0].title).toBe('Trending in the library')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('one cache row per student and book', async () => {
      const { user } = await seedUser()
      const { user: other } = await seedUser()
      const book = await seedBook('Book A')
      const second = await seedBook('Book B')
      await seedCache(user.id, book.id, 0.9)

      await expect(seedCache(user.id, book.id, 0.1, 'hybrid')).rejects.toMatchObject({ code: 'P2002' })

      // The same book for another student, and another book for the same student, are fine.
      await seedCache(other.id, book.id, 0.9)
      await seedCache(user.id, second.id, 0.5)
      expect(await prisma.recommendationCache.count({ where: { userId: user.id } })).toBe(2)
      expect(await prisma.recommendationCache.count({ where: { userId: user.id, bookId: book.id } })).toBe(1)
    })
  })
})

describe('recommender constants', () => {
  it('carry the agreed values', () => {
    expect(RECOMMEND_LIMIT).toBe(10)
    expect(RECOMMEND_REFRESH_MS).toBe(24 * 60 * 60 * 1000)
    expect(RECOMMEND_RETRY_MS).toBe(15 * 60 * 1000)
    expect(RECOMMEND_TIMEOUT_MS).toBe(90_000)
    expect(RECOMMEND_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(RECOMMEND_MAX_BOOKS).toBe(5000)
    // The backend's own send cap, below the 200,000 the AI service accepts: at that size the service can outgrow a free
    // 512 MB instance, so the refresh keeps the 50,000 most recent interactions instead.
    expect(RECOMMEND_MAX_INTERACTIONS).toBe(50_000)
    expect(RECOMMEND_LOAN_WEIGHT).toBe(1)
    expect(RECOMMEND_RENEWAL_BONUS).toBe(0.5)
    expect(RECOMMEND_RESERVATION_WEIGHT).toBe(0.5)
    expect(RECOMMEND_MAX_PAIR_WEIGHT).toBe(3)
  })
})
