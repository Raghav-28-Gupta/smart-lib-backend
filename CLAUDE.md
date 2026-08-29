# SmartLib — Core Backend

The Core Backend owns authentication, book lending, physical resource scheduling (seats & rooms), overdue fine calculations, waitlists, and user reliability scoring. It is the **single public entrypoint** for the Flutter client and communicates internally with the FastAPI AI backend for predictions and recommendations.

## Tech Stack
- **Runtime**: Node.js 18+ (tested on v22)
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
   ) WHERE (status IN ('booked', 'checked_in'));
   ```
3. Apply migration:
   ```bash
   npx prisma migrate dev
   ```

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
