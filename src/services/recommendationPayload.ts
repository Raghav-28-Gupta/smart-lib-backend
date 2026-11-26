// The payload of POST /recommend/batch, built from the database (slice 8; spec 2026-11-25-book-recommender-design.md,
// section 3, step 3). The AI service is stateless and never reads a database, so everything it fits from travels in
// this one object: the catalog and the students' interactions. It carries user ids and book ids only: no name, no email,
// no other user field (the AI service and every log line see ids, counts and the model version, nothing personal).
import {
  RECOMMEND_LIMIT,
  RECOMMEND_LOAN_WEIGHT,
  RECOMMEND_MAX_BOOKS,
  RECOMMEND_MAX_INTERACTIONS,
  RECOMMEND_MAX_PAIR_WEIGHT,
  RECOMMEND_RENEWAL_BONUS,
  RECOMMEND_RESERVATION_WEIGHT,
} from '../config/constants'
import type { RecommendBatchBook, RecommendBatchInteraction, RecommendBatchRequest } from '../lib/aiClient'
import { prisma } from '../lib/prisma'

export interface RecommendationPayloadLimits {
  maxBooks: number
  maxInteractions: number
}

const DEFAULT_LIMITS: RecommendationPayloadLimits = { maxBooks: RECOMMEND_MAX_BOOKS, maxInteractions: RECOMMEND_MAX_INTERACTIONS }

/** One student's summed interest in one book, and when it last moved. */
interface Pair {
  userId: string
  bookId: string
  weight: number
  lastActivity: number
}

// Plain code-unit order, the same on every machine (a database collation or a locale could differ): the payload for one
// database state is always the same bytes, so the AI service's answer for it is too.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Builds the request for the AI service, or `null` when there is no interaction left to send (no student has borrowed or
 * reserved a sendable book: there is nothing to ask).
 *
 * Books: those with at least one copy whose status is not `lost`. Interactions, students only: each loan adds 1 (plus
 * 0.5 when it was renewed, once however many times), each reservation of any status adds 0.5; a (student, book) pair
 * sums them and is capped at 3. A pair whose book is not sent is dropped. When the caps bite: the interactions are cut to
 * the `maxInteractions` with the most recent activity (a pair's activity is its latest loan or reservation), and when the
 * books are too many the books with an interaction come first (most recent first), then the rest by title; an
 * interaction on a book that was cut goes with it. A student left with no interaction is absent. Never a 422 for the AI
 * service's caps: it would make every refresh fail for ever.
 */
export async function buildRecommendationPayload(limits: RecommendationPayloadLimits = DEFAULT_LIMITS): Promise<RecommendBatchRequest | null> {
  const [books, loans, reservations] = await Promise.all([
    prisma.book.findMany({
      where: { copies: { some: { status: { not: 'lost' } } } },
      select: { id: true, title: true, author: true, genre: true, description: true },
    }),
    prisma.loan.findMany({
      where: { user: { role: 'student' } },
      select: { userId: true, renewedCount: true, borrowedAt: true, bookCopy: { select: { bookId: true } } },
    }),
    prisma.reservation.findMany({
      where: { user: { role: 'student' } },
      select: { userId: true, bookId: true, requestedAt: true },
    }),
  ])

  const sendable = new Map(books.map((book) => [book.id, book]))

  const pairs = new Map<string, Pair>()
  const add = (userId: string, bookId: string, weight: number, at: Date) => {
    if (!sendable.has(bookId)) return
    const key = JSON.stringify([userId, bookId])
    const pair = pairs.get(key)
    if (pair) {
      pair.weight += weight
      pair.lastActivity = Math.max(pair.lastActivity, at.getTime())
    } else {
      pairs.set(key, { userId, bookId, weight, lastActivity: at.getTime() })
    }
  }
  for (const loan of loans) {
    add(loan.userId, loan.bookCopy.bookId, RECOMMEND_LOAN_WEIGHT + (loan.renewedCount > 0 ? RECOMMEND_RENEWAL_BONUS : 0), loan.borrowedAt)
  }
  for (const reservation of reservations) add(reservation.userId, reservation.bookId, RECOMMEND_RESERVATION_WEIGHT, reservation.requestedAt)

  // Most recent first; equal instants fall back to the ids, so the cut is the same every time.
  const recent = [...pairs.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity || compare(a.userId, b.userId) || compare(a.bookId, b.bookId))
    .slice(0, limits.maxInteractions)

  let sentBookIds: Set<string>
  if (sendable.size <= limits.maxBooks) {
    sentBookIds = new Set(sendable.keys())
  } else {
    sentBookIds = new Set()
    for (const pair of recent) {
      if (sentBookIds.size >= limits.maxBooks) break
      sentBookIds.add(pair.bookId)
    }
    const others = books.filter((book) => !sentBookIds.has(book.id)).sort((a, b) => compare(a.title, b.title) || compare(a.id, b.id))
    for (const book of others) {
      if (sentBookIds.size >= limits.maxBooks) break
      sentBookIds.add(book.id)
    }
  }

  const interactions: RecommendBatchInteraction[] = recent
    .filter((pair) => sentBookIds.has(pair.bookId))
    .map((pair) => ({ user_id: pair.userId, book_id: pair.bookId, weight: Math.min(pair.weight, RECOMMEND_MAX_PAIR_WEIGHT) }))
  if (interactions.length === 0) return null

  const sentBooks: RecommendBatchBook[] = books
    .filter((book) => sentBookIds.has(book.id))
    .sort((a, b) => compare(a.title, b.title) || compare(a.id, b.id))
    .map((book) => ({ id: book.id, title: book.title, author: book.author, genre: book.genre, description: book.description }))

  return { books: sentBooks, interactions, limit: RECOMMEND_LIMIT }
}
