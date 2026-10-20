// The board in a phone's browser, through `tailscale serve` (src/core/pwa.ts) or through the
// owner's own domain (src/core/tunnel.ts): the server marks that page (`data-remote` on <html>).
// The page on 127.0.0.1 has no mark, and none of what reads it runs there.

/** Whether this page is the board in a phone's browser. */
export const remotePage = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.hasAttribute('data-remote')

/** The page runs as an app from the home screen, not in a browser's tab. */
export const standalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

const LANG_KEY = 'agent-board:phone-language'
const AUTH_KEY = 'agent-board:phone-auth'

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

/**
 * How the last hello said this browser gets in: the offline and refused screens word themselves by
 * it (the domain's say nothing of Tailscale), and Settings offers Sign out by it.
 */
export function keptAuth(): 'pair' | 'login' | null {
  try {
    const auth = localStorage.getItem(AUTH_KEY)
    return auth === 'pair' || auth === 'login' ? auth : null
  } catch {
    return null
  }
}

export function keepAuth(auth: 'pair' | 'login'): void {
  try {
    localStorage.setItem(AUTH_KEY, auth)
  } catch {}
}

/** The page's own event when the board says this browser is no longer paired, or its login ended. */
export const UNPAIRED = 'board:unpaired'

/** What `/api/hello` says to a phone's browser (src/server/remote.ts, src/server/tunnel.ts). */
export interface PhoneHello {
  name: string | null
  host: string
  paired: boolean
  language: string | null
  /** How this browser gets in: 'pair', a phone approved on the computer (Tailscale); 'login', through the owner's domain. */
  auth: 'pair' | 'login'
  /** Through the domain: this browser's login is valid. */
  signedIn: boolean
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
    auth: v.auth === 'login' ? 'login' : 'pair',
    signedIn: v.signedIn === true,
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
