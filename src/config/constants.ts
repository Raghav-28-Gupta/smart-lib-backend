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

// A student may report a seat or room they have booked while one of their bookings
// of it started within the last REPORT_BOOKING_LOOKBACK_DAYS days or starts within
// the next REPORT_BOOKING_LOOKAHEAD_HOURS hours (reportService.ts).
export const REPORT_BOOKING_LOOKBACK_DAYS = 7
export const REPORT_BOOKING_LOOKAHEAD_HOURS = 24

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
// on-time booking check-in, capped at 100 (see reliabilityService.ts). The
// negative trigger is RELIABILITY_NOSHOW_PENALTY, below.
export const RELIABILITY_ONTIME_BOOKING_BONUS = 2

// No-show handling (slice 7; spec 2026-11-24-no-show-handling-design.md).

// [ARBITRARY — flagged, not yet a team decision] Like the +2 bonus above, a
// placeholder: five on-time check-ins earn a miss back. Taken from the score
// (clamped to [0, 100]) when the sweep records a no-show; an overturn gives back
// exactly what was taken, which is stored on the NoShowEvent.
export const RELIABILITY_NOSHOW_PENALTY = 10

// The sweep only records a no-show whose grace period ended no more than this
// long ago, so nothing older than a day is ever penalized (the migration turns
// the older unattended bookings into plain `released` rows instead).
export const SWEEP_LOOKBACK_HOURS = 24

// A booking starting within this many minutes gets a "starts soon" reminder, and
// only if it was made (or approved) at least this long before it starts.
export const REMINDER_LEAD_MINUTES = 30

// The most bookings one sweep call handles per action (record, remind); the rest
// wait for the next call.
export const SWEEP_BATCH = 200

// A student may dispute a recorded no-show for this many days after the
// booking's grace period ended.
export const NO_SHOW_DISPUTE_DAYS = 7

// Fairness bound on the prediction's effect on the order of room requests: the
// penalty factor never exceeds this (the AI service caps it, and the backend
// clamps it again). With PRIORITY_WINDOW_HOURS the worst case is a request that
// waits 72 minutes longer in the librarian's list than its time alone says.
export const MAX_PENALTY_CAP = 0.2
export const PRIORITY_WINDOW_HOURS = 6

// The most the backend waits for the AI service's no-show prediction. It is never
// awaited by a request: a booking never waits on it.
export const PREDICT_TIMEOUT_MS = 2000

// A student with no booking history is assumed to attend this often when the
// prediction's features are built (the simulator uses the same prior).
export const NO_SHOW_PRIOR_ATTENDANCE = 0.85

// The book recommender (slice 8; spec 2026-11-25-book-recommender-design.md). A background refresh fills
// RecommendationCache from the AI service; GET /recommendations/me only ever reads the cache.

// How many personal picks a student sees.
export const RECOMMEND_LIMIT = 10

// The cache is refreshed when its newest row is older than this; after any attempt (success or failure) the
// process waits RECOMMEND_RETRY_MS before trying again; the AI call gets RECOMMEND_TIMEOUT_MS (a cold start on a
// free host can take most of it).
export const RECOMMEND_REFRESH_MS = 24 * 60 * 60 * 1000
export const RECOMMEND_RETRY_MS = 15 * 60 * 1000
export const RECOMMEND_TIMEOUT_MS = 90_000

// Cache rows older than this are not served, so a long-dead AI service never shows month-old picks.
export const RECOMMEND_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

// The most the refresh sends: the backend truncates first, keeping the most recent interactions. Books: the AI service
// answers 422 beyond 5,000, so this is its own limit. Interactions: the AI service accepts up to 200,000, but fitting
// that many (with the 36-character ids the backend really sends) peaked at about 510 to 530 MB (Windows; ai-backend/README.md), at or over a free 512 MB
// instance, so the backend sends 50,000 at most. The AI service's own cap stays as it is (it is the contract's limit).
export const RECOMMEND_MAX_BOOKS = 5000
export const RECOMMEND_MAX_INTERACTIONS = 50_000

// How much each kind of history counts, summed per (student, book) and capped at RECOMMEND_MAX_PAIR_WEIGHT (the
// AI service accepts a weight above 0 up to 3). [ARBITRARY — flagged, not a team decision] like the other placeholders.
export const RECOMMEND_LOAN_WEIGHT = 1
export const RECOMMEND_RENEWAL_BONUS = 0.5
export const RECOMMEND_RESERVATION_WEIGHT = 0.5
export const RECOMMEND_MAX_PAIR_WEIGHT = 3

// Same validate-at-startup pattern as lib/prisma.ts's DATABASE_URL check —
// fail loudly at boot rather than the first time a route tries to sign a token.
const secret = process.env.JWT_SECRET
if (!secret) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to backend/.env and fill it in.')
}
export const JWT_SECRET = secret
export const JWT_EXPIRES_IN = '7d'
