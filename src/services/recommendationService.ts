import { RECOMMEND_LIMIT, RECOMMEND_MAX_AGE_MS } from '../config/constants'
import { prisma } from '../lib/prisma'
import { getBooksByIds, type BookDto } from './bookService'

export interface RecommendationSectionDto {
  title: string
  caption: string
  books: BookDto[]
}

export interface RecommendationsDto {
  note: string
  sections: RecommendationSectionDto[]
}

const POPULARITY_WINDOW_DAYS = 30
const POPULARITY_LIMIT = 10

// Ranks books by recent loan count (in JS, not a SQL groupBy) because Loan
// only carries a bookCopyId, not a bookId -- grouping "by book" means
// joining through BookCopy first, which groupBy can't express across a
// relation. Fine at this project's scale. Falls back to an alphabetical
// listing when nothing's been borrowed recently, so the section is never
// empty just because the library is quiet.
async function popularBookIds(limit: number): Promise<string[]> {
  const since = new Date(Date.now() - POPULARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const recentLoans = await prisma.loan.findMany({
    where: { borrowedAt: { gte: since } },
    select: { bookCopy: { select: { bookId: true } } },
  })

  const counts = new Map<string, number>()
  for (const loan of recentLoans) {
    counts.set(loan.bookCopy.bookId, (counts.get(loan.bookCopy.bookId) ?? 0) + 1)
  }

  if (counts.size > 0) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
  }

  const fallback = await prisma.book.findMany({ take: limit, orderBy: { title: 'asc' }, select: { id: true } })
  return fallback.map((b) => b.id)
}

// Of the books a student's cached picks name, the ones they hold right now: a copy out on loan (any status but
// returned or lost: a lost loan is closed), a reservation that is waiting or fulfilled (a fulfilled one is a copy kept
// for the student to claim), or a borrow request still pending (it sets a copy aside for them until a librarian decides;
// an approved one has become a loan, which the loan rule judges, and a declined, expired or cancelled one holds nothing).
// Recommending a book they already have would be noise.
async function heldBookIds(userId: string, bookIds: string[]): Promise<Set<string>> {
  const [loans, reservations, requests] = await Promise.all([
    prisma.loan.findMany({
      where: { userId, status: { notIn: ['returned', 'lost'] }, bookCopy: { bookId: { in: bookIds } } },
      select: { bookCopy: { select: { bookId: true } } },
    }),
    prisma.reservation.findMany({
      where: { userId, bookId: { in: bookIds }, status: { in: ['waiting', 'fulfilled'] } },
      select: { bookId: true },
    }),
    prisma.borrowRequest.findMany({
      where: { userId, bookId: { in: bookIds }, status: 'pending' },
      select: { bookId: true },
    }),
  ])
  return new Set([...loans.map((l) => l.bookCopy.bookId), ...reservations.map((r) => r.bookId), ...requests.map((r) => r.bookId)])
}

// The student's personal section, read only from RecommendationCache (the background refresh fills it; this never
// calls the AI service). Null when nothing is left to show, so the caller falls back to the popularity list: no
// fresh rows, every pick held now, or every pick's book deleted since the refresh.
async function personalRecommendations(userId: string, now: Date): Promise<RecommendationsDto | null> {
  const rows = await prisma.recommendationCache.findMany({
    where: { userId, generatedAt: { gt: new Date(now.getTime() - RECOMMEND_MAX_AGE_MS) } },
    // Equal scores break on the book id, ascending, as the AI service's own ranking does.
    orderBy: [{ score: 'desc' }, { bookId: 'asc' }],
    select: { bookId: true, method: true },
  })
  if (rows.length === 0) return null

  const held = await heldBookIds(userId, rows.map((r) => r.bookId))
  const picks = rows.filter((r) => !held.has(r.bookId)).slice(0, RECOMMEND_LIMIT)

  // Drops a book deleted since; the caption is then judged by the picks actually shown.
  const books = await getBooksByIds(picks.map((p) => p.bookId))
  if (books.length === 0) return null
  const shown = new Set(books.map((b) => b.id))
  const allContent = picks.filter((p) => shown.has(p.bookId)).every((p) => p.method === 'content')

  return {
    note: 'Based on your recent activity.',
    sections: [
      {
        title: 'Recommended for you',
        caption: allContent ? "Similar to books you've borrowed" : "Similar to books you've borrowed, and what similar students borrow",
        books,
      },
    ],
  }
}

async function popularRecommendations(userId: string): Promise<RecommendationsDto> {
  const books = await getBooksByIds(await popularBookIds(POPULARITY_LIMIT))
  if (books.length === 0) return { note: 'No recommendations available yet.', sections: [] }

  // A book the student has out now; a loan closed because its copy was marked lost is not out.
  const hasActiveLoan = (await prisma.loan.count({ where: { userId, status: { notIn: ['returned', 'lost'] } } })) > 0
  const note = hasActiveLoan
    ? 'Personalized picks are on the way — for now, here\'s what\'s popular in the library.'
    : "You haven't borrowed anything yet — here's what's popular right now."

  return { note, sections: [{ title: 'Trending in the library', caption: 'Most borrowed in the last 30 days', books }] }
}

// The student's cached picks when any are left to show, else the popularity list (also when the cache is empty, stale
// or the AI service was never deployed: the screen is never blank because of the recommender). `now` is the clock for
// the cache's age limit.
export async function getRecommendations(userId: string, now: Date = new Date()): Promise<RecommendationsDto> {
  return (await personalRecommendations(userId, now)) ?? (await popularRecommendations(userId))
}
