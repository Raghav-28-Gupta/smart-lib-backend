import { RELIABILITY_ONTIME_BOOKING_BONUS } from '../config/constants'
import type { Prisma, PrismaClient } from '../generated/prisma/client'
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

function tierFor(score: number): string {
  if (score >= GOOD_STANDING_THRESHOLD) return 'Good standing'
  if (score >= BUILDING_BACK_UP_THRESHOLD) return 'Building back up'
  if (score >= NEEDS_IMPROVEMENT_THRESHOLD) return 'Needs improvement'
  return 'At risk'
}

function buildNote(score: number, mostRecentMiss: { reason: string } | undefined): string {
  if (!mostRecentMiss || score >= GOOD_STANDING_THRESHOLD) {
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
    note: buildNote(user.reliabilityScore, mostRecentMiss),
    history: [...logs].reverse().map((l) => (l.delta < 0 ? 'miss' : 'ok')),
  }
}

// Shared by any flow that adjusts reliability (currently just an on-time
// booking check-in): clamps to [0, 100] and records the log entry that
// getReliability's history/note read back. Takes a transaction client so the
// score update lands atomically with whatever triggered it.
export async function applyReliabilityDelta(
  tx: Prisma.TransactionClient | PrismaClient,
  userId: string,
  delta: number,
  reason: string,
): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
  const newScore = Math.max(0, Math.min(100, user.reliabilityScore + delta))
  const appliedDelta = newScore - user.reliabilityScore

  await tx.user.update({ where: { id: userId }, data: { reliabilityScore: newScore } })
  await tx.reliabilityScoreLog.create({ data: { userId, score: newScore, delta: appliedDelta, reason } })
}
