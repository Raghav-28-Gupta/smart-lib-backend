import cors from 'cors'
import express from 'express'
import { errorHandler } from './middleware/errorHandler'
import { authRouter } from './routes/auth'
import { booksRouter } from './routes/books'
import { healthRouter } from './routes/health'
import { loansRouter } from './routes/loans'
import { reservationsRouter } from './routes/reservations'
import { bookingsRouter } from './routes/bookings'
import { profileRouter } from './routes/profile'
import { recommendationsRouter } from './routes/recommendations'
import { resourcesRouter } from './routes/resources'

// The Express app, separate from the listen() call in index.ts, so tests can
// mount it directly with supertest without binding a real port.
export const app = express()
app.use(cors())
app.use(express.json())

app.use(healthRouter)
app.use(authRouter)
app.use(booksRouter)
app.use(loansRouter)
app.use(reservationsRouter)
app.use(resourcesRouter)
app.use(bookingsRouter)
app.use(profileRouter)
app.use(recommendationsRouter)

// More route modules land here as later tasks add them — each router
// declares its own full paths (e.g. authRouter's '/auth/register'), so
// they're mounted with no prefix, same as the routers above.

// Must be the LAST app.use() — Express walks middleware in registration
// order, and an error handler earlier in the chain can't catch errors thrown
// by routes registered after it.
app.use(errorHandler)
