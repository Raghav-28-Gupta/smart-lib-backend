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
  waitlistCount: number
}

function toBookDto(book: Book, availableCopies: number, waitlistCount: number): BookDto {
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
    waitlistCount,
  }
}

// availableCopies/waitlistCount aren't stored columns — they're computed by
// counting BookCopy/Reservation rows, same as the frontend mock repository
// derives them from its in-memory Book fields. For a list of books this
// batches both counts into two groupBy queries instead of N+1 individual
// counts per book.
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

  if (books.length === 0) return []

  const bookIds = books.map((b) => b.id)
  const [availableGroups, waitlistGroups] = await Promise.all([
    prisma.bookCopy.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds }, status: 'available' },
      _count: true,
    }),
    prisma.reservation.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds }, status: 'waiting' },
      _count: true,
    }),
  ])
  const availableMap = new Map(availableGroups.map((g) => [g.bookId, g._count]))
  const waitlistMap = new Map(waitlistGroups.map((g) => [g.bookId, g._count]))

  return books.map((b) => toBookDto(b, availableMap.get(b.id) ?? 0, waitlistMap.get(b.id) ?? 0))
}

export async function getBookById(id: string): Promise<BookDto> {
  const book = await prisma.book.findUnique({ where: { id } })
  if (!book) throw new NotFoundError('Book')

  const [availableCopies, waitlistCount] = await Promise.all([
    prisma.bookCopy.count({ where: { bookId: id, status: 'available' } }),
    prisma.reservation.count({ where: { bookId: id, status: 'waiting' } }),
  ])
  return toBookDto(book, availableCopies, waitlistCount)
}
