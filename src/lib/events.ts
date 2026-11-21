// The in-process bus behind the admin console's live updates. Services
// publish after their database write has committed; GET /admin/events streams
// what they publish (lib/liveStream.ts). Events say what changed, never the
// new state: the console refetches. One Render instance means every console
// is connected to this process; several instances would need a shared bus
// (Redis pub/sub).

export type LiveTopic = 'requests' | 'metrics' | 'bookings' | 'resources'
export type LiveEventType =
  | 'request.created'
  | 'request.decided'
  | 'request.expired'
  | 'request.cancelled'
  | 'activity'
  | 'booking.changed'
  | 'resource.changed'

export interface LiveEvent {
  type: LiveEventType
  topics: LiveTopic[]
  kind?: 'borrow' | 'room'
  /** request.created only, e.g. "Aditi Sharma wants to borrow Clean Code". */
  summary?: string
}

type Listener = (event: LiveEvent) => void

const listeners = new Set<Listener>()

export function publish(event: LiveEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      // One broken stream must not stop the others hearing about it.
      console.error(error)
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function subscriberCount(): number {
  return listeners.size
}

/** For the many actions that only move Dashboard numbers. */
export function publishActivity(): void {
  publish({ type: 'activity', topics: ['metrics'] })
}

/** A change to a booking row that is not a request: seat booked, checked in, cancelled, reassigned. */
export function publishBookingChange(): void {
  publish({ type: 'booking.changed', topics: ['bookings', 'metrics'] })
}

/** A change to a resource: created, edited, taken offline or brought back. */
export function publishResourceChange(): void {
  publish({ type: 'resource.changed', topics: ['resources', 'metrics'] })
}
