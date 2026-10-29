// The server's passwords as the local board remembers them between clicks (the board-on-own-server
// spec's "The admin login by password": remembered 30 minutes in the local board's memory): the
// login's (`password`, sudo's too) and sudo's own (`sudoPassword`), once a login with them went
// through. Kept in this process's memory only: never in config.json, web.log, the view (which has
// only until when: `passwordHeld`), an answer or the browser's storage; gone when the board
// restarts, on "Forget the password", and 30 minutes after their last use, each use counting
// again. A request that carries none of its own gets the held ones (remote-access.ts); one the
// server refused is dropped, never held. Only the local board reaches this (/api/access is
// refused over the tunnel and Tailscale, core/remote.ts localOnly).

/** How long the passwords stay since their last use. */
export const HOLD_MS = 30 * 60_000

/** The longest password the services take (server-setup.ts, profile-sync.ts PASSWORD_MOST). */
const PASSWORD_MOST = 1024

type Fields = Record<string, unknown>
type Kept = { password: string | null; sudoPassword: string | null }

export interface HeldPasswords {
  /**
   * The request as it goes on: the held passwords where it carries none (each one used: its 30
   * minutes start again); the request itself when nothing is held.
   */
  fill(body: Fields): Fields
  /**
   * After the answer to a request `fill` gave (`proves`: its ok means a login with its passwords
   * went through): an ok one's passwords held from now; a refusal that asks for the login's
   * password drops both, one that asks for sudo's drops sudo's own.
   */
  settle(body: Fields, answer: { body: unknown }, proves: boolean): void
  /** "Forget the password": whether anything was held. */
  forget(): boolean
  /** Until when they are held (no secret); null when none is. */
  view(): { until: number } | null
}

/** A password a request carries: null for none, or one the services would refuse (they say why). */
function given(v: unknown): string | null {
  if (typeof v !== 'string' || v === '' || /[\r\n]/.test(v) || v.length > PASSWORD_MOST) return null
  return v
}

const none = (v: unknown): boolean => v === undefined || v === null || v === ''

export function heldPasswords(now: () => number = Date.now): HeldPasswords {
  let kept: Kept | null = null
  let used = 0

  /** What is held now: nothing once its 30 minutes since the last use are over. */
  function live(): Kept | null {
    if (kept && now() - used >= HOLD_MS) kept = null
    return kept
  }

  return {
    fill(body) {
      const k = live()
      if (!k) return body
      const out = { ...body }
      let filled = false
      if (k.password !== null && none(body.password)) {
        out.password = k.password
        filled = true
      }
      if (k.sudoPassword !== null && none(body.sudoPassword)) {
        out.sudoPassword = k.sudoPassword
        filled = true
      }
      if (filled) used = now()
      return out
    },

    settle(body, answer, proves) {
      const a = answer.body && typeof answer.body === 'object' ? (answer.body as Fields) : {}
      if (a.ok === true) {
        const sent = { password: given(body.password), sudoPassword: given(body.sudoPassword) }
        if (proves && (sent.password !== null || sent.sudoPassword !== null)) {
          kept = sent
          used = now()
        }
      } else if (kept && a.need === 'password') kept = null
      else if (kept && a.need === 'sudoPassword') {
        kept = kept.password === null ? null : { ...kept, sudoPassword: null }
      }
    },

    forget() {
      const had = live() !== null
      kept = null
      return had
    },

    view() {
      return live() ? { until: used + HOLD_MS } : null
    },
  }
}
