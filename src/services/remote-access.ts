// Remote access as the board on this computer sets it up (spec, "The 'Remote access…' panel"):
// the panel's view, and each change it asks for. Only the local board reaches this
// (server/routes/access.ts): every remote listener refuses /api/access (core/remote.ts localOnly).
// The view holds no secret: the public key is none, and the TOTP secret goes out once, in
// totp-begin's own answer. A tunnel field that fails its own check is refused with config.json
// untouched; changing the domain while passkeys or logins exist is asked first (they belong to
// the old one), and then ends them all.
// The view is fetched on every change of the board's access, which anyone on the internet can
// make (a failed sign-in is recorded): what ssh-keygen reads of the key and of the pinned server
// key is kept while their files stay as they were, and read again after Generate key, Forget the
// server's key and Test connection.
import { existsSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { type EditResult, editTunnel, setTunnelOn } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import {
  forgetHostKey,
  generatedKey,
  generateKey,
  hostKeyFingerprint,
  keyPath,
  knownHostsFile,
  publicKeyOf,
  sshBin,
  sshKeygenBin,
} from '../adapters/ssh.ts'
import type { AccessView } from '../core/access.ts'
import { t } from '../core/lang.ts'
import {
  boardPorts,
  fieldProblem,
  type TunnelConfig,
  type TunnelField,
  type TunnelProblem,
  tunnelConfig,
  tunnelPort,
  tunnelProblems,
} from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import type { Access } from './access.ts'
import type { Supervisor } from './tunnel.ts'

export interface RemoteAccess {
  /** What the panel shows (GET /api/access). */
  view(): Promise<AccessView>
  /** One change, `{ op, … }` (POST /api/access): 200 `{ ok: true, … }`, a refusal 409 `{ ok: false, error, … }`, an unknown op 400. */
  op(body: unknown): Promise<{ status: number; body: unknown }>
}

export interface RemoteAccessDeps {
  /** The live config (liveConfig). */
  cfg: Config
  webPort: number
  access: Access
  /** The tunnel's ssh (services/tunnel.ts): its status, and Test connection. */
  supervisor: Supervisor
  /** The tunnel listener (server/tunnel.ts): the port it listens on, or null. */
  tunnel: { listening(): number | null }
  /** A change of the view nothing else tells of: a key made, the server's key forgotten, or pinned by a Test. */
  onChange?: () => void
}

type Answer = { status: number; body: unknown }

const ok = (more: object = {}): Answer => ({ status: 200, body: { ok: true, ...more } })
const refused = (error: string, more: object = {}): Answer => ({ status: 409, body: { ok: false, error, ...more } })
const edited = (r: EditResult): Answer => (r.ok ? ok() : refused(r.error))
const malformed = (error: string): Answer => ({ status: 400, body: { ok: false, error } })

const FIELDS: ReadonlySet<string> = new Set<TunnelField>([
  'host',
  'sshPort',
  'user',
  'key',
  'socket',
  'domain',
  'publicPort',
  'port',
])
const isField = (name: string): name is TunnelField => FIELDS.has(name)

/** A file as it stands (its size and times), '' when it is not there. */
function stampOf(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    return ''
  }
}

/** One answer kept while its stamp (the files it read, as they stand) stays the same. */
function keptBy<T>(): { get(stamp: string, read: () => Promise<T>): Promise<T>; forget(): void } {
  let kept: { stamp: string; value: Promise<T> } | null = null
  return {
    get(stamp, read) {
      if (kept?.stamp === stamp) return kept.value
      const value = read()
      const entry = { stamp, value }
      kept = entry
      // A read that failed is not kept.
      value.catch(() => {
        if (kept === entry) kept = null
      })
      return value
    },
    forget() {
      kept = null
    },
  }
}

export function createRemoteAccess(d: RemoteAccessDeps): RemoteAccess {
  const { cfg, webPort, access, supervisor } = d
  const conf = () => tunnelConfig(cfg.tunnel)
  const ports = () => boardPorts(cfg.remote, webPort)
  const changed = (): void => d.onChange?.()
  // What ssh-keygen said of the key and of the pinned server key, by the files it read.
  const keyRead = keptBy<Awaited<ReturnType<typeof publicKeyOf>>>()
  const hostKeyRead = keptBy<string | null>()

  /** Why On is refused now: the first setting that does not check out, or the login not set up; null when it may be on. */
  const blocked = (problems: readonly TunnelProblem[]): string | null =>
    problems[0]?.message ?? (access.ready() ? null : t('access.err.notReady'))

  /** The key ssh is given: whether it is there, and its public half as ssh-keygen reads it (or why not). */
  async function keyView(c: TunnelConfig): Promise<AccessView['tunnel']['key']> {
    const path = keyPath(c)
    const exists = existsSync(path)
    const stamp = JSON.stringify([sshKeygenBin(), path, stampOf(path), stampOf(`${path}.pub`)])
    const read = exists ? await keyRead.get(stamp, () => publicKeyOf(path)) : null
    return {
      path,
      generated: !c.key,
      exists,
      publicKey: read?.ok ? read.publicKey : null,
      error: read && !read.ok ? read.error : null,
    }
  }

  /**
   * `{ op: 'tunnel', fields, confirm? }`: each field checked on its own (the domain trimmed and
   * lowercased first; null or '' takes the default, unchecked), then saved together, or none.
   */
  function editFields(fields: unknown, confirm: boolean): Answer {
    if (!isRecord(fields)) return malformed('fields')
    const now = conf()
    const saved: Partial<Record<TunnelField, unknown>> = {}
    for (const [field, given] of Object.entries(fields)) {
      // Only the settings: `on` has an op of its own, with its checks.
      if (!isField(field)) return malformed(`unknown field ${field}`)
      const value = field === 'domain' && typeof given === 'string' ? given.trim().toLowerCase() : given
      const problem = value === null || value === '' ? null : fieldProblem(field, value, ports())
      if (problem) return refused(problem, { field })
      saved[field] = value
    }
    const domain = 'domain' in saved ? (typeof saved.domain === 'string' ? saved.domain : '') : now.domain
    if (domain !== now.domain) {
      if (!confirm && access.hasPasskeysOrLogins()) return refused(t('access.domainSure'), { confirm: 'domain' })
      access.domainChanged()
    }
    return edited(editTunnel(saved))
  }

  /** Generate key: the board's own pair, made again only when asked to replace the one there. */
  async function newKey(replace: boolean): Promise<Answer> {
    if (existsSync(generatedKey()) && !replace) return refused(t('access.keySure'), { confirm: 'key' })
    const made = await generateKey(`agent-board@${hostname()}`)
    keyRead.forget()
    if (!made.ok) return refused(made.error)
    changed()
    return ok({ publicKey: made.publicKey })
  }

  return {
    async view() {
      const c = conf()
      const problems = tunnelProblems(c, ports())
      const { logins, attempts, ...login } = access.view()
      return {
        tunnel: {
          settings: c,
          problems,
          blocked: blocked(problems),
          listenPort: d.tunnel.listening() ?? tunnelPort(c, webPort),
          status: supervisor.status(),
          ssh: sshBin(),
          key: await keyView(c),
          hostKey: await hostKeyRead.get(JSON.stringify([sshKeygenBin(), stampOf(knownHostsFile())]), () =>
            hostKeyFingerprint(),
          ),
        },
        login,
        logins,
        attempts,
        server: null,
      }
    },

    async op(body) {
      const b = isRecord(body) ? body : {}
      const id = typeof b.id === 'string' ? b.id : ''
      switch (b.op) {
        case 'tunnel':
          return editFields(b.fields, b.confirm === true)
        case 'on': {
          const why = blocked(tunnelProblems(conf(), ports()))
          return why === null ? edited(setTunnelOn(true)) : refused(why)
        }
        case 'off':
          return edited(setTunnelOn(false))
        case 'key-generate':
          return newKey(b.replace === true)
        case 'hostkey-forget':
          forgetHostKey()
          hostKeyRead.forget()
          changed()
          return ok()
        case 'test': {
          const steps = await supervisor.test()
          // its own ssh may have pinned the server's key; the key's rights may have been put right
          keyRead.forget()
          hostKeyRead.forget()
          changed()
          return ok({ steps })
        }
        case 'password':
          return edited(await access.setPassword(b.password))
        case 'totp-begin':
          return ok(access.beginTotp(conf().domain))
        case 'totp-confirm':
          return edited(access.confirmTotp(b.code))
        // Gone already (another tab, an expiry) is what was asked for, too.
        case 'passkey-remove':
          access.removePasskey(id)
          return ok()
        case 'login-end':
          access.end(id)
          return ok()
        case 'logins-end-all':
          access.endAll()
          return ok()
        case 'lockout-lift':
          access.liftLockout()
          return ok()
        default:
          return malformed(`unknown op ${String(b.op)}`)
      }
    },
  }
}
