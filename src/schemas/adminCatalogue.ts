import { z } from 'zod'

export const MAX_BOOK_PAGE_SIZE = 100
export const MAX_BOOK_SEARCH_LENGTH = 100
export const MAX_COPIES_PER_REQUEST = 20

// A cap that no real list reaches, so a huge page number is a 400 and never
// an OFFSET that overflows the database's integer.
const MAX_BOOK_PAGE = 100_000

const MIN_PUBLISHED_YEAR = 1450

export const adminBooksQuerySchema = z.object({
  // Trimmed before the length check; a search of only spaces comes out empty,
  // which the service ignores.
  search: z.string().trim().max(MAX_BOOK_SEARCH_LENGTH).optional(),
  page: z.coerce.number().int().min(1).max(MAX_BOOK_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_BOOK_PAGE_SIZE).default(25),
})

export const adminBookParamsSchema = z.object({ id: z.string().min(1) })

// No checksum on the ISBN: the seed's ISBNs are placeholders.
const isbn = z.string().trim().min(1).max(20)
const title = z.string().trim().min(1).max(200)
const author = z.string().trim().min(1).max(200)
const genre = z.string().trim().min(1).max(50)
// A blank description means none, so the console can clear the field.
const description = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => (value === '' ? null : value))
// The upper bound is the year it is now, read per request, not when the server started.
const publishedYear = z
  .number()
  .int()
  .min(MIN_PUBLISHED_YEAR)
  .refine((year) => year <= new Date().getFullYear(), { message: 'The year cannot be in the future' })
const copies = z.number().int().min(1).max(MAX_COPIES_PER_REQUEST)

export const createBookSchema = z.object({
  isbn,
  title,
  author,
  genre,
  description: description.nullish(),
  publishedYear: publishedYear.nullish(),
  copies,
})

// The same fields except copies, which have their own route: a `copies` in the
// body is not a field here, so zod drops it, and a body of only copies counts as
// no fields. The genre is required on create, so on edit it can change but not
// be blanked or cleared; `null` clears only the description and the year.
export const updateBookSchema = z
  .object({
    isbn: isbn.optional(),
    title: title.optional(),
    author: author.optional(),
    genre: genre.optional(),
    description: description.nullish(),
    publishedYear: publishedYear.nullish(),
  })
  .refine((fields) => Object.values(fields).some((value) => value !== undefined), { message: 'Send at least one field to change' })

export const addCopiesSchema = z.object({ count: copies })

export const adminCopyParamsSchema = z.object({ id: z.string().min(1) })

export const MAX_REPLACEMENT_CHARGE_INR = 10_000

// Both optional here: they are only asked for when the copy is on loan
// (adminCopyService.markCopyLost). The charge is whole rupees; the borrower is the
// student the librarian saw holding the copy.
export const markCopyLostSchema = z
  .object({
    replacementCharge: z.number().int().min(0).max(MAX_REPLACEMENT_CHARGE_INR).optional(),
    borrowerId: z.string().min(1).optional(),
  })
  .default({})

export const restoreCopySchema = z.object({ waiveReplacementCharge: z.boolean().optional() }).default({})
