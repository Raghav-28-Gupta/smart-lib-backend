import cors from 'cors'
import express from 'express'
import { errorHandler } from './middleware/errorHandler'
import { healthRouter } from './routes/health'

// The Express app, separate from the listen() call in index.ts, so tests can
// mount it directly with supertest without binding a real port.
export const app = express()
app.use(cors())
app.use(express.json())

app.use(healthRouter)

// Route modules land here as later tasks add them:
// app.use('/auth', authRouter)
// app.use('/books', booksRouter)
// ...

// Must be the LAST app.use() — Express walks middleware in registration
// order, and an error handler earlier in the chain can't catch errors thrown
// by routes registered after it.
app.use(errorHandler)
