// "Add a server" (#509, docs/design/nodes/README.md 11.1, 11.4, 12): a server becomes a node from
// one form in Settings, Devices. On "Set up the server"'s ssh plumbing (core/server-admin.ts,
// adapters/ssh.ts), with a plan of its own (core/node-plan.ts):
//
// - Look: the admin logs in once (a key, or a password held in memory only and given to ssh's
//   askpass, adapters/ssh.ts spawnRemote), the first login pins the server's key and shows it, the
//   probe finds the sudo it needs, and Look reads the server as root, changing nothing. The plan
//   follows in plain words, with what is refused and why, the ceiling proposed and the packages
//   tick. A node already there (set up by hand, or by an earlier run) is said so, and its plan does
//   only what is missing.
// - Apply: the device's token (only its hash crosses, in the plan's config step) and its link key
//   (the link step puts its public half in place), kept by adapters/node-store.ts; the plugin, this
//   board's checkout at its commit as one tar archive, up on the admin's ssh stdin; then the plan as
//   one packed script the server runs as root, followed line by line, a failed step undone there.
// - The master's half, each step said: the device written into config.json's `nodes` (a board
//   without it gets the section), the link started, its hello and first status through the link
//   user, the default thresholds, the first bundle (services/nodes/bundle-sync.ts) with its report,
//   and "Log in to Claude on <device>" while a profile there is not logged in. A failure stops on a
//   state the form continues from (`finish`), and says what to do.
// - Undo: Look again, the record's Undo, and the device's token, link key and entry gone here.
//
// The passwords come with each request and live only as long as it, or its run, does: never in
// config.json, web.log, the view, an answer or a command line. Only the local board reaches this:
// app.ts picks its routes itself, so no remote listener and no node's door has them, and it is made
// the first time the form asks, so a board that never opens it runs none of it.
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { EditResult } from '../../adapters/config-file.ts'
import type { DeviceStore } from '../../adapters/node-store.ts'
import type { RemoteRun, spawnRemote } from '../../adapters/ssh.ts'
import { t } from '../../core/lang.ts'
import {
  type Ceiling,
  ceilingFor,
  ceilingProblem,
  type NodeFacts,
  type NodePlan,
  type NodeRecord,
  type NodeWanted,
  nodeLookScript,
  nodePlan,
  nodeRecord,
  nodeRunScript,
  nodeUndoPlan,
  readNodeLook,
  readNodeRun,
} from '../../core/node-plan.ts'
import {
  cleanScript,
  deviceIdFor,
  deviceIdProblem,
  dropDevice,
  IDLE_VIEW,
  loginOf,
  MASTER_AFTER,
  MASTER_BEFORE,
  type MasterState,
  type MasterStepId,
  masterSteps,
  type NodeSetupView,
  packedRun,
  putDevice,
  readUpload,
  type SetupServer,
  sshLink,
  UPLOAD_SCRIPT,
  uploadFailure,
} from '../../core/node-setup.ts'
import {
  DEVICE_ID,
  defaultThresholds,
  deviceIdFromHost,
  fillThresholds,
  type LinkReason,
  LOCAL,
  NODE_PORT,
  type NodeStatus,
  nodesConfig,
} from '../../core/nodes.ts'
import {
  type AskpassReport,
  adminHint,
  adminSshArgs,
  connectionLost,
  loginHint,
  needFor,
  PROBE_SCRIPT,
  readProbe,
  remoteCommand,
  takesAskpass,
} from '../../core/server-admin.ts'
import type { Text } from '../../core/server-plan.ts'
import type { AdminHint, SudoMode } from '../../core/server-view.ts'
import { fieldProblem } from '../../core/tunnel.ts'
import type { Config } from '../../core/types.ts'
import type { BundleSync, SyncReport } from './bundle-sync.ts'
import type { NodeLinks } from './links.ts'

export interface NodeSetupDeps {
  /** The live config (liveConfig): `nodes` is read from it and mirrored into it at once after a write. */
  cfg: Config
  /** The ssh binary (adapters/ssh.ts sshBin); null when there is none. */
  ssh(): string | null
  /** That binary's `ssh -V` line: asked only for a login by password. */
  sshVersion(bin: string): Promise<string>
  /** The board's own known_hosts (its folder made), where the first admin login pins the server's key; the link reads it too. */
  knownHosts(): string
  hostKeyPinned(host: string, port: number): Promise<boolean>
  hostKeyFingerprint(host: string, port: number): Promise<string | null>
  spawn: typeof spawnRemote
  store: Pick<DeviceStore, 'token' | 'setToken' | 'dropCredentials'>
  /**
   * The public half of the device's link key (adapters/node-store.ts keyPath); with `make`, a new
   * pair is made when there is none, as `board nodes key` makes it. null for a key that is not
   * there and is not to be made.
   */
  linkKey(id: string, make: boolean): Promise<{ ok: true; publicKey: string } | { ok: false; error: string } | null>
  /** This board's commit, and its checkout at that commit as one tar archive (adapters/git.ts). */
  commit(): Promise<string | null>
  archive(commit: string): Promise<Uint8Array | null>
  /** config-file.ts editNodesAdding: refuses a config.json that does not parse. */
  editNodes(change: (nodes: Record<string, unknown>, had: boolean) => boolean): EditResult
  /** The links follow the live config now (app.ts linksFollow): made the first time `nodes` is there. */
  follow(): void
  links(): Pick<NodeLinks, 'link' | 'retry'> | null
  bundles(): Pick<BundleSync, 'syncIfBehind'> | null
  /** This computer's name: this board's id in a new `nodes`, and its name in the node's masters.json. */
  hostName(): string
  onChange(): void
  log(text: string): void
  now(): number
  /** A plan's or a run's id (letters, digits, `.`, `_`, `-`). */
  newId(): string
  /** How long the master waits for the link's hello and first status (BOARD_NODE_SETUP_LINK_MS in tests). */
  linkWaitMs: number
  /** One wait between two looks at the link (adapters/pacing.ts pause). */
  pause(ms: number): Promise<void>
}

export type Answer = { status: number; body: unknown }

export interface NodeSetup {
  view(): NodeSetupView
  /** `{ host, sshPort?, user, key?, port?, id?, password?, sudoPassword? }`: Look and the plan. */
  look(o: Fields): Promise<Answer>
  /** `{ plan, ceiling?, packages?, password?, sudoPassword? }`: Apply the last Look's plan, then the master's half. */
  apply(o: Fields): Promise<Answer>
  /** The master's half again, from config.json on: after a failure there, or a board that was busy. */
  finish(): Promise<Answer>
  /** As look, for the record's Undo. */
  undoLook(o: Fields): Promise<Answer>
  /** `{ plan, work?, password?, sudoPassword? }`. */
  undo(o: Fields): Promise<Answer>
  cancel(): Answer
}

type Fields = Record<string, unknown>

const PROBE_MS = 30_000
const LOOK_MS = 90_000
/** The archive up a slow link: 20 MB at 100 KB/s is under 4 minutes. */
const UPLOAD_MS = 10 * 60_000
const CLEAN_MS = 30_000
/** Past the sum of the steps' own limits: ssh, sudo, and the run's own turns. */
const RUN_MORE_MS = 5 * 60_000
const PASSWORD_MOST = 1024
const DETAIL_LINES = 6
/** The run's lines kept besides its `@@` lines: an installer says a lot. */
const OUT_KEPT = 400
const MASK = '••••'
/** How often the link is looked at while the master waits for it. */
const LINK_LOOK_MS = 250
/** A link refused for one of these does not heal by waiting. */
const FATAL: readonly LinkReason[] = ['host-key', 'key', 'api', 'device', 'not-built']
/** Look's plan before Apply makes the link key: its words do not depend on the key. */
const NO_KEY_YET = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgentBoardLinkKeyIsMadeAtApply0000000000 agent-board link'
const NO_HASH_YET = '0'.repeat(64)
const NO_PATH_YET = '/var/tmp/agent-board-node.XXXXXXXX/plugin.tar'
/** The refusals the packages tick lifts: a tool the steps use comes with it. */
const PACKAGE_REFUSALS = new Set(['node.refuse.curl', 'node.refuse.unzip'])

const PACK = (text: string): string => gzipSync(text).toString('base64')
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const ok = (more: Fields = {}): Answer => ({ status: 200, body: { ok: true, ...more } })
const malformed = (error: string): Answer => ({ status: 400, body: { ok: false, error } })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A password as the page sent it: null for none; false when it is no one-line string. */
function passwordOf(v: unknown): string | null | false {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > PASSWORD_MOST) return false
  return v
}

/** The server as the form named it, or the field that does not check out. */
function serverOf(o: Fields): SetupServer | { field: string; error: string } {
  const host = typeof o.host === 'string' ? o.host.trim() : ''
  const user = typeof o.user === 'string' ? o.user.trim() : ''
  const key = typeof o.key === 'string' ? o.key.trim() : ''
  const sshPort = o.sshPort === undefined || o.sshPort === null || o.sshPort === '' ? 22 : o.sshPort
  if (host === '') return { field: 'host', error: t('tunnel.err.required', { field: t('tunnel.field.host') }) }
  if (user === '') return { field: 'user', error: t('tunnel.err.required', { field: t('server.field.adminUser') }) }
  for (const [field, value] of [
    ['host', host],
    ['user', user],
    ['key', key],
    ['sshPort', sshPort],
  ] as const) {
    const problem = fieldProblem(field, value)
    if (problem) return { field, error: problem }
  }
  return { host, sshPort: sshPort as number, user, key }
}

/** The board's own ports on a node (wake, the web board): the door cannot take either. */
const BOARD_PORTS = [12421, 12422]

/** The door's port the form asked for: undefined for none (the node's own, else the default), null when it is not one. */
function portOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 && !BOARD_PORTS.includes(v as number)
    ? (v as number)
    : null
}

/** The owner's ceiling, each figure a whole number; null when one is not (nodeRefusals checks the ranges). */
function ceilingOf(v: unknown, fallback: Ceiling): Ceiling | null {
  if (v === undefined || v === null) return fallback
  if (!isObject(v)) return null
  const c = { ...fallback }
  for (const key of ['memoryMaxMb', 'memoryHighMb', 'swapMaxMb', 'cpuWeight', 'tasksMax'] as const) {
    if (v[key] === undefined) continue
    if (!Number.isInteger(v[key])) return null
    c[key] = v[key] as number
  }
  return c
}

/** ssh's or sudo's last lines, for an error's detail; null without any. */
const detailOf = (lines: readonly string[]): string | null =>
  lines
    .filter(l => l.trim())
    .slice(-DETAIL_LINES)
    .join('\n') || null

interface Login {
  password: string | null
  typed: boolean
  oldSsh: boolean
}

type SudoFrom = 'login' | 'own' | null
const sudoFromOf = (mode: SudoMode, password: string | null, sudoPassword: string | null): SudoFrom =>
  mode !== 'password' ? null : sudoPassword !== null ? 'own' : password !== null ? 'login' : null

interface Heard {
  code: number | null
  error: string | null
  out: string[]
  err: string[]
  askpass: AskpassReport | null
}

/** What a Look leaves for its Apply or Undo. */
interface Looked {
  kind: 'apply' | 'undo'
  planId: string
  server: SetupServer
  id: string
  port: number
  facts: NodeFacts
  mode: SudoMode
  /** Look's login took the password: Apply and Undo log in with it again. */
  password: boolean
  /** Apply: the commit and its archive Look made the plan with; the ceiling it proposed; whether the packages tick is needed. */
  commit?: string
  archive?: Uint8Array
  ceiling?: Ceiling
  packagesNeeded?: boolean
  /** Undo: the record it undoes. */
  record?: NodeRecord
}

/**
 * What Continue picks up after a failure here: the master's half of an Apply (the device and its
 * link), or the end of an Undo whose server is undone and whose entry here is not gone yet.
 */
type Pending = { kind: 'apply'; id: string; server: SetupServer; port: number } | { kind: 'undo'; id: string }

export function createNodeSetup(d: NodeSetupDeps): NodeSetup {
  let view: NodeSetupView = { ...IDLE_VIEW }
  let last: Looked | null = null
  let pending: Pending | null = null
  let busy = false
  let current: RemoteRun | null = null
  /** The server runs a plan now: it goes on there whatever the board does, so Cancel waits for it. */
  let serverRuns = false
  /** Counts Cancel: what it cut short leaves the view alone. */
  let generation = 0

  const changed = (): void => d.onChange()
  const set = (patch: Partial<NodeSetupView>): void => {
    view = { ...view, ...patch }
    changed()
  }
  const selfId = (): string => nodesConfig(d.cfg.nodes, d.hostName())?.id ?? deviceIdFromHost(d.hostName())
  const masterName = (): string => {
    // a control character in a host name is left out: masters.json's name takes none
    const name = [...d.hostName()]
      .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
      .trim()
      .slice(0, 64)
      .trim()
    return name || selfId()
  }
  const devices = (): Record<string, { link?: unknown } | undefined> => {
    const n = d.cfg.nodes
    return isObject(n) && isObject(n.devices) ? (n.devices as Record<string, { link?: unknown }>) : {}
  }
  const step = (id: MasterStepId, state: MasterState, said: Text | null = null): void =>
    set({ master: view.master.map(s => (s.id === id ? { ...s, state, said: said ?? s.said } : s)) })

  function refused(h: AdminHint | null, detail: string | null, more: Fields = {}): Answer {
    const need = needFor(h)
    return {
      status: 409,
      body: {
        ok: false,
        hint: h,
        error: detail ?? (h ? t(`server.hint.${h}`, { admin: view.server?.user ?? 'root' }) : ''),
        ...(need && { need }),
        ...more,
      },
    }
  }
  const cancelled = (): Answer => refused(null, t('server.err.cancelled'))

  function stopLook(h: AdminHint | null, detail: string | null): Answer {
    set({ phase: 'idle', hint: h, error: detail })
    return refused(h, detail)
  }

  async function loginFor(bin: string, password: string | null): Promise<Login> {
    if (password === null) return { password: null, typed: false, oldSsh: false }
    const takes = takesAskpass(await d.sshVersion(bin))
    return takes ? { password, typed: true, oldSsh: false } : { password: null, typed: true, oldSsh: true }
  }

  /** One ssh to the admin, its lines kept as they are; with `pin`, this login pins the server's key. */
  async function hear(
    bin: string,
    s: SetupServer,
    command: string,
    stdin: string | Uint8Array | null,
    ms: number,
    login: Login,
    pin = false,
  ): Promise<Heard> {
    const args = adminSshArgs({
      conf: { host: s.host, sshPort: s.sshPort },
      admin: { user: s.user, key: s.key },
      knownHosts: d.knownHosts(),
      command,
      ...(login.password !== null && { password: true }),
      ...(pin && { pin }),
    })
    const run = d.spawn(bin, args, stdin, ms, login.password === null ? null : { password: login.password })
    current = run
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    run.onLine((line, from) => heard[from === 'err' ? 'err' : 'out'].push(line))
    const end = await run.done
    if (current === run) current = null
    return { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }
  }

  const mask = (line: string, secrets: readonly string[]): string =>
    secrets.reduce((l, secret) => (secret ? l.replaceAll(secret, MASK) : l), line)

  /** Why an ssh that did not give its answer stopped, as "Set up the server" reads it. */
  function stopped(
    h: Heard,
    login: Login,
    sudoFrom: SudoFrom,
    secrets: readonly string[],
    admin: string,
  ): { hint: AdminHint | null; detail: string | null } {
    if (h.code === null && h.error !== null && h.error !== 'timeout')
      return h.error === 'ENOENT'
        ? { hint: 'noSsh', detail: h.error }
        : { hint: null, detail: t('server.err.spawn', { code: h.error }) }
    const asked = h.askpass?.refused ?? null
    const lines = asked === null ? h.err : [...h.err, t('server.err.prompt', { prompt: asked.trim() })]
    const detail = detailOf(lines.map(l => mask(l, secrets)))
    const said =
      loginHint({
        lines: h.err,
        typed: login.typed,
        askpass: h.askpass,
        oldSsh: login.oldSsh,
        root: admin === 'root',
      }) ?? adminHint(h.err)
    const why = said === 'wrongPassword' && sudoFrom === 'login' ? 'sudoPassword' : said
    if (h.error === 'timeout')
      return { hint: why, detail: [t('server.err.timeout'), detail].filter(Boolean).join('\n') }
    return { hint: why, detail }
  }

  /** The public half of the device's link key, when the store has one: Look checks the keys file against it. */
  async function knownKey(id: string): Promise<string | undefined> {
    const r = await d.linkKey(id, false).catch(() => null)
    return r?.ok ? r.publicKey : undefined
  }

  /** The values a plan is made from; before Apply, the key, the token's hash and the archive's place stand in. */
  function wantedOf(
    l: Pick<Looked, 'id' | 'port'>,
    o: {
      linkKey?: string
      tokenHash?: string
      plugin: { path: string; sha256: string; commit: string }
      ceiling: Ceiling
      packages: boolean
    },
  ): NodeWanted {
    return {
      id: l.id,
      port: l.port,
      linkKey: o.linkKey ?? NO_KEY_YET,
      master: { id: selfId(), name: masterName(), tokenHash: o.tokenHash ?? NO_HASH_YET },
      plugin: o.plugin,
      ceiling: o.ceiling,
      packages: o.packages,
    }
  }

  const planView = (p: NodePlan, id: string, extra: Partial<NonNullable<NodeSetupView['plan']>> = {}) => ({
    id,
    words: p.words,
    warnings: p.warnings,
    steps: p.steps.map(s => ({ id: s.id, title: s.title, why: s.why })),
    ceiling: p.ceiling,
    packagesNeeded: false,
    ...extra,
  })

  const foundOf = (f: NodeFacts): NodeSetupView['found'] => {
    const rec = f.record === null ? null : nodeRecord(f.record)
    return {
      os: f.os.pretty || `${f.os.id} ${f.os.version}`.trim(),
      arch: f.arch,
      cpus: f.cpus,
      memTotalMb: f.memTotalMb,
      memAvailableMb: f.memAvailableMb,
      homeFreeMb: f.homeFreeMb,
      bun: f.bun,
      herdr: f.herdr,
      claude: f.claude,
      node: f.nodeConfig?.id ?? rec?.node.id ?? null,
      record: rec !== null,
    }
  }

  /**
   * Look for Apply or Undo: the login and its probe (the first login pins the server's key), then
   * the server read as root. Leaves the plan (or what refuses it) in the view and in `last`.
   */
  async function lookAt(o: Fields, kind: 'apply' | 'undo'): Promise<Answer> {
    const password = passwordOf(o.password)
    if (password === false) return malformed('password')
    const sudoPassword = passwordOf(o.sudoPassword)
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', null)
    const server = serverOf(o)
    if ('field' in server)
      return { status: 409, body: { ok: false, hint: null, field: server.field, error: server.error } }
    const askedPort = portOf(o.port)
    if (askedPort === null)
      return { status: 409, body: { ok: false, hint: null, field: 'port', error: t('node.setup.err.port') } }
    const asked = o.id === undefined || o.id === null || o.id === '' ? undefined : o.id
    if (asked !== undefined && (typeof asked !== 'string' || !DEVICE_ID.test(asked) || asked === LOCAL))
      return {
        status: 409,
        body: { ok: false, hint: null, field: 'id', error: t('node.setup.refuse.id', { id: String(asked) }) },
      }
    const bin = d.ssh()
    if (!bin) return refused('noSsh', null)
    busy = true
    const gen = generation
    const gone = (): boolean => gen !== generation
    last = null
    pending = null
    view = { ...IDLE_VIEW, phase: 'looking', kind, server }
    changed()
    const secrets = [password ?? '', sudoPassword ?? '']
    try {
      const pinnedBefore = await d.hostKeyPinned(server.host, server.sshPort)
      if (gone()) return cancelled()
      const login = await loginFor(bin, password)
      if (gone()) return cancelled()
      const probe = await hear(bin, server, remoteCommand(PROBE_SCRIPT, 'root'), null, PROBE_MS, login, !pinnedBefore)
      if (gone()) return cancelled()
      const pinnedNow = !pinnedBefore && (await d.hostKeyPinned(server.host, server.sshPort))
      if (pinnedBefore || pinnedNow) {
        const fingerprint = await d.hostKeyFingerprint(server.host, server.sshPort)
        if (fingerprint && !gone()) set({ hostKey: { fingerprint, pinnedNow } })
      }
      if (gone()) return cancelled()
      const read = probe.code === 0 ? readProbe(probe.out) : null
      if (!read) {
        const why = stopped(probe, login, null, secrets, server.user)
        return stopLook(why.hint ?? (probe.code === 0 ? 'unreadable' : null), why.detail)
      }
      if (!pinnedBefore && !pinnedNow) return stopLook('noHostKey', null)
      set({ sudo: read.mode })
      if (read.mode === 'requiretty') return stopLook('requiretty', null)
      if (read.mode === 'none') return stopLook(adminHint(probe.out) ?? 'notSudoer', null)
      const sudoFrom = sudoFromOf(read.mode, password, sudoPassword)
      if (read.mode === 'password' && sudoFrom === null) return stopLook('needPassword', null)
      const stdin = sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`
      const lookOnce = async (port: number, linkKey: string | undefined): Promise<NodeFacts | Answer> => {
        const h = await hear(
          bin,
          server,
          remoteCommand(nodeLookScript({ port, ...(linkKey && { linkKey }) }), read.mode),
          stdin,
          LOOK_MS,
          login,
        )
        if (gone()) return cancelled()
        const f = h.code === 0 ? readNodeLook(h.out) : null
        if (f) return f
        const why = stopped(h, login, sudoFrom, secrets, server.user)
        return stopLook(why.hint ?? (h.code === 0 ? 'unreadable' : null), why.detail)
      }
      // Look with the link key and the door's port of the device this master already has for the
      // host, so a node of its own reads as its own; again when the server names another device
      // (its key) or its node another port (a node set up by hand on a port of the owner's).
      const firstId = deviceIdFor({ asked, host: server.host, sshPort: server.sshPort, devices: devices() })
      const firstKey = firstId ? await knownKey(firstId) : undefined
      const firstLink = firstId ? devices()[firstId]?.link : undefined
      const firstPort =
        askedPort ?? (isObject(firstLink) && Number.isInteger(firstLink.port) ? (firstLink.port as number) : NODE_PORT)
      let f = await lookOnce(firstPort, firstKey)
      if (!('os' in f)) return f
      const rec = f.record === null ? null : nodeRecord(f.record)
      const port = askedPort ?? f.nodeConfig?.port ?? rec?.node.port ?? firstPort
      const id =
        deviceIdFor({
          asked,
          host: server.host,
          sshPort: server.sshPort,
          devices: devices(),
          server: { nodeId: f.nodeConfig?.id ?? null, recordId: rec?.node.id ?? null, hostname: f.hostname },
        }) ?? deviceIdFromHost(server.host)
      const key = id === firstId ? firstKey : await knownKey(id)
      if (key !== firstKey || port !== firstPort) {
        const again = await lookOnce(port, key)
        if (!('os' in again)) return again
        f = again
      }
      const planId = d.newId()
      const base = {
        kind,
        planId,
        server,
        id,
        port,
        facts: f,
        mode: read.mode,
        password: (probe.askpass?.answered ?? 0) > 0,
      }
      set({ device: { id, port }, found: foundOf(f) })
      return kind === 'apply' ? await planApply(base) : planUndo(base)
    } catch (err) {
      if (gone()) return cancelled()
      return stopLook(null, messageOf(err))
    } finally {
      if (!gone()) busy = false
    }
  }

  /** Apply's plan from what Look found: refused in words, or the plan with the ceiling proposed. */
  async function planApply(l: Looked): Promise<Answer> {
    const idWhy = deviceIdProblem(l.id, {
      host: l.server.host,
      sshPort: l.server.sshPort,
      selfId: selfId(),
      devices: devices(),
    })
    const commit = await d.commit()
    const archive = commit ? await d.archive(commit) : null
    if (!commit || !archive) return stopLook(null, t('node.setup.err.archive'))
    const proposed: Ceiling = ceilingFor(l.facts) ?? {
      memoryMaxMb: 1500,
      memoryHighMb: 1200,
      swapMaxMb: 512,
      cpuWeight: 50,
      tasksMax: 3000,
    }
    const plugin = { path: NO_PATH_YET, sha256: sha256(archive), commit }
    const token = d.store.token(l.id)
    const key = await knownKey(l.id)
    const made = (packages: boolean) =>
      nodePlan(
        l.facts,
        wantedOf(l, {
          ...(key && { linkKey: key }),
          ...(token && { tokenHash: sha256(token) }),
          plugin,
          ceiling: proposed,
          packages,
        }),
      )
    let r = made(false)
    let packagesNeeded = false
    if (!r.ok && r.why.every(w => PACKAGE_REFUSALS.has(w.key))) {
      r = made(true)
      packagesNeeded = true
    }
    const refusals = [...(idWhy ? [idWhy] : []), ...(r.ok ? [] : r.why)]
    if (refusals.length || !r.ok) {
      set({ phase: 'plan', refusals, plan: null })
      return ok()
    }
    last = { ...l, commit, archive, ceiling: proposed, packagesNeeded }
    const words =
      l.facts.nodeConfig || l.facts.record !== null
        ? [{ key: 'node.setup.already', params: { id: l.facts.nodeConfig?.id ?? l.id } }, ...r.plan.words]
        : r.plan.words
    set({
      phase: 'plan',
      refusals: [],
      plan: planView({ ...r.plan, words }, l.planId, { ceiling: proposed, packagesNeeded }),
      run: {
        steps: r.plan.steps.map(s => ({ id: s.id, state: 'wait' })),
        undone: [],
        result: null,
        warnings: [],
        said: [],
      },
      master: masterSteps([...MASTER_BEFORE, ...MASTER_AFTER]),
    })
    return ok()
  }

  /** Undo's plan from the record Look found; none: nothing of a run of the board's is there. */
  function planUndo(l: Looked): Answer {
    const rec = l.facts.record === null ? null : nodeRecord(l.facts.record)
    if (!rec) return stopLook(null, t(l.facts.nodeConfig ? 'node.setup.err.byHand' : 'node.setup.err.noRecord'))
    const p = nodeUndoPlan(rec, { work: false })
    last = { ...l, id: rec.node.id, record: rec }
    set({
      phase: 'plan',
      device: { id: rec.node.id, port: rec.node.port },
      plan: planView(p, l.planId, { work: false }),
      run: { steps: p.steps.map(s => ({ id: s.id, state: 'wait' })), undone: [], result: null, warnings: [], said: [] },
      master: [],
    })
    return ok()
  }

  /** The admin's login for a run: the password again when Look took it, sudo's on stdin. Or the refusal. */
  async function runLogin(
    l: Looked,
    password: string | null,
    sudoPassword: string | null,
  ): Promise<{ bin: string; login: Login; sudoFrom: SudoFrom; stdin: string | null } | Answer> {
    if (l.password && password === null) return refused('loginPassword', null)
    const sudoFrom = sudoFromOf(l.mode, password, sudoPassword)
    if (l.mode === 'password' && sudoFrom === null) return refused('needPassword', null)
    const bin = d.ssh()
    if (!bin) return refused('noSsh', null)
    if (!(await d.hostKeyPinned(l.server.host, l.server.sshPort))) return refused('noHostKey', null)
    const login = await loginFor(bin, password)
    return {
      bin,
      login,
      sudoFrom,
      stdin: sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`,
    }
  }

  /**
   * One packed run on the server as root, followed line by line into the view; its end. The run's
   * own lines are shown as it printed them, a step's output masked where it holds a password.
   */
  async function runOnServer(
    l: Looked,
    to: { bin: string; login: Login; stdin: string | null },
    plan: NodePlan,
    secrets: readonly string[],
  ): Promise<{ heard: Heard; lines: string[] }> {
    const runId = d.newId()
    const at = new Date(d.now()).toISOString()
    const script = packedRun(plan.kind, nodeRunScript(plan, { id: runId, at }), PACK)
    const ms = plan.steps.reduce((sum, s) => sum + s.timeoutS * 1000, 0) + RUN_MORE_MS
    const args = adminSshArgs({
      conf: { host: l.server.host, sshPort: l.server.sshPort },
      admin: { user: l.server.user, key: l.server.key },
      knownHosts: d.knownHosts(),
      command: remoteCommand(script, l.mode),
      ...(to.login.password !== null && { password: true }),
    })
    const child = d.spawn(
      to.bin,
      args,
      to.stdin,
      ms,
      to.login.password === null ? null : { password: to.login.password },
    )
    current = child
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    const lines: string[] = []
    let others = 0
    child.onLine((line, from) => {
      if (from === 'err') {
        heard.err.push(line)
        return
      }
      // the run's own protocol lines as it printed them (a password may be a word they hold); its
      // words, a step's output and a warning, masked
      const shown = /^@@(step|undo|result|kept) /.test(line) ? line : mask(line, secrets)
      if (!shown.startsWith('@@')) {
        others++
        if (others > OUT_KEPT) {
          const at = lines.findIndex(x => !x.startsWith('@@'))
          if (at >= 0) lines.splice(at, 1)
        }
      }
      lines.push(shown)
      heard.out.push(shown)
      if (heard.out.length > OUT_KEPT) heard.out.shift()
      if (!line.startsWith('@@')) return
      const r = readNodeRun(lines)
      const steps = (view.run?.steps ?? []).map(s => ({
        ...s,
        state: r.steps.find(x => x.id === s.id)?.state ?? s.state,
      }))
      set({ run: { steps, undone: r.undone, result: r.result, warnings: r.warnings, said: r.said } })
    })
    const end = await child.done
    if (current === child) current = null
    return { heard: { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }, lines }
  }

  /** A run that did not end applied or undone: the view says why and what to do. */
  function runFailed(
    r: ReturnType<typeof readNodeRun>,
    heard: Heard,
    login: Login,
    sudoFrom: SudoFrom,
    secrets: readonly string[],
    l: Looked,
  ): void {
    let hint: AdminHint | null = null
    let error: string | null = null
    let next: Text | null = null
    if (r.result === null) {
      const why = stopped(heard, login, sudoFrom, secrets, l.server.user)
      const lost = heard.out.length > 0 || (heard.code === 255 && connectionLost(heard.err))
      hint = why.hint ?? (lost ? 'lost' : null)
      error = why.detail
      next = { key: lost ? 'node.setup.next.lost' : 'node.setup.next.again' }
    } else {
      if (r.result === 'busy') hint = 'busy'
      error = r.said.slice(-DETAIL_LINES).join('\n') || null
      next = {
        key:
          r.result === 'rollback-failed' || r.result === 'undo-failed'
            ? 'node.setup.next.undo'
            : 'node.setup.next.again',
      }
    }
    set({ phase: 'failed', hint, error, next })
  }

  /** The master's half after the server's run, from config.json on; each step said; a failure stops where Continue picks up. */
  async function finishMaster(p: Extract<Pending, { kind: 'apply' }>, gen: number): Promise<void> {
    const gone = (): boolean => gen !== generation
    const fail = (id: MasterStepId, said: Text, next: Text): void => {
      // a Cancel meanwhile left the form idle: it stays so
      if (gone()) return
      step(id, 'fail', said)
      set({ phase: 'failed', next, error: null })
    }
    set({ phase: 'finishing', next: null, error: null, hint: null })
    for (const s of view.master)
      if (MASTER_AFTER.includes(s.id as (typeof MASTER_AFTER)[number]) && s.state !== 'wait') step(s.id, 'wait')
    // config.json's `nodes`: the device and its link, the section made when there is none
    step('config', 'run')
    const link = sshLink(p.server.host, p.server.sshPort, p.port)
    const me = selfId()
    let wrote = false
    const r = d.editNodes((nodes, had) => {
      wrote = putDevice(nodes, had, { id: p.id, link, selfId: me })
      return wrote
    })
    if (!r.ok)
      return fail(
        'config',
        { key: 'node.setup.said.config', params: { error: r.error } },
        { key: 'node.setup.next.config' },
      )
    // the live config at once, not ~120 ms later when its watcher follows the file
    const liveHad = isObject(d.cfg.nodes)
    const live = liveHad ? structuredClone(d.cfg.nodes as Fields) : {}
    putDevice(live, liveHad, { id: p.id, link, selfId: me })
    d.cfg.nodes = live
    step('config', wrote ? 'ok' : 'skip', { key: 'node.setup.said.device', params: { id: p.id } })
    d.follow()
    // no links after the board followed config.json: the section does not check out (nodesConfig)
    if (!d.links()) return fail('link', { key: 'node.setup.said.noLinks' }, { key: 'node.setup.next.config' })
    // the link up, through the link user: the door's hello, then the first status
    step('link', 'run')
    const deadline = d.now() + d.linkWaitMs
    let retried = false
    let status: NodeStatus | null = null
    for (;;) {
      if (gone()) return
      const lk = d.links()?.link(p.id) ?? null
      const st = lk?.state()
      if (st?.state === 'refused' && st.reason && FATAL.includes(st.reason))
        return fail(
          'link',
          { key: `node.setup.why.${st.reason}`, params: { detail: st.detail ?? '' } },
          { key: 'node.setup.next.link' },
        )
      // the door read masters.json a moment after the run wrote it: the link asks again at once, once
      if (st?.state === 'refused' && st.reason === 'token' && !retried) {
        retried = true
        d.links()?.retry(p.id)
      }
      if (lk && st?.state === 'online') {
        if (view.master.find(s => s.id === 'link')?.state !== 'ok') step('link', 'ok')
        step('status', 'run')
        status = await lk.status()
        if (gone()) return
        if (status) break
      }
      if (d.now() > deadline) {
        const which = st?.state === 'online' ? 'status' : 'link'
        const why: Text =
          st?.state === 'refused' && st.reason
            ? { key: `node.setup.why.${st.reason}`, params: { detail: st.detail ?? '' } }
            : { key: 'node.setup.said.noAnswer', params: { s: String(Math.round(d.linkWaitMs / 1000)) } }
        return fail(which, why, { key: 'node.setup.next.link' })
      }
      await d.pause(LINK_LOOK_MS)
    }
    step('status', 'ok', {
      key: 'node.setup.said.status',
      params: { mem: String(status.memTotalMb), cpus: String(status.cpus) },
    })
    // the default thresholds from the first status; a figure the owner set stays
    step('thresholds', 'run')
    const given = defaultThresholds(status)
    let filled = false
    const t2 = d.editNodes(nodes => {
      filled = fillThresholds(nodes, p.id, given)
      return filled
    })
    if (!t2.ok)
      return fail(
        'thresholds',
        { key: 'node.setup.said.config', params: { error: t2.error } },
        { key: 'node.setup.next.config' },
      )
    if (isObject(d.cfg.nodes)) fillThresholds(d.cfg.nodes as Fields, p.id, given)
    step('thresholds', filled ? 'ok' : 'skip', {
      key: 'node.setup.said.thresholds',
      params: { sessions: String(given.maxSessions), mem: String(given.minFreeMemMb) },
    })
    // the first bundle, before any start there: the owner's settings answer a fresh profile's dialogs
    step('bundle', 'run', { key: 'node.place.syncing', params: { name: p.id } })
    const bundles = d.bundles()
    if (!bundles) return fail('bundle', { key: 'node.setup.said.noLinks' }, { key: 'node.setup.next.bundle' })
    let report: SyncReport
    try {
      report = await bundles.syncIfBehind(p.id)
    } catch (err) {
      return fail(
        'bundle',
        { key: 'node.setup.said.bundleError', params: { error: messageOf(err) } },
        { key: 'node.setup.next.bundle' },
      )
    }
    if (gone()) return
    view = {
      ...view,
      bundle: {
        ok: report.ok,
        applied: report.applied.length,
        kept: report.kept.length,
        sent: report.sent,
        why: report.why ?? null,
      },
    }
    if (!report.ok)
      return fail(
        'bundle',
        { key: 'node.setup.said.bundleFailed', params: { why: report.why ?? '', detail: report.detail ?? '' } },
        { key: 'node.setup.next.bundle' },
      )
    step('bundle', 'ok', {
      key: 'node.setup.said.bundle',
      params: { applied: String(report.applied.length), kept: String(report.kept.length) },
    })
    // Claude's login there: the status says which profile is logged in
    const login = loginOf(p.id, status)
    const out = login?.profiles.some(x => x.loggedIn !== true) ?? true
    view = { ...view, login }
    step('login', out ? 'wait' : 'ok', {
      key: out ? 'node.setup.said.login' : 'node.setup.said.loggedIn',
      params: { device: p.id },
    })
    d.log(`node setup: ${p.id} added`)
    set({ phase: 'done' })
  }

  async function runApply(o: Fields): Promise<Answer> {
    const password = passwordOf(o.password)
    if (password === false) return malformed('password')
    const sudoPassword = passwordOf(o.sudoPassword)
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', null)
    const l = last
    if (
      l?.kind !== 'apply' ||
      typeof o.plan !== 'string' ||
      o.plan !== l.planId ||
      !l.archive ||
      !l.commit ||
      !l.ceiling
    )
      return refused('lookAgain', null)
    const ceiling = ceilingOf(o.ceiling, l.ceiling)
    if (!ceiling) return malformed('ceiling')
    // the owner's figures checked before anything is made or sent
    const tooMuch = ceilingProblem(ceiling, l.facts)
    if (tooMuch)
      return { status: 409, body: { ok: false, hint: null, field: 'ceiling', error: t(tooMuch.key, tooMuch.params) } }
    if (o.packages !== undefined && typeof o.packages !== 'boolean') return malformed('packages')
    const packages = o.packages === true
    if (l.packagesNeeded && !packages) return refused(null, t('node.setup.err.packages'))
    busy = true
    const gen = generation
    const gone = (): boolean => gen !== generation
    const secrets = [password ?? '', sudoPassword ?? '']
    // the run, once started, frees the form itself when it and the master's half are over
    let detached = false
    try {
      const to = await runLogin(l, password, sudoPassword)
      if ('status' in to) return to
      if (gone()) return cancelled()
      // the commit Look made the plan with: a new one since needs its own Look (its archive differs)
      const commitNow = await d.commit()
      if (gone()) return cancelled()
      if (commitNow !== l.commit) return refused('lookAgain', null)
      last = null
      pending = null
      set({
        phase: 'applying',
        hint: null,
        error: null,
        next: null,
        master: masterSteps([...MASTER_BEFORE, ...MASTER_AFTER]),
      })
      const fail = (id: MasterStepId, said: Text, next: Text = { key: 'node.setup.next.again' }): Answer => {
        step(id, 'fail', said)
        set({ phase: 'failed', next })
        return ok()
      }
      // the device's token, made here and kept here; only its hash goes to the server
      step('token', 'run')
      let token = d.store.token(l.id)
      const madeToken = token === null
      if (token === null) {
        token = randomBytes(32).toString('base64url')
        d.store.setToken(l.id, token)
      }
      step('token', madeToken ? 'ok' : 'skip', {
        key: madeToken ? 'node.setup.said.tokenMade' : 'node.setup.said.tokenKept',
      })
      // the link key: its public half goes in the link user's keys file
      step('key', 'run')
      const key = await d.linkKey(l.id, true)
      if (!key?.ok)
        return fail('key', { key: 'node.setup.said.keyFailed', params: { error: key && !key.ok ? key.error : '' } })
      step('key', 'ok')
      step('archive', 'ok', {
        key: 'node.setup.said.archive',
        params: { commit: l.commit.slice(0, 8), mb: (l.archive.length / 1048576).toFixed(1) },
      })
      // the plugin up as the admin, into a folder only the admin and root can read
      step('upload', 'run')
      const up = await hear(to.bin, l.server, remoteCommand(UPLOAD_SCRIPT, 'root'), l.archive, UPLOAD_MS, to.login)
      if (gone()) return cancelled()
      const where = up.code === 0 ? readUpload(up.out) : null
      if (!where) {
        const why = stopped(up, to.login, null, secrets, l.server.user)
        set({ hint: why.hint, error: uploadFailure(up.out) ?? why.detail })
        return fail('upload', { key: 'node.setup.said.uploadFailed' })
      }
      const sha = sha256(l.archive)
      if (where.sha256 !== sha) {
        await clean(to, l, where.path)
        return fail('upload', { key: 'node.setup.said.uploadChanged' })
      }
      step('upload', 'ok')
      const r = nodePlan(
        l.facts,
        wantedOf(l, {
          linkKey: key.publicKey,
          tokenHash: sha256(token),
          plugin: { path: where.path, sha256: sha, commit: l.commit },
          ceiling,
          packages,
        }),
      )
      if (!r.ok) {
        set({ phase: 'failed', refusals: r.why, next: { key: 'node.setup.next.again' } })
        void clean(to, l, where.path)
        return ok()
      }
      set({
        run: {
          steps: r.plan.steps.map(s => ({ id: s.id, state: 'wait' })),
          undone: [],
          result: null,
          warnings: [],
          said: [],
        },
      })
      detached = true
      void (async () => {
        let applied = false
        try {
          serverRuns = true
          const { heard, lines } = await runOnServer(l, to, r.plan, secrets)
          serverRuns = false
          await clean(to, l, where.path)
          const run = readNodeRun(lines)
          if (run.result !== 'applied') {
            runFailed(run, heard, to.login, to.sudoFrom, secrets, l)
            return
          }
          applied = true
          const p = { kind: 'apply' as const, id: l.id, server: l.server, port: l.port }
          pending = p
          await finishMaster(p, gen)
        } catch (err) {
          serverRuns = false
          if (!gone())
            set({
              phase: 'failed',
              error: messageOf(err),
              next: { key: applied ? 'node.setup.next.finish' : 'node.setup.next.lost' },
            })
        } finally {
          if (!gone()) busy = false
          changed()
        }
      })()
      return ok()
    } catch (err) {
      set({ phase: 'failed', error: messageOf(err), next: { key: 'node.setup.next.again' } })
      return ok()
    } finally {
      if (!detached && !gone()) busy = false
    }
  }

  /** The upload's folder removed, as the admin; a failure only logged (the folder is the admin's own, under /var/tmp). */
  async function clean(to: { bin: string; login: Login }, l: Looked, path: string): Promise<void> {
    try {
      const h = await hear(to.bin, l.server, remoteCommand(cleanScript(path), 'root'), null, CLEAN_MS, to.login)
      if (h.code !== 0)
        d.log(`node setup: the archive's folder on ${l.server.host} was not removed (${h.code ?? h.error})`)
    } catch (err) {
      d.log(`node setup: the archive's folder was not removed: ${messageOf(err)}`)
    }
  }

  /** Whether this master's device of that id is the one for this server (its link goes to that host). */
  const oursFor = (id: string, s: SetupServer): boolean => {
    const link = devices()[id]?.link
    return (
      isObject(link) &&
      link.kind === 'ssh' &&
      link.host === s.host &&
      ((link.sshPort as number | undefined) ?? 22) === s.sshPort
    )
  }

  /** A device's entry changed here and in the live config at once; whether the file took it. */
  function editDevice(change: (nodes: Fields) => boolean): { ok: true } | { ok: false; error: string } {
    const r = d.editNodes((nodes, had) => had && change(nodes))
    if (!r.ok) return r
    if (isObject(d.cfg.nodes)) {
      const live = structuredClone(d.cfg.nodes as Fields)
      change(live)
      d.cfg.nodes = live
    }
    d.follow()
    return { ok: true }
  }

  /** After the server's Undo: the device's entry goes from config.json, then its token and link key. */
  function dropHere(id: string): boolean {
    const r = editDevice(nodes => dropDevice(nodes, id))
    if (!r.ok) {
      pending = { kind: 'undo', id }
      set({ phase: 'failed', error: r.error, next: { key: 'node.setup.next.undoConfig' } })
      return false
    }
    d.store.dropCredentials(id)
    pending = null
    return true
  }

  async function runUndo(o: Fields): Promise<Answer> {
    const password = passwordOf(o.password)
    if (password === false) return malformed('password')
    const sudoPassword = passwordOf(o.sudoPassword)
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', null)
    const l = last
    if (l?.kind !== 'undo' || !l.record || typeof o.plan !== 'string' || o.plan !== l.planId)
      return refused('lookAgain', null)
    if (o.work !== undefined && typeof o.work !== 'boolean') return malformed('work')
    const plan = nodeUndoPlan(l.record, { work: o.work === true })
    busy = true
    const gen = generation
    const secrets = [password ?? '', sudoPassword ?? '']
    const to = await runLogin(l, password, sudoPassword)
    if ('status' in to) {
      busy = false
      return to
    }
    if (gen !== generation) return cancelled()
    last = null
    const id = l.record.node.id
    const ours = oursFor(id, l.server)
    // nothing new is placed on a node being taken down: paused here first (the placer refuses a
    // paused device at once); it stays paused if the Undo fails, for the owner to see
    if (ours) {
      const paused = editDevice(nodes => {
        const entry = isObject(nodes.devices) ? (nodes.devices as Fields)[id] : null
        if (!isObject(entry) || entry.paused === true) return false
        entry.paused = true
        return true
      })
      if (!paused.ok) {
        busy = false
        return refused(null, paused.error)
      }
    }
    set({
      phase: 'undoing',
      hint: null,
      error: null,
      next: null,
      plan: view.plan && { ...view.plan, work: o.work === true },
    })
    void (async () => {
      try {
        serverRuns = true
        const { heard, lines } = await runOnServer(l, to, plan, secrets)
        serverRuns = false
        const run = readNodeRun(lines)
        if (gen !== generation) return
        if (run.result !== 'undone' && run.result !== 'none') {
          runFailed(run, heard, to.login, to.sudoFrom, secrets, l)
          return
        }
        // this master's device for that server goes too: its entry, then its token and link key
        if (ours && !dropHere(id)) return
        d.log(`node setup: ${id} undone on ${l.server.host}`)
        set({ phase: 'undone' })
      } catch (err) {
        serverRuns = false
        set({ phase: 'failed', error: messageOf(err), next: { key: 'node.setup.next.lost' } })
      } finally {
        if (gen === generation) busy = false
        changed()
      }
    })()
    return ok()
  }

  return {
    view: () => view,
    look: o => lookAt(o, 'apply'),
    undoLook: o => lookAt(o, 'undo'),
    apply: o => runApply(o),
    undo: o => runUndo(o),
    async finish() {
      if (busy) return refused('busy', null)
      const p = pending
      if (!p || view.phase !== 'failed') return refused('lookAgain', null)
      if (p.kind === 'undo') {
        if (dropHere(p.id)) set({ phase: 'undone', error: null, next: null })
        return ok()
      }
      busy = true
      const gen = generation
      try {
        await finishMaster(p, gen)
      } catch (err) {
        if (gen === generation) set({ phase: 'failed', error: messageOf(err), next: { key: 'node.setup.next.finish' } })
      } finally {
        if (gen === generation) busy = false
        changed()
      }
      return ok()
    },
    cancel() {
      // a run goes on on the server whatever the board does: it is followed to its end. Before it
      // (the archive on its way up), and in the master's half, Cancel stops what goes on here.
      if (serverRuns || view.phase === 'undoing') return refused('busy', null)
      generation += 1
      current?.kill()
      current = null
      busy = false
      last = null
      pending = null
      view = { ...IDLE_VIEW }
      changed()
      return ok()
    },
  }
}
