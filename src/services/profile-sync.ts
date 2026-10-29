// "Sync profiles" in the Remote access panel (the board-on-own-server spec's "Next step: syncing
// the Claude profiles"): the Claude profiles of this computer and of the board installed on the
// server, synced by hand in the direction the owner picks. Look scans both sides (the server's
// through the sync program, entrypoints/profile-sync.ts, as the board's user) and makes the
// preview (core/profile-sync/plan.ts); a project left unpaired gets the path the owner gives, or
// stays out; Apply sends what the owner said yes to (the groups that change how the target runs
// and session history only when ticked), packed, over the admin's login, each file with the
// target's hash at Look; the target leaves what changed since as it is, and each side records the
// sync's hashes of what was written (the target as it writes, the source once all has arrived).
//
// The login is the server setup's (services/server-setup.ts): the admin's fields in config.json,
// the server's key pinned by its Look, the password typed in the panel (or remembered by the local
// board for 30 minutes, filled in by remote-access.ts: services/held-passwords.ts) and sent with each
// request, kept here in memory only while that request (or its run) lasts, never stored. sudo's password goes
// alone first (SUDO_CHECK), then on the sync's stdin before its frames. Nothing runs, nothing is
// read before the owner asks: a board that never syncs is as it was.
//
// The path rules (core/profile-sync/rules.ts) are the local board's, per server (config.json
// `tunnel.syncPaths`, by its host): a project under a rule's folder lands at the same place
// below its folder on the other side. The preview says which targets' folders are there yet (the
// server's asked once more over the login, this computer's looked at here). The owner picks the
// rules' folders and a project's own path with a picker: the server's folders listed (and one
// made) by the sync program as the board's user, this computer's by the board's folder route.
import { createGunzip } from 'node:zlib'
import { SLOW, statOf } from '../adapters/folders.ts'
import { isRecord } from '../adapters/json-store.ts'
import {
  type Frame,
  type FrameSink,
  frameSink,
  framesOf,
  openTarget,
  prepare,
  recordSynced,
  scanSide,
  sideProfiles,
} from '../adapters/profile-sync.ts'
import type { RemoteEnd, RemoteStream, spawnRemoteStream } from '../adapters/ssh.ts'
import { t } from '../core/lang.ts'
import { givenPath, projectKey } from '../core/profile-sync/paths.ts'
import {
  buildPreview,
  type Choices,
  type Direction,
  type Manifest,
  type Preview,
  transferOf,
} from '../core/profile-sync/plan.ts'
import { NO_BOARD, OLD_BOARD, type SyncOp, syncScript } from '../core/profile-sync/remote.ts'
import { cleanRules, type PathRule, rulesIn } from '../core/profile-sync/rules.ts'
import { type Allow, type CarryTo, RUN_GROUPS } from '../core/profile-sync/secrets.ts'
import { type Skipped, SYNC_IDLE, type SyncView } from '../core/profile-sync/view.ts'
import {
  type Admin,
  adminConfig,
  adminHint,
  adminProblems,
  adminSshArgs,
  loginHint,
  needFor,
  PROBE_SCRIPT,
  readProbe,
  remoteCommand,
  SUDO_CHECK,
  takesAskpass,
} from '../core/server-admin.ts'
import type { AdminHint, SudoMode } from '../core/server-view.ts'
import { type TunnelConfig, tunnelConfig } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'

/** The sync's version the server's program must speak (entrypoints/profile-sync.ts SYNC_VERSION). */
const SYNC_VERSION = 2
const PROBE_MS = 30_000
const SCAN_MS = 15 * 60_000
/** A sync's run: the first one carries the profiles whole (the owner's: about 1.7 GB). */
const RUN_MS = 8 * 60 * 60_000
const PASSWORD_MOST = 1024

type Answer = { status: number; body: unknown }
type Fields = Record<string, unknown>

/** This side, as the sync uses it (adapters/profile-sync.ts); tests give their own. */
export interface LocalSide {
  scanSide: typeof scanSide
  sideProfiles: typeof sideProfiles
  prepare: typeof prepare
  openTarget: typeof openTarget
  recordSynced: typeof recordSynced
}

export interface ProfileSyncDeps {
  /** The live config: the server and the admin's login (the server setup's). */
  cfg: Config
  /** This computer's home and system, and its name (the server keeps its hashes of the last sync by it). */
  home: string
  platform: string
  name: string
  ssh(): string | null
  sshVersion(bin: string): Promise<string>
  knownHosts(): string
  /** The server's key is pinned (the server setup's Look pinned it). */
  hostKeyPinned(): Promise<boolean>
  spawn: typeof spawnRemoteStream
  onChange(): void
  log(text: string): void
  newId(): string
  now(): number
  local?: LocalSide
  /** The path rules for a server kept in config.json (`tunnel.syncPaths[host]`); none given: kept in the live config only. */
  saveRules?(host: string, rules: PathRule[]): boolean
  /** Whether a folder is on this computer (a target's, for a sync to here). */
  folderThere?(path: string): Promise<boolean>
}

export interface ProfileSync {
  /** The panel's part; null until a sync was asked for. */
  view(): SyncView | null
  /** `{ direction, password?, sudoPassword? }`: both sides scanned, the preview made. */
  look(body: Fields): Promise<Answer>
  /** `{ profile, folder, path, password?, sudoPassword? }`: a project's own path on the target (null: left out, '': as the rules and remotes say); the preview made again. */
  pair(body: Fields): Answer
  /** `{ rules: [{ pc, server }], password?, sudoPassword? }`: this server's path rules kept; the preview made again. */
  rules(body: Fields): Answer
  /** `{ path?, password?, sudoPassword? }`: the folders in a folder on the server ('' its board user's home), as that user lists them. */
  dirs(body: Fields): Promise<Answer>
  /** `{ path, name, password?, sudoPassword? }`: a folder made in a folder on the server, as the board's user; its listing. */
  mkdir(body: Fields): Promise<Answer>
  /** `{ id, conflicts, deletions, password?, sudoPassword? }`: the preview applied, its run followed in the view. */
  apply(body: Fields): Promise<Answer>
  cancel(): Answer
  /** The part closed: back to nothing shown (a run goes on). */
  forget(): Answer
}

const ok = (more: Fields = {}): Answer => ({ status: 200, body: { ok: true, ...more } })
/** Is this a folder here, without holding the board up on a share that does not answer. */
async function folderHere(path: string): Promise<boolean> {
  const st = await statOf(path)
  return st !== null && st !== SLOW && st.isDirectory()
}
const malformed = (error: string): Answer => ({ status: 400, body: { ok: false, error } })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function passwordOf(v: unknown): string | null | false {
  if (v === undefined || v === null || v === '') return null
  return typeof v === 'string' && v.length <= PASSWORD_MOST && !/[\r\n\0]/.test(v) ? v : false
}

/** The groups the page ticked: each run group and session history, only as booleans. */
function allowOf(v: unknown): Allow {
  if (!isRecord(v)) return {}
  const known = new Set<string>([...RUN_GROUPS, 'history'])
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => known.has(k) && typeof x === 'boolean'))
}

/** What the target left as it was, as its frame says it. */
const skippedOf = (v: unknown): Skipped[] =>
  (Array.isArray(v) ? v.filter(isRecord) : []).flatMap(x =>
    typeof x.profile === 'string' && typeof x.rel === 'string' && typeof x.why === 'string'
      ? [{ profile: x.profile, rel: x.rel, why: x.why as Skipped['why'] }]
      : [],
  )

/** What one remote run heard: its exit, ssh's and sudo's lines, the askpass's report. */
interface Heard {
  end: RemoteEnd
  err: string[]
}

class Refused extends Error {
  constructor(
    readonly hint: AdminHint | null,
    message: string,
  ) {
    super(message)
  }
}

export function createProfileSync(d: ProfileSyncDeps): ProfileSync {
  const local: LocalSide = d.local ?? { scanSide, sideProfiles, prepare, openTarget, recordSynced }
  let view: SyncView | null = null
  let busy = false
  let current: RemoteStream | null = null
  let cancelled = false
  /** The last Look: both manifests, the server's sudo, whether a password logged in, the paths given. */
  let looked: {
    direction: Direction
    source: Manifest
    target: Manifest
    mode: SudoMode
    given: Record<string, string | null>
    /** What is known of the targets' folders: there or not, by path. */
    there: Record<string, boolean>
  } | null = null
  /** sudo's way on the server, from its last probe (the picker's listings need no probe each). */
  let probed: { host: string; mode: SudoMode } | null = null

  const changed = (): void => d.onChange()
  const tunnel = (): Fields => (isRecord(d.cfg.tunnel) ? d.cfg.tunnel : {})
  const conf = (): TunnelConfig => tunnelConfig(d.cfg.tunnel)
  const admin = (): Admin => adminConfig(tunnel().admin)
  /** The server, as this side keeps its hashes of the last sync by it. */
  const serverPeer = (): string => `server-${conf().host}`
  /** This server's path rules, as config.json has them. */
  const rulesNow = (): PathRule[] => rulesIn(d.cfg.tunnel, conf().host)
  /** sudo's way on this server, when probed already. */
  const modeKnown = (): SudoMode | null => (probed && probed.host === conf().host ? probed.mode : null)
  const set = (patch: Partial<SyncView>): void => {
    view = { ...(view ?? SYNC_IDLE), ...patch }
    changed()
  }
  const hintText = (h: AdminHint): string => t(`server.hint.${h}`, { admin: admin().user || 'root' })

  function refused(h: AdminHint | null, error: string): Answer {
    const need = needFor(h)
    return { status: 409, body: { ok: false, hint: h, error, ...(need && { need }) } }
  }

  /** A Look or a run that stopped: the view says why, as the answer does. */
  function stop(h: AdminHint | null, error: string): Answer {
    set({ phase: 'failed', hint: h, error })
    return refused(h, error)
  }

  /** The server and the admin's login as the server setup has them, and ssh; or why not. */
  function ready(): { bin: string; c: TunnelConfig; a: Admin } | Answer {
    const a = admin()
    const problem = adminProblems(a)[0]
    if (problem) return refused(null, problem.message)
    const c = conf()
    if (c.host === '') return refused(null, t('sync.err.noServer'))
    const bin = d.ssh()
    if (!bin) return refused('noSsh', hintText('noSsh'))
    return { bin, c, a }
  }

  /** One ssh to the admin: its command, what goes on its stdin (written by `feed`), what comes back. */
  async function remote(
    to: { bin: string; c: TunnelConfig; a: Admin },
    password: string | null,
    command: string,
    ms: number,
    feed: ((child: RemoteStream) => Promise<void>) | null,
    read: ((child: RemoteStream) => Promise<void>) | null,
  ): Promise<Heard> {
    const args = adminSshArgs({
      conf: to.c,
      admin: to.a,
      knownHosts: d.knownHosts(),
      command,
      ...(password !== null && { password: true }),
    })
    const child = d.spawn(to.bin, args, ms, password === null ? null : { password })
    current = child
    const err: string[] = []
    child.onErr(line => err.push(line))
    const reading = read
      ? read(child).catch(e => {
          err.push(messageOf(e))
          child.kill()
        })
      : new Promise<void>(resolve => {
          child.stdout.resume()
          child.stdout.once('end', () => resolve())
        })
    if (feed)
      await feed(child).catch(e => {
        err.push(messageOf(e))
        child.kill()
      })
    else child.stdin.end()
    const end = await child.done
    await Promise.race([reading, new Promise(resolve => setTimeout(resolve, 2000))])
    if (current === child) current = null
    return { end, err }
  }

  /** Why a remote run failed, in the panel's words: the login, sudo, no board there, or its own lines. */
  function why(h: Heard, typed: boolean, said: string | null): Refused {
    if (h.end.code === null && h.end.error !== null && h.end.error !== 'timeout')
      return new Refused(h.end.error === 'ENOENT' ? 'noSsh' : null, t('server.err.spawn', { code: h.end.error }))
    if (h.err.includes(NO_BOARD)) return new Refused(null, t('sync.err.noBoard'))
    if (h.err.includes(OLD_BOARD)) return new Refused(null, t('sync.err.oldBoard'))
    const hint =
      loginHint({
        lines: h.err,
        typed,
        askpass: h.end.askpass ?? null,
        oldSsh: false,
        root: admin().user === 'root',
      }) ?? adminHint(h.err)
    const detail = said ?? (h.err.slice(-6).join('\n') || (h.end.error === 'timeout' ? t('server.err.timeout') : ''))
    return new Refused(hint, detail || (hint ? hintText(hint) : t('sync.err.failed')))
  }

  /** The login, as far as the sync goes: sudo's way on the server, its password checked once alone. */
  async function login(
    to: { bin: string; c: TunnelConfig; a: Admin },
    password: string | null,
    sudoPassword: string | null,
    known: SudoMode | null,
  ): Promise<{ password: string | null; mode: SudoMode; sudoLine: string }> {
    if (!(await d.hostKeyPinned())) throw new Refused('noHostKey', hintText('noHostKey'))
    const typed = password !== null
    const pw = typed && takesAskpass(await d.sshVersion(to.bin)) ? password : null
    if (typed && pw === null) throw new Refused('sshOld', hintText('sshOld'))
    let mode = known
    if (mode === null) {
      let out = ''
      const h = await remote(to, pw, remoteCommand(PROBE_SCRIPT, 'root'), PROBE_MS, null, async child => {
        for await (const chunk of child.stdout) out += String(chunk)
      })
      const read = h.end.code === 0 ? readProbe(out.split(/\r?\n/)) : null
      if (!read) throw why(h, typed, null)
      mode = read.mode
      probed = { host: to.c.host, mode }
    }
    if (mode === 'requiretty' || mode === 'none') throw new Refused(mode === 'none' ? 'notSudoer' : 'requiretty', '')
    const sudo = mode === 'password' ? (sudoPassword ?? password) : null
    if (mode === 'password' && sudo === null) throw new Refused('needPassword', hintText('needPassword'))
    const sudoLine = sudo === null ? '' : `${sudo}\n`
    if (sudoLine) {
      const h = await remote(
        to,
        pw,
        remoteCommand(SUDO_CHECK, mode),
        PROBE_MS,
        async child => {
          child.stdin.end(sudoLine)
        },
        null,
      )
      if (h.end.code !== 0) {
        const r = why(h, typed, null)
        throw new Refused(r.hint === 'wrongPassword' && sudoPassword === null ? 'sudoPassword' : r.hint, r.message)
      }
    }
    return { password: pw, mode, sudoLine }
  }

  /**
   * The sync program on the server: its op's request, then what `more` sends, on its stdin (after
   * sudo's password); each frame it answers to `onFrame`. An error frame, or none at the end, fails.
   */
  async function program(
    to: { bin: string; c: TunnelConfig; a: Admin },
    l: { password: string | null; mode: SudoMode; sudoLine: string },
    op: SyncOp,
    req: Fields,
    ms: number,
    onFrame: (f: Frame) => void | Promise<void>,
    more: ((sink: FrameSink) => Promise<void>) | null = null,
  ): Promise<void> {
    let said: string | null = null
    let answered = false
    const h = await remote(
      to,
      l.password,
      remoteCommand(syncScript(op), l.mode),
      ms,
      async child => {
        if (l.sudoLine) child.stdin.write(l.sudoLine)
        const sink = frameSink(child.stdin, child.done)
        await sink.send({ op, v: SYNC_VERSION, peer: d.name, ...req })
        if (more) await more(sink)
        await sink.end()
      },
      async child => {
        const gunzip = createGunzip()
        child.stdout.pipe(gunzip)
        try {
          for await (const f of framesOf(gunzip)) {
            if (f.head.t === 'error') said = typeof f.head.message === 'string' ? f.head.message : ''
            else {
              answered = true
              await onFrame(f)
            }
          }
        } catch (err) {
          // no gzip at all: ssh or the command failed before the program spoke
          if (answered) throw err
        }
      },
    )
    if (cancelled) throw new Refused(null, t('server.err.cancelled'))
    // a board on the server from before this op
    if (said !== null && (said as string).startsWith('no op ')) throw new Refused(null, t('sync.err.oldBoard'))
    if (said !== null || h.end.code !== 0 || !answered) throw why(h, l.password !== null, said)
  }

  const answerOf = (err: unknown): { hint: AdminHint | null; error: string } =>
    err instanceof Refused
      ? { hint: err.hint, error: err.message || (err.hint ? hintText(err.hint) : t('sync.err.failed')) }
      : { hint: null, error: messageOf(err) }

  /** How this side carries its files to the server, or the server its files here. */
  const carry = (server: Manifest, direction: Direction): CarryTo =>
    direction === 'up'
      ? { platform: server.platform, from: d.platform, fromHome: d.home, toHome: server.home }
      : { platform: d.platform, from: server.platform, fromHome: server.home, toHome: d.home }

  /** The preview made again from the last Look: a new one (its choices start again), or the same one with what is known of the folders there. */
  function preview(same: Preview | null = null): Preview {
    if (!looked) throw new Error('no Look')
    return buildPreview({
      id: same?.id ?? d.newId(),
      at: same?.at ?? d.now(),
      direction: looked.direction,
      source: looked.source,
      target: looked.target,
      given: looked.given,
      rules: rulesNow(),
      there: looked.there,
    })
  }

  /** The targets' folders not known yet: whether each is there (the server's by its program, over the login `l`). */
  async function askThere(
    to: { bin: string; c: TunnelConfig; a: Admin },
    l: { password: string | null; mode: SudoMode; sudoLine: string } | null,
    p: Preview,
  ): Promise<void> {
    const l0 = looked
    if (!l0) return
    const ask = [...new Set(p.pairs.map(x => x.to))].filter(x => !(x in l0.there))
    if (ask.length === 0) return
    let found: boolean[] = []
    if (l0.direction === 'down') found = await Promise.all(ask.map(x => (d.folderThere ?? folderHere)(x)))
    else if (l)
      await program(to, l, 'exists', { paths: ask }, PROBE_MS, f => {
        if (f.head.t === 'exists' && Array.isArray(f.head.there)) found = f.head.there.map(x => x === true)
      })
    ask.forEach((x, i) => {
      if (i < found.length) l0.there[x] = found[i] as boolean
    })
  }

  /**
   * After a change of the pairs: the folders there asked about in the background (the passwords
   * only while it runs), the preview shown again as it is when they are known. A failure leaves
   * them not known.
   */
  function thereLater(body: Fields): void {
    const l0 = looked
    const p = view?.preview ?? null
    if (!l0 || !p || p.pairs.every(x => x.to in l0.there)) return
    const password = passwordOf(body.password)
    const sudoPassword = passwordOf(body.sudoPassword)
    if (password === false || sudoPassword === false) return
    void (async () => {
      try {
        const to = ready()
        if ('status' in to) return
        const l = l0.direction === 'up' ? await login(to, password, sudoPassword, l0.mode) : null
        await askThere(to, l, p)
      } catch {
        return
      }
      const now = view?.preview ?? null
      if (looked === l0 && view?.phase === 'preview' && now) set({ preview: preview(now) })
    })()
  }

  /** The picker's listing of a folder on the server (or of the folder made in it), as the board's user. */
  async function listThere(op: 'dirs' | 'mkdir', req: Fields, body: Fields): Promise<Answer> {
    const password = passwordOf(body.password)
    const sudoPassword = passwordOf(body.sudoPassword)
    if (password === false) return malformed('password')
    if (sudoPassword === false) return malformed('sudoPassword')
    if (busy) return refused('busy', hintText('busy'))
    const to = ready()
    if ('status' in to) return to
    try {
      const l = await login(to, password, sudoPassword, looked?.mode ?? modeKnown())
      let listing: Fields | null = null
      await program(to, l, op, req, PROBE_MS, f => {
        if (f.head.t === 'dirs') listing = f.head
      })
      if (!listing) throw new Refused(null, t('sync.err.failed'))
      const { t: _, ...folders } = listing as Fields
      if (op === 'mkdir' && typeof folders.path === 'string' && looked) looked.there[folders.path] = true
      return ok(folders)
    } catch (err) {
      const a = answerOf(err)
      return refused(a.hint, a.error)
    }
  }

  return {
    view: () => view,

    async look(body) {
      const direction = body.direction
      if (direction !== 'up' && direction !== 'down') return malformed('direction')
      const password = passwordOf(body.password)
      const sudoPassword = passwordOf(body.sudoPassword)
      if (password === false) return malformed('password')
      if (sudoPassword === false) return malformed('sudoPassword')
      if (busy) return refused('busy', hintText('busy'))
      const to = ready()
      if ('status' in to) return to
      busy = true
      cancelled = false
      looked = null
      set({ ...SYNC_IDLE, phase: 'looking', direction })
      try {
        const l = await login(to, password, sudoPassword, null)
        let server: Manifest | null = null
        await program(
          to,
          l,
          'scan',
          { to: direction === 'down' ? { platform: d.platform, home: d.home } : null },
          SCAN_MS,
          f => {
            if (f.head.t === 'manifest') server = JSON.parse(f.body.toString('utf8')) as Manifest
          },
        )
        if (!server) throw new Refused(null, t('sync.err.failed'))
        const there: Manifest = server
        const here = await local.scanSide({
          home: d.home,
          platform: d.platform,
          peer: serverPeer(),
          to: direction === 'up' ? carry(there, 'up') : null,
          clones: false,
        })
        if (cancelled) throw new Refused(null, t('server.err.cancelled'))
        looked = {
          direction,
          source: direction === 'up' ? here : there,
          target: direction === 'up' ? there : here,
          mode: l.mode,
          given: {},
          there: {},
        }
        // which targets' folders are there yet: asked once more of the server, looked at here
        await askThere(to, l, preview()).catch(() => {})
        if (cancelled) throw new Refused(null, t('server.err.cancelled'))
        set({ phase: 'preview', preview: preview(), hint: null, error: null })
        d.log(`profile sync: preview ${direction}`)
        return ok()
      } catch (err) {
        const a = answerOf(err)
        return stop(a.hint, a.error)
      } finally {
        busy = false
      }
    },

    pair(body) {
      if (!looked || view?.phase !== 'preview') return refused('lookAgain', t('sync.err.lookAgain'))
      const profile = typeof body.profile === 'string' ? body.profile : ''
      const folder = typeof body.folder === 'string' ? body.folder : ''
      const project = looked.source.projects.find(p => p.profile === profile && p.folder === folder)
      if (!project) return malformed('folder')
      const key = projectKey(project)
      if (body.path === null) looked.given[key] = null
      else if (body.path === undefined || body.path === '') delete looked.given[key]
      else {
        const path = typeof body.path === 'string' ? givenPath(body.path, looked.target.platform) : null
        if (path === null) return refused(null, t('sync.err.path'))
        looked.given[key] = path
      }
      set({ preview: preview() })
      thereLater(body)
      return ok()
    },

    rules(body) {
      const server = looked ? (looked.direction === 'up' ? looked.target : looked.source).platform : 'linux'
      const rules = cleanRules(body.rules, d.platform, server)
      if (rules === null) return refused(null, t('sync.err.rule'))
      const host = conf().host
      if (host === '') return refused(null, t('sync.err.noServer'))
      if (d.saveRules && !d.saveRules(host, rules)) return refused(null, t('sync.err.ruleSave'))
      // the live config at once (config.json's watcher follows with the same)
      const tunnel = isRecord(d.cfg.tunnel) ? d.cfg.tunnel : {}
      const all = isRecord(tunnel.syncPaths) ? tunnel.syncPaths : {}
      d.cfg.tunnel = { ...tunnel, syncPaths: { ...all, [host]: rules } }
      d.log(`profile sync: ${rules.length} path rules`)
      if (looked && view?.phase === 'preview') {
        set({ preview: preview() })
        thereLater(body)
      }
      return ok({ rules })
    },

    dirs(body) {
      return listThere('dirs', { path: typeof body.path === 'string' ? body.path : '' }, body)
    },

    mkdir(body) {
      if (typeof body.path !== 'string' || typeof body.name !== 'string') return Promise.resolve(malformed('name'))
      return listThere('mkdir', { path: body.path, name: body.name }, body)
    },

    async apply(body) {
      const password = passwordOf(body.password)
      const sudoPassword = passwordOf(body.sudoPassword)
      if (password === false) return malformed('password')
      if (sudoPassword === false) return malformed('sudoPassword')
      if (busy) return refused('busy', hintText('busy'))
      const p = view?.preview ?? null
      const l0 = looked
      if (!p || !l0 || view?.phase !== 'preview' || body.id !== p.id)
        return refused('lookAgain', t('sync.err.lookAgain'))
      const choices: Choices = {
        conflicts: isRecord(body.conflicts)
          ? Object.fromEntries(
              Object.entries(body.conflicts).filter(
                (e): e is [string, 'source' | 'target'] => e[1] === 'source' || e[1] === 'target',
              ),
            )
          : {},
        deletions: Array.isArray(body.deletions)
          ? body.deletions.filter((x): x is string => typeof x === 'string')
          : [],
        allow: allowOf(body.allow),
      }
      const to = ready()
      if ('status' in to) return to
      busy = true
      cancelled = false
      let l: Awaited<ReturnType<typeof login>>
      try {
        l = await login(to, password, sudoPassword, l0.mode)
      } catch (err) {
        busy = false
        const a = answerOf(err)
        return refused(a.hint, a.error)
      }
      const x = transferOf(p, choices)
      const server = l0.direction === 'up' ? l0.target : l0.source
      const progress = { files: 0, filesTotal: x.send.length, bytes: 0, bytesTotal: x.bytes, step: 'files' as const }
      set({ phase: 'applying', progress, result: null, hint: null, error: null })
      d.log(`profile sync: apply ${l0.direction}, ${x.send.length} files`)
      let soon: ReturnType<typeof setTimeout> | null = null
      const later = (): void => {
        soon ??= setTimeout(() => {
          soon = null
          if (view?.phase === 'applying') set({ progress: { ...progress } })
        }, 500)
      }
      const kept =
        p.conflicts.length - x.send.filter(s => p.conflicts.some(c => c.profile === s.profile && c.to === s.to)).length
      void (async () => {
        try {
          let gone = 0
          let created: string[] = []
          let install: boolean | null = null
          let skipped: Skipped[] = []
          /** What the target left as it was: not recorded, so the next preview offers it again. */
          const left = (): Set<string> => new Set(skipped.map(s => `${s.profile}:${s.rel}`))
          const records = (): { profile: string; rel: string; hash: string | null }[] => {
            const off = left()
            return [
              ...x.same.map(s => ({ profile: s.profile, rel: s.from, hash: s.hash })),
              ...x.deletions
                .filter(s => !off.has(`${s.profile}:${s.to}`))
                .map(s => ({ profile: s.profile, rel: s.from, hash: null })),
              ...x.forget.map(s => ({ profile: s.profile, rel: s.from, hash: null })),
            ]
          }
          if (l0.direction === 'up') {
            const profiles = new Map(local.sideProfiles(d.home).map(q => [q.name, q]))
            const ctx = { to: carry(server, 'up'), moves: x.moves, allow: x.allow }
            const sent: { profile: string; rel: string; to: string; hash: string | null }[] = []
            await program(
              to,
              l,
              'apply',
              { profiles: x.profiles, deletions: x.deletions, same: x.same, forget: x.forget, allow: x.allow },
              RUN_MS,
              f => {
                if (f.head.t === 'done') {
                  created = Array.isArray(f.head.created) ? f.head.created.map(String) : []
                  install = typeof f.head.install === 'boolean' ? f.head.install : null
                  skipped = skippedOf(f.head.skipped)
                }
              },
              async sink => {
                for (const s of x.send) {
                  const q = profiles.get(s.profile)
                  const ready = q ? local.prepare(q, s.from, ctx) : null
                  if (!ready) {
                    gone++
                    continue
                  }
                  await sink.send(
                    {
                      t: 'file',
                      profile: s.profile,
                      to: s.to,
                      merge: s.merge,
                      expect: s.expect ?? null,
                      cut: ready.cut,
                      exec: ready.exec,
                    },
                    ready.body,
                  )
                  sent.push({ profile: s.profile, rel: s.from, to: s.to, hash: ready.hash })
                  progress.files++
                  progress.bytes += ready.body.length
                  later()
                }
                await sink.send({ t: 'end' })
              },
            )
            const off = left()
            local.recordSynced(serverPeer(), [
              ...sent.filter(s => !off.has(`${s.profile}:${s.to}`)).map(({ to: _, ...r }) => r),
              ...records(),
            ])
          } else {
            const target = local.openTarget({
              peer: serverPeer(),
              home: d.home,
              platform: d.platform,
              profiles: x.profiles,
              allow: x.allow,
            })
            // only what this side asked for is written, with the hash this side had at Look
            const asked = new Map(x.send.map(s => [`${s.profile}:${s.from}`, s]))
            const got: { profile: string; rel: string; hash: string | null }[] = []
            try {
              for (const s of x.same) target.same(s.profile, s.to, s.there)
              for (const s of x.forget) target.forget(s.profile, s.to)
              await program(
                to,
                l,
                'pack',
                {
                  to: { platform: d.platform, home: d.home },
                  moves: x.moves,
                  items: x.send.map(s => ({ profile: s.profile, from: s.from, to: s.to, merge: s.merge })),
                  allow: x.allow,
                },
                RUN_MS,
                f => {
                  if (f.head.t !== 'file') return
                  if (f.head.gone === true) {
                    gone++
                    return
                  }
                  const s = asked.get(`${String(f.head.profile)}:${String(f.head.from)}`)
                  if (!s) return
                  const found = isRecord(f.head.found) && Object.keys(f.head.found).length > 0
                  const why = target.write(s.profile, s.to, f.body, {
                    merge: s.merge,
                    expect: s.expect ?? null,
                    cut: f.head.cut === true || (found && !s.merge),
                    exec: f.head.exec === true,
                  })
                  if (why !== null) return
                  got.push({
                    profile: s.profile,
                    rel: s.from,
                    hash: typeof f.head.hash === 'string' ? f.head.hash : null,
                  })
                  progress.files++
                  progress.bytes += f.body.length
                  later()
                },
              )
              for (const s of x.deletions) target.remove(s.profile, s.to, s.expect)
            } finally {
              // what was written is recorded here, however the run ended
              const done = target.finish()
              created = done.created
              skipped = done.skipped
            }
            set({ progress: { ...progress, step: 'record' } })
            await program(
              to,
              l,
              'record',
              { changes: [...got.filter(g => g.hash !== null), ...records()] },
              SCAN_MS,
              () => {},
            )
          }
          set({
            phase: 'done',
            progress: { ...progress },
            result: {
              files: progress.files,
              bytes: progress.bytes,
              deleted: x.deletions.length - x.deletions.filter(s => left().has(`${s.profile}:${s.to}`)).length,
              kept,
              created,
              install,
              gone,
              skipped,
            },
          })
          d.log(`profile sync: done ${l0.direction}, ${progress.files} files`)
        } catch (err) {
          const a = answerOf(err)
          set({ phase: 'failed', progress: { ...progress }, hint: a.hint, error: a.error })
          d.log(`profile sync: failed ${l0.direction}`)
        } finally {
          if (soon) clearTimeout(soon)
          looked = null
          busy = false
        }
      })()
      return ok()
    },

    cancel() {
      cancelled = true
      current?.kill()
      return ok()
    },

    forget() {
      if (busy) return ok()
      view = null
      looked = null
      changed()
      return ok()
    },
  }
}
