// What a librarian is told when their decision lands on a request that was
// already settled: by another librarian, by the student, or by the deadline.

export type Settled = 'approved' | 'declined' | 'expired' | 'withdrawn'

export function settledMessage(settled: Settled | null, deciderName: string | null): string {
  switch (settled) {
    case 'approved':
      return deciderName ? `Already approved by ${deciderName}.` : 'This request was already approved.'
    case 'declined':
      return deciderName ? `Already declined by ${deciderName}.` : 'This request was already declined.'
    case 'expired':
      return 'This request expired.'
    case 'withdrawn':
      return 'The student withdrew this request.'
    default:
      return 'This request is no longer pending.'
  }
}
