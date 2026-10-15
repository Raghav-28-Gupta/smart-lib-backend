import 'dotenv/config'
import { app } from './app'
import { timeZoneWarning } from './config/timezone'
import { prisma } from './lib/prisma'

const tzWarning = timeZoneWarning(process.env)
if (tzWarning) console.warn(tzWarning)

const PORT = process.env.PORT ?? 3000
const server = app.listen(PORT, () => console.log(`Node backend running on port ${PORT}`))

// Render (like Docker) stops the old instance with SIGTERM on every deploy.
// Finish in-flight requests and release the database connections, rather
// than dropping both mid-request; give up after 10s if a connection lingers.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`)
    setTimeout(() => process.exit(1), 10_000).unref()
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0))
    })
  })
}
