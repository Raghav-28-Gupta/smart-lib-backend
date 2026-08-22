# SmartLib — Core Backend (Node + TypeScript + Express + Prisma)

Owns auth, lending, and booking. This is the **only** service the Flutter client
talks to; it calls the FastAPI service internally for anything ML-related.

## Prerequisites

- Node.js 18+ (developed on v22)
- A Postgres database — Neon, `docker-compose up` from the repo root, or a local install

## Setup

```bash
cd backend
npm install                     # also runs `prisma generate` via postinstall
cp ../.env.example .env         # then fill in DATABASE_URL
```

`.env` needs at minimum:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/smartlib?sslmode=require
AI_BACKEND_URL=http://127.0.0.1:8000
JWT_SECRET=change-me-in-phase-1
PORT=3000
```

> Use `127.0.0.1`, not `localhost`, for `AI_BACKEND_URL`. On Windows, Node
> resolves `localhost` to `::1` first while uvicorn binds IPv4 only, which fails
> with `ECONNREFUSED` even though the service is running.

> If you're on Neon, use the **direct / unpooled** connection string for
> migrations. `sslmode=require` is mandatory.

## Database migration

```bash
npx prisma migrate dev --name init --create-only
```

Then open the generated `prisma/migrations/<timestamp>_init/migration.sql` and
append the overlap constraint — Prisma's schema language can't express
`EXCLUDE`, so it has to be added as raw SQL:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ResourceBooking"
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("startTime", "endTime") WITH &&
) WHERE (status IN ('booked', 'checked_in'));
```

Apply it:

```bash
npx prisma migrate dev
```

This is what makes double-booking a *database-level* impossibility rather than
something the application layer has to get right every time.

## Run

```bash
npm run dev        # tsx watch on src/index.ts, http://localhost:3000
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`,
`npm run prisma:studio`.

## Endpoints (Phase 1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Is this service up |
| GET | `/health/db` | Proves the Node → Postgres link (`SELECT 1`) |
| GET | `/health/ai` | Proves the Node → FastAPI link |

```bash
curl localhost:3000/health      # {"status":"ok","service":"node-backend"}
curl localhost:3000/health/db   # {"status":"ok","service":"postgres"}
curl localhost:3000/health/ai   # {"status":"ok","service":"ai-backend"}
```

`/health/ai` requires the AI backend to be running — see `../ai-backend/README.md`.

## Notes on Prisma 7

This project is on Prisma 7, which differs from most tutorials (written for v6):

- The generator is `prisma-client` (not `prisma-client-js`) and emits to
  `src/generated/prisma`, which is gitignored and rebuilt by `npm install`.
- The datasource URL lives in `prisma.config.ts`, not in `schema.prisma`.
- `.env` is no longer auto-loaded — `prisma.config.ts` imports `dotenv/config`.
- `PrismaClient` requires a driver adapter; we use `@prisma/adapter-pg`.

## Layout

```
src/
├── index.ts            # app bootstrap
├── routes/
│   ├── health.ts       # /health, /health/db, /health/ai
│   └── auth.ts         # placeholder — Phase 2
├── services/           # business logic — Phase 2
├── middleware/         # auth guards, error handling — Phase 2
└── lib/
    ├── prisma.ts       # PrismaClient singleton
    └── aiClient.ts     # the only caller of the FastAPI service
```
