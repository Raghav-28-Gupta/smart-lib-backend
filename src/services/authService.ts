import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { JWT_EXPIRES_IN, JWT_SECRET } from '../config/constants'
import type { User } from '../generated/prisma/client'
import { UnauthorizedError } from '../lib/httpError'
import { prisma } from '../lib/prisma'

const BCRYPT_ROUNDS = 10

export interface AppUserDto {
  id: string
  name: string
  email: string
  roll: string
}

// Matches the frontend's AppUser shape exactly (lib/features/auth/auth_repository.dart)
// — roll falls back to 'Pending' for accounts that don't have one set, same
// as the mock repository's register() behavior.
export function toAppUser(user: User): AppUserDto {
  return { id: user.id, name: user.name, email: user.email, roll: user.roll ?? 'Pending' }
}

function signToken(user: User): string {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

// Duplicate emails are NOT pre-checked with a SELECT here — the unique
// constraint on User.email is the actual source of truth, and a violation
// surfaces as a Prisma P2002 error, which errorHandler.ts already maps to a
// 409. A pre-check would just be a redundant, racy extra query.
export async function registerUser(input: { name: string; email: string; password: string }) {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)
  const user = await prisma.user.create({
    data: { name: input.name, email: input.email, passwordHash },
  })
  return { user: toAppUser(user), token: signToken(user) }
}

export async function loginUser(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  // Same message whether the email doesn't exist or the password is wrong —
  // avoids confirming to a caller which part failed. Matches the frontend
  // mock repository's copy verbatim, so nothing needs to change there once
  // the frontend gets wired to this API.
  const mismatch = () => new UnauthorizedError("That email and password don't match our records.")
  if (!user) throw mismatch()
  const valid = await bcrypt.compare(input.password, user.passwordHash)
  if (!valid) throw mismatch()
  return { user: toAppUser(user), token: signToken(user) }
}
