// Central home for every tunable business rule, so the team can change a
// policy without hunting through service code.

export const LOAN_PERIOD_DAYS = 14
export const MAX_RENEWALS = 2
export const GRACE_PERIOD_MINUTES = 15
export const WAITLIST_CLAIM_HOURS = 48

// Declined and expired requests stay in the student's lists this long, so the
// student sees the answer.
export const REQUEST_OUTCOME_VISIBLE_DAYS = 7

// A borrow request holds its copy this long while it waits for a librarian.
export const BORROW_REQUEST_HOURS = 24

// The demo accounts the seed creates. They are placeholders, never real
// inboxes, so the mailer (lib/mailer.ts) never sends to them.
export const DEMO_EMAIL_PATTERN = /^(aditi\.sharma|seed\.student\d+)@thapar\.edu$/i

// The most an email send may take before it counts as failed; it is never
// retried and never holds up the action that caused it.
export const MAIL_TIMEOUT_MS = 5000

// Matches the frontend's kTimeSlots exactly (booking_repository.dart) — each
// entry is a 1-hour slot starting at `hour` (24h clock, local time). There's
// no per-user timezone concept anywhere in the project yet, so "date" is
// interpreted in the server's local time, same simplification the frontend
// itself makes with DateTime.now().
export const TIME_SLOTS = [
  { label: '9:00 AM', hour: 9 },
  { label: '10:00 AM', hour: 10 },
  { label: '11:00 AM', hour: 11 },
  { label: '12:00 PM', hour: 12 },
  { label: '1:00 PM', hour: 13 },
  { label: '2:00 PM', hour: 14 },
  { label: '3:00 PM', hour: 15 },
  { label: '4:00 PM', hour: 16 },
  { label: '5:00 PM', hour: 17 },
  { label: '6:00 PM', hour: 18 },
  { label: '7:00 PM', hour: 19 },
] as const

// [ARBITRARY — flagged, not yet a team decision] SMARTLIB_PROJECT_CONTEXT.md
// §9 notes explicitly that the fine rate was never actually agreed on; ₹10/day
// is a placeholder that makes the fine logic concrete and testable. Change it
// here, in one place, once the team decides on a real rate.
export const FINE_PER_DAY_INR = 10

// [ARBITRARY — flagged, not yet a team decision] Same status as
// FINE_PER_DAY_INR above: a concrete placeholder so the reliability system is
// testable, not a value the team has actually agreed on. Applied per
// on-time booking check-in, capped at 100 (see reliabilityService.ts).
// No-show detection isn't implemented in this phase (no scheduler exists to
// detect a missed grace window yet), so there's currently no negative
// trigger — only this positive one.
export const RELIABILITY_ONTIME_BOOKING_BONUS = 2

// Same validate-at-startup pattern as lib/prisma.ts's DATABASE_URL check —
// fail loudly at boot rather than the first time a route tries to sign a token.
const secret = process.env.JWT_SECRET
if (!secret) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to backend/.env and fill it in.')
}
export const JWT_SECRET = secret
export const JWT_EXPIRES_IN = '7d'
