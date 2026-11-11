// The owner's confirmations by passkey (#224, the rules in core/team-confirm.ts). A gated request
// becomes a pending action (in memory, CONFIRM_MS, one use); its confirmation window on
// `http://localhost:<port>` reads it (GET: the action and the WebAuthn options) and answers it
// (POST: an assertion, or for a new passkey a registration). Only then does the route do the
// action. A confirmed send gives an unlock token, which goes to the page that opened the window
// and nowhere else: the board keeps its hash and its end (UNLOCK_MS) in memory, so a restart ends
// every unlock.
//
// Passkeys (adapters/team-store.ts, team-passkeys.json): the first is added by whoever is at the
// screen (trust on first use: nothing on one machine does better); every later add, and every
// removal, waits for an assertion by one already there. The checks are the tunnel's
// (core/webauthn.ts), with RP ID `localhost`, so a passkey of the tunnel's domain fails here and
// one of here fails there.
//
// The switch (#367): required() says whether the gated actions wait at all. It is on only while a
// passkey is there, so a board cannot lock its owner out; removing the last passkey turns it off.
// Turning it on is free (it narrows); turning it off is a pending action, confirmed like the rest.
import { createHash, randomBytes } from 'node:crypto'
import { audit, changeOwnerKeys, type OwnerPasskey, readOwnerKeys } from '../adapters/team-store.ts'
import { deviceLabel } from '../core/access.ts'
import {
  CONFIRM_MS,
  confirmOrigin,
  confirmUrl,
  HINTS,
  MAX_PENDING,
  type OwnerAction,
  RP_ID,
  UNLOCK_MS,
  unlocks,
} from '../core/team-confirm.ts'
import {
  assertionOf,
  b64url,
  CREDENTIAL_ID_MAX,
  challengeOf,
  registrationOf,
  verifyAssertion,
  verifyRegistration,
} from '../core/webauthn.ts'

const ID_BYTES = 16
const CHALLENGE_BYTES = 32
const TOKEN_BYTES = 32
const USER_ID_BYTES = 16

interface Pending {
  action: OwnerAction
  at: number
  /** The challenge of the window's last read, for one answer. */
  challenge: string | null
  /** A passkey add whose assertion by an existing passkey went through: next comes the new one. */
  verified: boolean
  /** A window read it: when the cap is reached, the ones nobody opened go first. */
  viewed: boolean
}

/** What the window does next: sign with a passkey there is, or make a new one. */
export type ConfirmStep = 'get' | 'create'

export interface ConfirmView {
  action: OwnerAction
  step: ConfirmStep
  /** WebAuthn's options as JSON, their bytes base64url (web/src/models/passkey.ts reads them). */
  options: Record<string, unknown>
}

export type ConfirmAnswer =
  | { ok: true; done: false }
  | { ok: true; done: true; action: OwnerAction; unlock?: string }
  | { ok: false; error: 'gone' | 'passkey' | 'shape' | 'challenge' | 'exists' | string }

export interface PublicPasskey {
  id: string
  label: string
  addedAt: number
  usedAt: number | null
}

export interface TeamConfirm {
  /** Whether the owner has added a passkey. */
  hasPasskey(): boolean
  /** Whether the gated actions wait for a confirmation (#367): the switch on, and a passkey there. */
  required(): boolean
  /** Turns the switch on; false while there is no passkey to confirm with. */
  turnOn(): boolean
  passkeys(): PublicPasskey[]
  /** Keeps a gated action for its confirmation; its id. */
  pend(action: OwnerAction): string
  /** The pending action and the window's next step, with a fresh challenge; null when it is gone. */
  view(id: string): ConfirmView | null | 'passkey'
  /** The window's answer to `view` (an assertion or a registration). */
  answer(id: string, body: unknown, userAgent: string | null): ConfirmAnswer
  /** Whether `token` (the X-Board-Unlock header) still unlocks the owner's sending. */
  unlocked(token: string | null): boolean
  /** Where the panel opens the confirmation of `id`. */
  urlOf(id: string): string
  /** The only origin the confirmation's answers come from. */
  origin(): string
  /**
   * Whether a window on localhost reaches this board: false while another program holds
   * [::1]:<port>, which a browser may try first for `localhost` (server/app.ts holds it).
   */
  safe(): boolean
}

const random = (n: number): string => b64url.encode(new Uint8Array(randomBytes(n)))
const hash = (token: string): string => createHash('sha256').update(token).digest('base64url')

export function createTeamConfirm({
  port,
  now = Date.now,
  safe = () => true,
}: {
  port: () => number
  now?: () => number
  safe?: () => boolean
}): TeamConfirm {
  const pending = new Map<string, Pending>()
  const unlockedUntil = new Map<string, number>()

  function sweep(): void {
    const t = now()
    for (const [id, p] of pending) if (t - p.at > CONFIRM_MS) pending.delete(id)
    for (const [h, until] of unlockedUntil) if (until <= t) unlockedUntil.delete(h)
  }

  function live(id: string): Pending | null {
    sweep()
    return pending.get(id) ?? null
  }

  const expect = (challenge: string) => ({ challenge, origin: confirmOrigin(port()), rpId: RP_ID })

  function creationOptions(challenge: string, userId: string, have: OwnerPasskey[]): Record<string, unknown> {
    return {
      challenge,
      rp: { id: RP_ID, name: 'Agent board (this computer)' },
      user: { id: userId, name: 'owner', displayName: 'Agent board owner' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      hints: HINTS,
      excludeCredentials: have.map(p => ({ type: 'public-key', id: p.id })),
      timeout: CONFIRM_MS,
    }
  }

  function requestOptions(challenge: string, have: OwnerPasskey[]): Record<string, unknown> {
    return {
      challenge,
      rpId: RP_ID,
      allowCredentials: have.map(p => ({ type: 'public-key', id: p.id, transports: p.transports })),
      userVerification: 'required',
      hints: HINTS,
      timeout: CONFIRM_MS,
    }
  }

  /** Checks an assertion by one of the owner's passkeys, and notes its use; null when it went through. */
  function asserted(p: Pending, body: unknown): string | null {
    const a = assertionOf(body)
    if (!a || p.challenge === null || challengeOf(a.clientDataJSON) !== p.challenge) return 'challenge'
    const keys = readOwnerKeys()
    const stored = keys.passkeys.find(k => k.id === a.id)
    if (!stored || keys.userId === null) return 'passkey'
    const checked = verifyAssertion(a, expect(p.challenge), { ...stored, userId: keys.userId })
    if (!checked.ok) return checked.why
    changeOwnerKeys(k => {
      const kept = k.passkeys.find(x => x.id === stored.id)
      if (kept) {
        kept.counter = checked.counter
        kept.usedAt = now()
      }
    })
    return null
  }

  /** Adds the passkey a registration makes; null when it was added. */
  function registered(p: Pending, body: unknown, userAgent: string | null): string | null {
    const r = registrationOf(body)
    if (!r || p.challenge === null || challengeOf(r.clientDataJSON) !== p.challenge) return 'challenge'
    const checked = verifyRegistration(r, expect(p.challenge))
    if (!checked.ok) return checked.why
    const { id, jwk, alg, counter } = checked.credential
    if (id !== r.id || (b64url.decode(id)?.length ?? 0) > CREDENTIAL_ID_MAX) return 'shape'
    const label = deviceLabel(userAgent)
    const added = changeOwnerKeys(k => {
      // Between the window's read and this answer another passkey may have come: then this is a
      // later add, and it needed an assertion first.
      if (k.passkeys.length && !p.verified) return 'passkey'
      if (k.passkeys.some(x => x.id === id)) return 'exists'
      k.passkeys.push({ id, jwk, alg, counter, transports: r.transports, label, addedAt: now(), usedAt: null })
      return null
    })
    if (added === null) audit('passkey', null, { op: 'add', label, count: readOwnerKeys().passkeys.length })
    return added
  }

  return {
    hasPasskey: () => readOwnerKeys().passkeys.length > 0,

    required() {
      const k = readOwnerKeys()
      return k.required && k.passkeys.length > 0
    },

    turnOn() {
      // No passkey: refused before anything is written (a refusal makes no file).
      if (!readOwnerKeys().passkeys.length) return false
      const was = changeOwnerKeys(k => {
        if (!k.passkeys.length) return null
        const before = k.required
        k.required = true
        return before
      })
      if (was === null) return false
      if (!was) audit('passkey', null, { op: 'on' })
      return true
    },

    passkeys: () =>
      readOwnerKeys().passkeys.map(p => ({ id: p.id, label: p.label, addedAt: p.addedAt, usedAt: p.usedAt })),

    pend(action) {
      sweep()
      // Full: the oldest that no window has read goes first (a flood of requests nobody opens
      // does not push out the one the owner is confirming), else the oldest.
      while (pending.size >= MAX_PENDING) {
        const unread = [...pending].find(([, p]) => !p.viewed)?.[0]
        const oldest = unread ?? pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
      }
      const id = random(ID_BYTES)
      pending.set(id, { action, at: now(), challenge: null, verified: false, viewed: false })
      return id
    },

    view(id) {
      const p = live(id)
      if (!p) return null
      p.viewed = true
      const keys = readOwnerKeys()
      const challenge = random(CHALLENGE_BYTES)
      if (p.action.kind === 'passkey-add' && (!keys.passkeys.length || p.verified)) {
        const userId =
          keys.userId ??
          changeOwnerKeys(k => {
            k.userId ??= random(USER_ID_BYTES)
            return k.userId
          })
        p.challenge = challenge
        return { action: p.action, step: 'create', options: creationOptions(challenge, userId, keys.passkeys) }
      }
      if (!keys.passkeys.length) return 'passkey'
      p.challenge = challenge
      return { action: p.action, step: 'get', options: requestOptions(challenge, keys.passkeys) }
    },

    answer(id, body, userAgent) {
      const p = live(id)
      if (!p) return { ok: false, error: 'gone' }
      const create = p.action.kind === 'passkey-add' && (p.verified || !readOwnerKeys().passkeys.length)
      const why = create ? registered(p, body, userAgent) : asserted(p, body)
      // A challenge serves one answer, right or wrong.
      p.challenge = null
      if (why !== null) return { ok: false, error: why }
      if (p.action.kind === 'passkey-add' && !create) {
        p.verified = true
        return { ok: true, done: false }
      }
      pending.delete(id)
      if (p.action.kind === 'passkey-remove') {
        const gone = p.action.id
        changeOwnerKeys(k => {
          k.passkeys = k.passkeys.filter(x => x.id !== gone)
          // Without a passkey nothing could confirm, nor turn the switch off: it goes off with the last.
          if (!k.passkeys.length) k.required = false
        })
        audit('passkey', null, { op: 'remove', count: readOwnerKeys().passkeys.length })
      }
      if (p.action.kind === 'passkey-off') {
        changeOwnerKeys(k => {
          k.required = false
        })
        audit('passkey', null, { op: 'off' })
      }
      if (!unlocks(p.action)) return { ok: true, done: true, action: p.action }
      const token = random(TOKEN_BYTES)
      unlockedUntil.set(hash(token), now() + UNLOCK_MS)
      return { ok: true, done: true, action: p.action, unlock: token }
    },

    urlOf: id => confirmUrl(port(), id),
    safe,
    origin: () => confirmOrigin(port()),

    unlocked(token) {
      if (!token) return false
      sweep()
      return (unlockedUntil.get(hash(token)) ?? 0) > now()
    },
  }
}
