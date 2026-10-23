// One admin console's live connection: the event bus (lib/events.ts) written
// to an HTTP response as Server-Sent Events.
import { subscribe } from './events'

export const RETRY_MS = 5_000
export const HEARTBEAT_MS = 25_000
/** Each stream ends after this long; the console reconnects, re-checking its token and role. */
export const MAX_STREAM_MS = 15 * 60_000

/** The parts of an Express response a stream uses (a fake in the unit tests). */
export interface StreamResponse {
  /** True once the connection is gone. A real response has it; the unit tests' fake sets it. */
  readonly destroyed?: boolean
  status(code: number): unknown
  set(headers: Record<string, string>): unknown
  flushHeaders(): void
  write(chunk: string): boolean
  end(): void
  on(event: 'close', listener: () => void): unknown
}

/** How to end each open stream. */
const open = new Set<() => void>()

export function openLiveStream(res: StreamResponse): void {
  // The console can hang up while the route's async admin check is still
  // running. Its 'close' has then already fired, so nothing would ever stop a
  // stream opened on this response.
  if (res.destroyed) return

  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Asks any buffering proxy in between to pass each event straight through.
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write(`retry: ${RETRY_MS}\n\n`)
  res.write('event: ready\ndata: {}\n\n')

  const unsubscribe = subscribe(({ type, ...rest }) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`)
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  const maxAge = setTimeout(end, MAX_STREAM_MS)
  open.add(end)
  res.on('close', stop)

  // Stops all writing. It runs before res.end(), not only on 'close': a real
  // response emits 'close' a moment after end(), and a write in between (a
  // heartbeat or an event) is an 'error' event on the response, which would
  // crash the process. MAX_STREAM_MS is a multiple of HEARTBEAT_MS, so a
  // heartbeat is always due right at the end.
  function stop() {
    clearInterval(heartbeat)
    clearTimeout(maxAge)
    unsubscribe()
    open.delete(end)
  }

  function end() {
    stop()
    res.end()
  }
}

/** Ends every open stream (on shutdown), so the HTTP server can close. */
export function closeAllLiveStreams(): void {
  for (const end of [...open]) end()
}
