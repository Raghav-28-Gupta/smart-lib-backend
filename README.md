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
npx prisma migrate deploy
```

Some migrations carry hand-written SQL that Prisma's schema language can't
express: the `EXCLUDE` constraint below (rewritten in
`20261020120100_request_approvals` so pending room requests hold their slot)
and a partial unique index allowing one pending borrow request per student and
title. Create new migrations with `npx prisma migrate dev --create-only` and
read the SQL before applying it. Prisma doesn't model these two, so a
generated migration may try to drop them.

The `EXCLUDE` constraint makes double-booking a resource a *database-level*
impossibility rather than something application code has to get right on
every code path:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ResourceBooking"
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("startTime", "endTime") WITH &&
) WHERE (status IN ('requested', 'booked', 'checked_in'));
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

It also generates four weeks of past activity, ending yesterday, for the six
"Seed Student" accounts: about 600-900 bookings (weekday afternoons busiest,
about 1 in 5 missed) and 40-60 loans. The admin console's Dashboard reads it.
The same seed (`HISTORY_SEED` in `prisma/history.ts`) gives the same history
every time, shifted to end yesterday. The demo student's account gets none of
it, so the student app looks exactly as before.

Re-running it resets the seeded books (b1-b12), resources (s1-r3) and seed
accounts, then recreates them. The reset includes every loan, booking and
waitlist entry on those books and resources, including ones students made
through the live app. Other books, resources and accounts are left alone.
Against production, only re-run it if nothing there needs keeping.

## Admin accounts

The admin console (`../admin`) only lets in accounts with the admin role.
Public registration never creates one, and the seed doesn't either, because
the seed is also run against production. Create one per database:

```bash
npm run create-admin
```

It asks for a name, email and password (typed twice, not shown). If the email
already belongs to an account, it asks before making that account an admin and
setting the new password; the account keeps its name.

For production, point this terminal only at the production database first:

```powershell
$env:DATABASE_URL = '<production direct connection string>'
npm run create-admin
Remove-Item Env:DATABASE_URL
```

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
| `TZ` | `Asia/Kolkata`. Days and booking slots use the server's time zone; without it Render uses UTC and every slot is off by 5½ hours |
| `DATABASE_URL` | You, once: the production Neon branch's **direct** connection string |
| `JWT_SECRET` | You, once: a long random string (generator command in `.env.example`). Changing it logs everyone out |
| `CORS_ORIGINS` | Browser origins, comma-separated: the student web app `https://raghav-28-gupta.github.io` and the admin console's Vercel origin |
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
| POST | `/loans` | ✓ | Retired: answers 409 asking older app versions to update (borrowing is a request now) |
| POST | `/borrow-requests` | ✓ | Ask to borrow a book (`{ bookId }`); holds one copy for 24 hours |
| GET | `/borrow-requests/me` | ✓ | Your pending requests, and those declined or expired in the last 7 days |
| POST | `/borrow-requests/:id/cancel` | ✓ | Withdraw a pending request |
| GET | `/loans/me` | ✓ | Active loans, with computed fine/renewal/overdue fields |
| POST | `/loans/:id/renew` | ✓ | Renew (blocked by renewal cap or an active waitlist) |
| POST | `/loans/:id/return` | ✓ | Return (creates a `Fine` if overdue; cascades the waitlist) |
| POST | `/reservations` | ✓ | Join a book's waitlist |
| GET | `/reservations/me` | ✓ | Your queue position or active claim |
| DELETE | `/reservations/:id` | ✓ | Leave the waitlist / decline a claim |
| GET | `/resources/availability?type=&date=` | — | Seats/rooms with per-slot occupancy for a date |
| POST | `/bookings` | ✓ | Book a seat, or request a room (`{ resourceId, startTime, endTime }`); 409 + alternatives on conflict |
| GET | `/bookings/me` | ✓ | Your bookings and room requests, with computed grace-window status; also a booking the library cancelled or moved, for 7 days (see *Bookings and resources*) |
| POST | `/bookings/:id/checkin` | ✓ | Check in within the grace window |
| POST | `/bookings/:id/cancel` | ✓ | Cancel before check-in, or withdraw a room request |
| GET | `/profile/reliability` | ✓ | Reliability score, tier, and recent history |
| GET | `/recommendations/me` | ✓ | AI-backend recommendations, falling back to "popular right now" |
| GET | `/admin/metrics/utilization` | admin | Booked share of open hours: today, the same weekday last week, and seats/rooms for the last 7 days |
| GET | `/admin/metrics/circulation` | admin | Borrows, returns and top 5 titles over the last 7 days |
| GET | `/admin/metrics/overdue` | admin | Loans overdue now and 24 hours ago |
| GET | `/admin/metrics/demand` | admin | Booked share and busiest slot per area over the last 7 days |
| GET | `/admin/requests` | admin | Pending borrow and room requests, oldest first, with counts |
| POST | `/admin/requests/:kind/:id/approve` | admin | Approve (`kind` is `borrow` or `room`); 409 if it was already settled |
| POST | `/admin/requests/:kind/:id/decline` | admin | Decline, with an optional `{ reason }` (up to 300 characters) |
| GET | `/admin/resources?type=` | admin | Every seat and room (`type` is `seat` or `room`; omit for both), by name, with its status and how many bookings it still holds (`upcomingBookings`) |
| POST | `/admin/resources` | admin | Add one: `{ type, name, location?, capacity }` (name and location up to 100 characters, capacity a whole number 1-100); answers 201 |
| PATCH | `/admin/resources/:id` | admin | Change `name`, `location` and/or `capacity` (at least one; a blank `location` clears it); the type cannot change |
| POST | `/admin/resources/:id/offline` | admin | Take it offline, with an optional `{ note }` (up to 300 characters); 409 if it already is |
| POST | `/admin/resources/:id/online` | admin | Bring it back and clear the note; 409 if it already is |
| GET | `/admin/bookings?search=&status=&page=&pageSize=` | admin | Bookings, newest start time first, 25 per page (up to 100), with the total behind the filters |
| POST | `/admin/bookings/:id/cancel` | admin | Cancel a booking for the library, with an optional `{ reason }` (up to 300 characters); 409 if it can no longer be cancelled |
| GET | `/admin/bookings/:id/reassign-options` | admin | Resources the booking could move to: online, same type, free for its time |
| POST | `/admin/bookings/:id/reassign` | admin | Move the booking to another resource of the same type (`{ resourceId }`), keeping its time |
| GET | `/admin/events` | admin | Live updates for the console, as Server-Sent Events |
| GET | `/health` | — | Is this service up |
| GET | `/health/db` | — | Proves the Node → Postgres link |
| GET | `/health/ai` | — | Proves the Node → FastAPI link |

`admin` routes need a token for an account with the admin role: 401 without a
token, 403 for a student. Admin accounts are created with `npm run create-admin`
(see *Admin accounts*). The metric definitions live in
`src/services/adminMetrics.ts`, and in the design spec in the admin console's
repository (`smart-lib-admin`, `docs/2026-10-15-admin-console-slice1-design.md`).

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

## Request approvals

Borrowing a book and booking a room are requests that a librarian approves in
the admin console. Seats, renewals, returns, check-ins and the waitlist are
instant.

- A borrow request holds one copy (copy status `requested`) for 24 hours. A
  room request holds its slot (booking status `requested`, covered by the
  exclusion constraint) until the slot's 15-minute grace period ends.
- Approving a borrow request creates the loan, so its 14 days start then.
  Declining it, letting it lapse, or the student withdrawing it frees the copy
  and runs the waitlist cascade.
- Lapsed requests are expired by a sweep that runs at startup and every minute
  (`src/services/requestHolds.ts`), and before the request paths read or write.
- Students see declined and expired requests for 7 days.

## Bookings and resources

The admin console manages resources (seats and rooms) and the bookings on them.
All nine routes sit behind the `/admin` guard, like the rest.

**Resources.** A resource is `available` or `offline`. Offline means no new
bookings: `POST /bookings` answers 409 ("This resource is offline right now."),
`GET /resources/availability` leaves it out, a conflict never suggests it as an
alternative, and no booking can be moved onto it. Bookings that already exist
stay, which is why the list carries `upcomingBookings` (requested, booked or
checked-in bookings that have not ended). Taking a resource offline can carry a
note; bringing it back clears the note. A new resource needs a type, a name and
a capacity; the type is fixed after that. A name or location over 100
characters, a capacity outside 1-100, a note over 300 characters, or a `PATCH`
with no field to change is a 400.

**The bookings list.** `GET /admin/bookings` returns
`{ bookings, total, page, pageSize }`. `search` (up to 100 characters) matches
the student's name or email or the resource name, ignoring case. `status` is
`booked`, `released`, `checked_in`, `completed` or `cancelled`; anything else,
including `requested` and `no_show`, is a 400. As for students, the status is
worked out when it is read: a booking is `released` once its grace period has
passed without a check-in, and a checked-in one is `completed` once its end time
is reached. Room requests that are still pending, declined or expired are not
listed (they live on the Requests page). Each booking carries `cancelledBy`
(`student` or `library`), `cancelReason`, `movedFromName` and `canManage`, which
is true exactly while the booking is `booked`. `page` starts at 1 and
`pageSize` defaults to 25 (up to 100).

**Cancel and reassign.** Both are conditional updates on the booking still
being `booked` and not past its grace period, so of a librarian and a student
acting at once only the first write lands, and a librarian who lost is told what
happened with a 409: "Already cancelled by the library.", "The student already cancelled
this booking.", "The student already checked in.", "This booking has already
finished.", "This booking has already been released.", or, for a room request,
"This is a room request. Decide it on the Requests page." An unknown booking is
a 404. Neither changes the student's reliability score. A cancel records who
did it, when and why (`cancelledById`, `cancelledAt`, `cancelReason`). A
reassign keeps the booking's time and records the name of the resource it left
and when (`movedFromName`, `movedAt`). It is refused with a 400 for a resource
of the other type or the one it is already on, and with a 409 for an offline
resource ("That resource is offline.") or one that is taken at that time ("That
resource is taken at this time."; the exclusion constraint decides, under the
same per-resource lock as `POST /bookings`). `reassign-options` lists the
online resources of the same type with nothing holding the booking's time, by
name, as `{ id, name, location, capacity }`; it is a snapshot, and the reassign
re-checks.

**What students see.** `GET /bookings/me` shows a booking the library cancelled
(the library cancelled it exactly when `cancelledById` is set) with
`frontendStatus: 'cancelledByLibrary'` and, if the librarian gave one, its
`cancelReason` (null for every other booking). It stays listed for 7 days
after `cancelledAt` and then drops off, the way declined and expired requests
do. A student's own cancel is not listed, as before. A booking the library moved
shows the new resource's name and id, and `movedFrom`, the old resource's name,
for 7 days after `movedAt` (null otherwise). The booking's `status` stays the
raw database value (`cancelled` for a library cancel).

## Live events

`GET /admin/events` streams Server-Sent Events to the admin console: `ready` on
connect, then one event per change:

```
event: request.created
data: {"topics":["requests"],"kind":"borrow","summary":"Aditi Sharma wants to borrow Clean Code"}
```

Events name what changed (`requests`, `metrics`, `bookings`, `resources`),
never the new state: the console refetches. A booking that is not a request
changing (a seat booked, a check-in, a cancel or a move) sends
`booking.changed`; a resource added, edited, taken offline or brought back
sends `resource.changed`. A `: ping` comment goes out every 25 seconds, and each
stream ends after 15 minutes, so the console reconnects and its token and role
are checked again.

The bus is in-process (`src/lib/events.ts`). That reaches every console while
one instance serves the API, as on Render's free plan; several instances would
need a shared bus such as Redis pub/sub.

## Response shape

Most list/detail endpoints return **normalized fields alongside computed
ones** rather than one or the other — e.g. a book carries its raw
`totalCopies` next to the computed `availableCopies`/`heldCopies`/`waitlistCount`
(`heldCopies` = shelf copies earmarked for a waitlisted student's live claim,
which only that student may borrow); a loan
carries the raw Prisma `status` next to the frontend-facing `frontendStatus`
(`normal`/`overdue`). Apart from the request-lapse sweep (see *Request
approvals*), nothing here runs on a schedule — grace-window expiry, overdue
status, and waitlist-claim expiry are all computed lazily, at read time or
when an adjacent write happens (a return, a renewal), not by a background job.

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
