// Signing in through the owner's own domain (the tunnel listener's login routes, src/server/tunnel.ts):
// what the board's answer to a sign-in tells the person at the login screen, and the one note the
// screen shows for it. A wrong password and a wrong code are one answer, never which of them.
import type { Translator } from '../../../src/core/types.ts'
import { timeOf } from '../../../src/core/when-format.ts'

/** Why a sign-in did not go through. */
export type LoginNote =
  | { kind: 'wrong' }
  | { kind: 'locked'; until: number }
  | { kind: 'limited'; retryAfterS: number }
  | { kind: 'failed'; why: string }

/** A sign-in's answer (its status, body and Retry-After header) as a note; null when it went through. */
export function loginNote(status: number, body: unknown, retryAfter: string | null): LoginNote | null {
  if (status >= 200 && status < 300) return null
  const reply = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const error = typeof reply.error === 'string' ? reply.error : null
  if (error === 'wrong') return { kind: 'wrong' }
  if (error === 'locked' && typeof reply.until === 'number') return { kind: 'locked', until: reply.until }
  if (error === 'limited' || status === 429) {
    const header = retryAfter === null ? Number.NaN : Number(retryAfter)
    const seconds = Number.isFinite(header) ? header : typeof reply.retryAfterS === 'number' ? reply.retryAfterS : 60
    return { kind: 'limited', retryAfterS: Math.max(1, Math.ceil(seconds)) }
  }
  return { kind: 'failed', why: error ?? String(status) }
}

/**
 * What the login screen says: a sign-in's note; a passkey the board did not accept (its answer is
 * `wrong` too, but no password was typed); the offer's own: a code that is not the next one, or a
 * passkey that could not be added.
 */
export type ScreenNote = LoginNote | { kind: 'passkey' } | { kind: 'wrongCode' } | { kind: 'addFailed'; why: string }

export function noteText(note: ScreenNote, t: Translator): string {
  switch (note.kind) {
    case 'wrong':
      return t('login.wrong')
    case 'locked':
      return t('login.locked', { time: timeOf(note.until, t) })
    case 'limited':
      return t('login.limited', { seconds: note.retryAfterS })
    case 'failed':
      return t('login.failed', { why: note.why })
    case 'passkey':
      return t('login.passkeyWrong')
    case 'wrongCode':
      return t('login.wrongCode')
    case 'addFailed':
      return t('login.addFailed', { why: note.why })
  }
}
