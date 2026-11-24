// "Relay on the server" (#511, design docs/design/nodes/README.md 20): sets up the SSH relay on
// a server of the owner's for machines behind NAT. Uses the admin connection plumbing
// (core/server-admin.ts, adapters/ssh.ts) or runs locally on the same server when `local: true`
// (for when the master itself is a public server, epic #702, without needing a second machine or
// SSHing to itself).
//
// Passwords live in memory only for the request/run and are never saved, logged or returned in the
// view. Only the local board reaches this service (/api/nodes/relay/setup).
import { gzipSync } from 'node:zlib'
import type { EditResult } from '../../adapters/config-file.ts'
import type { RemoteRun, spawnRemote } from '../../adapters/ssh.ts'
import { t } from '../../core/lang.ts'
import { deviceIdFromHost, nodesConfig } from '../../core/nodes.ts'
import {
  type RelayFacts,
  type RelayPlan,
  type RelayRecord,
  type RelayWanted,
  readRelayLook,
  readRelayRun,
  relayLookScript,
  relayPlan,
  relayRecord,
  relayRunScript,
  relayUndoPlan,
} from '../../core/relay-plan.ts'
import {
  dropRelay,
  packedRelayRun,
  putRelay,
  RELAY_IDLE_VIEW,
  RELAY_MASTER_AFTER,
  RELAY_MASTER_BEFORE,
  type RelayMasterState,
  type RelayMasterStepId,
  type RelaySetupServer,
  type RelaySetupView,
  relayMasterSteps,
} from '../../core/relay-setup.ts'
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

export interface RelaySetupDeps {
  cfg: Config
  ssh(): string | null
  sshVersion(bin: string): Promise<string>
  knownHosts(): string
  hostKeyPinned(host: string, port: number): Promise<boolean>
  hostKeyFingerprint(host: string, port: number): Promise<string | null>
  spawn: typeof spawnRemote
  /** Runs a command locally on this machine (same-server relay setup without SSH). */
  spawnLocal?: (command: string, stdin: string | null, ms: number) => RemoteRun
  platform?: () => string
  relayKey(
    kind: 'master' | 'enrol',
    make: boolean,
  ): Promise<{ ok: true; publicKey: string } | { ok: false; error: string } | null>
  dropRelayKeys(): void
  editNodes(change: (nodes: Record<string, unknown>, had: boolean) => boolean): EditResult
  follow(): void
  hostName(): string
  onChange(): void
  log(text: string): void
  now(): number
  newId(): string
}

export type Answer = { status: number; body: unknown }

export interface RelaySetup {
  view(): RelaySetupView
  look(o: Fields): Promise<Answer>
  apply(o: Fields): Promise<Answer>
  finish(): Promise<Answer>
  undoLook(o: Fields): Promise<Answer>
  undo(o: Fields): Promise<Answer>
  cancel(): Answer
}

type Fields = Record<string, unknown>

const PROBE_MS = 30_000
const LOOK_MS = 90_000
const RUN_MORE_MS = 2 * 60_000
const PASSWORD_MOST = 1024
const DETAIL_LINES = 6
const OUT_KEPT = 400
const MASK = '••••'

const NO_MASTER_KEY_YET =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterKeyIsMadeAtApply0000000000000000 agent-board relay master'
const NO_ENROL_KEY_YET =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayEnrolKeyIsMadeAtApply00000000000000000 agent-board relay enrol'

const PACK = (text: string): string => gzipSync(text).toString('base64')
const ok = (more: Fields = {}): Answer => ({ status: 200, body: { ok: true, ...more } })
const malformed = (error: string): Answer => ({ status: 400, body: { ok: false, error } })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)

function passwordOf(v: unknown): string | null | false {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > PASSWORD_MOST) return false
  return v
}

function serverOf(
  o: Fields,
  kind: 'apply' | 'undo',
  currentRelay: { host: string; sshPort: number } | null | undefined,
): RelaySetupServer | { field: string; error: string } {
  const local = o.local === true
  const rawHost = typeof o.host === 'string' ? o.host.trim() : ''
  const host = local && kind === 'undo' && rawHost === '' ? (currentRelay?.host ?? '127.0.0.1') : rawHost
  const sshPort =
    o.sshPort === undefined || o.sshPort === null || o.sshPort === ''
      ? local && kind === 'undo'
        ? (currentRelay?.sshPort ?? 22)
        : 22
      : o.sshPort
  if (host === '') return { field: 'host', error: t('tunnel.err.required', { field: t('tunnel.field.host') }) }
  const hostProblem = fieldProblem('host', host)
  if (hostProblem) return { field: 'host', error: hostProblem }
  const portProblem = fieldProblem('sshPort', sshPort)
  if (portProblem) return { field: 'sshPort', error: portProblem }
  if (local) return { host, adminHost: '127.0.0.1', sshPort: sshPort as number, user: '', key: '', local: true }
  const adminHost = typeof o.adminHost === 'string' && o.adminHost.trim() ? o.adminHost.trim() : host
  const adminHostProblem = fieldProblem('host', adminHost)
  if (adminHostProblem) return { field: 'adminHost', error: adminHostProblem }
  const user = typeof o.user === 'string' ? o.user.trim() : ''
  const key = typeof o.key === 'string' ? o.key.trim() : ''
  if (user === '') return { field: 'user', error: t('tunnel.err.required', { field: t('server.field.adminUser') }) }
  for (const [field, value] of [
    ['user', user],
    ['key', key],
  ] as const) {
    const problem = fieldProblem(field, value)
    if (problem) return { field, error: problem }
  }
  return { host, adminHost, sshPort: sshPort as number, user, key, local: false }
}

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

interface Looked {
  kind: 'apply' | 'undo'
  planId: string
  server: RelaySetupServer
  facts: RelayFacts
  mode: SudoMode
  password: boolean
  record?: RelayRecord
}

type Pending = { kind: 'apply'; server: RelaySetupServer } | { kind: 'undo'; server: RelaySetupServer }

export function createRelaySetup(d: RelaySetupDeps): RelaySetup {
  let view: RelaySetupView = { ...RELAY_IDLE_VIEW }
  let last: Looked | null = null
  let pending: Pending | null = null
  let busy = false
  let current: RemoteRun | null = null
  let serverRuns = false
  let generation = 0

  const changed = (): void => d.onChange()
  const set = (patch: Partial<RelaySetupView>): void => {
    view = { ...view, ...patch }
    changed()
  }
  const selfId = (): string => nodesConfig(d.cfg.nodes, d.hostName())?.id ?? deviceIdFromHost(d.hostName())
  const step = (id: RelayMasterStepId, state: RelayMasterState, said: Text | null = null): void =>
    set({ master: view.master.map(s => (s.id === id ? { ...s, state, said: said ?? s.said } : s)) })

  const runLocal = (command: string, stdin: string | null, ms: number): RemoteRun =>
    d.spawnLocal ? d.spawnLocal(command, stdin, ms) : d.spawn('/bin/sh', ['-c', command], stdin, ms, null)

  function refused(h: AdminHint | null, detail: string | null, more: Fields = {}): Answer {
    const need = needFor(h)
    return {
      status: 409,
      body: {
        ok: false,
        hint: h,
        error: detail ?? (h ? t(`server.hint.${h}`, { admin: view.server?.user || 'root' }) : ''),
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

  async function hear(
    bin: string | null,
    s: RelaySetupServer,
    command: string,
    stdin: string | null,
    ms: number,
    login: Login,
    pin = false,
  ): Promise<Heard> {
    let run: RemoteRun
    if (s.local) {
      run = runLocal(command, stdin, ms)
    } else {
      const args = adminSshArgs({
        conf: { host: s.adminHost, sshPort: s.sshPort },
        admin: { user: s.user, key: s.key },
        knownHosts: d.knownHosts(),
        command,
        ...(login.password !== null && { password: true }),
        ...(pin && { pin }),
      })
      run = d.spawn(bin as string, args, stdin, ms, login.password === null ? null : { password: login.password })
    }
    current = run
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    run.onLine((line, from) => heard[from === 'err' ? 'err' : 'out'].push(line))
    const end = await run.done
    if (current === run) current = null
    return { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }
  }

  const mask = (line: string, secrets: readonly string[]): string =>
    secrets.reduce((l, secret) => (secret ? l.replaceAll(secret, MASK) : l), line)

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

  async function knownKeys(): Promise<{ masterKey?: string; enrolKey?: string }> {
    const [m, e] = await Promise.all([
      d.relayKey('master', false).catch(() => null),
      d.relayKey('enrol', false).catch(() => null),
    ])
    return m?.ok && e?.ok ? { masterKey: m.publicKey, enrolKey: e.publicKey } : {}
  }

  const foundOf = (f: RelayFacts): RelaySetupView['found'] => ({
    os: f.os.pretty || `${f.os.id} ${f.os.version}`.trim(),
    ssh: f.ssh,
    hostname: f.hostname,
    include: f.include,
    nodeUser: f.nodeUser,
    masterUser: f.masterUser,
    socketsDir: f.socketsDir,
    keysDir: f.keysDir,
    fence: f.fence,
    enrolled: f.enrolled,
    record: f.record !== null,
  })

  const planView = (p: RelayPlan, id: string) => ({
    id,
    words: p.words,
    warnings: p.warnings,
    steps: p.steps.map(s => ({ id: s.id, title: s.title, why: s.why })),
  })

  async function lookAt(o: Fields, kind: 'apply' | 'undo'): Promise<Answer> {
    const password = passwordOf(o.password)
    if (password === false) return malformed('password')
    const sudoPassword = passwordOf(o.sudoPassword)
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', null)
    const curRelay = nodesConfig(d.cfg.nodes)?.relay
    const server = serverOf(o, kind, curRelay)
    if ('field' in server)
      return { status: 409, body: { ok: false, hint: null, field: server.field, error: server.error } }
    if (server.local && (d.platform ?? (() => process.platform))() !== 'linux')
      return refused(null, t('relay.setup.err.localOs'))
    const bin = server.local ? null : d.ssh()
    if (!server.local && !bin) return refused('noSsh', null)
    busy = true
    const gen = generation
    const gone = (): boolean => gen !== generation
    last = null
    pending = null
    view = { ...RELAY_IDLE_VIEW, phase: 'looking', kind, server }
    changed()
    const secrets = [password ?? '', sudoPassword ?? '']
    try {
      let pinnedBefore = false
      let login: Login = { password: null, typed: false, oldSsh: false }
      if (!server.local) {
        pinnedBefore = await d.hostKeyPinned(server.adminHost, server.sshPort)
        if (gone()) return cancelled()
        login = await loginFor(bin as string, password)
        if (gone()) return cancelled()
      }
      const probe = await hear(bin, server, remoteCommand(PROBE_SCRIPT, 'root'), null, PROBE_MS, login, !pinnedBefore)
      if (gone()) return cancelled()
      let pinnedNow = false
      if (!server.local) {
        pinnedNow = !pinnedBefore && (await d.hostKeyPinned(server.adminHost, server.sshPort))
        if (pinnedBefore || pinnedNow) {
          const fingerprint = await d.hostKeyFingerprint(server.adminHost, server.sshPort)
          if (fingerprint && !gone()) set({ hostKey: { fingerprint, pinnedNow } })
        }
        if (gone()) return cancelled()
      }
      const read = probe.code === 0 ? readProbe(probe.out) : null
      if (!read) {
        const why = stopped(probe, login, null, secrets, server.user)
        return stopLook(why.hint ?? (probe.code === 0 ? 'unreadable' : null), why.detail)
      }
      if (!server.local && !pinnedBefore && !pinnedNow) return stopLook('noHostKey', null)
      set({ sudo: read.mode })
      if (read.mode === 'requiretty') return stopLook('requiretty', null)
      if (read.mode === 'none') return stopLook(adminHint(probe.out) ?? 'notSudoer', null)
      const sudoFrom = sudoFromOf(read.mode, password, sudoPassword)
      if (read.mode === 'password' && sudoFrom === null) return stopLook('needPassword', null)
      const stdin = sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`
      const keys = await knownKeys()
      const h = await hear(bin, server, remoteCommand(relayLookScript(keys), read.mode), stdin, LOOK_MS, login)
      if (gone()) return cancelled()
      const f = h.code === 0 ? readRelayLook(h.out) : null
      if (!f) {
        const why = stopped(h, login, sudoFrom, secrets, server.user)
        return stopLook(why.hint ?? (h.code === 0 ? 'unreadable' : null), why.detail)
      }
      const planId = d.newId()
      const base: Looked = {
        kind,
        planId,
        server,
        facts: f,
        mode: read.mode,
        password: (probe.askpass?.answered ?? 0) > 0,
      }
      set({ found: foundOf(f) })
      return kind === 'apply' ? planApply(base, keys) : planUndo(base)
    } catch (err) {
      if (gone()) return cancelled()
      return stopLook(null, messageOf(err))
    } finally {
      if (!gone()) busy = false
    }
  }

  function planApply(l: Looked, keys: { masterKey?: string; enrolKey?: string }): Answer {
    const wanted: RelayWanted = {
      masterKey: keys.masterKey ?? NO_MASTER_KEY_YET,
      enrolKey: keys.enrolKey ?? NO_ENROL_KEY_YET,
    }
    const r = relayPlan(l.facts, wanted)
    if (!r.ok) {
      set({ phase: 'plan', refusals: r.why, plan: null })
      return ok()
    }
    last = l
    set({
      phase: 'plan',
      refusals: [],
      plan: planView(r.plan, l.planId),
      run: {
        steps: r.plan.steps.map(s => ({ id: s.id, state: 'wait' })),
        undone: [],
        result: null,
        warnings: [],
        said: [],
      },
      master: relayMasterSteps([...RELAY_MASTER_BEFORE, ...RELAY_MASTER_AFTER]),
    })
    return ok()
  }

  function planUndo(l: Looked): Answer {
    const rec = l.facts.record === null ? null : relayRecord(l.facts.record)
    if (!rec) return stopLook(null, t('relay.setup.err.noRecord'))
    const p = relayUndoPlan(rec, { enrolled: l.facts.enrolled })
    last = { ...l, record: rec }
    set({
      phase: 'plan',
      refusals: [],
      plan: planView(p, l.planId),
      run: {
        steps: p.steps.map(s => ({ id: s.id, state: 'wait' })),
        undone: [],
        result: null,
        warnings: [],
        said: [],
      },
      master: [],
    })
    return ok()
  }

  async function runLogin(
    l: Looked,
    password: string | null,
    sudoPassword: string | null,
  ): Promise<{ bin: string | null; login: Login; sudoFrom: SudoFrom; stdin: string | null } | Answer> {
    if (!l.server.local && l.password && password === null) return refused('loginPassword', null)
    const sudoFrom = sudoFromOf(l.mode, password, sudoPassword)
    if (l.mode === 'password' && sudoFrom === null) return refused('needPassword', null)
    let bin: string | null = null
    if (!l.server.local) {
      bin = d.ssh()
      if (!bin) return refused('noSsh', null)
      if (!(await d.hostKeyPinned(l.server.adminHost, l.server.sshPort))) return refused('noHostKey', null)
    }
    const login = l.server.local
      ? { password: null, typed: false, oldSsh: false }
      : await loginFor(bin as string, password)
    return {
      bin,
      login,
      sudoFrom,
      stdin: sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`,
    }
  }

  async function runOnServer(
    l: Looked,
    to: { bin: string | null; login: Login; stdin: string | null },
    plan: RelayPlan,
    secrets: readonly string[],
  ): Promise<{ heard: Heard; lines: string[] }> {
    const runId = d.newId()
    const at = new Date(d.now()).toISOString()
    const script = packedRelayRun(plan.kind, relayRunScript(plan, { id: runId, at }), PACK)
    const ms = plan.steps.reduce((sum, s) => sum + s.timeoutS * 1000, 0) + RUN_MORE_MS
    let child: RemoteRun
    if (l.server.local) {
      child = runLocal(remoteCommand(script, l.mode), to.stdin, ms)
    } else {
      const args = adminSshArgs({
        conf: { host: l.server.adminHost, sshPort: l.server.sshPort },
        admin: { user: l.server.user, key: l.server.key },
        knownHosts: d.knownHosts(),
        command: remoteCommand(script, l.mode),
        ...(to.login.password !== null && { password: true }),
      })
      child = d.spawn(
        to.bin as string,
        args,
        to.stdin,
        ms,
        to.login.password === null ? null : { password: to.login.password },
      )
    }
    current = child
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    const lines: string[] = []
    let others = 0
    child.onLine((line, from) => {
      if (from === 'err') {
        heard.err.push(line)
        return
      }
      const shown = /^@@(step|undo|result) /.test(line) ? line : mask(line, secrets)
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
      const r = readRelayRun(lines)
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

  function runFailed(
    r: ReturnType<typeof readRelayRun>,
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
      const lost = !l.server.local && (heard.out.length > 0 || (heard.code === 255 && connectionLost(heard.err)))
      hint = why.hint ?? (lost ? 'lost' : null)
      error = why.detail
      next = { key: lost ? 'relay.setup.next.lost' : 'relay.setup.next.again' }
    } else {
      if (r.result === 'busy') hint = 'busy'
      error = r.said.slice(-DETAIL_LINES).join('\n') || null
      next = {
        key:
          r.result === 'rollback-failed' || r.result === 'undo-failed'
            ? 'relay.setup.next.undo'
            : 'relay.setup.next.again',
      }
    }
    set({ phase: 'failed', hint, error, next })
  }

  function finishMaster(p: Extract<Pending, { kind: 'apply' }>, gen: number): void {
    if (gen !== generation) return
    set({ phase: 'finishing', next: null, error: null, hint: null })
    for (const s of view.master)
      if (RELAY_MASTER_AFTER.includes(s.id as (typeof RELAY_MASTER_AFTER)[number]) && s.state !== 'wait')
        step(s.id, 'wait')
    step('config', 'run')
    const me = selfId()
    let wrote = false
    const r = d.editNodes((nodes, had) => {
      wrote = putRelay(nodes, had, { host: p.server.host, sshPort: p.server.sshPort, selfId: me })
      return wrote
    })
    if (!r.ok) {
      step('config', 'fail', { key: 'relay.setup.said.config', params: { error: r.error } })
      set({ phase: 'failed', next: { key: 'relay.setup.next.config' }, error: null })
      return
    }
    const liveHad = isObject(d.cfg.nodes)
    const live = liveHad ? structuredClone(d.cfg.nodes as Fields) : {}
    putRelay(live, liveHad, { host: p.server.host, sshPort: p.server.sshPort, selfId: me })
    d.cfg.nodes = live
    step('config', wrote ? 'ok' : 'skip', {
      key: 'relay.setup.said.saved',
      params: { host: p.server.host, port: String(p.server.sshPort) },
    })
    d.follow()
    pending = null
    d.log(`relay setup: ${p.server.host}:${p.server.sshPort} ready`)
    set({ phase: 'done' })
  }

  function dropHere(s: RelaySetupServer): boolean {
    const cur = nodesConfig(d.cfg.nodes)?.relay
    if (cur && (cur.host !== s.host || cur.sshPort !== s.sshPort)) {
      pending = null
      return true
    }
    const r = d.editNodes((nodes, had) => had && dropRelay(nodes))
    if (!r.ok) {
      pending = { kind: 'undo', server: s }
      set({ phase: 'failed', error: r.error, next: { key: 'relay.setup.next.undoConfig' } })
      return false
    }
    if (isObject(d.cfg.nodes)) {
      const live = structuredClone(d.cfg.nodes as Fields)
      dropRelay(live)
      d.cfg.nodes = live
    }
    d.follow()
    d.dropRelayKeys()
    pending = null
    return true
  }

  async function runApply(o: Fields): Promise<Answer> {
    const password = passwordOf(o.password)
    if (password === false) return malformed('password')
    const sudoPassword = passwordOf(o.sudoPassword)
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', null)
    const l = last
    if (l?.kind !== 'apply' || typeof o.plan !== 'string' || o.plan !== l.planId) return refused('lookAgain', null)
    busy = true
    const gen = generation
    const gone = (): boolean => gen !== generation
    const secrets = [password ?? '', sudoPassword ?? '']
    let detached = false
    try {
      const to = await runLogin(l, password, sudoPassword)
      if ('status' in to) return to
      if (gone()) return cancelled()
      last = null
      pending = null
      set({
        phase: 'applying',
        hint: null,
        error: null,
        next: null,
        master: relayMasterSteps([...RELAY_MASTER_BEFORE, ...RELAY_MASTER_AFTER]),
      })
      step('keys', 'run')
      const [masterKey, enrolKey] = await Promise.all([d.relayKey('master', true), d.relayKey('enrol', true)])
      if (gone()) return cancelled()
      if (!masterKey?.ok || !enrolKey?.ok) {
        const err = !masterKey?.ok
          ? masterKey && !masterKey.ok
            ? masterKey.error
            : ''
          : enrolKey && !enrolKey.ok
            ? enrolKey.error
            : ''
        step('keys', 'fail', { key: 'relay.setup.said.keyFailed', params: { error: err } })
        set({ phase: 'failed', next: { key: 'relay.setup.next.again' } })
        return ok()
      }
      step('keys', 'ok', { key: 'relay.setup.said.keysMade' })
      const r = relayPlan(l.facts, { masterKey: masterKey.publicKey, enrolKey: enrolKey.publicKey })
      if (!r.ok) {
        set({ phase: 'failed', refusals: r.why, next: { key: 'relay.setup.next.again' } })
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
          const run = readRelayRun(lines)
          if (gone()) return
          if (run.result !== 'applied') {
            runFailed(run, heard, to.login, to.sudoFrom, secrets, l)
            return
          }
          applied = true
          const p: Pending = { kind: 'apply', server: l.server }
          pending = p
          finishMaster(p, gen)
        } catch (err) {
          serverRuns = false
          if (!gone())
            set({
              phase: 'failed',
              error: messageOf(err),
              next: { key: applied ? 'relay.setup.next.config' : 'relay.setup.next.lost' },
            })
        } finally {
          if (!gone()) busy = false
          changed()
        }
      })()
      return ok()
    } catch (err) {
      set({ phase: 'failed', error: messageOf(err), next: { key: 'relay.setup.next.again' } })
      return ok()
    } finally {
      if (!detached && !gone()) busy = false
    }
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
    const plan = relayUndoPlan(l.record, { enrolled: l.facts.enrolled })
    busy = true
    const gen = generation
    const secrets = [password ?? '', sudoPassword ?? '']
    let detached = false
    try {
      const to = await runLogin(l, password, sudoPassword)
      if ('status' in to) return to
      if (gen !== generation) return cancelled()
      last = null
      set({ phase: 'undoing', hint: null, error: null, next: null })
      detached = true
      void (async () => {
        try {
          serverRuns = true
          const { heard, lines } = await runOnServer(l, to, plan, secrets)
          serverRuns = false
          const run = readRelayRun(lines)
          if (gen !== generation) return
          if (run.result !== 'undone' && run.result !== 'none') {
            runFailed(run, heard, to.login, to.sudoFrom, secrets, l)
            return
          }
          if (!dropHere(l.server)) return
          d.log(`relay setup: undone on ${l.server.adminHost}`)
          set({ phase: 'undone' })
        } catch (err) {
          serverRuns = false
          set({ phase: 'failed', error: messageOf(err), next: { key: 'relay.setup.next.lost' } })
        } finally {
          if (gen === generation) busy = false
          changed()
        }
      })()
      return ok()
    } catch (err) {
      set({ phase: 'failed', error: messageOf(err), next: { key: 'relay.setup.next.again' } })
      return ok()
    } finally {
      if (!detached && gen === generation) busy = false
    }
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
        if (dropHere(p.server)) set({ phase: 'undone', error: null, next: null })
        return ok()
      }
      busy = true
      const gen = generation
      try {
        finishMaster(p, gen)
      } catch (err) {
        if (gen === generation)
          set({ phase: 'failed', error: messageOf(err), next: { key: 'relay.setup.next.config' } })
      } finally {
        if (gen === generation) busy = false
        changed()
      }
      return ok()
    },
    cancel() {
      if (serverRuns || view.phase === 'undoing') return refused('busy', null)
      generation += 1
      current?.kill()
      current = null
      busy = false
      last = null
      pending = null
      view = { ...RELAY_IDLE_VIEW }
      changed()
      return ok()
    },
  }
}
