import { fetchRecommendations } from '../lib/aiClient'
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

export async function getRecommendations(userId: string): Promise<RecommendationsDto> {
  let aiResults: Awaited<ReturnType<typeof fetchRecommendations>> = []
  try {
    aiResults = await fetchRecommendations(userId)
  } catch {
    // AI backend unreachable or still returning its Phase 3 stub -- either
    // way, fall through to the popularity-based listing below.
    aiResults = []
  }

  if (aiResults.length > 0) {
    const books = await getBooksByIds(aiResults.map((r) => r.book_id))
    return {
      note: 'Based on your recent activity.',
      sections: [{ title: 'Recommended for you', caption: 'Personalized picks', books }],
    }
  }

  const books = await getBooksByIds(await popularBookIds(POPULARITY_LIMIT))
  if (books.length === 0) return { note: 'No recommendations available yet.', sections: [] }

  const hasActiveLoan = (await prisma.loan.count({ where: { userId, status: { not: 'returned' } } })) > 0
  const note = hasActiveLoan
    ? 'Personalized picks are on the way — for now, here\'s what\'s popular in the library.'
    : "You haven't borrowed anything yet — here's what's popular right now."

  return { note, sections: [{ title: 'Trending in the library', caption: 'Most borrowed in the last 30 days', books }] }
}
