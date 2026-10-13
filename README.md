# SmartLib — Core Backend (Node + TypeScript + Express + Prisma)

Owns auth, lending, and booking. This is the **only** service the Flutter client
talks to; it calls the FastAPI service internally for anything ML-related.

## Prerequisites

- Node.js 22 (pinned in `package.json` `engines`; Render uses the same)
- A Postgres database — Neon, `docker-compose up` from the repo root, or a local install
- `btree_gist` available (Neon has it; the migration installs it with `CREATE EXTENSION IF NOT EXISTS`)

## Setup

```bash
cd backend
npm install                     # also runs `prisma generate` via postinstall
cp .env.example .env            # then fill in DATABASE_URL, TEST_DATABASE_URL, JWT_SECRET
```

See `.env.example` for what each variable does and why. Two things worth
calling out up front:

> **Direct vs. pooled Neon URLs.** Use the **direct / unpooled** endpoint (the
> host *without* `-pooler`) for `DATABASE_URL` and `TEST_DATABASE_URL`.
> Prisma migrations break against PgBouncer's transaction-pooling mode, and
> the app already runs its own connection pool via `@prisma/adapter-pg`, so
> Neon's pooler adds nothing here — only friction.

> **`TEST_DATABASE_URL` must be a separate database from `DATABASE_URL`.**
> The integration test suite truncates every table between test files
> (`test/helpers/db.ts`). Pointing it at your dev database will wipe it.

> Use `127.0.0.1`, not `localhost`, for `AI_BACKEND_URL`. On Windows, Node
> resolves `localhost` to `::1` first while uvicorn binds IPv4 only, which
> fails with `ECONNREFUSED` even though the service is running.

## Database migration

```bash
npx prisma migrate dev
```

The one migration in `prisma/migrations/` includes a hand-written block Prisma's
schema language can't express — a Postgres `EXCLUDE` constraint that makes
double-booking a resource a *database-level* impossibility rather than
something application code has to get right on every code path:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ResourceBooking"
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("startTime", "endTime") WITH &&
) WHERE (status IN ('booked', 'checked_in'));
```

`routes`/`services/bookingService.ts` catches the resulting SQLSTATE `23P01`
and turns it into a 409 with alternative-slot suggestions — see the endpoint
table below.

The insert runs inside a transaction that first takes a per-resource advisory
lock (`pg_advisory_xact_lock`). The constraint is still what guarantees
correctness; the lock keeps simultaneous requests orderly. Without it,
Postgres can abort the losers of an insert race with a deadlock (`40P01`),
which the API would answer with a 500 and which costs about a second per
loser, instead of the clean `23P01`.

## Seed data

```bash
npm run seed
```

Populates the database with the same 12 books, 4 seats, 3 rooms, and demo
user (`aditi.sharma@thapar.edu` / `password123`) that the Flutter frontend's
mock repositories were built and screenshotted against — so a live demo
matches the UI the team has already seen. It also gives the demo user a
representative loan/reliability history (an overdue loan with a fine, a loan
blocked from renewal by a waitlist, a degraded reliability score) so her own
screens aren't empty on first login. Details and the specific scope decisions
are documented in the comment block at the top of `prisma/seed.ts`.

Safe to re-run — it deletes only the rows it owns (matched by the fixed seed
ids/emails) before recreating them, so it won't touch data created through
the live API separately.

## Run

```bash
npm run dev        # tsx watch on src/index.ts, http://localhost:3000
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`,
`npm run prisma:studio`.

## Tests

```bash
npm test            # migrates TEST_DATABASE_URL, then runs the full suite once
npm run test:watch  # watch mode
```

Tests run against a **real Postgres database** (`TEST_DATABASE_URL`), not
mocks — `test/helpers/db.ts` truncates all tables between test files. This
matters most for `test/routes/bookings.test.ts`, which includes a genuine
concurrency test: it fires several simultaneous `POST /bookings` requests for
the identical resource and time slot and asserts that exactly one succeeds —
proving the `EXCLUDE` constraint holds under real concurrent load, rather
than assuming it from the application logic alone. A second test repeats the
race up to 40 times (at most about 5 seconds): the deadlock described under
*Database migration* above only shows up against a local database with warm
connections, such as CI's. Neon's network latency staggers the requests and
hides it, so a green local run does not prove this case.

## Deploy

Production runs on **Render** as a Node web service on the `main` branch, in
Singapore next to the Neon database, configured in Render's dashboard.

**On every push to `main`:** GitHub Actions (`.github/workflows/ci.yml`) runs
the tests against a throwaway Postgres. It also runs the build and start
commands below against an empty database and checks the server answers.
With auto-deploy set to "After CI checks pass", Render deploys the commit
only once both pass. Its build applies any pending migrations
(`prisma migrate deploy`); on redeploy, the old server finishes in-flight
requests before exiting.

| Setting | Value |
|---|---|
| Runtime / branch / region | Node / `main` / Singapore |
| Build command | `npm ci --include=dev && npm run build && npx prisma migrate deploy` |
| Start command | `npm start` |
| Health check path | `/health` |
| Auto-deploy | After CI checks pass |

The build needs `--include=dev`: with `NODE_ENV=production`, npm would skip
TypeScript, a dev dependency. Node 22 comes from `engines` in `package.json`.

| Variable | Where it comes from |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | You, once: the production Neon branch's **direct** connection string |
| `JWT_SECRET` | You, once: a long random string (generator command in `.env.example`). Changing it logs everyone out |
| `CORS_ORIGINS` | The web app's origin: `https://raghav-28-gupta.github.io` |
| `PORT` | Set by Render |
| `AI_BACKEND_URL` | Unset: the AI service isn't deployed, so recommendations fall back to what's popular |

### First-time setup

1. **Neon:** create a branch named `production` from your main branch
   (Branches → New branch, with data). Copy its **direct** connection string
   (not `-pooler`), with `sslmode=verify-full`. Don't create it schema-only:
   that leaves out Prisma's migration history, and the first deploy would try
   to recreate tables that already exist.
2. **Render:** New → Web Service → this repository, with the settings and
   variables above.
3. **Demo data**, once, from your machine. This resets the demo accounts on the
   production branch:
   ```powershell
   $env:DATABASE_URL = '<production direct connection string>'   # this terminal only
   npm run seed
   Remove-Item Env:DATABASE_URL
   ```
   `dotenv` never overrides a variable that's already set, so this beats
   `backend/.env`.
4. **Check** `https://<your-service>.onrender.com/health/db`. It should report
   `ok`.

**Free plan:** the service sleeps after 15 minutes without requests, so the
next request takes about a minute while it wakes.

**Running the production build locally:** `npm run build && npm start`
(compiled JavaScript, as Render runs it, rather than `npm run dev`).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account |
| POST | `/auth/login` | — | Get a JWT |
| GET | `/auth/me` | ✓ | Current user |
| GET | `/books/search?q=&genre=` | — | Catalog search |
| GET | `/books/:id` | — | Book detail, with computed `availableCopies`/`heldCopies`/`waitlistCount` |
| POST | `/loans` | ✓ | Borrow a book (`{ bookId }`) |
| GET | `/loans/me` | ✓ | Active loans, with computed fine/renewal/overdue fields |
| POST | `/loans/:id/renew` | ✓ | Renew (blocked by renewal cap or an active waitlist) |
| POST | `/loans/:id/return` | ✓ | Return (creates a `Fine` if overdue; cascades the waitlist) |
| POST | `/reservations` | ✓ | Join a book's waitlist |
| GET | `/reservations/me` | ✓ | Your queue position or active claim |
| DELETE | `/reservations/:id` | ✓ | Leave the waitlist / decline a claim |
| GET | `/resources/availability?type=&date=` | — | Seats/rooms with per-slot occupancy for a date |
| POST | `/bookings` | ✓ | Book a resource (`{ resourceId, startTime, endTime }`); 409 + alternatives on conflict |
| GET | `/bookings/me` | ✓ | Your bookings, with computed grace-window status |
| POST | `/bookings/:id/checkin` | ✓ | Check in within the grace window |
| POST | `/bookings/:id/cancel` | ✓ | Cancel before check-in |
| GET | `/profile/reliability` | ✓ | Reliability score, tier, and recent history |
| GET | `/recommendations/me` | ✓ | AI-backend recommendations, falling back to "popular right now" |
| GET | `/health` | — | Is this service up |
| GET | `/health/db` | — | Proves the Node → Postgres link |
| GET | `/health/ai` | — | Proves the Node → FastAPI link |

Routes marked `✓` require `Authorization: Bearer <token>` from `/auth/login`
or `/auth/register`.

```bash
curl localhost:3000/health      # {"status":"ok","service":"node-backend"}
curl localhost:3000/health/db   # {"status":"ok","service":"postgres"}
curl localhost:3000/health/ai   # {"status":"ok","service":"ai-backend"}
```

`/health/ai` (and the real path behind `/recommendations/me`) requires the AI
backend to be running — see `../ai-backend/README.md`. `/recommendations/me`
degrades gracefully to its fallback when it isn't.

## Response shape

Most list/detail endpoints return **normalized fields alongside computed
ones** rather than one or the other — e.g. a book carries its raw
`totalCopies` next to the computed `availableCopies`/`heldCopies`/`waitlistCount`
(`heldCopies` = shelf copies earmarked for a waitlisted student's live claim,
which only that student may borrow); a loan
carries the raw Prisma `status` next to the frontend-facing `frontendStatus`
(`normal`/`overdue`). Nothing here runs on a schedule — grace-window expiry,
overdue status, and waitlist-claim expiry are all computed lazily, at read
time or when an adjacent write happens (a return, a renewal), not by a
background job.

## Notes on Prisma 7

This project is on Prisma 7, which differs from most tutorials (written for v6):

- The generator is `prisma-client` (not `prisma-client-js`) and emits to
  `src/generated/prisma`, which is gitignored and rebuilt by `npm install`.
- The datasource URL lives in `prisma.config.ts`, not in `schema.prisma`.
- `.env` is no longer auto-loaded — `prisma.config.ts` imports `dotenv/config`.
- `PrismaClient` requires a driver adapter; we use `@prisma/adapter-pg`.
- The generator is pinned to `moduleFormat = "cjs"` and
  `importFileExtension = "js"`. Left to infer, it emits ES-module code that
  imports `./x.ts`. `tsx` and vitest tolerate that, but the compiled server
  (`node dist/index.js`, production) crashes on it at startup. CI builds and
  starts the compiled server for exactly this reason.
- An unmodeled constraint violation (like the `EXCLUDE` constraint above)
  surfaces as a generic `PrismaClientKnownRequestError` with code `P2039` —
  the real SQLSTATE only appears in the message text, not a structured field.
  See the comment on `isExclusionViolation()` in `bookingService.ts`.

## Layout

```
prisma/
├── schema.prisma
├── migrations/
└── seed.ts              # demo data — see `npm run seed` above
src/
├── index.ts              # app bootstrap (listen())
├── app.ts                # Express app factory — supertest mounts this directly
├── routes/                # one file per resource, each declaring its own full paths
├── services/              # business logic; routes stay thin
├── schemas/                # zod request validation
├── middleware/
│   ├── requireAuth.ts     # JWT verification, req.user
│   ├── validate.ts        # zod middleware for body/params/query
│   └── errorHandler.ts    # AppError + Prisma error -> HTTP response mapping
├── config/
│   └── constants.ts       # every tunable business rule in one place
└── lib/
    ├── prisma.ts          # PrismaClient singleton
    └── aiClient.ts        # the only caller of the FastAPI service
test/
├── routes/                 # integration tests, one file per resource
└── helpers/db.ts           # resetDb() — truncates between test files
```
