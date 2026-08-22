// Prisma 7 no longer auto-loads .env, so dotenv is imported explicitly here.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

type Env = {
  DATABASE_URL: string
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
})
