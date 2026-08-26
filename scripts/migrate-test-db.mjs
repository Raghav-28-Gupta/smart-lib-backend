// Applies the committed migrations to TEST_DATABASE_URL specifically — never
// the dev DATABASE_URL. Run automatically before `npm test` (see the
// `pretest` script) so the test database's schema can never drift out of
// sync with what the migrations define.
import 'dotenv/config'
import { spawnSync } from 'node:child_process'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set. Copy .env.example to backend/.env and fill it in.')
  process.exit(1)
}

// prisma.config.ts sources the datasource URL from process.env.DATABASE_URL;
// overriding it just for this child process (not the whole shell) points the
// CLI at the test database without touching anything else. `migrate deploy`
// (not `dev`) applies existing migrations only — it never prompts and never
// generates a new one, which is what an automated pretest step needs.
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
})

process.exit(result.status ?? 1)
