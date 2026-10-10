import type { Book } from '../generated/prisma/client'
import { NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

export interface BookDto {
  id: string
  isbn: string
  title: string
  author: string
  genre: string | null
  description: string | null
  publishedYear: number | null
  totalCopies: number
  availableCopies: number
  // Of availableCopies, how many are earmarked for a waitlisted student's live
  // claim. They're on the shelf, but only the claimant can borrow them.
  heldCopies: number
  waitlistCount: number
}

function toBookDto(book: Book, availableCopies: number, heldCopies: number, waitlistCount: number): BookDto {
  return {
    id: book.id,
    isbn: book.isbn,
    title: book.title,
    author: book.author,
    genre: book.genre,
    description: book.description,
    publishedYear: book.publishedYear,
    totalCopies: book.totalCopies,
    availableCopies,
    heldCopies,
    waitlistCount,
  }
}

// availableCopies/waitlistCount aren't stored columns — they're computed by
// counting BookCopy/Reservation rows, same as the frontend mock repository
// derives them from its in-memory Book fields. Batches both counts into two
// groupBy queries instead of N+1 individual counts per book.
async function attachComputedCounts(books: Book[]): Promise<BookDto[]> {
  if (books.length === 0) return []

  const bookIds = books.map((b) => b.id)
  const now = new Date()
  const [availableGroups, heldGroups, waitlistGroups] = await Promise.all([
    prisma.bookCopy.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds }, status: 'available' },
      _count: true,
    }),
    // Counted, not rebalanced: a read shouldn't write. A claim past its
    // expiry is excluded here and expired for real on the next write path
    // (borrow, join, return), which runs rebalanceClaims.
    prisma.reservation.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds }, status: 'fulfilled', claimExpiresAt: { gt: now } },
      _count: true,
    }),
    prisma.reservation.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds }, status: 'waiting' },
      _count: true,
    }),
  ])
  const availableMap = new Map(availableGroups.map((g) => [g.bookId, g._count]))
  const heldMap = new Map(heldGroups.map((g) => [g.bookId, g._count]))
  const waitlistMap = new Map(waitlistGroups.map((g) => [g.bookId, g._count]))

  return books.map((b) =>
    toBookDto(b, availableMap.get(b.id) ?? 0, heldMap.get(b.id) ?? 0, waitlistMap.get(b.id) ?? 0),
  )
}

export async function searchBooks(input: { q?: string; genre?: string }): Promise<BookDto[]> {
  const q = input.q?.trim()
  const genre = input.genre && input.genre !== 'All' ? input.genre : undefined

  const books = await prisma.book.findMany({
    where: {
      ...(genre ? { genre } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { author: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { title: 'asc' },
  })

  return attachComputedCounts(books)
}

// Used by recommendationService: fetches an arbitrary set of books and
// preserves the caller's ordering (e.g. popularity or AI-model rank) rather
// than falling back to alphabetical, since order is the whole point of a
// recommendation list. Silently drops any id that no longer resolves to a
// book rather than erroring, since a stale AI result shouldn't break the page.
export async function getBooksByIds(ids: string[]): Promise<BookDto[]> {
  if (ids.length === 0) return []
  const books = await prisma.book.findMany({ where: { id: { in: ids } } })
  const dtos = await attachComputedCounts(books)
  const byId = new Map(dtos.map((d) => [d.id, d]))
  return ids.map((id) => byId.get(id)).filter((d): d is BookDto => d != null)
}

export async function getBookById(id: string): Promise<BookDto> {
  const book = await prisma.book.findUnique({ where: { id } })
  if (!book) throw new NotFoundError('Book')

  // Same counting as search, so the two can't disagree about a book.
  const [dto] = await attachComputedCounts([book])
  return dto
}
