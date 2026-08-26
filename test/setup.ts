import 'dotenv/config'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to backend/.env and fill it in.')
}

// Tests must never touch the dev database. Every test file's first import of
// src/app.ts (transitively src/lib/prisma.ts) happens after Vitest's
// setupFiles run, so DATABASE_URL is already repointed at the test database
// by the time any Prisma client gets constructed.
process.env.DATABASE_URL = testUrl
