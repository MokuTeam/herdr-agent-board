// The owner's git identity and GitHub login on a node (#609, docs/design/nodes 10, item 3). The
// identity comes with each bundle's commit (services/node/bundle.ts), the login with the secrets
// request of a device given its secrets (services/node/secrets.ts, #604). Each is taken only where
// it does not undo the node owner's own: an identity or a login the node has already and that is
// the same is taken over with nothing run (the first real node was set up by hand with them); one
// the bundle set before is replaced; another one is kept and said.
//
// `<state>/node/git-access.json` (0600) records what was set and by which master: the identity, and
// per host the account, how it was taken (gh, or git's own store where there is no gh) and the
// token's SHA-256, never the token. Leaving that master (the leave route, `board node leave`) takes
// out what it gave and is still as it gave it.
//
// What the status says (git, gh, an identity, the hosts with a login) is looked once per run of the
// board and again after a secrets request: a file read and one git call, never on every status.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeWhole } from '../../adapters/bundle-files.ts'
import {
  type GitTools,
  ghHosts,
  ghLogin,
  ghLogout,
  ghSetupGit,
  ghTokenThere,
  globalIdentity,
  identityParts,
  setIdentity,
  storeLogin,
  storeLogout,
  storeToken,
  TOOL_MS,
  unsetIdentity,
} from '../../adapters/git-access.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  type GitFacts,
  type GitIdentity,
  identityOf,
  identityStep,
  isAccount,
  isHost,
  isToken,
  type LoginRecord,
  loginStep,
  sameIdentity,
} from '../../core/git-access.ts'

/** At most this many logins in one request. */
export const MAX_LOGINS = 16
/** The logins of one request have this long in all: the request itself has 20 s (bundle-sync.ts SYNC_MS). */
export const LOGIN_BUDGET_MS = 12_000
/** A login that failed with a token is not tried again with that token for this long. */
export const RETRY_MS = 10 * 60_000

export interface NodeGitDeps {
  /** `<state>/node`. */
  dir: string
  /** git and gh on this node (adapters/git-access.ts gitTools), found once. */
  tools: GitTools
  /** One line of the secrets' audit, names only (services/secrets.ts auditBundle). */
  audit(line: Record<string, unknown>): void
  log(text: string): void
  now?: () => number
  /** The time all logins of one request have, LOGIN_BUDGET_MS unless given (tests). */
  loginBudgetMs?: number
}

/** What a master's leave took out, and what it could not (left in the record for the next leave). */
export interface GitLeft {
  identity: boolean
  logins: string[]
  failed?: string[]
}

/** What a node did with the logins of one request: hosts and accounts only. */
export interface LoginsTaken {
  /** The logins this node holds from that master after it, and how. */
  logins: { host: string; user: string; via: 'gh' | 'store' }[]
  /** Logged in now (or stored), by host. */
  taken: string[]
  /** Not taken: another login of the node's own there (`not-owned`, `changed`), or gh or git failed. */
  kept: { host: string; why: string }[]
  /** Hosts or entries it would not take. */
  refused: string[]
  /** Whether this node has gh: without it pull requests cannot be opened here. */
  gh: boolean
}

export type IdentityTaken = 'same' | 'set' | 'kept' | 'no-git' | 'failed'

export interface NodeGit {
  /** The identity a commit carries, set unless the node's owner set another (#609). */
  identity(given: GitIdentity, master: string | undefined): Promise<IdentityTaken>
  /** The logins a secrets request carries: `[{ host, user, token }]`. */
  logins(given: unknown, master: string | undefined): Promise<LoginsTaken>
  /** For the status: git and gh here, the identity, the logins; looked once until `changed`. */
  facts(): Promise<GitFacts>
  /** 'git' and 'gh', those here: they join the status's `programs`. */
  programs(): string[]
  /** What a master gave, taken out as it leaves: the logins and the identity still as it gave them. */
  leave(master: string): Promise<GitLeft>
}

interface GitRecord {
  identity?: GitIdentity & { master: string }
  logins: LoginRecord[]
}

const SHA = /^[0-9a-f]{64}$/
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
/** Before #609 a node knew one master: what it holds without a master's id is that one's. */
const LONE = ''

function recordOf(raw: unknown): GitRecord {
  if (!isRecord(raw)) return { logins: [] }
  const id = isRecord(raw.identity) ? identityOf(raw.identity.name, raw.identity.email) : null
  const master = (v: unknown): string => (typeof v === 'string' ? v : LONE)
  const logins: LoginRecord[] = []
  for (const l of Array.isArray(raw.logins) ? raw.logins : []) {
    if (!isRecord(l) || !isHost(l.host) || !isAccount(l.user) || typeof l.sha !== 'string' || !SHA.test(l.sha)) continue
    if (l.via !== 'gh' && l.via !== 'store') continue
    if (logins.some(x => x.host === l.host)) continue
    logins.push({
      host: l.host,
      user: l.user,
      sha: l.sha,
      via: l.via,
      ...(l.helper === true && { helper: true as const }),
      master: master(l.master),
    })
  }
  return {
    ...(id && isRecord(raw.identity) && { identity: { ...id, master: master(raw.identity.master) } }),
    logins,
  }
}

export function createNodeGit(deps: NodeGitDeps): NodeGit {
  const t = deps.tools
  const file = join(deps.dir, 'git-access.json')
  let facts: Promise<GitFacts> | null = null
  const now = deps.now ?? Date.now
  const budget = deps.loginBudgetMs ?? LOGIN_BUDGET_MS
  // Per host, the token a login failed with and when: in memory, for this run of the board.
  const failures = new Map<string, { sha: string; at: number }>()
  let queue: Promise<unknown> = Promise.resolve()

  const read = (): GitRecord => {
    try {
      return recordOf(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return { logins: [] }
    }
  }
  const save = (r: GitRecord): void => {
    if (!r.identity && !r.logins.length) rmSync(file, { force: true })
    else writeWhole(file, `${JSON.stringify(r, null, 2)}\n`, 0o600)
  }
  /** One at a time: a commit's identity, a request's logins and a leave never write the record over each other. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  async function identity(given: GitIdentity, master: string | undefined): Promise<IdentityTaken> {
    if (!t.git) return 'no-git'
    const rec = read()
    // One of the two set alone is the node owner's too: never filled in or replaced around it.
    const parts = await identityParts(t)
    const current =
      identityOf(parts.name, parts.email) ??
      (parts.name !== null || parts.email !== null ? { name: parts.name ?? '', email: parts.email ?? '' } : null)
    const step = identityStep(given, rec.identity ?? null, current)
    if (step === 'kept') {
      deps.log('node git: the identity set on this node by hand is kept')
      return 'kept'
    }
    if (step === 'set' && !(await setIdentity(t, given))) {
      deps.log('node git: the identity could not be set')
      return 'failed'
    }
    const mine = { ...given, master: master ?? LONE }
    if (!rec.identity || !sameIdentity(rec.identity, given) || rec.identity.master !== mine.master)
      save({ ...rec, identity: mine })
    if (step === 'set') {
      facts = null
      deps.audit({ op: 'git-identity', master: mine.master })
      deps.log('node git: the identity set from the bundle')
    }
    return step
  }

  async function logins(given: unknown, master: string | undefined): Promise<LoginsTaken> {
    const from = master ?? LONE
    const list = Array.isArray(given) ? given : []
    const refused: string[] = []
    const wanted: { host: string; user: string; token: string }[] = []
    for (const g of list.slice(0, MAX_LOGINS)) {
      const host = isRecord(g) ? g.host : undefined
      if (
        isRecord(g) &&
        isHost(g.host) &&
        isAccount(g.user) &&
        isToken(g.token) &&
        !wanted.some(w => w.host === g.host)
      )
        wanted.push({ host: g.host, user: g.user, token: g.token })
      else refused.push(typeof host === 'string' ? host.slice(0, 256) : '?')
    }
    if (list.length > MAX_LOGINS) refused.push(`${list.length - MAX_LOGINS} more`)
    const rec = read()
    const taken: string[] = []
    const kept: { host: string; why: string }[] = []
    // The request waits on these: all of them have the budget, so a host gh cannot reach (a login asks
    // the host) never holds the sync past its own limit; a host that failed is not tried again for a while.
    const started = now()
    const left = (): number => budget - (now() - started)
    const ms = (): number => Math.max(1000, Math.min(TOOL_MS, left()))
    for (const w of wanted) {
      const sha = sha256(w.token)
      if (left() <= 0) {
        kept.push({ host: w.host, why: 'timeout' })
        continue
      }
      const failed = failures.get(w.host)
      if (failed && failed.sha === sha && now() - failed.at < RETRY_MS) {
        kept.push({ host: w.host, why: 'failed-recently' })
        continue
      }
      const had = rec.logins.find(l => l.host === w.host) ?? null
      const via: 'gh' | 'store' = t.gh ? 'gh' : 'store'
      const current = via === 'gh' ? await ghTokenThere(t, w.host, ms()) : await storeToken(t, w.host, w.user, ms())
      const step = loginStep(
        sha,
        had?.via === via ? had.sha : null,
        current === undefined ? undefined : current === null ? null : sha256(current),
      )
      if (step === 'kept') {
        kept.push({ host: w.host, why: had ? 'changed' : current === undefined ? 'unreadable' : 'not-owned' })
        continue
      }
      let helper = had?.helper === true
      if (step === 'login') {
        const ok =
          via === 'gh'
            ? await ghLogin(t, w.host, w.token, ms())
            : await storeLogin(t, w.host, w.user, w.token, ms()).then(r => {
                helper ||= r.helper
                return r.ok
              })
        if (!ok) {
          failures.set(w.host, { sha, at: now() })
          kept.push({ host: w.host, why: via === 'gh' ? 'gh' : 'git' })
          continue
        }
        failures.delete(w.host)
        taken.push(w.host)
      } else if (!had && via === 'gh') {
        // The same login, set by hand: taken over with no second login, and git told to ask gh.
        await ghSetupGit(t, w.host, ms())
      }
      const next: LoginRecord = {
        host: w.host,
        user: w.user,
        sha,
        via,
        ...(helper && { helper: true as const }),
        master: from,
      }
      rec.logins = [...rec.logins.filter(l => l.host !== w.host), next]
    }
    rec.logins.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
    const before = JSON.stringify(read())
    if (JSON.stringify(rec) !== before) save(rec)
    facts = null
    if (taken.length) {
      deps.audit({ op: 'git-login', master: from, hosts: taken })
      deps.log(`node git: GitHub login taken for ${taken.join(', ')} (${t.gh ? 'gh' : "git's store"})`)
    }
    return {
      logins: rec.logins.filter(l => l.master === from).map(l => ({ host: l.host, user: l.user, via: l.via })),
      taken,
      kept,
      refused,
      gh: t.gh !== null,
    }
  }

  async function lookFacts(): Promise<GitFacts> {
    const hosts = ghHosts(t)
    for (const l of read().logins)
      if (l.via === 'store' && !hosts.some(h => h.host === l.host)) hosts.push({ host: l.host, user: l.user })
    return { identity: (await globalIdentity(t)) !== null, logins: hosts }
  }

  async function leave(master: string): Promise<GitLeft> {
    const rec = read()
    const mine = (m: string): boolean => m === master || m === LONE
    const out: string[] = []
    const failed: string[] = []
    const stay: LoginRecord[] = rec.logins.filter(l => !mine(l.master))
    for (const l of rec.logins.filter(x => mine(x.master))) {
      // Only what is still as the bundle gave it: a login the node's owner changed since stays his. One
      // gh cannot read is the bundle's, as when it was given.
      const current = l.via === 'gh' ? await ghTokenThere(t, l.host) : await storeToken(t, l.host, l.user)
      const ours = current === undefined || (current !== null && sha256(current) === l.sha)
      if (ours) {
        const ok =
          l.via === 'gh' ? await ghLogout(t, l.host, l.user) : await storeLogout(t, l.host, l.user, l.helper === true)
        if (ok) out.push(l.host)
        else {
          // Still there: kept in the record, and the next leave tries again.
          failed.push(l.host)
          stay.push(l)
        }
      } else if (l.via === 'store' && l.helper && current === null) await storeLogout(t, l.host, l.user, true)
    }
    let identity = false
    let keepIdentity = rec.identity && !mine(rec.identity.master) ? rec.identity : undefined
    if (rec.identity && mine(rec.identity.master) && sameIdentity(await globalIdentity(t), rec.identity)) {
      await unsetIdentity(t)
      if ((await identityParts(t)).name === null) identity = true
      else {
        failed.push('identity')
        keepIdentity = rec.identity
      }
    }
    save({ ...(keepIdentity && { identity: keepIdentity }), logins: stay })
    facts = null
    if (identity || out.length || failed.length) {
      deps.audit({ op: 'git-left', master, hosts: out, identity, ...(failed.length && { failed }) })
      deps.log(
        `node git: the master ${master} leaves; ${out.length ? `logged out of ${out.join(', ')}` : 'no login to take out'}${identity ? ', its identity taken out' : ''}${failed.length ? `; could not take out ${failed.join(', ')}` : ''}`,
      )
    }
    return { identity, logins: out, ...(failed.length && { failed }) }
  }

  return {
    identity: (given, master) => serial(() => identity(given, master)),
    logins: (given, master) => serial(() => logins(given, master)),
    facts() {
      facts ??= lookFacts().catch(() => ({ identity: false, logins: [] }))
      return facts
    },
    programs: () => [...(t.git ? ['git'] : []), ...(t.gh ? ['gh'] : [])],
    leave: master => serial(() => leave(master)),
  }
}
