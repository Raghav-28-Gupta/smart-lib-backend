// Creates an admin account, or promotes an existing one, from a terminal.
// Production: set DATABASE_URL to the production connection string in this
// terminal only (dotenv never overrides a variable that's already set).
import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { prisma } from '../src/lib/prisma'
import { createOrPromoteAdmin } from '../src/services/adminAccountService'

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/** Reads a line without echoing it, so the password never appears on screen. */
function askHidden(question: string): Promise<string> {
  stdout.write(question)
  return new Promise((resolve) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  if (!stdin.isTTY) {
    console.error('Run create-admin in an interactive terminal: it needs to read a password without echoing it.')
    process.exitCode = 1
    return
  }
  const name = await ask('Name: ')
  const email = await ask('Email: ')
  const password = await askHidden('Password (at least 8 characters): ')
  const again = await askHidden('Password again: ')
  if (password !== again) {
    console.error('The passwords do not match. Nothing was changed.')
    process.exitCode = 1
    return
  }
  const result = await createOrPromoteAdmin({ name, email, password }, async () => {
    const answer = await ask('An account with this email exists. Make it an admin and set this password? (y/N) ')
    return answer.trim().toLowerCase() === 'y'
  })
  const messages = {
    created: `Created admin account ${email.trim()}.`,
    promoted: `${email.trim()} is now an admin, with the new password.`,
    declined: 'Nothing was changed.',
  }
  console.log(messages[result])
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
