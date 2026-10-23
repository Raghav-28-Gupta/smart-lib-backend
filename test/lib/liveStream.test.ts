import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publish, subscriberCount } from '../../src/lib/events'
import { closeAllLiveStreams, openLiveStream } from '../../src/lib/liveStream'

/** The parts of an Express response the stream uses. */
class FakeResponse extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  flushed = false
  chunks: string[] = []
  ended = false
  status(code: number) {
    this.statusCode = code
    return this
  }
  set(headers: Record<string, string>) {
    Object.assign(this.headers, headers)
    return this
  }
  flushHeaders() {
    this.flushed = true
  }
  write(chunk: string) {
    this.chunks.push(chunk)
    return true
  }
  end() {
    this.ended = true
    this.emit('close')
  }
}

describe('openLiveStream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    closeAllLiveStreams()
    vi.useRealTimers()
  })

  it('opens with the SSE headers, a retry hint and a ready event', () => {
    const res = new FakeResponse()
    openLiveStream(res)
    expect(res.statusCode).toBe(200)
    expect(res.headers).toMatchObject({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    })
    expect(res.flushed).toBe(true)
    expect(res.chunks).toEqual(['retry: 5000\n\n', 'event: ready\ndata: {}\n\n'])
  })

  it('writes each published event with its type as the event name', () => {
    const res = new FakeResponse()
    openLiveStream(res)
    publish({ type: 'request.created', topics: ['requests'], kind: 'borrow', summary: 'Aditi Sharma wants to borrow Clean Code' })
    publish({ type: 'activity', topics: ['metrics'] })
    expect(res.chunks.slice(2)).toEqual([
      'event: request.created\ndata: {"topics":["requests"],"kind":"borrow","summary":"Aditi Sharma wants to borrow Clean Code"}\n\n',
      'event: activity\ndata: {"topics":["metrics"]}\n\n',
    ])
  })

  it('sends a heartbeat every 25 seconds', () => {
    const res = new FakeResponse()
    openLiveStream(res)
    vi.advanceTimersByTime(25_000)
    expect(res.chunks.at(-1)).toBe(': ping\n\n')
  })

  it('ends the stream after 15 minutes and stops listening', () => {
    const res = new FakeResponse()
    openLiveStream(res)
    vi.advanceTimersByTime(15 * 60_000)
    expect(res.ended).toBe(true)
    expect(subscriberCount()).toBe(0)
  })

  it('stops listening and writing when the console goes away', () => {
    const res = new FakeResponse()
    openLiveStream(res)
    res.emit('close')
    expect(subscriberCount()).toBe(0)
    const written = res.chunks.length
    vi.advanceTimersByTime(60_000)
    expect(res.chunks).toHaveLength(written)
  })

  it('closeAllLiveStreams ends every open stream', () => {
    const a = new FakeResponse()
    const b = new FakeResponse()
    openLiveStream(a)
    openLiveStream(b)
    closeAllLiveStreams()
    expect([a.ended, b.ended]).toEqual([true, true])
    expect(subscriberCount()).toBe(0)
  })

  it('writes nothing after ending, even before the response closes', () => {
    // A real response emits 'close' a moment after end(), not during it.
    const res = new FakeResponse()
    res.end = () => {
      res.ended = true
    }
    openLiveStream(res)
    vi.advanceTimersByTime(15 * 60_000)
    const written = res.chunks.length

    publish({ type: 'activity', topics: ['metrics'] })
    vi.advanceTimersByTime(60_000)

    expect(res.ended).toBe(true)
    expect(res.chunks).toHaveLength(written)
    expect(subscriberCount()).toBe(0)
  })

  it('closeAllLiveStreams stops writing before the responses close', () => {
    const res = new FakeResponse()
    res.end = () => {
      res.ended = true
    }
    openLiveStream(res)

    closeAllLiveStreams()

    expect(res.ended).toBe(true)
    expect(subscriberCount()).toBe(0)
  })
})
