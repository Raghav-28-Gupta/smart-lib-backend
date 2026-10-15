import bcrypt from 'bcrypt'
import { prisma } from '../lib/prisma'
import { registerSchema } from '../schemas/auth'
import { BCRYPT_ROUNDS } from './authService'

export type AdminAccountResult = 'created' | 'promoted' | 'declined'

/**
 * Makes `email` an admin. A new email gets a new admin account. An existing
 * account is promoted, and its password replaced, only if `confirmPromote`
 * resolves true; its name is kept. Inputs follow the registration rules.
 * Used by scripts/create-admin.ts; public registration never creates admins.
 */
export async function createOrPromoteAdmin(
  input: { name: string; email: string; password: string },
  confirmPromote: () => Promise<boolean>,
): Promise<AdminAccountResult> {
  const parsed = registerSchema.safeParse({ name: input.name.trim(), email: input.email.trim(), password: input.password })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const { name, email, password } = parsed.data

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing && !(await confirmPromote())) return 'declined'

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  if (!existing) {
    await prisma.user.create({ data: { name, email, passwordHash, role: 'admin' } })
    return 'created'
  }
  await prisma.user.update({ where: { id: existing.id }, data: { role: 'admin', passwordHash } })
  return 'promoted'
}
