import { afterEach, describe, expect, it, vi } from 'vitest'
import { publish, publishActivity, subscribe, subscriberCount, type LiveEvent } from '../../src/lib/events'

const created: LiveEvent = {
  type: 'request.created',
  topics: ['requests'],
  kind: 'borrow',
  summary: 'Aditi Sharma wants to borrow Clean Code',
}

describe('event bus', () => {
  const stops: Array<() => void> = []
  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.restoreAllMocks()
  })

  it('delivers each published event to every subscriber', () => {
    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    stops.push(subscribe((e) => a.push(e)), subscribe((e) => b.push(e)))
    publish(created)
    expect(a).toEqual([created])
    expect(b).toEqual([created])
  })

  it('stops delivering once unsubscribed', () => {
    const got: LiveEvent[] = []
    const stop = subscribe((e) => got.push(e))
    stop()
    publish(created)
    expect(got).toEqual([])
    expect(subscriberCount()).toBe(0)
  })

  it('keeps delivering to the others when one subscriber throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const got: LiveEvent[] = []
    stops.push(
      subscribe(() => {
        throw new Error('socket closed')
      }),
      subscribe((e) => got.push(e)),
    )
    publish(created)
    expect(got).toEqual([created])
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('publishActivity announces a change to the Dashboard numbers', () => {
    const got: LiveEvent[] = []
    stops.push(subscribe((e) => got.push(e)))
    publishActivity()
    expect(got).toEqual([{ type: 'activity', topics: ['metrics'] }])
  })
})
