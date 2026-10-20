// The board in a phone's browser, through `tailscale serve` (src/core/pwa.ts): the server marks
// that page (`data-remote` on <html>). The page on 127.0.0.1 has no mark, and none of what reads
// it runs there.

/** Whether this page is the board in a phone's browser. */
export const remotePage = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.hasAttribute('data-remote')

const LANG_KEY = 'agent-board:phone-language'

/** The board's language as hello said it last: the screens before the board use it with no connection too. */
export function keptLanguage(): string | null {
  try {
    return localStorage.getItem(LANG_KEY)
  } catch {
    return null
  }
}

export function keepLanguage(lang: string): void {
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {}
}

/** The page's own event when the board says this browser is no longer paired. */
export const UNPAIRED = 'board:unpaired'

/** What `/api/hello` says to a phone's browser (src/server/remote.ts). */
export interface PhoneHello {
  name: string | null
  host: string
  paired: boolean
  language: string | null
}

export function helloOf(value: unknown): PhoneHello | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.board !== 'agent-board') return null
  return {
    name: typeof v.name === 'string' ? v.name : null,
    host: typeof v.host === 'string' ? v.host : '',
    paired: v.paired === true,
    language: typeof v.language === 'string' ? v.language : null,
  }
}

/** What the request to pair calls this browser: the Phones panel shows it with the phone's name. */
export function pairName(userAgent: string): string {
  const browser = /EdgA?\//.test(userAgent)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(userAgent)
      ? 'Firefox'
      : /SamsungBrowser\//.test(userAgent)
        ? 'Samsung Internet'
        : /Chrome\/|CriOS\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : ''
  return browser ? `Board in ${browser}` : 'Board in a browser'
}

/** Where pairing stands, from the board's answers (POST /api/remote/pair, then its poll). */
export type PairStep =
  | { step: 'idle' }
  | { step: 'asking' }
  | { step: 'waiting'; id: string }
  | { step: 'paired' }
  | { step: 'denied' }
  | { step: 'expired' }
  | { step: 'busy' }
  | { step: 'failed'; why: string }

/** The next step from a poll's answer; null while it still waits. */
export function pollStep(answer: unknown): PairStep | null {
  const status = answer && typeof answer === 'object' ? (answer as { status?: unknown }).status : null
  if (status === 'approved') return { step: 'paired' }
  if (status === 'denied') return { step: 'denied' }
  if (status === 'gone') return { step: 'expired' }
  return null
}

/** What the page shows: a check under way, no connection, refused, pairing, or the board. */
export type Gate = 'checking' | 'offline' | 'refused' | 'pair' | 'board'

/** What a check of /api/hello came to: paired or not, refused (403), or no answer (a 5xx, the network). */
export type CheckResult = 'paired' | 'unpaired' | 'refused' | 'unreachable'

/**
 * What the page shows after a check. The board on show stays through a check that got no answer
 * or a refusal (a 502 from serve while the board's listener is down, a whois Tailscale could not
 * answer): it says it reconnects and tries again by itself, keeping the open session and its draft
 * (#108). Only the board saying this browser is not paired takes it away.
 */
export function gateAfter(current: Gate, result: CheckResult): Gate {
  if (result === 'paired') return 'board'
  if (result === 'unpaired') return 'pair'
  if (current === 'board') return 'board'
  return result === 'refused' ? 'refused' : 'offline'
}

/** How long to wait before the next try after one of `ms`: doubling from 2 seconds, at most 15. */
export const nextRetryMs = (ms: number | null): number => (ms === null ? 2000 : Math.min(ms * 2, 15_000))
