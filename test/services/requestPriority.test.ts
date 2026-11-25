// The bounded priority in the librarian's Requests queue (slice 7, spec section 6, "Bounds
// (fairness)"): the pure key, clamp and ordering helpers exported by adminRequestService.
// The route-level tests, with real rows, are in test/routes/adminRequests.test.ts.
import { describe, expect, it } from 'vitest'
import { MAX_PENALTY_CAP } from '../../src/config/constants'
import {
  clampPriorityScore,
  orderRequests,
  priorityDelayMs,
  suggestedDelayMinutes,
  type QueueEntry,
} from '../../src/services/adminRequestService'

const MINUTE_MS = 60_000
const MAX_DELAY_MS = 72 * MINUTE_MS // MAX_PENALTY_CAP 0.2 of a 6 hour window

const base = Date.now()
const at = (minutes: number) => new Date(base + minutes * MINUTE_MS)
const room = (id: string, minutes: number, priorityScore: number | null): QueueEntry => ({ id, kind: 'room', requestedAt: at(minutes), priorityScore })
const borrow = (id: string, minutes: number, priorityScore?: number | null): QueueEntry => ({ id, kind: 'borrow', requestedAt: at(minutes), priorityScore })
const ids = (list: QueueEntry[]) => list.map((entry) => entry.id)

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
}

describe('the bounded priority of a room request', () => {
  it('a room request with priorityScore 0.8 sits at most 72 minutes later than its request time says', () => {
    expect(suggestedDelayMinutes(0.8)).toBe(72)
    expect(priorityDelayMs(0.8)).toBeLessThanOrEqual(MAX_DELAY_MS)

    // Requested at minute 0 it sits after what was requested at 71 and before what was requested at 73.
    expect(ids(orderRequests([borrow('b73', 73), room('r', 0, 0.8), borrow('b71', 71)], 'suggested'))).toEqual(['b71', 'r', 'b73'])
    // No score, in range or not, ever costs more than that.
    for (const score of [0.8, 0.5, 0, -1, -1e9, -Infinity]) expect(priorityDelayMs(score)).toBeLessThanOrEqual(MAX_DELAY_MS)
  })

  it('a null score changes nothing', () => {
    expect(clampPriorityScore(null)).toBe(1)
    expect(priorityDelayMs(null)).toBe(0)
    expect(suggestedDelayMinutes(1)).toBe(0)

    const list = [room('c', 30, null), borrow('a', 0), room('b', 10, null)]
    expect(ids(orderRequests(list, 'suggested'))).toEqual(['a', 'b', 'c'])
    expect(ids(orderRequests(list, 'suggested'))).toEqual(ids(orderRequests(list, 'request')))
  })

  it('borrow requests are never reordered by priority', () => {
    // A score on a borrow entry (which the service never gives one) would be ignored all the same.
    const list = [borrow('b3', 40, 0.8), room('r', 5, 0.8), borrow('b1', 0, 0.8), borrow('b2', 20, 0.8)]

    const suggested = orderRequests(list, 'suggested')

    expect(ids(suggested.filter((entry) => entry.kind === 'borrow'))).toEqual(['b1', 'b2', 'b3'])
    // The room (requested at 5, key 77) went behind the borrow request made at 40, and only that.
    expect(ids(suggested)).toEqual(['b1', 'b2', 'b3', 'r'])
    expect(ids(orderRequests(list, 'request'))).toEqual(['b1', 'r', 'b2', 'b3'])
  })

  it('order=request returns plain request-time order', () => {
    const list = [room('late', 50, 1), room('penalised', 0, 0.8), borrow('mid', 30), room('tie-b', 60, 0.9), room('tie-a', 60, null)]

    expect(ids(orderRequests(list, 'request'))).toEqual(['penalised', 'mid', 'late', 'tie-a', 'tie-b'])
    // The same list in the suggested order puts the penalised request later.
    expect(ids(orderRequests(list, 'suggested'))).not.toEqual(ids(orderRequests(list, 'request')))
  })

  it('a score above 1 or below 0.8 in the database is clamped when read', () => {
    expect(clampPriorityScore(1.7)).toBe(1)
    expect(clampPriorityScore(Infinity)).toBe(1)
    expect(clampPriorityScore(-3)).toBeCloseTo(1 - MAX_PENALTY_CAP, 10)
    expect(clampPriorityScore(0.5)).toBeCloseTo(1 - MAX_PENALTY_CAP, 10)
    expect(clampPriorityScore(-Infinity)).toBeCloseTo(1 - MAX_PENALTY_CAP, 10)
    expect(clampPriorityScore(0.9)).toBe(0.9)
    expect(clampPriorityScore(NaN)).toBe(1) // a NaN key would make the sort inconsistent

    expect(suggestedDelayMinutes(1.7)).toBe(0)
    expect(suggestedDelayMinutes(-3)).toBe(72)
    expect(suggestedDelayMinutes(0.9)).toBe(36)

    // A request stored with 5 is not moved earlier than its time says; one stored with -3 is not pushed past 72 minutes.
    expect(ids(orderRequests([borrow('b', 1), room('r', 2, 5)], 'suggested'))).toEqual(['b', 'r'])
    expect(ids(orderRequests([room('r', 0, -3), borrow('b72', 72), borrow('b73', 73)], 'suggested'))).toEqual(['r', 'b72', 'b73'])
    expect(ids(orderRequests([room('r', 0, -3), borrow('b71', 71)], 'suggested'))).toEqual(['b71', 'r'])
  })

  it('the order is stable and deterministic for equal keys', () => {
    // m1 (score 0.9, minute 0) has the same key as the two entries at minute 36 (0.9 delays 36 minutes).
    // Equal key: the earlier real request time first, then the id, whatever order they arrive in.
    const list = [room('m1', 0, 0.9), borrow('z-borrow', 36), room('a-room', 36, null), room('m-room', 36, 1)]
    const expected = ['m1', 'a-room', 'm-room', 'z-borrow']

    for (const arrival of permutations(list)) {
      expect(ids(orderRequests(arrival, 'suggested'))).toEqual(expected)
    }
    // Plain order breaks its ties the same way.
    for (const arrival of permutations(list)) {
      expect(ids(orderRequests(arrival, 'request'))).toEqual(['m1', 'a-room', 'm-room', 'z-borrow'])
    }
    // It never reorders its input in place.
    const input = [...list]
    orderRequests(input, 'suggested')
    expect(ids(input)).toEqual(ids(list))
  })
})
