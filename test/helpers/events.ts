import { subscribe, type LiveEvent } from '../../src/lib/events'

/** Records every event published until stop() is called (call it in afterEach). */
export function recordEvents(): { events: LiveEvent[]; stop: () => void } {
  const events: LiveEvent[] = []
  const stop = subscribe((event) => events.push(event))
  return { events, stop }
}
