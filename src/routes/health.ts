import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { checkAiBackendHealth } from '../lib/aiClient'

export const healthRouter = Router()

healthRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'node-backend' })
})

// Proves the Node -> Postgres link. Phase 1 only needs the connection to answer.
healthRouter.get('/health/db', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', service: 'postgres' })
  } catch (err) {
    res.status(502).json({ status: 'error', service: 'postgres', error: reason(err) })
  }
})

// Proves the Node -> FastAPI link.
healthRouter.get('/health/ai', async (req, res) => {
  try {
    res.json(await checkAiBackendHealth())
  } catch (err) {
    res.status(502).json({ status: 'error', service: 'ai-backend', error: reason(err) })
  }
})

// Health checks are the first thing anyone runs when setup breaks, so surface
// why it failed instead of a generic "unreachable".
function reason(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause?.code
  if (cause) return cause
  return err instanceof Error ? err.message : String(err)
}
