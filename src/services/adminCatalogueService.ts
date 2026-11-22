// The librarian's Catalogue: list books with their copies, add a book with its
// first copies, edit a book, and add copies to one.
//
// A page costs a fixed handful of queries however many books it holds: one raw
// query picks the page of book ids and, through count(*) OVER(), the total behind
// the search (the search runs in SQL, over title, author, ISBN and every copy's
// barcode, so a filtered page is still a full page); then one query each loads
// those books with their copies, counts their student-visible totals, finds the
// borrowers of the copies out on loan and the replacement fines still owed for
// the lost ones.
//
// Every successful write publishes catalogue.changed once, after it has
// committed. A refusal (bad id, duplicate ISBN) publishes nothing.
import { Prisma, type CopyStatus } from '../generated/prisma/client'
import { publishCatalogueChange } from '../lib/events'
import { ConflictError, NotFoundError } from '../lib/httpError'
import { escapeLike } from '../lib/like'
import { prisma } from '../lib/prisma'
import { totalCopiesByBook } from './bookService'
import { onBookReturned } from './reservationService'

export type AdminCopyStatus = 'available' | 'on_loan' | 'held' | 'maintenance' | 'lost'

export interface AdminCopyDto {
  id: string
  barcode: string
  status: AdminCopyStatus
  /** The student holding the copy, from its open loan; null when it is not out, or is marked borrowed with no open loan (the seed has some). */
  borrower: { id: string; name: string } | null
  dueAt: Date | null
  /**
   * For a lost copy, the replacement fine of its latest lost loan while it is still
   * owed (outstanding or adjusted, at its current amount): what Restore offers to
   * waive. Null otherwise, including when only an older loss's fine is still owed.
   */
  owedReplacement: OwedReplacement | null
}

export interface OwedReplacement {
  fineId: string
  amount: number
  student: { id: string; name: string }
}

/**
 * A copy's lost loans, latest first. The first is the one whose replacement fine
 * the copy offers to waive (here) and Restore waives (adminCopyService).
 */
export const LATEST_LOST_LOAN_FIRST: Prisma.LoanOrderByWithRelationInput[] = [
  { lostAt: { sort: 'desc', nulls: 'last' } },
  { borrowedAt: 'desc' },
  { id: 'asc' },
]

export interface AdminBookDto {
  id: string
  isbn: string
  title: string
  author: string
  genre: string | null
  description: string | null
  publishedYear: number | null
  /** What students see: the copies that are not lost. */
  totalCopies: number
  availableCopies: number
  /** Every copy, lost ones included, in barcode order. */
  copies: AdminCopyDto[]
}

export type BookInput = {
  isbn: string
  title: string
  author: string
  genre: string
  description?: string | null
  publishedYear?: number | null
}

// A type alias, not an interface, so the route can cast req.validatedQuery to it.
export type AdminBookListQuery = {
  search?: string
  page: number
  pageSize: number
}

export interface AdminBookList {
  books: AdminBookDto[]
  total: number
  page: number
  pageSize: number
  /** Every distinct genre in use across the whole catalogue, sorted; not narrowed by the search or the page. */
  genres: string[]
}

const DUPLICATE_ISBN_MESSAGE = 'A book with this ISBN is already in the catalogue.'

type BookWithCopies = Prisma.BookGetPayload<{ include: { copies: true } }>

interface Borrower {
  borrower: { id: string; name: string }
  dueAt: Date
}

function toCopyStatus(status: CopyStatus): AdminCopyStatus {
  if (status === 'borrowed') return 'on_loan'
  if (status === 'requested') return 'held'
  return status
}

// Barcodes are SL- and five digits, widening past SL-99999, so a text sort would
// put SL-100000 before SL-99999: shorter first, then by text.
function byBarcode(a: { barcode: string }, b: { barcode: string }): number {
  return a.barcode.length - b.barcode.length || (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0)
}

/** The open (active) loan of every copy of these books that has one, by copy id. */
async function findOpenLoans(bookIds: string[]): Promise<Map<string, Borrower>> {
  const loans = await prisma.loan.findMany({
    where: { status: 'active', bookCopy: { bookId: { in: bookIds } } },
    select: { bookCopyId: true, dueAt: true, user: { select: { id: true, name: true } } },
    // A copy has one open loan; should the data ever say otherwise, the latest wins.
    orderBy: { borrowedAt: 'asc' },
  })
  return new Map(loans.map((loan) => [loan.bookCopyId, { borrower: loan.user, dueAt: loan.dueAt }]))
}

/**
 * For each of these lost copies, the replacement fine still owed (outstanding or
 * adjusted) on its latest lost loan, by copy id. One query for all of them: every
 * lost loan of these copies, latest first, each with its owed lost fine if any;
 * only each copy's first counts.
 */
async function findOwedReplacements(lostCopyIds: string[]): Promise<Map<string, OwedReplacement>> {
  const owed = new Map<string, OwedReplacement>()
  if (lostCopyIds.length === 0) return owed

  const loans = await prisma.loan.findMany({
    where: { status: 'lost', bookCopyId: { in: lostCopyIds } },
    orderBy: LATEST_LOST_LOAN_FIRST,
    select: {
      bookCopyId: true,
      user: { select: { id: true, name: true } },
      fines: {
        where: { reason: 'lost', status: { in: ['pending', 'adjusted'] } },
        select: { id: true, amount: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  const seen = new Set<string>()
  for (const loan of loans) {
    if (seen.has(loan.bookCopyId)) continue
    seen.add(loan.bookCopyId)
    const fine = loan.fines[0]
    if (fine) owed.set(loan.bookCopyId, { fineId: fine.id, amount: fine.amount, student: loan.user })
  }
  return owed
}

async function toAdminBookDtos(books: BookWithCopies[]): Promise<AdminBookDto[]> {
  if (books.length === 0) return []

  const bookIds = books.map((b) => b.id)
  const lostCopyIds = books.flatMap((b) => b.copies.filter((c) => c.status === 'lost').map((c) => c.id))
  const [totals, openLoans, owedReplacements] = await Promise.all([
    totalCopiesByBook(bookIds),
    findOpenLoans(bookIds),
    findOwedReplacements(lostCopyIds),
  ])

  return books.map((book) => {
    const copies: AdminCopyDto[] = [...book.copies].sort(byBarcode).map((copy) => {
      const loan = openLoans.get(copy.id)
      return {
        id: copy.id,
        barcode: copy.barcode,
        status: toCopyStatus(copy.status),
        borrower: loan?.borrower ?? null,
        dueAt: loan?.dueAt ?? null,
        owedReplacement: owedReplacements.get(copy.id) ?? null,
      }
    })
    return {
      id: book.id,
      isbn: book.isbn,
      title: book.title,
      author: book.author,
      genre: book.genre,
      description: book.description,
      publishedYear: book.publishedYear,
      totalCopies: totals.get(book.id) ?? 0,
      availableCopies: copies.filter((c) => c.status === 'available').length,
      copies,
    }
  })
}

/**
 * The FROM and WHERE of the book list: every book, or those with the search in
 * their title, author or ISBN, or in the barcode of any of their copies. Matched
 * with ILIKE, where `%`, `_` and `\` in the search are literal; the search goes in
 * as a bound parameter, never text.
 */
function matchingBooks(search: string | undefined): Prisma.Sql {
  const text = search?.trim()
  if (!text) return Prisma.sql`FROM "Book" b`
  const pattern = `%${escapeLike(text)}%`
  return Prisma.sql`
    FROM "Book" b
    WHERE b.title ILIKE ${pattern} ESCAPE '\\'
       OR b.author ILIKE ${pattern} ESCAPE '\\'
       OR b.isbn ILIKE ${pattern} ESCAPE '\\'
       OR EXISTS (
         SELECT 1 FROM "BookCopy" c WHERE c."bookId" = b.id AND c.barcode ILIKE ${pattern} ESCAPE '\\'
       )`
}

/** One page of books in title order, each with its copies, and the total behind the search. */
export async function listBooks(q: AdminBookListQuery): Promise<AdminBookList> {
  const from = matchingBooks(q.search)
  const offset = (q.page - 1) * q.pageSize

  const [rows, genreGroups] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; total: number }>>(Prisma.sql`
      SELECT b.id, (count(*) OVER ())::int AS total
      ${from}
      ORDER BY b.title, b.id
      LIMIT ${q.pageSize} OFFSET ${offset}`),
    prisma.book.groupBy({ by: ['genre'], where: { genre: { not: null } }, orderBy: { genre: 'asc' } }),
  ])

  let total = rows[0]?.total ?? 0
  // A page past the end has no row to carry the window count; ask for it on its
  // own so the console can still say how many books match.
  if (rows.length === 0 && q.page > 1) {
    const [counted] = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total ${from}`)
    total = counted?.total ?? 0
  }

  const books = await prisma.book.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: { copies: true } })
  const byId = new Map((await toAdminBookDtos(books)).map((dto) => [dto.id, dto]))

  return {
    books: rows.map((r) => byId.get(r.id)).filter((dto): dto is AdminBookDto => dto != null),
    total,
    page: q.page,
    pageSize: q.pageSize,
    genres: genreGroups.map((g) => g.genre).filter((genre): genre is string => genre != null),
  }
}

/** One book as the console lists it. 404 for an id that is not a book. */
export async function getAdminBook(id: string): Promise<AdminBookDto> {
  const book = await prisma.book.findUnique({ where: { id }, include: { copies: true } })
  if (!book) throw new NotFoundError('Book')
  const [dto] = await toAdminBookDtos([book])
  return dto
}

/** 409 when another book already has this ISBN (`exceptBookId`: the book being edited, which may keep its own). */
async function refuseTakenIsbn(isbn: string, exceptBookId?: string): Promise<void> {
  const taken = await prisma.book.findFirst({
    where: { isbn, ...(exceptBookId ? { id: { not: exceptBookId } } : {}) },
    select: { id: true },
  })
  if (taken) throw new ConflictError(DUPLICATE_ISBN_MESSAGE)
}

/**
 * The check above and the write are two statements, so a second librarian can
 * add the same ISBN in between; the unique index then refuses the write (P2002).
 * Turns that into the same 409, and hands any other error back unchanged.
 */
function asDuplicateIsbn(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && JSON.stringify(error.meta ?? {}).includes('isbn')) {
    return new ConflictError(DUPLICATE_ISBN_MESSAGE)
  }
  return error
}

/**
 * Adds a book and its first copies in one transaction, so a failure leaves
 * neither behind. The copies get their barcodes from the database. The book's
 * stored totalCopies column (no longer read) is set to the copies made.
 */
export async function createBook(input: BookInput & { copies: number }): Promise<AdminBookDto> {
  await refuseTakenIsbn(input.isbn)

  let bookId: string
  try {
    bookId = await prisma.$transaction(async (tx) => {
      const book = await tx.book.create({
        data: {
          isbn: input.isbn,
          title: input.title,
          author: input.author,
          genre: input.genre,
          description: input.description ?? null,
          publishedYear: input.publishedYear ?? null,
          totalCopies: input.copies,
        },
      })
      await tx.bookCopy.createMany({ data: Array.from({ length: input.copies }, () => ({ bookId: book.id })) })
      return book.id
    })
  } catch (error) {
    throw asDuplicateIsbn(error)
  }

  publishCatalogueChange()
  return getAdminBook(bookId)
}

/**
 * Changes the fields that were sent. `null` clears the description and the
 * published year; the other fields have no empty value (the schema refuses one).
 */
export async function updateBook(id: string, input: Partial<BookInput>): Promise<AdminBookDto> {
  const current = await prisma.book.findUnique({ where: { id }, select: { id: true } })
  if (!current) throw new NotFoundError('Book')
  if (input.isbn !== undefined) await refuseTakenIsbn(input.isbn, id)

  try {
    // Prisma leaves a field alone when it is undefined, and sets it to NULL when it is null.
    await prisma.book.update({
      where: { id },
      data: {
        isbn: input.isbn,
        title: input.title,
        author: input.author,
        genre: input.genre,
        description: input.description,
        publishedYear: input.publishedYear,
      },
    })
  } catch (error) {
    throw asDuplicateIsbn(error)
  }

  publishCatalogueChange()
  return getAdminBook(id)
}

/**
 * Adds `count` available copies, each with a barcode from the database. The
 * student-visible total is counted from the copies, so it grows with them. Then
 * the waitlist hand-off a return runs, so a student waiting for this title gets a
 * claim on a new copy straight away.
 */
export async function addCopies(bookId: string, count: number, now = new Date()): Promise<AdminBookDto> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true } })
  if (!book) throw new NotFoundError('Book')

  // One INSERT: all the copies are there, or none.
  await prisma.bookCopy.createMany({ data: Array.from({ length: count }, () => ({ bookId })) })

  try {
    await onBookReturned(bookId, now)
  } finally {
    // The copies are committed even if the hand-off failed, so the console must hear of them.
    publishCatalogueChange()
  }
  return getAdminBook(bookId)
}
