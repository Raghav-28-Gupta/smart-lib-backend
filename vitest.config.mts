import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Integration tests share one Postgres database (test/setup.ts repoints
    // DATABASE_URL at TEST_DATABASE_URL; test/helpers/db.ts's resetDb()
    // truncates between tests). Running test FILES in parallel would let two
    // files truncate/write the same tables concurrently and corrupt each
    // other's state, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15000,
  },
})
