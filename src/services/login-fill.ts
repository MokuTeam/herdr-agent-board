// A login fill's life (core/login-fill.ts), on the board's own server: the agent asks for its
// pane, the board reads the page with the focus itself (services/cdp-peek.ts) and puts the request
// on the card under "needs you"; the owner approves on the board with the vault's master password
// (services/vault.ts opens it with the Bitwarden CLI) or declines; the board finds the login for that
// page, the owner picks one where several match, the board checks the page with the focus is still
// that site and types the values by keys (services/desktop.ts typeKeys), then locks the vault (or
// keeps it open in this process's memory for 15 minutes, as the owner said). The agent is told how
// it ended by a board reminder (browser_fill_login) or reads it (`board browser login` waits).
//
// Requests live in this process's memory only (a board restart forgets them, and the vault is
// locked as it starts again); no value is ever on a card, in the payload, an answer, a log or the
// audit, which says who asked for which site, what came of it and the item's id. The master
// password goes from the owner's submit to bw's stdin and nowhere else.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import {
  FILL_EXPIRES_MS,
  type FillAsk,
  type FillField,
  type FillMatch,
  type FillStatus,
  fieldWord,
  fillKeys,
  fillResult,
  HOLD_MS,
  type LoginFillView,
  matchUrl,
  onSite,
  PICK_MS,
  pageHost,
} from '../core/login-fill.ts'
import type { Item } from '../core/types.ts'
import type { Desktops } from './desktop.ts'
import type { Vault } from './vault.ts'

interface Request {
  id: string
  pane: string
  /** The asking session's card. */
  key: string
  site: string
  /** The page's address as Chrome had it (no query), for the vault's matching. */
  url: string
  title: string
  field: string
  fields: FillField[]
  submit: boolean
  username: string
  at: number
  expires: number
  /** Tell the agent how it ended by a board reminder (the MCP tool); the CLI waits and reads it. */
  wake: boolean
  stage: 'asked' | 'pick' | 'busy'
  matches: FillMatch[] | null
  error: string
  status: FillStatus
  reason: string
  done: number
}

export interface LoginFillOptions {
  vault: Vault
  desktops: Pick<Desktops, 'peek' | 'typeKeys' | 'control'>
  /** The session in `pane` on the board now (not asleep), for its card and its reminder. */
  itemOf(pane: string): Item | undefined
  /** The agent told how it ended: a board reminder due now (as the browser's hand-back's). */
  remind(item: Item, text: string): void
  onChange(): void
  log(line: string): void
  now?: () => number
  /** The audit's file (one JSON line a step); the state folder's vault/audit.jsonl by default. */
  auditFile?: string
}

export type Asked = { ok: true; id: string } | { ok: false; status: number; error: string }

export interface Answer {
  status: number
  body: { ok: boolean; error?: string; stage?: string; result?: FillStatus }
}

export interface LoginFills {
  ask(pane: string, ask: FillAsk, wake: boolean): Promise<Asked>
  /** A request of `pane`'s as the agent may read it: its status, and its words (never a value). */
  status(pane: string, id: string): { status: FillStatus; text: string } | null
  approve(id: string, b: { password?: unknown; code?: unknown; keep?: unknown }): Promise<Answer>
  pick(id: string, item: unknown): Promise<Answer>
  decline(id: string): Answer
  /** The vault kept open by "keep unlocked": locked now. */
  lockNow(): Promise<void>
  /** What the card of `item` shows: its pending requests, under "needs you". */
  card(item: Item): Partial<Item>
  close(): Promise<void>
}

/** How long an ended request is kept for `board browser login` to read. */
const KEEP_DONE_MS = 15 * 60_000
const MAX_PASSWORD = 1024
const AUDIT_MAX = 1 << 20

export function createLoginFills(o: LoginFillOptions): LoginFills {
  const now = o.now ?? Date.now
  const requests = new Map<string, Request>()
  /** The vault open in memory: the session bw gave, until when (keep unlocked), or for one request's pick. */
  let held: { session: string; until: number; for: string | null } | null = null
  let lockTimer: ReturnType<typeof setTimeout> | undefined
  const sweep = setInterval(() => tick(), 5000)
  sweep.unref?.()

  function audit(op: string, r: Request, extra: Record<string, unknown> = {}): void {
    const file = o.auditFile ?? join(stateDir(), 'vault', 'audit.jsonl')
    const line = {
      at: new Date(now()).toISOString(),
      op,
      id: r.id,
      site: r.site,
      fields: r.fields,
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

  /** The vault locked again, unless the owner keeps it open for longer than `forRequest` needs it. */
  async function lock(forRequest?: string): Promise<void> {
    if (held && forRequest !== undefined && held.for !== forRequest) return
    held = null
    clearTimeout(lockTimer)
    await o.vault.lock().catch(() => {})
    o.onChange()
  }

  function hold(session: string, ms: number, forRequest: string | null): void {
    held = { session, until: now() + ms, for: forRequest }
    clearTimeout(lockTimer)
    lockTimer = setTimeout(() => void lock(), ms)
    lockTimer.unref?.()
  }

  /** The open vault's session for request `id`: kept open by the owner, or opened for that request's own pick. */
  const heldSession = (id: string): string | null =>
    held && held.until > now() && (held.for === null || held.for === id) ? held.session : null

  function settle(r: Request, status: FillStatus, reason = ''): void {
    if (r.status !== 'pending') return
    r.status = status
    r.reason = reason
    r.done = now()
    r.matches = null
    audit(status, r, reason ? { reason } : {})
    if (held?.for === r.id) void lock(r.id)
    if (r.wake) {
      const item = o.itemOf(r.pane)
      if (item && item.key === r.key)
        o.remind(item, `[board reminder] Login fill (browser_fill_login) ${fillResult(r)}`)
    }
    o.onChange()
  }

  function tick(): void {
    const at = now()
    for (const r of requests.values()) {
      if (r.status === 'pending' && r.stage !== 'busy' && at >= r.expires) settle(r, 'expired')
      if (r.status !== 'pending' && at - r.done > KEEP_DONE_MS) requests.delete(r.id)
    }
  }

  /** The matches for a request, the vault open (`session`): Bitwarden's own matching, then the page's host on the site, the agent's username if it named one. */
  async function find(r: Request, session: string): Promise<FillMatch[] | null> {
    await o.vault.sync(session)
    const all = await o.vault.matches(session, r.url)
    if (!all) return null
    return all
      .filter(m => !r.username || m.username.toLowerCase() === r.username.toLowerCase())
      .map(({ uris: _, ...m }) => m)
  }

  /** The page with the focus is still the request's site, with a field to type into: why not, or null. */
  async function stillThere(r: Request): Promise<string | null> {
    if (o.desktops.control(r.pane) === 'owner') return t('fill.err.owner')
    // the page made the active one: the display's keys reach it then
    const page = await o.desktops.peek(r.pane, { activate: true })
    if (!page.ok) return t('fill.err.page')
    if (pageHost(page.url) !== r.site) return t('fill.err.moved', { site: r.site })
    if (!fieldWord(page.field)) return t('fill.err.noField')
    return null
  }

  /** Types the item's values for the request (the vault open), and settles it. */
  async function fill(r: Request, session: string, match: FillMatch): Promise<Answer> {
    r.stage = 'busy'
    o.onChange()
    try {
      const why = await stillThere(r)
      // the owner has the browser: they give it back and approve again
      if (why && o.desktops.control(r.pane) === 'owner') return fail(r, why)
      if (why) {
        settle(r, 'failed', why)
        return { status: 409, body: { ok: false, error: why, result: 'failed' } }
      }
      const item = await o.vault.secret(session, match.id)
      if (!item) return fail(r, t('fill.err.bw'))
      const values: string[] = []
      for (const f of r.fields) {
        if (f === 'username') values.push(item.username)
        else if (f === 'password') values.push(item.password)
        else {
          const code = item.totp ? await o.vault.totp(session, match.id) : null
          if (!code) {
            settle(r, 'failed', t('fill.err.noTotp'))
            return { status: 409, body: { ok: false, error: t('fill.err.noTotp'), result: 'failed' } }
          }
          values.push(code)
        }
      }
      if (values.some(v => v === '')) {
        settle(r, 'failed', t('fill.err.empty'))
        return { status: 409, body: { ok: false, error: t('fill.err.empty'), result: 'failed' } }
      }
      const keys = fillKeys(values, r.submit)
      values.length = 0
      if (!keys) {
        settle(r, 'failed', t('fill.err.keys'))
        return { status: 409, body: { ok: false, error: t('fill.err.keys'), result: 'failed' } }
      }
      const typed = await o.desktops.typeKeys(r.pane, keys)
      keys.fill(0)
      if (!typed.ok) {
        const reason = typed.error === 'owner' ? t('fill.err.owner') : t('fill.err.typing')
        settle(r, 'failed', reason)
        return { status: 409, body: { ok: false, error: reason, result: 'failed' } }
      }
      audit('typed', r, { item: match.id })
      settle(r, 'ok')
      return { status: 200, body: { ok: true, result: 'ok' } }
    } finally {
      if (r.stage === 'busy') r.stage = 'asked'
      o.onChange()
    }
  }

  /** Stays pending, the reason on the card for the owner. */
  function fail(r: Request, error: string, status = 409): Answer {
    r.error = error
    r.stage = r.matches && r.matches.length > 1 && heldSession(r.id) ? 'pick' : 'asked'
    o.onChange()
    return { status, body: { ok: false, error } }
  }

  /** A pending request by id, past its time said expired. */
  function pendingOf(id: string): Request | { refused: Answer } {
    tick()
    const r = requests.get(id)
    if (!r) return { refused: { status: 404, body: { ok: false, error: t('fill.err.gone') } } }
    if (r.status !== 'pending')
      return { refused: { status: 409, body: { ok: false, error: t(`fill.err.was.${r.status}`), result: r.status } } }
    if (r.stage === 'busy') return { refused: { status: 409, body: { ok: false, error: t('fill.err.busy') } } }
    return r
  }

  function view(r: Request): LoginFillView {
    return {
      id: r.id,
      site: r.site,
      title: r.title,
      field: r.field,
      fields: r.fields,
      submit: r.submit,
      username: r.username,
      at: r.at,
      expires: r.expires,
      stage: r.stage,
      matches: r.matches,
      unlockedUntil: held && held.for === null && held.until > now() ? held.until : null,
      firstLogin: firstLogin,
      error: r.error,
    }
  }

  let firstLogin = false

  return {
    async ask(pane, a, wake) {
      const item = o.itemOf(pane)
      if (!item) return { ok: false, status: 409, error: 'no session of yours on the board in this pane' }
      if (!o.vault.config()) return { ok: false, status: 409, error: t('fill.err.noVault') }
      if (o.desktops.control(pane) === 'owner') return { ok: false, status: 409, error: t('fill.err.ownerAgent') }
      for (const r of requests.values())
        if (r.pane === pane && r.status === 'pending')
          return { ok: false, status: 409, error: t('fill.err.waiting', { site: r.site }) }
      const page = await o.desktops.peek(pane)
      if (!page.ok)
        return {
          ok: false,
          status: 409,
          error: page.error === 'which page' ? t('fill.err.whichPage') : t('fill.err.noBrowser'),
        }
      const host = pageHost(page.url)
      if (!host) return { ok: false, status: 409, error: t('fill.err.notWeb') }
      if (a.site && !onSite(host, a.site))
        return { ok: false, status: 409, error: t('fill.err.otherSite', { page: host, site: a.site }) }
      const field = fieldWord(page.field)
      if (!field)
        return {
          ok: false,
          status: 409,
          error: page.field.crossFrame ? t('fill.err.frame') : t('fill.err.noFieldAgent'),
        }
      const at = now()
      const r: Request = {
        id: randomBytes(6).toString('hex'),
        pane,
        key: item.key,
        site: host,
        url: matchUrl(page.url),
        title: page.title.slice(0, 200),
        field,
        fields: a.fields,
        submit: a.submit,
        username: a.username,
        at,
        expires: at + FILL_EXPIRES_MS,
        wake,
        stage: 'asked',
        matches: null,
        error: '',
        status: 'pending',
        reason: '',
        done: 0,
      }
      requests.set(r.id, r)
      audit('asked', r, a.username ? { username: true } : {})
      o.onChange()
      // the vault kept open: the card shows its matches at once; the first sign-in shows a code field
      void (async () => {
        const session = held?.for === null ? heldSession(r.id) : null
        if (session) {
          r.matches = await find(r, session).catch(() => null)
          o.onChange()
        } else {
          firstLogin = !(await o.vault.signedIn().catch(() => true))
          o.onChange()
        }
      })()
      return { ok: true, id: r.id }
    },

    status(pane, id) {
      tick()
      const r = requests.get(id)
      if (!r || r.pane !== pane) return null
      return { status: r.status, text: fillResult(r) }
    },

    async approve(id, b) {
      const got = pendingOf(id)
      if ('refused' in got) return got.refused
      const r = got
      const keep = b.keep === true
      let session = heldSession(r.id)
      if (!session) {
        const password = typeof b.password === 'string' ? b.password : ''
        if (!password || password.length > MAX_PASSWORD || /[\r\n]/.test(password))
          return fail(r, t('fill.err.password'), 400)
        const code = typeof b.code === 'string' && /^\d{4,10}$/.test(b.code.trim()) ? b.code.trim() : undefined
        r.stage = 'busy'
        r.error = ''
        o.onChange()
        const opened = await o.vault.unlock(password, code)
        r.stage = 'asked'
        if (!opened.ok) {
          audit('refused', r, { why: opened.why })
          if (opened.why === 'code') firstLogin = true
          return fail(r, t(`fill.err.unlock.${opened.why}`), 400)
        }
        firstLogin = false
        session = opened.session
        hold(session, keep ? HOLD_MS : PICK_MS, keep ? null : r.id)
      }
      r.stage = 'busy'
      o.onChange()
      const found = await find(r, session).catch(() => null)
      r.stage = 'asked'
      if (!found) {
        await lock(r.id)
        return fail(r, t('fill.err.bw'))
      }
      if (!found.length) {
        settle(r, 'nomatch', r.username ? t('fill.nomatch.user', { username: r.username }) : '')
        return { status: 200, body: { ok: true, result: 'nomatch' } }
      }
      r.matches = found
      if (found.length > 1) {
        r.stage = 'pick'
        r.error = ''
        // open for the pick only, unless kept: locked again after PICK_MS
        r.expires = Math.max(r.expires, now() + PICK_MS)
        o.onChange()
        return { status: 200, body: { ok: true, stage: 'pick' } }
      }
      return fill(r, session, found[0] as FillMatch)
    },

    async pick(id, itemId) {
      const got = pendingOf(id)
      if ('refused' in got) return got.refused
      const r = got
      const match = r.matches?.find(m => m.id === itemId)
      if (!match) return { status: 400, body: { ok: false, error: t('fill.err.pick') } }
      const session = heldSession(r.id)
      if (!session) {
        r.stage = 'asked'
        return fail(r, t('fill.err.lockedAgain'), 409)
      }
      return fill(r, session, match)
    },

    decline(id) {
      const got = pendingOf(id)
      if ('refused' in got) return got.refused
      settle(got, 'declined')
      return { status: 200, body: { ok: true, result: 'declined' } }
    },

    async lockNow() {
      await lock()
    },

    card(item) {
      if (!item.pane || item.sleeping) return {}
      const list = [...requests.values()].filter(
        r => r.pane === item.pane && r.key === item.key && r.status === 'pending',
      )
      if (!list.length) return {}
      const last = list[list.length - 1] as Request
      return {
        column: 'me',
        attention: 'ask',
        question: t('fill.asks', { site: last.site }),
        askSince: last.at,
        loginFill: list.map(view),
      }
    },

    async close() {
      clearInterval(sweep)
      if (held) await lock()
    },
  }
}
