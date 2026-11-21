import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { resetDb } from '../helpers/db'

async function seedBook(title = 'Clean Code') {
  return prisma.book.create({ data: { isbn: `isbn-${Math.random()}`, title, author: 'Robert C. Martin' } })
}

// A copy is created without naming a barcode: the database hands the next one
// out, so every way of adding a copy (the console, the seed, a script) gets one.
describe('copy barcodes', () => {
  beforeEach(resetDb)
  // The last test moves the shared sequence; leave it back at its start.
  afterAll(resetDb)

  it('a new copy gets SL-00001, the next SL-00002', async () => {
    const book = await seedBook()

    const first = await prisma.bookCopy.create({ data: { bookId: book.id } })
    const second = await prisma.bookCopy.create({ data: { bookId: book.id } })

    expect(first.barcode).toBe('SL-00001')
    expect(second.barcode).toBe('SL-00002')
  })

  it('barcodes are unique', async () => {
    const book = await seedBook()

    // Copies added at the same moment, one by one and in bulk, never share a barcode.
    await Promise.all([
      ...Array.from({ length: 5 }, () => prisma.bookCopy.create({ data: { bookId: book.id } })),
      prisma.bookCopy.createMany({ data: Array.from({ length: 5 }, () => ({ bookId: book.id })) }),
    ])

    const copies = await prisma.bookCopy.findMany({ select: { barcode: true } })
    expect(copies).toHaveLength(10)
    expect(new Set(copies.map((c) => c.barcode)).size).toBe(10)

    // And the column itself refuses a repeat, so a hand-typed barcode cannot clash.
    await expect(prisma.bookCopy.create({ data: { bookId: book.id, barcode: copies[0].barcode } })).rejects.toThrow()
  })

  it('keeps counting past five digits instead of wrapping', async () => {
    const book = await seedBook()
    await prisma.$executeRawUnsafe(`SELECT setval('"BookCopy_barcode_seq"', 99998)`)

    const copies = []
    for (let i = 0; i < 3; i++) copies.push(await prisma.bookCopy.create({ data: { bookId: book.id } }))

    expect(copies.map((c) => c.barcode)).toEqual(['SL-99999', 'SL-100000', 'SL-100001'])
  })
})
