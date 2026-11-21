// The overdue fine rule, in the two places it is applied: in code, when a late
// return or renewal writes the fine and when the student app's loan line shows
// the amount so far, and in SQL, for the librarian's Fines page, which lists
// the same amount for every loan still out and past due. Keep them in step;
// test/services/fineRules.test.ts runs them against each other.
import { FINE_PER_DAY_INR } from '../config/constants'
import { Prisma } from '../generated/prisma/client'

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days past `dueAt` at `at`, times the daily rate. Nothing is owed until a full day has passed. */
export function overdueFineAmount(dueAt: Date, at: Date): number {
  const ms = at.getTime() - dueAt.getTime()
  if (ms <= 0) return 0
  return Math.floor(ms / DAY_MS) * FINE_PER_DAY_INR
}

/**
 * `overdueFineAmount(dueAt, now)` as a SQL expression (double precision), with
 * `now` and the rate as bound parameters. `dueAtColumn` must be a plain
 * `timestamp` holding UTC, as Loan.dueAt is. Prisma binds a Date as UTC
 * wall-clock text (no offset), so `now` is read as a plain `timestamp` too:
 * casting it to timestamptz would apply the session's time zone and shift the
 * answer by hours on a session that is not on UTC.
 */
export function accruingAmountSql(now: Date, dueAtColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    GREATEST(0, floor(extract(epoch from (${now}::timestamp - ${dueAtColumn})) / 86400))
    * ${FINE_PER_DAY_INR}
  )::float8`
}
