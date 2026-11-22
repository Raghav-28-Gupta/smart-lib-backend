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
generated migration may try to drop them. (`20261121215218_console_catalogue`
also hand-writes the barcode sequence and the `next_copy_barcode()` function
that is `BookCopy.barcode`'s default; see *Catalogue and copies*.)

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
are documented in the comment block at the top of `prisma/seedData.ts` (the seed's work, as
`runSeed()`; `prisma/seed.ts` is the command line around it).

It also generates four weeks of past activity, ending yesterday, for the six
"Seed Student" accounts: about 600-900 bookings (weekday afternoons busiest,
about 1 in 5 missed) and 40-60 loans. The admin console's Dashboard reads it.
The same seed (`HISTORY_SEED` in `prisma/history.ts`) gives the same history
every time, shifted to end yesterday. The demo student's account gets none of
it, so the student app looks exactly as before.

Each late return in that history also has its overdue fine: about half paid,
one waived and one lowered (with their notes), the rest outstanding (the newest
always is), so every status filter on the Fines page has something (the demo
student's overdue loan, still out, is an accruing row). The seeded fines name no
librarian, since nobody recorded them. Every seeded copy gets its barcode from the same sequence as a copy added
in the console (see *Catalogue and copies*), so the numbers change on each
re-seed.

Re-running it resets the seeded books (b1-b12), resources (s1-r3) and seed
accounts (the demo student and the six "Seed Student" accounts), then recreates
them. It is safe to run after the console has been used: it never fails on rows
the console added.

**A re-seed resets:**

- the demo books back to their demo state (a console edit to them is undone)
  and all their copies, including copies a librarian added to them;
- every loan, borrow request, waitlist entry, cached recommendation and fine
  tied to a demo book or one of its copies, including other students' and ones
  made through the live app, so no fine is left without its loan;
- the demo resources, and every booking on them, with its no-show record and
  fines;
- the seed accounts, and everything they own wherever it points: loans, borrow
  requests, waitlist entries, bookings, fines and scores, including on books and
  resources a librarian added. A copy of a console-added book that a seed
  account held (a pending borrow request or an open loan) goes back to
  available first, so the book is not left with a copy held by nobody. A lost
  or maintenance copy stays as it is.

**A re-seed never touches:** books and resources a librarian added, their
copies, other students' loans, requests, bookings and fines on them, other
accounts (including admin accounts), and the shared barcode sequence.

Only the reset is atomic: it runs in one transaction, so a failure part-way
through it leaves the database as it was. The recreate that follows is not in
that transaction, so a failure there leaves the demo data partly made; running
the seed again repairs it.

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
| GET | `/loans/me` | ✓ | Open loans, with computed fine/renewal/overdue fields; a returned loan, or one closed because its copy was marked lost, is left out |
| POST | `/loans/:id/renew` | ✓ | Renew (blocked by renewal cap or an active waitlist; writes the overdue `Fine` if late); 409 for a returned or lost loan |
| POST | `/loans/:id/return` | ✓ | Return (creates a `Fine` if overdue; cascades the waitlist); 409 for a returned or lost loan |
| POST | `/reservations` | ✓ | Join a book's waitlist |
| GET | `/reservations/me` | ✓ | Your queue position or active claim |
| DELETE | `/reservations/:id` | ✓ | Leave the waitlist / decline a claim |
| GET | `/resources/availability?type=&date=` | — | Seats/rooms with per-slot occupancy for a date |
| POST | `/bookings` | ✓ | Book a seat, or request a room (`{ resourceId, startTime, endTime }`); 409 + alternatives on conflict |
| GET | `/bookings/me` | ✓ | Your bookings and room requests, with computed grace-window status; also a booking the library cancelled or moved, for 7 days (see *Bookings and resources*) |
| POST | `/bookings/:id/checkin` | ✓ | Check in within the grace window |
| POST | `/bookings/:id/cancel` | ✓ | Cancel before check-in, or withdraw a room request |
| GET | `/profile/reliability` | ✓ | Reliability score, tier, and recent history |
| GET | `/fines/me` | ✓ | Your fines, newest first (up to 50), with `outstandingTotal` over all of them (see *Fines*) |
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
| GET | `/admin/fines?search=&status=&page=&pageSize=` | admin | Fines and, as `accruing` rows, loans still out and past due; newest first, 25 per page (up to 100), with the total behind the filters |
| POST | `/admin/fines/:id/paid` | admin | Record a payment: `{ amount }`, the amount the librarian saw; 409 if the fine is already paid, was waived, or is no longer that amount |
| POST | `/admin/fines/:id/adjust` | admin | Lower a fine, or waive it at 0: `{ amount, reason }` (whole rupees below the current amount; reason up to 300 characters, required) |
| GET | `/admin/books?search=&page=&pageSize=` | admin | Books in title order, each with its copies, 25 per page (up to 100), with the total behind the search and the genres in use |
| POST | `/admin/books` | admin | Add a book and its first copies: `{ isbn, title, author, genre, description?, publishedYear?, copies }`; answers 201; 409 for an ISBN already in the catalogue |
| PATCH | `/admin/books/:id` | admin | Change those fields except `copies` (at least one); `null` clears `description` and `publishedYear` |
| POST | `/admin/books/:id/copies` | admin | Add `{ count }` (1-20) available copies; a waiting student gets a claim on them first |
| POST | `/admin/copies/:id/maintenance` | admin | Take a copy on the shelf out of service; no body |
| POST | `/admin/copies/:id/lost` | admin | Mark a copy lost. For a copy on loan the body is `{ replacementCharge, borrowerId }` (whole rupees 0-10,000, and the student the librarian saw holding it); otherwise none |
| POST | `/admin/copies/:id/restore` | admin | Bring a maintenance or lost copy back to available, optionally with `{ waiveReplacementCharge }` for a copy lost on loan; answers `{ book, replacementWaived }` |
| GET | `/admin/students/:id` | admin | A student's profile, reliability score and log, and their loan, booking and fine history; 404 for an unknown id or an admin account |
| POST | `/admin/students/:id/reliability` | admin | Adjust the score by hand: `{ delta, reason }` (a whole number from -10 to 10, not 0; reason up to 300 characters, required) |
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
is reached. Room requests that are still pending, declined or expired, or that
the student withdrew, are not listed (they live on the Requests page). A room
booking a librarian approved is listed, and stays listed if it is cancelled
later, by the student or the library; so is a seat booking the student
cancelled. Each booking carries `cancelledBy` (`student` or `library`),
`cancelReason`, `movedFromName` and `canManage`, which is true exactly while the
booking is `booked`. `page` starts at 1 and `pageSize` defaults to 25 (up to
100).

**Cancel and reassign.** Both are conditional updates on the booking still
being `booked` and not past its grace period, so of a librarian and a student
acting at once only the first write lands, and a librarian who lost is told what
happened with a 409: "Already cancelled by the library.", "The student already cancelled
this booking.", "The student already checked in.", "This booking has already
finished.", "This booking has already been released.", or, for a room request,
"This is a room request. Decide it on the Requests page." An unknown booking, or
a room request the student withdrew, is a 404. Neither changes the student's reliability score. A cancel records who
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

## Fines

A fine is `outstanding` (owed, never adjusted; stored as `pending`, and the API
never says `pending`), `adjusted` (owed, lowered by a librarian), `paid` or
`waived`. Its reason is `overdue`, `no_show` or `lost` (the replacement charge
for a lost book; nothing creates no-show fines yet). It keeps its
`originalAmount` (set by the first adjustment), the librarian's note after it is
paid, and who recorded the change (`recordedBy`, null for the seed's fines or an
account that is gone; the console and app then say "the library"). Amounts are
whole rupees; the overdue rate is `FINE_PER_DAY_INR` (₹10 a day, whole days
only), applied by `overdueFineAmount` in code and `accruingAmountSql` in SQL
(`src/services/fineRules.ts`), which a test runs against each other.

**The librarian's list.** `GET /admin/fines` returns
`{ fines, total, page, pageSize }`, newest first (`date` is when the fine was
created), 25 per page (up to 100). One SQL query merges two kinds of row
(`kind`): stored fines, and `accruing` rows, which are not stored at all, one
for each loan still out (`status: 'active'`) and past its due date. An accruing
row's amount is the same whole days times ₹10 as the `fineAmount` on the
student's loan, its date is the due date, and its id is the loan's, so the paid
and adjust routes answer 404 for it. A loan overdue by under a day is listed at
₹0; one exactly at its due time is not listed. When the loan is returned or
renewed late the fine is written and the accruing row goes. `search` (up to 100
characters) matches the student's name or email, ignoring case, with `%`, `_` and
`\` taken literally; `status` is `accruing`, `outstanding`, `adjusted`, `paid` or
`waived` (`pending` is a 400). `canSettle` is true exactly while a fine is
outstanding or adjusted.

**Mark paid, waive and adjust** are conditional writes, so of a payment and an
adjustment (or two of either) racing on one fine the database applies one and
the other is told why. Mark paid sends `{ amount }`, the amount the librarian
saw, and applies only while the fine is still outstanding or adjusted and still
exactly that amount: a payment collected against an amount a colleague has since
lowered is refused ("This fine was just changed to ₹X. Check it before marking
it paid.") instead of being recorded as paying the new one. Otherwise 409 "This
fine is already paid." or "This fine was waived."; an unknown fine, or an
accruing row's id, is a 404. Adjust takes `{ amount, reason }`: a whole number of
rupees of 0 or more and lower than the current amount (else 400 "The new amount
must be lower than ₹X."), and a required reason (trimmed, up to 300 characters).
`0` makes the fine `waived`, anything else `adjusted`; an adjusted fine can be
lowered again or paid, a paid or waived one cannot change.

**What students see.** `GET /fines/me` returns `{ fines, outstandingTotal }`: the
student's newest 50 fines, each with `id`, `reason`, `item` (book title, or the
resource's name for a no-show), `amount`, `originalAmount`, `status`, `date` and
`note` (the librarian's reason), and `outstandingTotal`, the outstanding and
adjusted amounts over all of the student's fines, not only the 50. Accruing
amounts are not in it: the student sees those on each overdue loan.

## Catalogue and copies

**The books list.** `GET /admin/books` returns
`{ books, total, page, pageSize, genres }` in title order, 25 per page (up to
100). `search` (up to 100 characters, case-insensitive, `%`, `_` and `\` literal)
matches title, author, ISBN or the barcode of any copy; `genres` is every genre
in use across the whole catalogue, not narrowed by the search or the page. A
book carries `totalCopies` and `availableCopies` as students see them (see
*Response shape*) and its copies in barcode order, each with `id`, `barcode`,
`status` (`available`, `on_loan`, `held`, `maintenance`, `lost`), `borrower` and
`dueAt` (from its open loan; empty for a copy marked borrowed with no open loan,
which the seed has some of) and `owedReplacement` (for a lost copy, the
replacement fine of its latest lost loan while it is still owed). `held` is a
copy kept for a pending borrow request; it is not the student API's
`heldCopies`, which counts shelf copies earmarked for a waitlist claim.

**Books.** An ISBN is required, trimmed, up to 20 characters and unique (409
"A book with this ISBN is already in the catalogue."); there is no checksum
check, because the seed's ISBNs are placeholders. Title and author are required
(up to 200 characters), genre is required on create and cannot be blanked on
edit (up to 50), a description is up to 2000 characters (blank or `null`
clears it), the published year runs from 1450 to the current year (`null`
clears it), and `copies` and `count` are 1-20. A `PATCH` with nothing to change
is a 400. Adding copies runs the same waitlist hand-off a return does, so a
student waiting for the title gets a claim on a new copy straight away.

**Barcodes.** Every copy has a unique barcode, `SL-00001` and up (widening past
`SL-99999`), handed out by the database as the column's default
(`next_copy_barcode()` over the sequence `BookCopy_barcode_seq`, in migration
`console_catalogue`), so every way of adding a copy gets one. They are never
typed or edited, and students never see them. The migration numbered the copies
that already existed in book-title order, then copy id, and moved the sequence
past them. The sequence belongs to the column, so the tests' `TRUNCATE ...
RESTART IDENTITY` starts the numbering again; a re-seed does not.

**Copy rules.** Each copy action is one transaction that locks the book's row,
then changes the copy with an update conditional on the status it read, so a
student borrowing or returning at the same moment cannot be overwritten; the
409 says what the copy is now.

- *Maintenance* only from the shelf (available); a copy on loan, in
  maintenance, lost or held answers 409.
- *Lost* from the shelf (available or maintenance), or while on loan (below). A
  copy marked borrowed with no open loan is marked lost with no fines.
- *Restore* from maintenance or lost to available, then the waitlist hand-off a
  return runs (`onBookReturned`), so a waiting student gets it first. From
  available, on loan or held it is a 409.
- *The waitlist refusal.* Taking an available copy out of service (maintenance,
  or lost from the shelf) is refused, 409 "This copy is set aside for a student
  on the waitlist.", when it would leave fewer available copies than live
  waitlist claims for the title (stale claims are expired first).
- *Held copies.* A copy kept for a pending borrow request accepts no action:
  409 "This copy is held for a borrow request."

**Lost while on loan.** For a copy with an open loan, `POST
/admin/copies/:id/lost` needs `{ replacementCharge, borrowerId }`: whole rupees
from 0 to 10,000 (0 charges nothing), and the student the librarian saw holding
the copy (400 "Enter a replacement charge for the copy on loan." or "Name the
borrower of the copy on loan." when only one is missing; with neither, which is
what a shelf dialog sends for a copy that has gone out on loan since the page
loaded, it is a 409 "This copy is now on loan."). If someone else has it now it is a
409 ("This copy's borrower has changed. Check it before marking it lost."), and
a `borrowerId` sent for a copy nobody has any more is a 409 too ("This copy is no
longer on loan."), so a charge never lands on the wrong student. In one
transaction the loan ends as lost (`lostAt`), conditional on it still being
active; the copy becomes lost; the days overdue so far become an `overdue` fine
(same rule as a late return, when above 0); and the charge becomes a `lost` fine
(when above 0). A student returning or renewing at the same moment is the other
side of that condition: exactly one wins, and the loser gets a 409.

**Restoring a copy lost on loan.** The loan stays closed as lost and its overdue
fine stands. With `{ waiveReplacementCharge: true }` the replacement fine of the
copy's latest lost loan is waived in the same transaction if it is still owed
(outstanding or adjusted), recorded with the librarian and the reason "Book
returned after it was marked lost"; a paid one is not refunded. If it was paid
or waived a moment earlier the copy is restored anyway and `replacementWaived`
is false.

**A lost loan is a closed loan.** `status: 'lost'` with `lostAt`: not active, not
returned, not overdue after `lostAt`. So every check for an open loan uses
`status: 'active'`. `GET /loans/me` leaves the loan out; the student's return and
renew answer 409 "This loan was closed because the copy was marked lost."; the
Dashboard's overdue count stops counting it from `lostAt` (it was overdue
before) and circulation never counts it as a return; and it does not stop the
student asking for the title again.

## Students

`GET /admin/students/:id` returns the student's `name`, `email`, `roll`
(`'Pending'` when none), `score`, `tier` (the function `/profile/reliability`
uses: Good standing from 80, Building back up from 50, Needs improvement from
25, At risk below) and, newest first and at most 50 of each, `history` (the score
log: date, score, change, reason, and the librarian's name for a manual entry),
`loans` (status `active`, `overdue`, `returned` or `lost`), `bookings` (the
Bookings page's statuses, plus room requests that are pending, declined or
expired) and `fines` (as on the Fines page, with the student's accruing rows). An
unknown id, or an admin account, is a 404.

`POST /admin/students/:id/reliability` takes `{ delta, reason }`: a whole number
from -10 to 10 but not 0, and a required reason (up to 300 characters). It is
stored as `Library adjustment: <reason>` with the librarian, through the same
0-100 clamp as an automatic change, and the student's reliability card shows it:
a drop is the card's note ("Your reliability score recently dropped: Library
adjustment: <reason>."), also in Good standing (with no "return to Good standing"
clause there) for as long as it is the newest entry in the score log. The
student's row is locked while the score is read and written, so a check-in
bonus landing at the same moment is not lost. If the clamp would change nothing
the answer is 409 ("The score is already at 100." or "... at 0.") and nothing is
logged.

## Live events

`GET /admin/events` streams Server-Sent Events to the admin console: `ready` on
connect, then one event per change:

```
event: request.created
data: {"topics":["requests"],"kind":"borrow","summary":"Aditi Sharma wants to borrow Clean Code"}
```

Events name what changed (`requests`, `metrics`, `bookings`, `resources`,
`fines`, `catalogue`, `students`), never the new state: the console refetches.
A write publishes once, after it has committed; a refused write publishes
nothing.

| Change | Event | Topics |
|---|---|---|
| A request created, decided, withdrawn or lapsed | `request.created`, `request.decided`, `request.cancelled`, `request.expired` | `requests` (an approval also `metrics`, an approved room request also `bookings`) |
| A booking that is not a request: a seat booked, a check-in, a cancel or a move | `booking.changed` | `bookings`, `metrics` |
| A resource added, edited, taken offline or brought back | `resource.changed` | `resources`, `metrics` |
| A waitlist join or leave | `activity` | `metrics` |
| A student's return or renewal | `loan.changed` | `metrics`, `catalogue` (a renewal's new due date, or the copy a return frees); and `fines` too when the loan was past due (even by under a day), since its accruing row turns into a stored fine |
| A fine marked paid, adjusted or waived | `fine.changed` | `fines` |
| A book added or edited, copies added, a copy to maintenance, lost from the shelf, or restored | `catalogue.changed` | `catalogue` |
| A copy lost while on loan | `catalogue.changed` | `catalogue`, `fines`, `metrics` |
| A copy restored with its replacement fine waived | `catalogue.changed` | `catalogue`, `fines` |
| A manual reliability adjustment | `student.changed` | `students` |

The publish helpers are in `src/lib/events.ts`: `publishActivity`,
`publishBookingChange`, `publishResourceChange`, `publishFineChange`,
`publishCatalogueChange(extra)` (the topics a change also moves),
`publishStudentChange` and `publishLoanChange(pastDue)`. A `: ping` comment goes
out every 25 seconds, and each stream ends after 15 minutes, so the console
reconnects and its token and role are checked again.

The bus is in-process (`src/lib/events.ts`). That reaches every console while
one instance serves the API, as on Render's free plan; several instances would
need a shared bus such as Redis pub/sub.

## Response shape

Most list/detail endpoints return **normalized fields alongside computed
ones** rather than one or the other — e.g. a book's `totalCopies` (its
copies that are not lost; the `Book.totalCopies` column is no longer read) and
its `availableCopies`/`heldCopies`/`waitlistCount` are all counted from rows
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
├── seed.ts              # the `npm run seed` command line
├── seedData.ts          # demo data and the re-seed reset — see `npm run seed` above
└── history.ts           # the generated four-week history, fines included
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
