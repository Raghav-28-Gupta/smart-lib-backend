// The in-process bus behind the admin console's live updates. Services
// publish after their database write has committed; GET /admin/events streams
// what they publish (lib/liveStream.ts). Events say what changed, never the
// new state: the console refetches. One Render instance means every console
// is connected to this process; several instances would need a shared bus
// (Redis pub/sub).

export type LiveTopic = 'requests' | 'metrics' | 'bookings' | 'resources' | 'fines' | 'catalogue' | 'students' | 'attention'
export type LiveEventType =
  | 'request.created'
  | 'request.decided'
  | 'request.expired'
  | 'request.cancelled'
  | 'request.scored'
  | 'activity'
  | 'booking.changed'
  | 'resource.changed'
  | 'fine.changed'
  | 'catalogue.changed'
  | 'student.changed'
  | 'loan.changed'
  | 'attention.changed'

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

/** A change to a fine row: created late, marked paid, adjusted or waived. */
export function publishFineChange(): void {
  publish({ type: 'fine.changed', topics: ['fines'] })
}

/** A change to books or copies: added, edited, or a copy's status moved. `extra` adds topics the same change also moves. */
export function publishCatalogueChange(extra: LiveTopic[] = []): void {
  publish({ type: 'catalogue.changed', topics: ['catalogue', ...extra] })
}

/** A change to what the student page shows that no other event covers: a manual reliability adjustment. */
export function publishStudentChange(): void {
  publish({ type: 'student.changed', topics: ['students'] })
}

/**
 * A change to the Needs attention queue: a reminder or escalation sent, a fine
 * dispute opened or settled, a problem report filed or settled. Services publish
 * it once, after commit and after any email outcome has been written.
 */
export function publishAttentionChange(): void {
  publish({ type: 'attention.changed', topics: ['attention'] })
}

/**
 * A student's loan changed by a return or a renewal: Dashboard numbers move, and
 * the Catalogue and student pages show the loan differently (a return frees its
 * copy; a renewal moves its due date). `pastDue` is whether the loan was past its
 * due date at that moment (even by less than a day), when its accruing row on the
 * Fines page turns into a stored fine or disappears, and its overdue item leaves
 * the Needs attention queue.
 */
export function publishLoanChange(pastDue: boolean): void {
  publish({
    type: 'loan.changed',
    topics: pastDue ? ['metrics', 'catalogue', 'fines', 'attention'] : ['metrics', 'catalogue'],
  })
}
