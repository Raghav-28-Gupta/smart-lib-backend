// Pins one interleaving of two writes on a booking row deterministically, the way
// test/helpers/rowLock.ts does for a fine row: the test holds the row lock, the
// action's write blocks on it, the competing change lands inside the locking
// transaction, and only when that commits does the action's write run, against the
// changed row, as if the competitor had landed just before it.
//
// A sibling of rowLock.ts rather than a change to it: that helper is typed for
// supertest responses and a FINE row, and an action here (the sweep, a check-in
// called as a function) answers a plain value or throws.
import type { Prisma } from '../../src/generated/prisma/client'
import { prisma } from '../../src/lib/prisma'

/** Polls until some other session is stuck waiting for a lock (the action under test, on the row the test holds). */
export async function waitUntilAWriterIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = await prisma.$queryRaw<[{ blocked: number }]>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (blocked > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The action never blocked on the booking row')
}

/**
 * Locks the booking row, starts `action`, waits until its write is blocked on that
 * lock, lets `competitor` change the row in the locking transaction and commits.
 * An action that read the booking first and wrote it blindly afterwards would be
 * caught: a plain read is not blocked by the lock, so it would see the old row.
 *
 * Answers how the action settled (it may refuse by throwing), never throws for it.
 */
export async function bookingLockedThenCompete<T>(
  bookingId: string,
  action: () => PromiseLike<T>,
  competitor: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<PromiseSettledResult<T>> {
  let pending: Promise<PromiseSettledResult<T>> | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ResourceBooking" WHERE id = ${bookingId} FOR UPDATE`
        pending = Promise.resolve(action()).then(
          (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
          (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
        )
        await waitUntilAWriterIsBlocked()
        await competitor(tx)
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
  } finally {
    // Never leave the action running into the next test, even when the setup failed.
    await pending
  }
  return pending!
}
