// Pins one interleaving of two writes on a fine row deterministically, the way
// test/services/fineRaces.test.ts does: the test holds the row lock, the action's
// write blocks on it, the competing change lands inside the locking transaction,
// and only when that commits does the action's write run, against the changed row,
// as if the competitor had landed just before it.
import type request from 'supertest'
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'

/** Polls until some other session is stuck waiting for a lock (the action under test, on the row the test holds). */
async function waitUntilAWriterIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the fine row')
}

/**
 * Locks the fine row, starts `action`, waits until its write is blocked on that
 * lock, lets `competitor` change the row in the locking transaction and commits.
 * An action that read the fine first and wrote it blindly afterwards would be
 * caught: a plain read is not blocked by the lock, so it would see the old row.
 */
export async function writeBlockedThenCompete(
  fineId: string,
  action: () => PromiseLike<request.Response>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<request.Response> {
  let pending: Promise<request.Response> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Fine" WHERE id = ${fineId} FOR UPDATE`
        pending = Promise.resolve(action())
        await waitUntilAWriterIsBlocked()
        await competitor(tx)
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
  } finally {
    // Never leave the request running into the next test, even when the setup failed.
    await pending
  }
  return pending!
}
