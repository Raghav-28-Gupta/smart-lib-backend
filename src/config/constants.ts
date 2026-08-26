// Central home for every tunable business rule, so the team can change a
// policy without hunting through service code.

export const LOAN_PERIOD_DAYS = 14
export const MAX_RENEWALS = 2
export const GRACE_PERIOD_MINUTES = 15
export const WAITLIST_CLAIM_HOURS = 48

// [ARBITRARY — flagged, not yet a team decision] SMARTLIB_PROJECT_CONTEXT.md
// §9 notes explicitly that the fine rate was never actually agreed on; ₹10/day
// is a placeholder that makes the fine logic concrete and testable. Change it
// here, in one place, once the team decides on a real rate.
export const FINE_PER_DAY_INR = 10

// Same validate-at-startup pattern as lib/prisma.ts's DATABASE_URL check —
// fail loudly at boot rather than the first time a route tries to sign a token.
const secret = process.env.JWT_SECRET
if (!secret) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to backend/.env and fill it in.')
}
export const JWT_SECRET = secret
export const JWT_EXPIRES_IN = '7d'
