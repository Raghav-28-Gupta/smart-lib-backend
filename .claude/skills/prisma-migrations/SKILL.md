---
name: prisma-migrations
description: Database migration workflows and PostgreSQL constraint patterns for Prisma 7 in the backend. Use when creating or updating database schemas and migrations in backend/.
---

# Prisma 7 Migration Guide

This skill documents how to manage schema updates and database migrations in `backend/` using **Prisma 7** and PostgreSQL with custom `EXCLUDE USING gist` constraints.

## Migration Workflow

Run all commands from `backend/`:

### 1. Schema Modifications
Edit `prisma/schema.prisma` to add or modify models, fields, or relations.

### 2. Create Migration with `--create-only`
If the migration introduces or touches `ResourceBooking` or any physical resource scheduling table, always create the migration draft first:

```bash
npx prisma migrate dev --name <migration_name> --create-only
```

### 3. Add Custom PostgreSQL Constraints
Open the newly generated migration file:
`prisma/migrations/<timestamp>_<migration_name>/migration.sql`

If not already present, ensure the `btree_gist` extension and the exclusion constraint are included:

```sql
-- Ensure extension exists
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prevent overlapping bookings for active reservations on the same resource
ALTER TABLE "ResourceBooking"
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("startTime", "endTime") WITH &&
) WHERE (status IN ('booked', 'checked_in'));
```

### 4. Apply the Migration
```bash
npx prisma migrate dev
```

### 5. Regenerate Prisma Client
```bash
npm run prisma:generate
```
This writes the updated TypeScript client to `src/generated/prisma`.

## Troubleshooting & Tips
- **Direct Neon URL**: Neon pooled connections do not support DDL commands. Verify `DATABASE_URL` in `backend/.env` points to the unpooled/direct database endpoint during migration runs.
- **Prisma 7 Config**: Datasource connection string resolution is managed in `prisma.config.ts`.
