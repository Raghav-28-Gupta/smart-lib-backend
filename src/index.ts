import 'dotenv/config'
import { app } from './app'
import { timeZoneWarning } from './config/timezone'
import { closeAllLiveStreams } from './lib/liveStream'
import { prisma } from './lib/prisma'
import { runScheduledSweeps, startExpirySweep } from './services/requestHolds'

const tzWarning = timeZoneWarning(process.env)
if (tzWarning) console.warn(tzWarning)

const PORT = process.env.PORT ?? 3000
const server = app.listen(PORT, () => console.log(`Node backend running on port ${PORT}`))

// Lapses stale requests and records missed bookings now (a sleeping Render
// instance can wake with some overdue) and then every minute.
const stopExpirySweep = startExpirySweep(runScheduledSweeps)

// Render (like Docker) stops the old instance with SIGTERM on every deploy.
// Finish in-flight requests and release the database connections, rather
// than dropping both mid-request; give up after 10s if a connection lingers.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`)
    setTimeout(() => process.exit(1), 10_000).unref()
    stopExpirySweep()
    // An open console stream would hold server.close() open until its 15
    // minutes are up, and Render would kill the process mid-shutdown.
    closeAllLiveStreams()
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0))
    })
  })
}
