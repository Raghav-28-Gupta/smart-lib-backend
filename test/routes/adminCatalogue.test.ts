import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app'
import { JWT_SECRET } from '../../src/config/constants'
import type { CopyStatus, LoanStatus } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'
import { recordEvents } from '../helpers/events'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DUPLICATE_ISBN_MESSAGE = 'A book with this ISBN is already in the catalogue.'

async function seedUser(role: 'student' | 'admin' = 'student', name = `${role} ${Math.random()}`) {
  const user = await prisma.user.create({
    data: { name, email: `${role}${Math.random()}@test.com`, passwordHash: 'x', role },
  })
  return { user, token: jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' }) }
}

interface BookSeed {
  isbn?: string
  author?: string
  genre?: string | null
  description?: string | null
  publishedYear?: number | null
}

function seedBook(title: string, extra: BookSeed = {}) {
  return prisma.book.create({
    data: {
      isbn: extra.isbn ?? `isbn-${Math.random()}`,
      title,
      author: extra.author ?? 'Some Author',
      genre: extra.genre === undefined ? 'Fiction' : extra.genre,
      description: extra.description ?? null,
      publishedYear: extra.publishedYear ?? null,
    },
  })
}

// One at a time, so the database hands out barcodes in the order the copies are made.
function seedCopy(bookId: string, status: CopyStatus = 'available') {
  return prisma.bookCopy.create({ data: { bookId, status } })
}

function seedLoan(userId: string, copyId: string, dueAt: Date, status: LoanStatus = 'active') {
  return prisma.loan.create({
    data: {
      userId,
      bookCopyId: copyId,
      dueAt,
      borrowedAt: new Date(dueAt.getTime() - 14 * DAY_MS),
      status,
      ...(status === 'returned' ? { returnedAt: new Date() } : {}),
    },
  })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const list = (token: string, query: Record<string, string | number> = {}) =>
  request(app).get('/admin/books').query(query).set(auth(token))
const create = (token: string, body: object) => request(app).post('/admin/books').set(auth(token)).send(body)
const edit = (token: string, id: string, body: object) => request(app).patch(`/admin/books/${id}`).set(auth(token)).send(body)
const addCopies = (token: string, id: string, body: object) =>
  request(app).post(`/admin/books/${id}/copies`).set(auth(token)).send(body)

function withToken(req: request.Test, token?: string): request.Test {
  return token ? req.set(auth(token)) : req
}

interface ListedCopy {
  id: string
  barcode: string
  status: string
  borrower: { id: string; name: string } | null
  dueAt: string | null
  owedReplacement: null
}

interface ListedBook {
  id: string
  isbn: string
  title: string
  author: string
  genre: string | null
  description: string | null
  publishedYear: number | null
  totalCopies: number
  availableCopies: number
  copies: ListedCopy[]
}

const titles = (res: request.Response) => (res.body.books as ListedBook[]).map((b) => b.title)

const validBook = {
  isbn: '978-0-00-000001-0',
  title: 'A New Book',
  author: 'A. Writer',
  genre: 'Fiction',
  copies: 2,
}

describe('admin catalogue', () => {
  beforeEach(resetDb)
  let recorder: ReturnType<typeof recordEvents> | undefined
  afterEach(() => {
    recorder?.stop()
    recorder = undefined
    vi.restoreAllMocks()
  })

  it('is for admins only', async () => {
    const { token: student } = await seedUser()
    const book = await seedBook('Dune')
    const calls: Array<(token?: string) => request.Test> = [
      (token) => withToken(request(app).get('/admin/books'), token),
      (token) => withToken(request(app).post('/admin/books'), token).send(validBook),
      (token) => withToken(request(app).patch(`/admin/books/${book.id}`), token).send({ title: 'Changed' }),
      (token) => withToken(request(app).post(`/admin/books/${book.id}/copies`), token).send({ count: 2 }),
    ]

    for (const call of calls) {
      expect((await call()).status).toBe(401)
      expect((await call(student)).status).toBe(403)
    }
    // Nothing was written by any of the refused calls.
    expect(await prisma.book.count()).toBe(1)
    expect(await prisma.bookCopy.count()).toBe(0)
    expect((await prisma.book.findUniqueOrThrow({ where: { id: book.id } })).title).toBe('Dune')
  })

  describe('list', () => {
    it('lists books in title order with copies, barcodes, statuses, borrower and due date', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: asha } = await seedUser('student', 'Asha Rao')
      const { user: bob } = await seedUser('student', 'Bob Iyer')
      // Made out of title order, so the order in the answer is the list's own.
      const zen = await seedBook('Zen and the Art', { isbn: 'isbn-zen' })
      const algorithms = await seedBook('Algorithms', {
        isbn: '978-0-262-03384-8',
        author: 'Cormen',
        genre: 'Computer Science',
        description: 'The classic.',
        publishedYear: 2009,
      })
      const shelf = await seedCopy(algorithms.id, 'available')
      const out = await seedCopy(algorithms.id, 'borrowed')
      const repair = await seedCopy(algorithms.id, 'maintenance')
      const gone = await seedCopy(algorithms.id, 'lost')
      const dueAt = new Date(Date.now() + 5 * DAY_MS)
      await seedLoan(asha.id, out.id, dueAt)
      // A loan that has ended makes nobody the shelf copy's borrower.
      await seedLoan(bob.id, shelf.id, new Date(Date.now() - 3 * DAY_MS), 'returned')

      const res = await list(admin)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        books: [
          {
            id: algorithms.id,
            isbn: '978-0-262-03384-8',
            title: 'Algorithms',
            author: 'Cormen',
            genre: 'Computer Science',
            description: 'The classic.',
            publishedYear: 2009,
            totalCopies: 3,
            availableCopies: 1,
            copies: [
              { id: shelf.id, barcode: shelf.barcode, status: 'available', borrower: null, dueAt: null, owedReplacement: null },
              {
                id: out.id,
                barcode: out.barcode,
                status: 'on_loan',
                borrower: { id: asha.id, name: 'Asha Rao' },
                dueAt: dueAt.toISOString(),
                owedReplacement: null,
              },
              { id: repair.id, barcode: repair.barcode, status: 'maintenance', borrower: null, dueAt: null, owedReplacement: null },
              { id: gone.id, barcode: gone.barcode, status: 'lost', borrower: null, dueAt: null, owedReplacement: null },
            ],
          },
          {
            id: zen.id,
            isbn: 'isbn-zen',
            title: 'Zen and the Art',
            author: 'Some Author',
            genre: 'Fiction',
            description: null,
            publishedYear: null,
            totalCopies: 0,
            availableCopies: 0,
            copies: [],
          },
        ],
        total: 2,
        page: 1,
        pageSize: 25,
        genres: ['Computer Science', 'Fiction'],
      })
      // Barcodes are SL-00001 and up, in the order the copies were made.
      const barcodes = (res.body.books as ListedBook[])[0].copies.map((c) => c.barcode)
      expect(barcodes).toEqual([...barcodes].sort())
      expect(new Set(barcodes).size).toBe(4)
      expect(barcodes.every((b) => /^SL-\d{5}$/.test(b))).toBe(true)
    })

    it('a requested copy is held and a borrowed copy without a loan is on loan with no borrower', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const requested = await seedCopy(book.id, 'requested')
      const borrowed = await seedCopy(book.id, 'borrowed')

      const res = await list(admin)

      const [listed] = res.body.books as ListedBook[]
      expect(listed.copies).toEqual([
        { id: requested.id, barcode: requested.barcode, status: 'held', borrower: null, dueAt: null, owedReplacement: null },
        { id: borrowed.id, barcode: borrowed.barcode, status: 'on_loan', borrower: null, dueAt: null, owedReplacement: null },
      ])
      // Neither is on the shelf; both are still the library's.
      expect(listed.totalCopies).toBe(2)
      expect(listed.availableCopies).toBe(0)
    })

    it('search by title, author, ISBN and barcode', async () => {
      const { token: admin } = await seedUser('admin')
      const clean = await seedBook('Clean Code', { author: 'Robert Martin', isbn: '9780132350884' })
      const dune = await seedBook('Dune', { author: 'Frank Herbert', isbn: '9780441172719' })
      const emma = await seedBook('Emma', { author: 'Jane Austen', isbn: 'isbn-emma' })
      await seedCopy(clean.id)
      await seedCopy(dune.id)
      const emmaCopy = await seedCopy(emma.id)
      await seedCopy(emma.id)

      expect(titles(await list(admin, { search: 'clean' }))).toEqual(['Clean Code'])
      expect(titles(await list(admin, { search: 'HERBERT' }))).toEqual(['Dune'])
      expect(titles(await list(admin, { search: '0132350' }))).toEqual(['Clean Code'])
      expect(titles(await list(admin, { search: emmaCopy.barcode.toLowerCase() }))).toEqual(['Emma'])
      expect(titles(await list(admin, { search: 'nothing like this' }))).toEqual([])

      // Several copies of one book match "SL-": the book is listed once, and counted once.
      const byBarcodePrefix = await list(admin, { search: 'SL-' })
      expect(titles(byBarcodePrefix)).toEqual(['Clean Code', 'Dune', 'Emma'])
      expect(byBarcodePrefix.body.total).toBe(3)
      expect((byBarcodePrefix.body.books as ListedBook[])[2].copies).toHaveLength(2)
      // A search of title, author and so on shows each book whole, not just the copies that matched.
      const narrowed = await list(admin, { search: emmaCopy.barcode })
      expect((narrowed.body.books as ListedBook[])[0].copies).toHaveLength(2)

      // The search is trimmed, and capped at 100 characters.
      expect(titles(await list(admin, { search: '  dune  ' }))).toEqual(['Dune'])
      expect((await list(admin, { search: 'x'.repeat(101) })).status).toBe(400)
    })

    it('search treats % and _ literally', async () => {
      const { token: admin } = await seedUser('admin')
      await seedBook('Fifty % Off')
      await seedBook('Under_Score')
      await seedBook('Back\\slash')
      await seedBook('Plain Book')

      expect(titles(await list(admin, { search: '%' }))).toEqual(['Fifty % Off'])
      expect(titles(await list(admin, { search: '_' }))).toEqual(['Under_Score'])
      expect(titles(await list(admin, { search: '\\' }))).toEqual(['Back\\slash'])
      // As wildcards these would match "Under_Score" and "Plain Book".
      expect(titles(await list(admin, { search: 'd_r' }))).toEqual([])
      expect(titles(await list(admin, { search: 'P%k' }))).toEqual([])
    })

    it('a quote is safe', async () => {
      const { token: admin } = await seedUser('admin')
      await seedBook("The O'Brien Affair")
      await seedBook('Other')

      expect(titles(await list(admin, { search: "O'Brien" }))).toEqual(["The O'Brien Affair"])
      const injection = await list(admin, { search: `'; DROP TABLE "Book"; --` })
      expect(injection.status).toBe(200)
      expect(titles(injection)).toEqual([])
      expect(await prisma.book.count()).toBe(2)
    })

    it('only spaces is ignored', async () => {
      const { token: admin } = await seedUser('admin')
      await seedBook('Alpha')
      await seedBook('Beta')

      const res = await list(admin, { search: '   ' })

      expect(res.status).toBe(200)
      expect(titles(res)).toEqual(['Alpha', 'Beta'])
      expect(res.body.total).toBe(2)
    })

    it('pages', async () => {
      const { token: admin } = await seedUser('admin')
      for (const letter of ['E', 'C', 'A', 'D', 'B']) await seedBook(`Book ${letter}`)

      const first = await list(admin, { pageSize: 2 })
      const second = await list(admin, { pageSize: 2, page: 2 })
      const third = await list(admin, { pageSize: 2, page: 3 })
      const past = await list(admin, { pageSize: 2, page: 4 })

      expect(titles(first)).toEqual(['Book A', 'Book B'])
      expect(titles(second)).toEqual(['Book C', 'Book D'])
      expect(titles(third)).toEqual(['Book E'])
      for (const res of [first, second, third, past]) expect(res.body.total).toBe(5)
      expect(first.body).toMatchObject({ page: 1, pageSize: 2 })
      expect(second.body).toMatchObject({ page: 2, pageSize: 2 })
      // A page past the end is empty but still says how many books there are.
      expect(past.body).toMatchObject({ books: [], total: 5, page: 4, pageSize: 2 })

      // Twenty-five a page unless asked otherwise, at most a hundred.
      expect((await list(admin)).body).toMatchObject({ page: 1, pageSize: 25 })
      expect((await list(admin, { pageSize: 100 })).status).toBe(200)
      expect((await list(admin, { pageSize: 101 })).status).toBe(400)
      expect((await list(admin, { pageSize: 0 })).status).toBe(400)
      expect((await list(admin, { page: 0 })).status).toBe(400)
    })

    it('genres lists each genre once, sorted', async () => {
      const { token: admin } = await seedUser('admin')
      await seedBook('One', { genre: 'Fiction' })
      await seedBook('Two', { genre: 'Algorithms' })
      await seedBook('Three', { genre: 'Fiction' })
      await seedBook('Four', { genre: null })
      await seedBook('Five', { genre: 'Biography' })

      const res = await list(admin)
      // Genres in use across the whole catalogue, not just the books on this page or in this search.
      const narrowed = await list(admin, { search: 'Four' })
      const secondPage = await list(admin, { pageSize: 1, page: 2 })

      expect(res.body.genres).toEqual(['Algorithms', 'Biography', 'Fiction'])
      expect(narrowed.body.genres).toEqual(['Algorithms', 'Biography', 'Fiction'])
      expect(secondPage.body.genres).toEqual(['Algorithms', 'Biography', 'Fiction'])
    })
  })

  describe('create', () => {
    it('creates a book with three copies and barcodes', async () => {
      const { token: admin } = await seedUser('admin')

      const res = await create(admin, {
        isbn: '  978-1-23-456789-0  ',
        title: '  Refactoring  ',
        author: ' Martin Fowler ',
        genre: ' Software ',
        description: 'Improving the design of existing code.',
        publishedYear: 2018,
        copies: 3,
      })

      expect(res.status).toBe(201)
      const book = res.body as ListedBook
      expect(book).toMatchObject({
        isbn: '978-1-23-456789-0',
        title: 'Refactoring',
        author: 'Martin Fowler',
        genre: 'Software',
        description: 'Improving the design of existing code.',
        publishedYear: 2018,
        totalCopies: 3,
        availableCopies: 3,
      })
      expect(book.copies).toHaveLength(3)
      expect(book.copies.every((c) => c.status === 'available' && c.borrower === null && c.dueAt === null)).toBe(true)
      const barcodes = book.copies.map((c) => c.barcode)
      expect(new Set(barcodes).size).toBe(3)
      expect(barcodes.every((b) => /^SL-\d{5}$/.test(b))).toBe(true)
      expect(barcodes).toEqual([...barcodes].sort())

      const stored = await prisma.book.findUniqueOrThrow({ where: { id: book.id }, include: { copies: true } })
      expect(stored.copies).toHaveLength(3)
      // The stored column is no longer read, but is set to the copies made.
      expect(stored.totalCopies).toBe(3)
    })

    it('leaves the description and year empty when they are not sent', async () => {
      const { token: admin } = await seedUser('admin')

      const res = await create(admin, validBook)

      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ description: null, publishedYear: null, totalCopies: 2 })
    })

    it('rejects a missing ISBN, a 21-character ISBN, a blank title, a missing genre on create, year 1449 and next year, 0 and 21 copies', async () => {
      const { token: admin } = await seedUser('admin')
      const nextYear = new Date().getFullYear() + 1
      const { isbn: _isbn, ...withoutIsbn } = validBook
      const { genre: _genre, ...withoutGenre } = validBook
      const { copies: _copies, ...withoutCopies } = validBook
      const bad: Array<[string, object]> = [
        ['missing ISBN', withoutIsbn],
        ['blank ISBN', { ...validBook, isbn: '   ' }],
        ['21-character ISBN', { ...validBook, isbn: 'x'.repeat(21) }],
        ['blank title', { ...validBook, title: '   ' }],
        ['201-character title', { ...validBook, title: 'x'.repeat(201) }],
        ['blank author', { ...validBook, author: '' }],
        ['201-character author', { ...validBook, author: 'x'.repeat(201) }],
        ['missing genre', withoutGenre],
        ['blank genre', { ...validBook, genre: '  ' }],
        ['51-character genre', { ...validBook, genre: 'x'.repeat(51) }],
        ['2001-character description', { ...validBook, description: 'x'.repeat(2001) }],
        ['year 1449', { ...validBook, publishedYear: 1449 }],
        ['next year', { ...validBook, publishedYear: nextYear }],
        ['fractional year', { ...validBook, publishedYear: 2000.5 }],
        ['text year', { ...validBook, publishedYear: '2000' }],
        ['0 copies', { ...validBook, copies: 0 }],
        ['21 copies', { ...validBook, copies: 21 }],
        ['fractional copies', { ...validBook, copies: 1.5 }],
        ['missing copies', withoutCopies],
      ]

      for (const [label, body] of bad) {
        const res = await create(admin, body)
        expect(res.status, label).toBe(400)
      }
      expect(await prisma.book.count()).toBe(0)
      expect(await prisma.bookCopy.count()).toBe(0)
    })

    it('accepts the edge of every limit', async () => {
      const { token: admin } = await seedUser('admin')

      const smallest = await create(admin, {
        isbn: 'x',
        title: 'x',
        author: 'x',
        genre: 'x',
        publishedYear: 1450,
        copies: 1,
      })
      const largest = await create(admin, {
        isbn: 'y'.repeat(20),
        title: 'y'.repeat(200),
        author: 'y'.repeat(200),
        genre: 'y'.repeat(50),
        description: 'y'.repeat(2000),
        publishedYear: new Date().getFullYear(),
        copies: 20,
      })

      expect(smallest.status).toBe(201)
      expect(largest.status).toBe(201)
      expect((largest.body as ListedBook).copies).toHaveLength(20)
    })

    it('a duplicate ISBN is 409 with the message, on create and on edit', async () => {
      const { token: admin } = await seedUser('admin')
      const existing = await seedBook('Existing', { isbn: '978-DUP' })
      const other = await seedBook('Other', { isbn: '978-OTHER' })

      const onCreate = await create(admin, { ...validBook, isbn: ' 978-DUP ' })
      const onEdit = await edit(admin, other.id, { isbn: '978-DUP' })
      // Keeping its own ISBN is not a clash.
      const own = await edit(admin, existing.id, { isbn: '978-DUP', title: 'Existing, 2nd ed.' })

      expect(onCreate.status).toBe(409)
      expect(onCreate.body).toEqual({ error: DUPLICATE_ISBN_MESSAGE })
      expect(onEdit.status).toBe(409)
      expect(onEdit.body).toEqual({ error: DUPLICATE_ISBN_MESSAGE })
      expect(own.status).toBe(200)
      // The refused create left no book and no copies behind; the refused edit changed nothing.
      expect(await prisma.book.count()).toBe(2)
      expect(await prisma.bookCopy.count()).toBe(0)
      expect((await prisma.book.findUniqueOrThrow({ where: { id: other.id } })).isbn).toBe('978-OTHER')
    })

    it('a duplicate ISBN that slips past the check is still 409 with the message', async () => {
      const { token: admin } = await seedUser('admin')
      await seedBook('Existing', { isbn: '978-RACE' })
      const other = await seedBook('Other', { isbn: '978-OTHER' })
      recorder = recordEvents()

      // As if the other book was added between the check and the write.
      vi.spyOn(prisma.book, 'findFirst').mockResolvedValueOnce(null)
      const onCreate = await create(admin, { ...validBook, isbn: '978-RACE' })
      vi.spyOn(prisma.book, 'findFirst').mockResolvedValueOnce(null)
      const onEdit = await edit(admin, other.id, { isbn: '978-RACE' })

      expect(onCreate.status).toBe(409)
      expect(onCreate.body).toEqual({ error: DUPLICATE_ISBN_MESSAGE })
      expect(onEdit.status).toBe(409)
      expect(onEdit.body).toEqual({ error: DUPLICATE_ISBN_MESSAGE })
      expect(await prisma.book.count()).toBe(2)
      expect(await prisma.bookCopy.count()).toBe(0)
      expect(recorder.events).toEqual([])
    })
  })

  describe('edit', () => {
    it('edits fields and clears description and year with null', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Old Title', {
        isbn: '978-OLD',
        author: 'Old Author',
        genre: 'Fiction',
        description: 'Old description',
        publishedYear: 1990,
      })
      const copy = await seedCopy(book.id)

      const cleared = await edit(admin, book.id, { title: '  New Title  ', description: null, publishedYear: null })

      expect(cleared.status).toBe(200)
      expect(cleared.body).toMatchObject({
        id: book.id,
        isbn: '978-OLD',
        title: 'New Title',
        author: 'Old Author',
        genre: 'Fiction',
        description: null,
        publishedYear: null,
        totalCopies: 1,
        availableCopies: 1,
      })
      expect((cleared.body as ListedBook).copies.map((c) => c.id)).toEqual([copy.id])

      const changed = await edit(admin, book.id, {
        isbn: ' 978-NEW ',
        author: 'New Author',
        genre: 'Poetry',
        description: 'New description',
        publishedYear: 1999,
      })

      expect(changed.status).toBe(200)
      expect(changed.body).toMatchObject({
        isbn: '978-NEW',
        title: 'New Title',
        author: 'New Author',
        genre: 'Poetry',
        description: 'New description',
        publishedYear: 1999,
      })
      const stored = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
      expect(stored).toMatchObject({ isbn: '978-NEW', title: 'New Title', genre: 'Poetry', description: 'New description', publishedYear: 1999 })
    })

    it('PATCH with no fields is 400', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune', { genre: 'Science Fiction' })
      const nextYear = new Date().getFullYear() + 1

      const bad: Array<[string, object]> = [
        ['empty body', {}],
        // The copies are added on their own route, so a PATCH of only copies changes no field.
        ['only copies', { copies: 5 }],
        ['blank genre', { genre: '   ' }],
        ['blank ISBN', { isbn: '' }],
        ['21-character ISBN', { isbn: 'x'.repeat(21) }],
        ['blank title', { title: ' ' }],
        ['blank author', { author: ' ' }],
        ['51-character genre', { genre: 'x'.repeat(51) }],
        ['null genre', { genre: null }],
        ['year 1449', { publishedYear: 1449 }],
        ['next year', { publishedYear: nextYear }],
        ['2001-character description', { description: 'x'.repeat(2001) }],
      ]

      for (const [label, body] of bad) {
        const res = await edit(admin, book.id, body)
        expect(res.status, label).toBe(400)
      }
      const stored = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
      expect(stored).toMatchObject({ title: 'Dune', genre: 'Science Fiction' })
    })
  })

  describe('add copies', () => {
    it('adds copies and the student-visible total grows', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')
      const first = await seedCopy(book.id, 'available')
      await seedCopy(book.id, 'lost')
      expect((await request(app).get(`/books/${book.id}`)).body).toMatchObject({ totalCopies: 1, availableCopies: 1 })

      const res = await addCopies(admin, book.id, { count: 2 })

      expect(res.status).toBe(200)
      const listed = res.body as ListedBook
      expect(listed.id).toBe(book.id)
      // The lost copy is still listed for the librarian but is not counted for students.
      expect(listed.copies).toHaveLength(4)
      expect(listed.totalCopies).toBe(3)
      expect(listed.availableCopies).toBe(3)
      const added = listed.copies.slice(2)
      expect(added.every((c) => c.status === 'available')).toBe(true)
      const barcodes = listed.copies.map((c) => c.barcode)
      expect(new Set(barcodes).size).toBe(4)
      expect(barcodes).toEqual([...barcodes].sort())
      expect(listed.copies[0].id).toBe(first.id)
      expect((await request(app).get(`/books/${book.id}`)).body).toMatchObject({ totalCopies: 3, availableCopies: 3 })
      expect(await prisma.bookCopy.count({ where: { bookId: book.id } })).toBe(4)
    })

    it('rejects a count of 0, 21, a fraction or text', async () => {
      const { token: admin } = await seedUser('admin')
      const book = await seedBook('Dune')

      for (const body of [{ count: 0 }, { count: 21 }, { count: 1.5 }, { count: '2' }, {}]) {
        expect((await addCopies(admin, book.id, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect((await addCopies(admin, book.id, { count: 20 })).status).toBe(200)
      expect(await prisma.bookCopy.count({ where: { bookId: book.id } })).toBe(20)
    })

    it('adding a copy to a waitlisted title gives the first waiting student a claim', async () => {
      const { token: admin } = await seedUser('admin')
      const { user: first } = await seedUser('student', 'First in line')
      const { user: second } = await seedUser('student', 'Second in line')
      const book = await seedBook('Dune')
      await seedCopy(book.id, 'borrowed')
      const firstWait = await prisma.reservation.create({
        data: { userId: first.id, bookId: book.id, requestedAt: new Date(Date.now() - 2 * HOUR_MS) },
      })
      const secondWait = await prisma.reservation.create({
        data: { userId: second.id, bookId: book.id, requestedAt: new Date(Date.now() - HOUR_MS) },
      })
      const before = Date.now()

      const res = await addCopies(admin, book.id, { count: 1 })

      expect(res.status).toBe(200)
      const claimed = await prisma.reservation.findUniqueOrThrow({ where: { id: firstWait.id } })
      expect(claimed.status).toBe('fulfilled')
      expect(claimed.claimExpiresAt!.getTime()).toBeGreaterThan(before)
      // One copy, one claim: the second student keeps waiting.
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: secondWait.id } })).status).toBe('waiting')

      await addCopies(admin, book.id, { count: 1 })

      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: secondWait.id } })).status).toBe('fulfilled')
    })
  })

  it('unknown id is 404', async () => {
    const { token: admin } = await seedUser('admin')
    recorder = recordEvents()

    const onEdit = await edit(admin, 'no-such-book', { title: 'Changed' })
    const onCopies = await addCopies(admin, 'no-such-book', { count: 2 })

    expect(onEdit.status).toBe(404)
    expect(onEdit.body).toEqual({ error: 'Book not found' })
    expect(onCopies.status).toBe(404)
    expect(onCopies.body).toEqual({ error: 'Book not found' })
    expect(await prisma.bookCopy.count()).toBe(0)
    expect(recorder.events).toEqual([])
  })

  it('each write publishes catalogue.changed once, refusals publish nothing', async () => {
    const { token: admin } = await seedUser('admin')
    const { token: student } = await seedUser()
    const { user: waiting } = await seedUser('student', 'Waiting')
    const taken = await seedBook('Taken', { isbn: '978-TAKEN' })
    const waitlisted = await seedBook('Waitlisted')
    await seedCopy(waitlisted.id, 'borrowed')
    await prisma.reservation.create({ data: { userId: waiting.id, bookId: waitlisted.id } })
    const changed = { type: 'catalogue.changed', topics: ['catalogue'] }
    recorder = recordEvents()

    const created = await create(admin, validBook)
    expect(created.status).toBe(201)
    expect(recorder.events).toEqual([changed])

    const edited = await edit(admin, (created.body as ListedBook).id, { title: 'Renamed' })
    expect(edited.status).toBe(200)
    expect(recorder.events).toEqual([changed, changed])

    const added = await addCopies(admin, (created.body as ListedBook).id, { count: 2 })
    expect(added.status).toBe(200)
    expect(recorder.events).toEqual([changed, changed, changed])

    // The waitlist hand-off that follows a new copy is part of the same single event.
    const claimed = await addCopies(admin, waitlisted.id, { count: 1 })
    expect(claimed.status).toBe(200)
    expect(recorder.events).toHaveLength(4)

    // Reading the list is not a change.
    await list(admin)
    expect(recorder.events).toHaveLength(4)

    // Refusals: a bad body, a duplicate ISBN, an unknown id, no token, a student.
    const refused = [
      await create(admin, { ...validBook, isbn: '' }),
      await create(admin, { ...validBook, isbn: '978-TAKEN' }),
      await edit(admin, taken.id, { isbn: '978-TAKEN-2', genre: '' }),
      await edit(admin, (created.body as ListedBook).id, { isbn: '978-TAKEN' }),
      await edit(admin, (created.body as ListedBook).id, {}),
      await edit(admin, 'no-such-book', { title: 'x' }),
      await addCopies(admin, (created.body as ListedBook).id, { count: 21 }),
      await addCopies(admin, 'no-such-book', { count: 1 }),
      await request(app).post('/admin/books').send(validBook),
      await create(student, validBook),
    ]
    expect(refused.map((r) => r.status)).toEqual([400, 409, 400, 409, 400, 404, 400, 404, 401, 403])
    expect(recorder.events).toHaveLength(4)
  })
})
