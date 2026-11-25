# SmartLib — Core Backend

The Core Backend owns authentication, book lending, physical resource scheduling (seats & rooms), overdue fine calculations, waitlists, and user reliability scoring. It is the **single public entrypoint** for the Flutter client and communicates internally with the FastAPI AI backend for predictions and recommendations.

## Tech Stack
- **Runtime**: Node.js 22 (`engines: 22.x`, matching Render)
- **Framework**: Express 5 + TypeScript
- **ORM / Database**: Prisma 7 + PostgreSQL (Neon) with `@prisma/adapter-pg`
- **Validation**: Zod
- **Testing**: Vitest + Supertest

---

## Development Commands

Always run these commands from the `backend/` directory:

```bash
# Install dependencies & generate Prisma client
npm install

# Start development server (tsx watch on src/index.ts, http://localhost:3000)
npm run dev

# Run type checking without emit
npm run typecheck

# Build for production
npm run build

# Start production build
npm start

# Run test suite with Vitest
npm test

# Run tests in watch mode
npm run test:watch

# Prisma operations
npm run prisma:generate    # Generates client to src/generated/prisma
npm run prisma:migrate     # Runs prisma migrate dev
npm run prisma:studio      # Opens Prisma Studio web interface
```

---

## Environment Configuration (`backend/.env`)

Required environment variables:
```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/smartlib?sslmode=require
AI_BACKEND_URL=http://127.0.0.1:8000
JWT_SECRET=your-secret-key
PORT=3000
```

> **Windows IPv4 Notice**: Always use `http://127.0.0.1:8000` for `AI_BACKEND_URL`. On Windows, Node resolves `localhost` to IPv6 `::1` first while Uvicorn binds to IPv4 only, causing `ECONNREFUSED` connection failures.

> **Neon Connection Notice**: Use the **direct / unpooled** connection string for database migrations. `sslmode=require` is mandatory.

Optional email settings (all commented out in `.env.example`; email is off unless the first two are set, and nothing else depends on them): `BREVO_API_KEY` (a secret), `MAIL_FROM`, `MAIL_FROM_NAME` (default "SmartLib") and `MAIL_ALLOWED_DOMAINS` (comma-separated). Never put a real key in a committed file. The rules are under *Notices, Disputes and Reports*.

`SWEEP_TOKEN` (optional, a secret, commented out in `.env.example`): the credential of `POST /internal/sweep`, which answers 404 while it is unset or blank. Environment only, never committed, printed or logged. `AI_BACKEND_URL` unset or blank means **no no-show scoring at all** (production today: the AI service is not deployed); recommendations and `/health/ai` still read it with the localhost default. The rules are under *No-shows, the Sweep and Scoring*.

---

## Prisma 7 Architecture & Nuances

This project uses **Prisma 7**, which has specific configuration patterns:
- **Generator**: Uses `prisma-client` (not `prisma-client-js`) and emits to `src/generated/prisma` (which is gitignored).
- **Datasource Configuration**: Datasource URL is defined in `prisma.config.ts` (importing `dotenv/config`), not inside `schema.prisma`.
- **Driver Adapter**: Uses `@prisma/adapter-pg` with a pooled `pg` client in `src/lib/prisma.ts`.
- **Module format**: The generator is pinned to `moduleFormat = "cjs"` + `importFileExtension = "js"`. Never remove them: dev (`tsx`) and tests (vitest) pass without them, but the compiled production server crashes at startup. Anything that changes how the app compiles or starts must be checked by building and *running* the compiled server (`npm run build && npm start`), not just `npm test`.
- **Deployment**: Render, Node runtime, branch `main`, configured in Render's dashboard (settings listed in README "Deploy"; keep them and `ci.yml`'s `start` job in sync). The build command runs `prisma migrate deploy`, so new migrations must be safe to apply to live data. Build with `npm ci --include=dev` (`NODE_ENV=production` would skip TypeScript). `CORS_ORIGINS` restricts browser origins in production.

---

## Critical Database Constraint (Conflict-Free Booking)

To guarantee zero double-bookings at the database level, the `ResourceBooking` table uses a PostgreSQL `EXCLUDE USING gist` constraint. Because Prisma's schema syntax cannot represent exclusion constraints, every migration modifying resource bookings must use the `--create-only` workflow:

1. Create migration draft:
   ```bash
   npx prisma migrate dev --name add_booking_constraint --create-only
   ```
2. Append the SQL constraint to `prisma/migrations/<timestamp>_add_booking_constraint/migration.sql`:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;

   ALTER TABLE "ResourceBooking"
   ADD CONSTRAINT no_overlapping_bookings
   EXCLUDE USING gist (
     "resourceId" WITH =,
     tstzrange("startTime", "endTime") WITH &&
   ) WHERE (status IN ('requested', 'booked', 'checked_in'));
   ```
3. Apply migration:
   ```bash
   npx prisma migrate dev
   ```
4. **Keep the per-resource advisory lock in `createBooking`.** The constraint alone guarantees no double booking, but simultaneous inserts can make Postgres abort the losers with a deadlock (`40P01`, a 500 here) instead of `23P01`. This only reproduces on a low-latency database with warm connections (CI), never on Neon, so a green local `npm test` does not prove it. To check booking concurrency locally, run the suite against a Docker `postgres:16` (`TEST_DATABASE_URL=postgresql://...@localhost:5433/...`), as CI does.

A pending room request (`requested`) holds its slot. `BorrowRequest` also
carries a hand-written partial unique index, `BorrowRequest_one_pending_per_title`.
`IssueReport` (migration `20261122164800_attention_reports`) carries a
hand-written CHECK, `IssueReport_exactly_one_target`
(`num_nonnulls("bookCopyId", "resourceId") = 1`: a report names a copy or a
resource, never both or neither), and two partial unique indexes,
`IssueReport_one_open_per_copy` (`"userId", "bookCopyId"`) and
`IssueReport_one_open_per_resource` (`"userId", "resourceId"`), both
`WHERE status = 'open'`: one open report per student and target. Prisma models
none of these, and no later migration or generator may drop them. Check every
generated migration for a `DROP` of `no_overlapping_bookings`,
`BorrowRequest_one_pending_per_title`, `IssueReport_exactly_one_target`,
`IssueReport_one_open_per_copy` or `IssueReport_one_open_per_resource` before
applying it.

---

## Live Events

Every write that changes what an admin page shows publishes an event once it
has committed, and a refused write publishes nothing. Topics: `requests`,
`metrics`, `bookings`, `resources`, `fines`, `catalogue`, `students`,
`attention`. The helpers in `src/lib/events.ts`:

- `publish(event)`: the raw call; the request events (`request.created`,
  `request.decided`, `request.cancelled`, `request.expired`) use it, on
  `requests` (an approval also `metrics`, an approved room request also
  `bookings`), and so does `request.scored` (`scoreBooking`, once after it wrote
  a room request's priority: the create event fired before the score existed, so
  an open Requests page refetches on this one).
- `publishActivity()`: a change that only moves Dashboard numbers (a waitlist
  join or leave); `metrics`.
- `publishBookingChange()`: a booking that is not a request (`booking.changed`);
  `bookings` and `metrics`. The no-show sweep publishes it once per sweep that
  recorded any no-show, and an overturned no-show publishes it too.
- `publishResourceChange()`: a resource added, edited, taken offline or brought
  back (`resource.changed`); `resources` and `metrics`.
- `publishFineChange()`: a fine marked paid, adjusted or waived, a dispute opened
  on it, or a dispute upheld (`fine.changed`); `fines`. Opening or settling a
  dispute also publishes `publishAttentionChange()` right after it.
- `publishCatalogueChange(extra)`: a book added or edited, copies added, a copy
  to maintenance, lost from the shelf or restored (`catalogue.changed`);
  `catalogue` plus whatever `extra` topics the change also moves. A copy lost
  while on loan passes `['fines', 'metrics', 'attention']` (closing the loan
  removes its overdue item from the queue); a restore that waived the
  replacement fine passes `['fines']`, and `['fines', 'attention']` when it also
  closed a student's dispute of that fine.
- `publishStudentChange()`: a manual reliability adjustment, a no-show the sweep
  recorded (its penalty) or an overturned one (its restore) (`student.changed`);
  `students`.
- `publishLoanChange(pastDue)`: a student's return or renewal (`loan.changed`);
  `metrics` and `catalogue` (a renewal's new due date shows on the Catalogue and
  student pages), and `fines` and `attention` as well when the loan was past due
  (its accruing row on the Fines page turns into a stored fine, and its overdue
  item leaves the Needs attention queue). It replaced `publishActivity()` (and,
  for a past-due renewal, `publishFineChange()`) in `returnLoan` and
  `renewLoan`.
- `publishAttentionChange()`: the Needs attention queue changed
  (`attention.changed`, topic `attention`): a reminder or escalation sent, a fine
  dispute opened or settled, a problem report filed, confirmed or dismissed, a
  return that carried a report, a no-show dispute opened (by the student) or
  answered (overturned or upheld). A service publishes it once, after the commit
  and after the notice's email outcome has been written (see *Notices, Disputes
  and Reports* below), so the console's refetch sees the true "emailed" or "not
  emailed"; a refused write publishes nothing. `loan.changed` carries `attention`
  when the loan was past due; a payment publishes `fine.changed` only, since a
  disputed fine cannot be paid and so a payment never moves the queue.

`GET /admin/events` streams them to the admin console. A new mutation the
console should see must publish one, with a test using `recordEvents()` from
`test/helpers/events.ts`, including that a refusal publishes nothing.

---

## Fines, Copies and Lost Loans

- **Fines.** Amounts are whole rupees. The database word for an owed, never
  adjusted fine is `pending`; the API says `outstanding`. The overdue amount
  comes only from `src/services/fineRules.ts` (`overdueFineAmount` in code,
  `accruingAmountSql` in SQL, kept in step by a test); the Fines page's accruing
  rows, the student's loan line and a late return all use it. Mark paid, adjust
  and waive are conditional updates, never read-then-write, and mark paid also
  checks the amount the librarian saw.
- **Copies.** Every copy action is one transaction that locks the book's row
  first (`FOR NO KEY UPDATE`), then updates the copy conditional on the status it
  read; the loan is changed before the copy, the order a return uses. A copy
  restored or added runs `onBookReturned` so a waiting student gets it first.
  Barcodes come only from the database default (`next_copy_barcode()`): never
  generate one in code. A book's `totalCopies` is counted from its copies that
  are not lost (`totalCopiesByBook`); the `Book.totalCopies` column is not read.
- **A lost loan is a closed loan.** It has `status: 'lost'` and `lostAt`, no
  `returnedAt`, and is not overdue after `lostAt`. So an open loan is one with
  `status: 'active'` (overdue is computed from `dueAt`, never stored): every
  "open loan" check uses it, or excludes both `returned` and `lost`, and a
  `returnedAt: null` test alone would count a lost loan as still out. The metrics
  treat `lostAt` like `returnedAt`. A student's return or renew of one is a 409.
- **Time zone in raw SQL.** Most date columns (`Loan`, `Fine`, the reliability
  log, ...) are plain `timestamp(3)` holding UTC; only the booking and borrow
  request ones are `timestamptz`. Prisma binds a JS `Date` as UTC wall-clock
  text, so a raw query against a plain-`timestamp` column must cast it
  `${now}::timestamp`, never `::timestamptz`, which the session's time zone would
  shift by hours. `fineRules`, `adminFineService`, `adminCopyService` and
  `adminAttentionService` rely on it.
  **`timestamptz` columns (the booking times) need the other rules.** The pg adapter
  binds a `Date` as text with no offset, so a bare `${d}` against a `timestamptz`
  column is read in the database SESSION's zone and the instant moves by the zone's
  offset. A `Date` bound against one goes through `asUtcInstant(d)`
  (`noShowService.ts`: `(${d}::timestamp AT TIME ZONE 'UTC')`), including any
  `now + minutes` worked out in JS. The read side is the mirror: a raw `SELECT` of a
  `timestamptz` column must read it `AT TIME ZONE 'UTC'` (`adminAttentionService`'s
  no-show queue and `noShowDisputeService`'s lock read do; a bare read came back
  5½ hours shifted under `Asia/Kolkata`). A typed Prisma read has no such problem.
  Test it under `SET LOCAL TIME ZONE` (the sweep's tests do, in New York and
  Kolkata). **Known limitation:** the older raw reads (`adminBookingService.filteredBookings`,
  `adminStudentService.bookingsFor`, `derivedStatusSql` and `requestHolds`'s
  expiry update) do neither and are correct only because the Neon and test DB
  sessions are UTC; keep the production session on GMT (Neon's default) and do not
  copy them.

---

## Notices, Disputes and Reports

A **notice** is the library's message to one student (`Notice`; kinds
`overdue_reminder`, `overdue_escalation`, `dispute_outcome`, `report_outcome`,
`booking_reminder`, `no_show`, `no_show_outcome`),
shown for 7 days (`REQUEST_OUTCOME_VISIBLE_DAYS`), at most 20, by
`GET /notices/me`. Everything that writes one (`adminAttentionService` for a
reminder or escalation, `disputeService`, `reportService`, the sweep and
`noShowDisputeService` for the booking kinds, and
`adminFineService.adjustFine` and `adminCopyService.restoreCopy` when they close
a dispute) follows the same order:

1. **The notice is created in the action's transaction** (`createNotice(tx, ...)`),
   so it commits or rolls back with the action. Its email status starts
   `skipped`.
2. **`deliverNotice(notice)` runs once, after the commit.** It emails the student
   (awaited, bounded by the mailer's 5 seconds, never throws) and writes the
   outcome (`sent`, `failed` or `skipped`, and `emailedAt`) to the notice.
3. **Then publish**, once: `publishAttentionChange()` plus whatever fine,
   catalogue or loan event the action moves (a restore that closes a dispute has
   no separate attention event: its `catalogue.changed` carries the `attention`
   topic). A refused action writes, sends and publishes nothing, and a repeated
   click sends nothing extra because its conditional update or rule refuses it
   first. Once the notice has committed nothing refuses the action (a reminder
   still answers 200 if the student returned the book during the email), so read
   whatever the answer needs inside the transaction, not after it.
4. **An email problem never fails, blocks or half-applies an action.** Never
   await the mailer inside a transaction, and never let its failure change the
   answer.

Conventions the new services follow:

- **Conditional updates with specific 409s.** A status change is one UPDATE with
  its precondition in the WHERE (a dispute: the fine is `pending` or `adjusted`
  with `disputedAt` null; a payment adds `disputedAt IS NULL`; a dispute or a
  report closes `WHERE status = 'open'`), never read-then-write. When nothing
  matched, read the row again and say why, in a message that names the reason.
- **Lock order: the fine row, then the dispute row.** `adjustFine`, `upholdDispute`
  and `waiveReplacementFine` lock the fine `FOR NO KEY UPDATE` first; opening a
  dispute updates the fine before inserting the dispute. Keep that order, or two
  of these can wait on each other in a circle. `closeReport` must take no loan,
  copy or book lock: a student's return takes the loan's lock and then writes a
  report row, so a closing step that locked them would wait in a circle (`40P01`,
  a 500).
- **A unique violation aborts a Postgres transaction.** Where the transaction has
  to go on (`returnLoan` with a report, when the student already has an open report
  on that copy), write with `createMany({ data, skipDuplicates: true })` and
  read the count, never insert and catch. Where the violation is the answer
  (`createDispute`, `createResourceReport`), let the insert fail and map it (Prisma
  P2002, or P2039 with SQLSTATE 23505 in its message) to the 409.
- **Confirming a report runs the action first, then closes it.** `confirmReport`
  calls the Catalogue or Resources service (their own transactions and events),
  then one small transaction closes the report and writes the notice. If another
  librarian resolves the report in between, the second confirm answers a bare 409
  "This report was already resolved." while its action stays done (a known limit;
  the README's *Problem reports* says how to undo it). A report never charges
  anyone: confirm-as-lost calls `markCopyLost` with no charge fields.
- **A new `/admin` route** answers 401 without a token and 403 for a student; the
  student routes (`/notices/me`, `/fines/:id/dispute`, `/reports`) touch only the
  caller's own rows, and another student's id is a 404 (a resource the student
  never booked is a 403).

**Email is optional and never fails an action.** The mailer (`src/lib/mailer.ts`):

- **Off unless configured.** `BREVO_API_KEY` and `MAIL_FROM` must both be set
  (`MAIL_FROM_NAME` defaults to "SmartLib"); otherwise `sendEmail` answers
  `skipped` with no network call. Settings are read from `process.env` on every
  call. `isEmailConfigured()` feeds `emailEnabled` in `GET /admin/attention`.
- **Brevo's HTTPS API**, through Node's built-in `fetch` (Render's free plan blocks
  SMTP, and there is no new dependency). The wait is 5 seconds (`MAIL_TIMEOUT_MS`)
  and there is no retry; a non-2xx answer, a network error or a timeout is
  `failed`.
- **It never throws and never logs a body, a recipient or the key** (only an HTTP
  status or an error name). Do not add a log line that does. `BREVO_API_KEY` is a
  secret: an environment variable only, never committed, printed or logged.
- **Skips by address.** The seed's demo accounts (`DEMO_EMAIL_PATTERN`:
  `aditi.sharma@thapar.edu`, `seed.student<n>@thapar.edu`) are always `skipped`,
  and when `MAIL_ALLOWED_DOMAINS` (comma-separated) is set so is every address
  outside those domains (an exact match on the part after the `@`: a subdomain
  does not match).
- **Tests never send.** Inject a fake with `setMailTransport(...)` and restore it
  with `setMailTransport(null)`; with none injected and `NODE_ENV=test` or `VITEST`
  set (Vitest sets it whatever `NODE_ENV` the shell has) the mailer is `skipped`.
- **Only these events send email:** an overdue reminder, an escalation, a fine
  dispute resolved, a report resolved, a recorded no-show, a no-show dispute
  answered and a **room's** booking reminder (never a seat's: a free Brevo plan
  allows about 300 a day; the in-app notice is a seat's only reminder channel). Do
  not email from anything else without being asked.

---

## No-shows, the Sweep and Scoring

The behaviour and the owner's deploy steps are in README *No-shows*; these are the
rules to keep when changing the code.

- **`sweepBookings(now)`** (`noShowService.ts`) is idempotent: every change is a
  conditional update on the status just read (`WHERE status = 'booked'`), one
  transaction per booking (`SWEEP_TX_OPTIONS`, 10 s to get a connection and 15 s to
  run), the email and the events only after the commit. Two isolated steps: record
  and remind. `SweepResult.failed` is present ONLY when a step failed (its candidate
  query or any of its bookings threw): every caller must act on it (the route
  answers 500 with the counts, the timer and the lazy sweep log at error level), and
  zero counts next to `failed` mean "could not run", never "nothing to do".
- **Three callers, one function.** `POST /internal/sweep` (`routes/internal.ts`:
  `x-sweep-token` against `SWEEP_TOKEN` as SHA-256 digests with `timingSafeEqual`,
  404 when unset, mounted outside `/admin` and without `requireAuth` on purpose);
  the 60-second timer (`runScheduledSweeps` in `requestHolds.ts`, passed to
  `startExpirySweep` in `index.ts`); and `sweepIfDue()` (background, at most once a
  minute per process, called first in `listMyBookings`, `checkInBooking`,
  `cancelBooking` and the admin bookings list; never await it). The timer and
  `sweepIfDue` share one in-process guard, `sweepUnlessRunning` (a skip is silent,
  except for one error line when the running sweep has hung for over 10 minutes);
  the route does not use it. The timer and the lazy sweep are off under Vitest
  unless a test calls `enableLazySweepForTests(true)`, and
  `settleSweepsForTests()` / `resetLazySweepForTests()` wait for them. Log counts
  and booking ids only: never a name, email, the token or free text.
- **Lock order, everywhere:** booking row, then (the dispute row,) then the
  `NoShowEvent`, then the user row (`applyReliabilityDelta` locks it `FOR UPDATE`).
  Sweep: booking, event, user. Check-in: booking, event (`actualNoShow = false`),
  user. Scoring: booking, event. Overturn: booking (`FOR NO KEY UPDATE`), then the
  dispute's conditional `open` update (first, so a loser rolls back having taken no
  other lock), the booking update, the event, the user. A new writer that takes them
  in another order can deadlock (`40P01`, a 500).
- **Statuses.** `released` and `no_show` both read as `frontendStatus: 'released'`
  (a value an installed app does not know would show "Update the app"), and
  `BookingDto.noShow` is the only difference: non-null for a `no_show` booking or
  any booking carrying a dispute (an overturned one is `released` again). A
  student's cancel after the grace end is 409 "This booking has already been
  released."; `REPORTABLE_BOOKING_STATUSES` includes `no_show` and `released`.
  `NoShowEvent.reliabilityDelta` is stored NEGATIVE (the applied, clamped amount); an
  overturn gives back `-delta` when it is below 0, and nothing for 0 or null.
- **Reliability.** `RELIABILITY_NOSHOW_PENALTY = 10` and the +2 bonus are flagged
  ARBITRARY placeholders. The history ring counts a row as a miss when `delta < 0`
  or its reason starts with `NO_SHOW_REASON_PREFIX` (`"No-show: "`, exported from
  `reliabilityService.ts`: the sweep writes a zero-delta row at score 0); the
  overturn's restore reads "No-show overturned: ..." so it is not a miss.
  `buildNote` says "No missed bookings yet" for any automatic miss at 80 or more
  (existing, test-pinned design), and a zero-points overturn leaves a lone miss dot:
  both are known and documented, not bugs to fix in passing.
- **Scoring** (`noShowScoring.ts`, `noShowFeatures.ts`, `aiClient.predictNoShow`):
  `void scoreBooking(id)` after the booking commits; never inside a transaction,
  never awaited, and it FAILS OPEN (a null `priorityScore` reads as 1.0). It does
  nothing when `AI_BACKEND_URL` is unset or blank, and under Vitest unless a test
  calls `enableScoringForTests(true)`. The AI service's penalty is clamped to
  `MAX_PENALTY_CAP` (0.2) again here and `PRIORITY_WINDOW_HOURS` (6) turns it into
  at most 72 minutes in the Requests order (`orderRequests`: room requests only,
  `order=suggested` only). A booking over 24 hours stays unscored (the AI service
  refuses a `duration_minutes` over 1440). The feature definitions must match
  `ai-backend/app/ml/noshow/history.py`: `test/fixtures/noshow-features.json` is a
  byte-identical copy of `ai-backend/tests/fixtures/noshow_features.json`
  (`.gitattributes` keeps it LF); change both and the fixture together and `cmp` them.
- **Migration and seed.** `20261124083414_no_show_handling` is additive and ends with
  a backfill `UPDATE` (past unattended `booked` rows become `released`): ship it with
  the rest of the slice, never alone, after a database backup. The re-seed deletes
  disputes before bookings and no-show events before bookings and users, and writes
  every seeded past booking in its final state, so a sweep right after a seed finds
  nothing old to penalize.

---

## Code Organization

```
backend/
├── src/
│   ├── index.ts          # Server listener entry point
│   ├── app.ts            # Express app configuration & middleware pipeline
│   ├── config/           # Environment and runtime configurations
│   ├── routes/           # Express router definitions (auth, books, loans, bookings, health)
│   ├── services/         # Business logic layer (lending engine, booking scheduler, scoring)
│   ├── schemas/          # Zod request/response validation schemas
│   ├── middleware/       # JWT auth, role validation (student/admin), error handlers
│   └── lib/
│       ├── prisma.ts     # PrismaClient singleton with @prisma/adapter-pg
│       ├── aiClient.ts   # Isolated Axios/fetch client calling FastAPI AI backend
│       └── mailer.ts     # Optional Brevo email sender; never throws, never logs a body or the key
├── prisma/
│   ├── schema.prisma     # Prisma data model
│   ├── migrations/       # Migration SQL history
│   └── prisma.config.ts  # Prisma 7 configuration file
└── test/
    ├── helpers/          # Test DB utilities, mock auth tokens, seed helpers
    ├── middleware/       # Middleware unit tests
    ├── routes/           # Integration tests with Supertest
    └── setup.ts          # Vitest environment setup
```

---

## Sibling Access
When started from `backend/`, Claude has access to `../ai-backend` to verify API contracts, route schemas, and response shapes.
