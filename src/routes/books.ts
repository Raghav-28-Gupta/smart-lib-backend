import { Router } from 'express'
import { validate } from '../middleware/validate'
import { bookIdParamsSchema, bookSearchQuerySchema } from '../schemas/books'
import { getBookById, searchBooks } from '../services/bookService'

export const booksRouter = Router()

booksRouter.get('/books/search', validate({ query: bookSearchQuerySchema }), async (req, res) => {
  const { q, genre } = req.validatedQuery as { q?: string; genre?: string }
  res.json(await searchBooks({ q, genre }))
})

booksRouter.get('/books/:id', validate({ params: bookIdParamsSchema }), async (req, res) => {
  // validate() already replaced req.params with bookIdParamsSchema's parsed
  // output at runtime; Express's own route-string type inference doesn't
  // know that, so it still types :id as string | string[].
  const { id } = req.params as { id: string }
  res.json(await getBookById(id))
})
