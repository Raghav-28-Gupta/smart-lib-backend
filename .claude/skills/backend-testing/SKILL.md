---
name: backend-testing
description: Testing patterns and workflows for the backend package with Vitest, Supertest, and Prisma test databases. Use when writing or modifying tests in backend/.
---

# Backend Testing Patterns

SmartLib backend tests use **Vitest** as the test runner and **Supertest** for HTTP endpoint integration tests.

## Running Tests

Run all commands from `backend/`:

```bash
# Run all tests once
npm test

# Run a specific test file
npx vitest run test/routes/bookings.test.ts

# Run tests in watch mode
npm run test:watch

# Run tests matching a name pattern
npx vitest -t "conflict-free booking"
```

## Test Database Lifecycle

- The `pretest` npm script runs `node scripts/migrate-test-db.mjs` automatically before running tests.
- Database clean state: Import `resetDb` from `test/helpers/db.ts` and invoke it in `beforeEach` to reset all tables:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { resetDb } from '../helpers/db';

describe('POST /bookings', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects overlapping bookings for the same resource', async () => {
    // Test logic here
  });
});
```

## Mocking External AI Service

When testing routes that interact with the Python AI Backend, mock `src/lib/aiClient.ts` to avoid requiring the FastAPI service to be active during unit and integration test runs:

```typescript
import { vi } from 'vitest';
import * as aiClient from '../../src/lib/aiClient';

vi.spyOn(aiClient, 'predictNoShow').mockResolvedValue({
  predicted_probability: 0.15,
  model_version: 'test-mock'
});
```

## Best Practices
- Always test both authenticated and unauthenticated paths.
- For concurrency tests, fire simultaneous `Promise.all([request(app)..., request(app)...])` calls and verify that PostgreSQL `EXCLUDE` constraint properly rejects double-bookings.
