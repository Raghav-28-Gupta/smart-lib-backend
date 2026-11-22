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
Check every generated migration for a `DROP` of either before applying it.

---

## Live Events

Every write that changes what an admin page shows publishes an event once it
has committed, and a refused write publishes nothing. Topics: `requests`,
`metrics`, `bookings`, `resources`, `fines`, `catalogue`, `students`. The
helpers in `src/lib/events.ts`:

- `publish(event)`: the raw call; the request events (`request.created`,
  `request.decided`, `request.cancelled`, `request.expired`) use it, on
  `requests` (an approval also `metrics`, an approved room request also
  `bookings`).
- `publishActivity()`: a change that only moves Dashboard numbers (a waitlist
  join or leave); `metrics`.
- `publishBookingChange()`: a booking that is not a request (`booking.changed`);
  `bookings` and `metrics`.
- `publishResourceChange()`: a resource added, edited, taken offline or brought
  back (`resource.changed`); `resources` and `metrics`.
- `publishFineChange()`: a fine marked paid, adjusted or waived
  (`fine.changed`); `fines`.
- `publishCatalogueChange(extra)`: a book added or edited, copies added, a copy
  to maintenance, lost from the shelf or restored (`catalogue.changed`);
  `catalogue` plus whatever `extra` topics the change also moves. A copy lost
  while on loan passes `['fines', 'metrics']`; a restore that waived the
  replacement fine passes `['fines']`.
- `publishStudentChange()`: a manual reliability adjustment
  (`student.changed`); `students`.
- `publishLoanChange(pastDue)`: a student's return or renewal (`loan.changed`);
  `metrics` and `catalogue` (a renewal's new due date shows on the Catalogue and
  student pages), and `fines` as well when the loan was past due (its accruing
  row on the Fines page turns into a stored fine). It replaced `publishActivity()`
  (and, for a past-due renewal, `publishFineChange()`) in `returnLoan` and
  `renewLoan`.

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
  shift by hours. `fineRules`, `adminFineService` and `adminCopyService` rely on
  it.

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
│       └── aiClient.ts   # Isolated Axios/fetch client calling FastAPI AI backend
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
