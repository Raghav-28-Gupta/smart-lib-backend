import { DEMO_EMAIL_PATTERN, MAIL_TIMEOUT_MS } from '../config/constants'

// Plain-text email to one address through Brevo's transactional email API
// (https://developers.brevo.com/reference/send-transac-email). It is an HTTPS
// API on purpose: Render's free plan blocks outbound SMTP.
//
// Email is off unless BREVO_API_KEY and MAIL_FROM are both set. sendEmail
// never throws, never retries, and never logs a message body, a recipient or
// the key: callers record the outcome and carry on.
//
// Configuration is read from process.env on every call, so a test can change
// it between cases.

export type MailOutcome = 'sent' | 'failed' | 'skipped'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface MailTransport {
  send(
    m: { from: { email: string; name: string }; to: string; subject: string; text: string },
    signal: AbortSignal,
  ): Promise<{ ok: boolean }>
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'
const DEFAULT_FROM_NAME = 'SmartLib'
// The sender used when a test injects a transport and MAIL_FROM is unset.
const TEST_FROM_EMAIL = 'noreply@test.invalid'

let injected: MailTransport | null = null

// Tests only: with a transport injected the mailer counts as configured and
// never touches the network. null restores the real Brevo transport.
export function setMailTransport(transport: MailTransport | null): void {
  injected = transport
}

function setting(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function brevoTransport(apiKey: string): MailTransport {
  return {
    async send(m, signal) {
      const res = await fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: { name: m.from.name, email: m.from.email },
          to: [{ email: m.to }],
          subject: m.subject,
          textContent: m.text,
        }),
        signal,
      })
      // The answer's body is never read; release it so the connection is freed.
      await res.body?.cancel().catch(() => undefined)
      // Only the status is worth a log line: it tells the owner a key is wrong
      // or a quota is spent, and carries no message content.
      if (!res.ok) console.warn(`mailer: Brevo answered HTTP ${res.status}`)
      return { ok: res.ok }
    },
  }
}

interface MailerConfig {
  transport: MailTransport
  from: { email: string; name: string }
}

// True under a test run. NODE_ENV alone is not enough: Vitest sets it only when
// the shell left it unset, so a shell with NODE_ENV=development would otherwise
// leave the real transport on. Vitest always sets VITEST.
function inTestRun(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
}

// null when email is off. In a test run (NODE_ENV=test or VITEST set) only an
// injected transport counts, so a key in a developer's environment or .env can
// never send from a test run.
function resolveConfig(): MailerConfig | null {
  const email = setting('MAIL_FROM')
  const name = setting('MAIL_FROM_NAME') ?? DEFAULT_FROM_NAME
  if (injected) return { transport: injected, from: { email: email ?? TEST_FROM_EMAIL, name } }
  if (inTestRun()) return null
  const apiKey = setting('BREVO_API_KEY')
  if (!apiKey || !email) return null
  return { transport: brevoTransport(apiKey), from: { email, name } }
}

export function isEmailConfigured(): boolean {
  return resolveConfig() !== null
}

// MAIL_ALLOWED_DOMAINS: comma-separated, trimmed, lowercased; null when unset
// (or only separators), which allows every address.
function allowedDomains(): string[] | null {
  const domains = (process.env.MAIL_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  return domains.length > 0 ? domains : null
}

function isAllowedAddress(to: string): boolean {
  if (DEMO_EMAIL_PATTERN.test(to)) return false
  const domains = allowedDomains()
  if (!domains) return true
  const at = to.lastIndexOf('@')
  return at > 0 && domains.includes(to.slice(at + 1).toLowerCase())
}

export async function sendEmail(message: MailMessage): Promise<MailOutcome> {
  try {
    const config = resolveConfig()
    const to = message.to.trim()
    if (!config || !isAllowedAddress(to)) return 'skipped'

    const { ok } = await config.transport.send(
      { from: config.from, to, subject: message.subject, text: message.text },
      AbortSignal.timeout(MAIL_TIMEOUT_MS),
    )
    return ok ? 'sent' : 'failed'
  } catch (err) {
    // The error's name only ('TimeoutError', 'TypeError', ...): its message
    // can carry a recipient or request detail.
    console.warn(`mailer: send failed (${err instanceof Error ? err.name : 'unknown error'})`)
    return 'failed'
  }
}
