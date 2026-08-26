import cors from 'cors'
import express from 'express'
import { errorHandler } from './middleware/errorHandler'
import { authRouter } from './routes/auth'
import { healthRouter } from './routes/health'

// The Express app, separate from the listen() call in index.ts, so tests can
// mount it directly with supertest without binding a real port.
export const app = express()
app.use(cors())
app.use(express.json())

app.use(healthRouter)
app.use(authRouter)

// More route modules land here as later tasks add them — each router
// declares its own full paths (e.g. authRouter's '/auth/register'), so
// they're mounted with no prefix, same as healthRouter/authRouter above:
// app.use(booksRouter)
// app.use(loansRouter)
// ...

// Must be the LAST app.use() — Express walks middleware in registration
// order, and an error handler earlier in the chain can't catch errors thrown
// by routes registered after it.
app.use(errorHandler)
