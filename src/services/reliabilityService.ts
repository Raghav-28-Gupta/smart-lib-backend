import { RELIABILITY_ONTIME_BOOKING_BONUS } from '../config/constants'
import type { Prisma } from '../generated/prisma/client'
import { NotFoundError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

const HISTORY_LIMIT = 8

// [ARBITRARY — flagged, same status as the tier thresholds in bookService's
// fine rate] The team hasn't agreed on real tier bands; these make the
// presentation layer concrete and testable.
const GOOD_STANDING_THRESHOLD = 80
const BUILDING_BACK_UP_THRESHOLD = 50
const NEEDS_IMPROVEMENT_THRESHOLD = 25

export interface ReliabilityDto {
  score: number
  tier: string
  ringFraction: number
  note: string
  history: ('ok' | 'miss')[]
}

export function tierFor(score: number): string {
  if (score >= GOOD_STANDING_THRESHOLD) return 'Good standing'
  if (score >= BUILDING_BACK_UP_THRESHOLD) return 'Building back up'
  if (score >= NEEDS_IMPROVEMENT_THRESHOLD) return 'Needs improvement'
  return 'At risk'
}

// What adminStudentService.adjustReliability prefixes a librarian's reason with.
const LIBRARY_ADJUSTMENT_PREFIX = 'Library adjustment: '

// `latestIsMiss` is whether the newest log entry overall is that miss, so a later
// check-in or positive adjustment stops the note repeating it.
function buildNote(score: number, mostRecentMiss: { reason: string } | undefined, latestIsMiss: boolean): string {
  if (!mostRecentMiss || score >= GOOD_STANDING_THRESHOLD) {
    // A typical library adjustment (-10 from 100) leaves the student in Good standing: the
    // reason is still shown, with no way back to spell out. Any other miss is not, as before.
    if (mostRecentMiss && latestIsMiss && mostRecentMiss.reason.startsWith(LIBRARY_ADJUSTMENT_PREFIX)) {
      return `Your reliability score recently dropped: ${mostRecentMiss.reason}.`
    }
    return 'No missed bookings yet. Reliability reflects your booking history over time, and can lightly affect priority access to high-demand resources during busy periods.'
  }
  const pointsNeeded = Math.max(0, GOOD_STANDING_THRESHOLD - score)
  const checkInsNeeded = Math.ceil(pointsNeeded / RELIABILITY_ONTIME_BOOKING_BONUS)
  const plural = checkInsNeeded === 1 ? 'booking' : 'bookings'
  return `Your reliability score recently dropped: ${mostRecentMiss.reason}. Complete ${checkInsNeeded} more on-time ${plural} to return to Good standing.`
}

export async function getReliability(userId: string): Promise<ReliabilityDto> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const logs = await prisma.reliabilityScoreLog.findMany({
    where: { userId },
    orderBy: { computedAt: 'desc' },
    take: HISTORY_LIMIT,
  })
  const mostRecentMiss = logs.find((l) => l.delta < 0)

  return {
    score: user.reliabilityScore,
    tier: tierFor(user.reliabilityScore),
    ringFraction: Math.max(0, Math.min(1, user.reliabilityScore / 100)),
    note: buildNote(user.reliabilityScore, mostRecentMiss, mostRecentMiss !== undefined && mostRecentMiss === logs[0]),
    history: [...logs].reverse().map((l) => (l.delta < 0 ? 'miss' : 'ok')),
  }
}

// Shared by every flow that changes a score (an on-time booking check-in, a
// librarian's manual adjustment): clamps to [0, 100] and records the log entry
// that getReliability's history/note read back, with the librarian's id for a
// manual one. Takes a transaction client so the update lands atomically with
// whatever triggered it, and locks the student's row FIRST: the score is read
// from the locked row, so two changes landing at once queue up and the second
// builds on the first instead of both writing from the same old score. Returns
// what was actually applied after the clamp (0 when the score was already at
// the limit) and the new score; the caller decides whether a no-op is an error.
export async function applyReliabilityDelta(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  adjustedById?: string,
): Promise<{ appliedDelta: number; score: number }> {
  const [user] = await tx.$queryRaw<{ reliabilityScore: number }[]>`
    SELECT "reliabilityScore" FROM "User" WHERE id = ${userId} FOR UPDATE`
  if (!user) throw new NotFoundError('User')

  const score = Math.max(0, Math.min(100, user.reliabilityScore + delta))
  const appliedDelta = score - user.reliabilityScore

  await tx.user.update({ where: { id: userId }, data: { reliabilityScore: score } })
  await tx.reliabilityScoreLog.create({ data: { userId, score, delta: appliedDelta, reason, adjustedById } })
  return { appliedDelta, score }
}
