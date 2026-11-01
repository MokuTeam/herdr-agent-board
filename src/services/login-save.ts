// A login the owner typed offered to their vault (core/login-save.ts), on the board's own server:
// the watcher (services/login-watch.ts) catches the owner's own sign-in while they hold an agent's
// browser, and hands it here; the board puts an offer on the card under "needs you" — "Save the
// login for <site> (<username>)?", or "Update the password?" when the vault has that site and
// username with another password (nothing when it is the same and the vault was open to tell). The
// owner approves on the board with the vault's master password (services/vault.ts opens it, or it
// is kept open already, shared with the login fill through services/vault-hold.ts) or declines; the
// board then creates or edits the item with the Bitwarden CLI and locks the vault again.
//
// The caught password lives in this process's memory only: dropped on an answer, on a decline,
// after SAVE_EXPIRES_MS, or when the board restarts (which also locks the vault). It is never on a
// card, in the payload, an answer, a log, the audit (vault/audit.jsonl: who offered which site,
// what kind, the item's id, what came of it — never a value) or on disk.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import { HOLD_MS } from '../core/login-fill.ts'
import {
  type Caught,
  caughtLogin,
  itemWithPassword,
  type LoginSaveView,
  newLoginItem,
  originOf,
  SAVE_EXPIRES_MS,
  type SaveKind,
  type SaveMatch,
  type SaveStatus,
  saveKindOf,
} from '../core/login-save.ts'
import type { Item } from '../core/types.ts'
import type { Vault } from './vault.ts'
import type { VaultHold } from './vault-hold.ts'

interface Offer {
  id: string
  pane: string
  /** The session's card the browser belongs to. */
  key: string
  site: string
  /** The page's address the vault matches on (no query). */
  url: string
  /** The page's origin, a new item's one URI. */
  uri: string
  username: string
  /** In this process's memory only, dropped the moment the offer ends. */
  password: string
  kind: SaveKind
  /** The vault item to update once that is known (saveKindOf), else null. */
  matchId: string | null
  at: number
  expires: number
  stage: 'asked' | 'busy'
  error: string
  status: SaveStatus
  done: number
}

export interface LoginSaveOptions {
  vault: Vault
  /** The one open vault, shared with the login fill (services/vault-hold.ts). */
  hold: VaultHold
  /** The session in `pane` on the board now (not asleep), for its card. */
  itemOf(pane: string): Item | undefined
  onChange(): void
  log(line: string): void
  now?: () => number
  /** The audit's file; the state folder's vault/audit.jsonl by default (the fill's own). */
  auditFile?: string
}

export interface Answer {
  status: number
  body: { ok: boolean; error?: string; result?: SaveStatus }
}

export interface LoginSaves {
  /** A sign-in the watcher caught (services/login-watch.ts), while the owner holds the pane's browser. */
  capture(pane: string, c: Caught): Promise<void>
  approve(id: string, b: { password?: unknown; code?: unknown; keep?: unknown }): Promise<Answer>
  decline(id: string): Answer
  /** The vault kept open by "keep unlocked": locked now (shared with the login fill). */
  lockNow(): Promise<void>
  /** What the card of `item` shows: its pending offers, under "needs you". */
  card(item: Item): Partial<Item>
  close(): Promise<void>
}

/** How long an ended offer is kept before it is forgotten (so its card clears at once; the page hears the result from its own answer). */
const KEEP_DONE_MS = 30_000
/** The vault kept open for one offer's own write, then locked again. */
const WRITE_MS = 60_000
const MAX_PASSWORD = 1024
const AUDIT_MAX = 1 << 20

export function createLoginSaves(o: LoginSaveOptions): LoginSaves {
  const now = o.now ?? Date.now
  const offers = new Map<string, Offer>()
  const hold = o.hold
  let firstLogin = false
  const sweep = setInterval(() => tick(), 5000)
  sweep.unref?.()

  function audit(op: string, r: Offer, extra: Record<string, unknown> = {}): void {
    const file = o.auditFile ?? join(stateDir(), 'vault', 'audit.jsonl')
    const line = {
      at: new Date(now()).toISOString(),
      op: `save.${op}`,
      id: r.id,
      site: r.site,
      kind: r.kind,
      user: !!r.username,
      asked: r.key,
      ...extra,
    }
    try {
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      try {
        if (statSync(file).size > AUDIT_MAX) renameSync(file, `${file}.1`)
      } catch {}
      appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch (err) {
      o.log(`vault audit: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function tick(): void {
    const at = now()
    for (const r of offers.values()) {
      if (r.status === 'pending' && r.stage !== 'busy' && at >= r.expires) settle(r, 'expired')
      if (r.status !== 'pending' && at - r.done > KEEP_DONE_MS) offers.delete(r.id)
    }
  }

  function settle(r: Offer, status: SaveStatus, extra: Record<string, unknown> = {}): void {
    if (r.status !== 'pending') return
    r.status = status
    r.done = now()
    r.password = ''
    audit(status, r, extra)
    void hold.lock(r.id)
    o.onChange()
  }

  /** Stays pending, the reason on the card for the owner. */
  function fail(r: Offer, error: string, status = 409): Answer {
    r.error = error
    r.stage = 'asked'
    o.onChange()
    return { status, body: { ok: false, error } }
  }

  function pendingOf(id: string): Offer | { refused: Answer } {
    tick()
    const r = offers.get(id)
    if (!r) return { refused: { status: 404, body: { ok: false, error: t('save.err.gone') } } }
    if (r.status !== 'pending')
      return { refused: { status: 409, body: { ok: false, error: t('save.err.was'), result: r.status } } }
    if (r.stage === 'busy') return { refused: { status: 409, body: { ok: false, error: t('save.err.busy') } } }
    return r
  }

  /** The vault's logins for the offer's site that have its username, with their passwords (to tell a new one from an update or the same). */
  async function candidates(r: Offer, session: string): Promise<SaveMatch[] | null> {
    await o.vault.sync(session)
    const all = await o.vault.matches(session, r.url)
    if (!all) return null
    const want = r.username.toLowerCase()
    const out: SaveMatch[] = []
    for (const m of all) {
      if (m.username.toLowerCase() !== want) continue
      const sec = await o.vault.secret(session, m.id)
      if (!sec) return null
      out.push({ id: m.id, username: m.username, password: sec.password })
    }
    return out
  }

  /** Writes the offer to the vault (the vault open): the same already (no write), an existing one's password, or a new login. */
  async function write(r: Offer, session: string): Promise<Answer> {
    r.stage = 'busy'
    r.error = ''
    o.onChange()
    try {
      const cand = await candidates(r, session)
      if (cand === null) return fail(r, t('save.err.bw'))
      const decide = saveKindOf(cand, r.username, r.password)
      if (decide.kind === 'same') {
        r.kind = 'update'
        settle(r, 'same', { item: decide.id })
        return { status: 200, body: { ok: true, result: 'same' } }
      }
      if (decide.kind === 'update') {
        r.kind = 'update'
        const full = await o.vault.item(session, decide.id)
        if (!full) return fail(r, t('save.err.bw'))
        const done = await o.vault.editItem(session, decide.id, itemWithPassword(full, r.password))
        if (!done) return fail(r, t('save.err.write'))
        settle(r, 'updated', { item: decide.id })
        return { status: 200, body: { ok: true, result: 'updated' } }
      }
      r.kind = 'new'
      const id = await o.vault.createItem(
        session,
        newLoginItem({ name: r.site, username: r.username, password: r.password, uri: r.uri }),
      )
      if (!id) return fail(r, t('save.err.write'))
      settle(r, 'saved', { item: id })
      return { status: 200, body: { ok: true, result: 'saved' } }
    } finally {
      if (r.stage === 'busy') r.stage = 'asked'
      o.onChange()
    }
  }

  function view(r: Offer): LoginSaveView {
    return {
      id: r.id,
      site: r.site,
      username: r.username,
      kind: r.kind,
      at: r.at,
      expires: r.expires,
      stage: r.stage,
      unlockedUntil: hold.keptUntil(),
      firstLogin,
      error: r.error,
    }
  }

  return {
    async capture(pane, c) {
      if (!o.vault.config()) return
      const g = caughtLogin(c)
      if (!g.ok) return
      const item = o.itemOf(pane)
      if (!item) return
      // one pending offer per session: the same sign-in again is kept, another replaces the older
      for (const [id, r] of [...offers]) {
        if (r.pane !== pane || r.status !== 'pending') continue
        if (r.site === g.site && r.username === g.username && r.password === g.password) return
        r.password = ''
        offers.delete(id)
      }
      const at = now()
      const r: Offer = {
        id: randomBytes(6).toString('hex'),
        pane,
        key: item.key,
        site: g.site,
        url: g.url,
        uri: originOf(c.url),
        username: g.username,
        password: g.password,
        kind: 'unknown',
        matchId: null,
        at,
        expires: at + SAVE_EXPIRES_MS,
        stage: 'asked',
        error: '',
        status: 'pending',
        done: 0,
      }
      // the vault kept open already: tell a new login from an update now, and drop a sign-in it has the same
      const session = hold.keptUntil() !== null ? hold.session(r.id) : null
      if (session) {
        const cand = await candidates(r, session).catch(() => null)
        if (cand) {
          const decide = saveKindOf(cand, r.username, r.password)
          if (decide.kind === 'same') {
            r.password = ''
            return
          }
          r.kind = decide.kind
          if (decide.kind === 'update') r.matchId = decide.id
        }
      } else {
        firstLogin = !(await o.vault.signedIn().catch(() => true))
      }
      offers.set(r.id, r)
      audit('caught', r)
      o.onChange()
    },

    async approve(id, b) {
      const got = pendingOf(id)
      if ('refused' in got) return got.refused
      const r = got
      const keep = b.keep === true
      let session = hold.session(r.id)
      if (!session) {
        const password = typeof b.password === 'string' ? b.password : ''
        if (!password || password.length > MAX_PASSWORD || /[\r\n]/.test(password))
          return fail(r, t('save.err.password'), 400)
        const code = typeof b.code === 'string' && /^\d{4,10}$/.test(b.code.trim()) ? b.code.trim() : undefined
        r.stage = 'busy'
        r.error = ''
        o.onChange()
        const opened = await o.vault.unlock(password, code)
        r.stage = 'asked'
        if (!opened.ok) {
          if (opened.why === 'code') firstLogin = true
          return fail(r, t(`fill.err.unlock.${opened.why}`), 400)
        }
        firstLogin = false
        session = opened.session
        hold.hold(session, keep ? HOLD_MS : WRITE_MS, keep ? null : r.id)
      }
      return write(r, session)
    },

    decline(id) {
      const got = pendingOf(id)
      if ('refused' in got) return got.refused
      settle(got, 'declined')
      return { status: 200, body: { ok: true, result: 'declined' } }
    },

    async lockNow() {
      await hold.lockNow()
    },

    card(item) {
      if (!item.pane || item.sleeping) return {}
      // a refresh settles an offer past its time, so its card clears without waiting for the sweep
      tick()
      const list = [...offers.values()].filter(
        r => r.pane === item.pane && r.key === item.key && r.status === 'pending',
      )
      if (!list.length) return {}
      const last = list[list.length - 1] as Offer
      return {
        column: 'me',
        attention: 'ask',
        question: t('save.asks', { site: last.site }),
        askSince: last.at,
        loginSave: list.map(view),
      }
    },

    async close() {
      clearInterval(sweep)
      for (const r of offers.values()) r.password = ''
      offers.clear()
    },
  }
}
