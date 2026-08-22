import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to backend/.env and fill it in.')
}

// Prisma 7 talks to Postgres through a driver adapter rather than its own
// query engine binary. `pg` handles Neon's required SSL from the connection
// string's `sslmode=require`.
const adapter = new PrismaPg({ connectionString })

// A single client for the whole process. `tsx watch` reloads the module graph
// on every save, so we stash the instance on globalThis to avoid leaking a new
// connection pool per reload in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
