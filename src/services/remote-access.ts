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
// The server's passwords are remembered here between clicks (services/held-passwords.ts): every
// server action that carries none gets the held ones; the view has until when only.
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
import { PORT_4 } from '../core/server-texts.ts'
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
import { type HeldPasswords, heldPasswords } from './held-passwords.ts'
import type { ProfileSync } from './profile-sync.ts'
import type { ServerSetup } from './server-setup.ts'
import type { Supervisor } from './tunnel.ts'

export interface RemoteAccess {
  /** What the panel shows (GET /api/access). */
  view(): Promise<AccessView>
  /** One change, `{ op, … }` (POST /api/access): 200 `{ ok: true, … }`, a refusal 409 `{ ok: false, error, … }`, an unknown op 400. */
  op(body: unknown): Promise<{ status: number; body: unknown }>
  /** "Do it myself" as one command, for the tunnel's settings and key (GET /api/access/server-command). */
  command(): Promise<{ status: number; body: unknown }>
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
  /** Setting up the server's web server through the admin connection (services/server-setup.ts). */
  server: ServerSetup
  /** Syncing the Claude profiles with the board installed on the server (services/profile-sync.ts). */
  sync?: ProfileSync
  /** The server's passwords remembered between clicks (a fresh keeper when none is given). */
  held?: HeldPasswords
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
/** Where "Do it myself" may have put the board: 443, else 8443 (case 4; simple-setup spec, call 11). */
const FIND_PORTS = [443, PORT_4]
/**
 * The ops that log in to the server, each with whether its ok proves the login went through with
 * the passwords it carried (a pair or the rules made again only ask about the folders after).
 */
const LOGS_IN: Readonly<Record<string, boolean>> = {
  'server-look': true,
  'server-apply': true,
  'server-undo-look': true,
  'server-undo': true,
  'server-install-look': true,
  'server-install': true,
  'server-install-version': true,
  'server-remove-look': true,
  'server-remove': true,
  'sync-look': true,
  'sync-pair': false,
  'sync-rules': false,
  'sync-dirs': true,
  'sync-mkdir': true,
  'sync-apply': true,
}

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
  const held = d.held ?? heldPasswords()
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
      const sync = d.sync?.view() ?? null
      return {
        tunnel: {
          settings: c,
          problems,
          blocked: blocked(problems),
          listenPort: d.tunnel.listening() ?? tunnelPort(c, webPort),
          status: supervisor.status(),
          ssh: sshBin(),
          key: await keyView(c),
          hostKey: await hostKeyRead.get(
            JSON.stringify([sshKeygenBin(), stampOf(knownHostsFile()), c.host, c.sshPort]),
            () => hostKeyFingerprint(c.host, c.sshPort),
          ),
        },
        login,
        logins,
        attempts,
        server: { ...d.server.view(), passwordHeld: held.view() },
        // only once a sync was asked for: the view is as it was until then
        ...(sync && { sync }),
      }
    },

    async command() {
      const key = await keyView(conf())
      return d.server.oneshot(key.publicKey)
    },

    async op(body) {
      const b0 = isRecord(body) ? body : {}
      const op = typeof b0.op === 'string' ? b0.op : ''
      if (!(op in LOGS_IN)) return answer(b0)
      // the held passwords where the request carries none; then held, or dropped, by the answer
      const before = held.view()?.until ?? null
      const b = held.fill(b0)
      const a = await answer(b)
      held.settle(b, a, LOGS_IN[op] === true)
      if ((held.view()?.until ?? null) !== before) changed()
      return a
    },
  }

  async function answer(b: Record<string, unknown>): Promise<Answer> {
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
        // After "Do it myself", with no setup recorded (call 11): the domain tried on 443, then
        // 8443, and the public port saved where the board answers. Else Test as it always is.
        const findPort = b.findPort === true && d.server.view().setup === null
        const steps = await (findPort ? supervisor.test({ ports: FIND_PORTS }) : supervisor.test())
        // its own ssh may have pinned the server's key; the key's rights may have been put right
        keyRead.forget()
        hostKeyRead.forget()
        if (!findPort) {
          changed()
          return ok({ steps })
        }
        const found = steps.find(s => s.id === 'domain' && s.ok === true)?.port ?? null
        const port = found === 443 ? null : found
        if (found !== null && conf().publicPort !== port) {
          const saved = editTunnel({ publicPort: port })
          if (!saved.ok) return refused(saved.error, { steps })
        }
        // the board answers at its domain: the tunnel on, as after Apply, unless something blocks it
        if (found !== null && !conf().on && blocked(tunnelProblems(conf(), ports())) === null) {
          const on = setTunnelOn(true)
          if (!on.ok) return refused(on.error, { steps })
        }
        changed()
        return ok({ steps, publicPort: found })
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
      // Setting up the server: answers that never hold the body (the passwords)
      case 'server-admin':
        return d.server.admin(b)
      case 'server-look':
        return d.server.look(b)
      case 'server-apply':
        return d.server.apply(b)
      case 'server-undo-look':
        return d.server.undoLook(b)
      case 'server-undo':
        return d.server.undo(b)
      case 'server-cancel':
        return d.server.cancel()
      // The passwords remembered between clicks let go of at once
      case 'server-password-forget':
        if (held.forget()) changed()
        return ok()
      // The board installed on the server itself (path B): its Look, its run, its link let go, and
      // its domain (its own, never among the tunnel's settings)
      case 'server-install-look':
        return d.server.installLook(b)
      case 'server-install':
        return d.server.install(b)
      case 'server-install-forget':
        return d.server.installForget()
      // the version of the board on the server read again (the card's), and its removal: its Look, its run
      case 'server-install-version':
        return d.server.installVersion(b)
      case 'server-remove-look':
        return d.server.removeLook(b)
      case 'server-remove':
        return d.server.remove(b)
      case 'server-install-domain':
        return d.server.installDomain(b)
      // Syncing the Claude profiles with the board on the server: answers that never hold the body (the passwords)
      case 'sync-look':
        return d.sync ? d.sync.look(b) : malformed('no sync')
      case 'sync-pair':
        return d.sync ? d.sync.pair(b) : malformed('no sync')
      case 'sync-rules':
        return d.sync ? d.sync.rules(b) : malformed('no sync')
      case 'sync-dirs':
        return d.sync ? d.sync.dirs(b) : malformed('no sync')
      case 'sync-mkdir':
        return d.sync ? d.sync.mkdir(b) : malformed('no sync')
      case 'sync-apply':
        return d.sync ? d.sync.apply(b) : malformed('no sync')
      case 'sync-cancel':
        return d.sync ? d.sync.cancel() : malformed('no sync')
      case 'sync-forget':
        return d.sync ? d.sync.forget() : malformed('no sync')
      default:
        return malformed(`unknown op ${String(b.op)}`)
    }
  }
}
