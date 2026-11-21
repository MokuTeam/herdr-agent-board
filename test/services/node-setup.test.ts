// "Add a server" (#509, services/nodes/setup.ts): Look, Apply with the master's half after it,
// Continue, and Undo, on the fake root (test/support/fake-root.ts) through a fake admin ssh that runs
// the real scripts there: the probe's lines, sudo's password on stdin, the login's password through
// the askpass only, the archive on stdin into /var/tmp, and the packed run unpacked and run as root.
// The master's half runs against this test's config.json with fake links and a fake bundle sync;
// the real link and bundle are test/server/node-setup.test.ts's, on the pair harness.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile, editNodesAdding, loadConfig } from '../../src/adapters/config-file.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { configDir, stateDir } from '../../src/adapters/paths.ts'
import type { RemoteEnd, RemoteRun, spawnRemote } from '../../src/adapters/ssh.ts'
import { NODE_API } from '../../src/core/node-door.ts'
import { ceilingFor } from '../../src/core/node-plan.ts'
import type { NodeSetupView } from '../../src/core/node-setup.ts'
import { LINK_FENCE, LINK_KEYS, linkFence, linkKeysLine } from '../../src/core/node-texts.ts'
import type { LinkStatus, NodeStatus } from '../../src/core/nodes.ts'
import type { SyncReport } from '../../src/services/nodes/bundle-sync.ts'
import { createNodeSetup } from '../../src/services/nodes/setup.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakeRoot, fakeRoot } from '../support/fake-root.ts'
import { nodeKind, unpackNodeRun } from '../support/fake-root-prep.ts'

const SLOW = 600_000
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINodeLinkTestKeyOnly00000000000000000000 agent-board link'
/** The password the tests type: what a shell, JSON or a URL would take apart. */
const SENTINEL = `S3cr3t%$'"\`Ж`
const COMMIT = 'c0ffee'.padEnd(40, '0')
const HELLO = JSON.stringify({ api: 1, version: '0.0.0', node: { api: NODE_API, id: 'server-1', claimed: true } })
const STATUS: NodeStatus = {
  api: 1,
  id: 'server-1',
  version: '0.0.0',
  commit: COMMIT,
  platform: 'linux',
  arch: 'x64',
  cpus: 4,
  memTotalMb: 7957,
  memAvailableMb: 7100,
  load: [0.1, 0.1, 0.1],
  sessions: { awake: 0, working: 0, asleep: 0 },
  launches: 0,
  workRootFreeMb: 50_000,
  profiles: [{ id: 'default', loggedIn: false, bundle: null }],
  agents: ['claude'],
  at: 0,
}

/** A small tar, as git archive would give one: the plugin the master sends. */
function pluginTar(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'board-setup-plugin-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"agent-board"}\n')
    const r = spawnSync('tar', ['-cf', 'plugin.tar', 'package.json'], { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return readFileSync(join(dir, 'plugin.tar'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface Admin {
  /** The keys are refused and this is the login's password (through the askpass only). */
  loginPassword?: string
  sudo?: 'nopasswd' | 'password'
  sudoPassword?: string
  failUpload?: boolean
  /** A node run's lines instead of running it (a test of the master's half alone). */
  run?: string[]
  /** More of the root's environment (FAKE_CLAUDE_FAIL…). */
  env?: Record<string, string>
  /** Tools Look says the server lacks (the fake root's PATH reaches this computer's own). */
  lacks?: string[]
  /** The upload says another sha256 than the archive's. */
  shaLie?: boolean
  /** A canned run waits this long before its lines; its end (default 0, nothing on stderr). */
  slowRun?: number
  runEnd?: { code: number; err: string }
  /** Called as a node run starts, before its lines (a test changes something here meanwhile). */
  onRun?: () => void
}

interface Call {
  args: string[]
  stdin: string | null
  bytes: number
  login: string | null
  kind: string | null
}

const REMOTE =
  /^(env LC_ALL=C sudo -n -- |env LC_ALL=C sudo -S -p '' -- )?sh -c 'eval "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/

/**
 * The admin's ssh as spawnRemote, on the fake root: the server's key pinned by the first login
 * (accept-new), refused after without it; the login, the sudo and the scripts as a server would
 * answer; output lines with the root's own folder taken out, as the server prints its paths.
 */
function fakeAdmin(root: FakeRoot, a: Admin) {
  let pinned = false
  const calls: Call[] = []
  const spawn: typeof spawnRemote = (_bin, args, stdin, _ms, login) => {
    const listeners: ((line: string, from: 'out' | 'err') => void)[] = []
    let settle: (e: RemoteEnd) => void = () => {}
    const done = new Promise<RemoteEnd>(r => {
      settle = r
    })
    const text = typeof stdin === 'string' ? stdin : null
    const bytes = stdin instanceof Uint8Array ? stdin : null
    const command = args.at(-1) ?? ''
    const m = REMOTE.exec(command)
    const script = m ? Buffer.from(m[2] ?? '', 'base64').toString('utf8') : ''
    const kind = nodeKind(script) ?? (script.includes('# agent-board: probe') ? 'probe' : null)
    calls.push({ args, stdin: text, bytes: bytes?.length ?? 0, login: login?.password ?? null, kind })
    const say = (from: 'out' | 'err', ...lines: string[]): void => {
      for (const line of lines) for (const fn of listeners) fn(line.replaceAll(root.R, ''), from)
    }
    void (async () => {
      await Promise.resolve()
      const askpass = a.loginPassword === undefined ? undefined : { answered: login ? 1 : 0, refused: null }
      const end = (code: number | null): void => settle({ code, error: null, ...(askpass && { askpass }) })
      const accept = args.includes('StrictHostKeyChecking=accept-new')
      if (!pinned && !accept) {
        say('err', 'Host key verification failed.')
        return end(255)
      }
      pinned = true
      if (a.loginPassword !== undefined && login?.password !== a.loginPassword) {
        say('err', 'admin@ssh.example.com: Permission denied (publickey,password).')
        return end(255)
      }
      if (!m) {
        say('err', 'fake: unexpected command')
        return end(2)
      }
      const mode = a.sudo ?? 'nopasswd'
      if (kind === 'probe') {
        say('out', '@@uid 1000')
        say('out', ...(mode === 'nopasswd' ? ['@@sudo ok'] : ['@@sudo sudo: a password is required']))
        say('out', '@@flavor Sudo version 1.9.16p2')
        return end(0)
      }
      const asAdmin = kind === 'upload' || kind === 'clean'
      const wanted = asAdmin ? '' : mode === 'nopasswd' ? 'env LC_ALL=C sudo -n -- ' : "env LC_ALL=C sudo -S -p '' -- "
      if ((m[1] ?? '') !== wanted) {
        say('err', `fake: ${kind} run behind the wrong sudo`)
        return end(2)
      }
      if (wanted.includes('sudo -S') && text !== `${a.sudoPassword}\n`) {
        say('err', 'Sorry, try again.', 'sudo: 1 incorrect password attempt')
        return end(1)
      }
      if (kind === 'upload' && a.failUpload) {
        say('out', '@@fail could not make a folder under /var/tmp')
        return end(1)
      }
      if (kind === 'apply' || kind === 'undo') a.onRun?.()
      if ((kind === 'apply' || kind === 'undo') && a.run) {
        if (a.slowRun) await Bun.sleep(a.slowRun)
        say('out', ...a.run)
        if (a.runEnd) say('err', a.runEnd.err)
        return end(a.runEnd?.code ?? 0)
      }
      const body = kind === 'apply' || kind === 'undo' ? unpackNodeRun(script) : script
      if (body === null) {
        say('err', 'fake: a run that is not packed')
        return end(2)
      }
      const r = await root.runAsync(body, { ...a.env }, kind === 'upload' ? (bytes ?? undefined) : undefined)
      const lacked = new Set((a.lacks ?? []).map(t => `@@has ${t}`))
      if (kind === 'upload' && a.shaLie)
        r.lines = r.lines.map(l => (l.startsWith('@@sha ') ? `@@sha ${'0'.repeat(64)}` : l))
      say(
        'out',
        ...r.lines.filter((l, i, all) => (l !== '' || i < all.length - 1) && !(kind === 'look' && lacked.has(l))),
      )
      for (const l of r.err.split(/\r?\n/).filter(Boolean)) say('err', l)
      end(r.code)
    })()
    return { onLine: fn => void listeners.push(fn), done, kill: () => {} } satisfies RemoteRun
  }
  return { spawn, calls, pinned: () => pinned }
}

/** A link that a test moves: its state, and its status once online. */
function fakeLink() {
  let state: LinkStatus = { state: 'connecting', since: 0, heardAt: null }
  let status: NodeStatus | null = STATUS
  const retries: string[] = []
  return {
    retries,
    set(next: Partial<LinkStatus>, s: NodeStatus | null = status) {
      state = { ...state, ...next }
      if (next.state && next.state !== 'refused') delete state.reason
      status = s
    },
    links: {
      link: (id: string) =>
        id === 'server-1'
          ? ({ id, state: () => state, status: async () => (state.state === 'online' ? status : null) } as never)
          : null,
      retry: (id: string) => {
        retries.push(id)
        return true
      },
    },
  }
}

const report = (ok: boolean, why?: SyncReport['why']): SyncReport => ({
  ok,
  device: 'server-1',
  profile: 'default',
  nodeProfile: 'default',
  seq: 1,
  hash: 'f'.repeat(64),
  ...(why && { why }),
  sent: ok ? 3 : 0,
  applied: ok ? ['CLAUDE.md', 'settings.json'] : [],
  kept: [],
  backup: null,
  lines: [],
  at: 0,
})

/**
 * A board (this test's config.json, `nodes` given or none) with the setup service over the fake
 * admin; `linkUp`: the link comes online as soon as the board follows config.json.
 */
function useSetup(
  o: {
    root?: FakeRoot
    admin?: Admin
    nodes?: Record<string, unknown>
    linkUp?: boolean
    bundle?: () => SyncReport
  } = {},
) {
  isolatedHome()
  const root = o.root ?? fakeRoot('include', { node: true })
  writeFileSync(root.path('/state/hello'), HELLO)
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify({ language: 'en', ...(o.nodes && { nodes: o.nodes }) }, null, 2))
  const cfg = loadConfig()
  const admin = fakeAdmin(root, o.admin ?? {})
  const link = fakeLink()
  const store = createDeviceStore()
  const keys = new Map<string, string>()
  let followed = 0
  const syncs: string[] = []
  const logs: string[] = []
  const archive = pluginTar()
  let ids = 0
  const setup = createNodeSetup({
    cfg,
    ssh: () => 'ssh',
    sshVersion: async () => 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
    knownHosts: () => join(stateDir(), 'known_hosts'),
    hostKeyPinned: async () => admin.pinned(),
    hostKeyFingerprint: async () => (admin.pinned() ? 'SHA256:fakeHostKey (ED25519)' : null),
    spawn: admin.spawn,
    store,
    linkKey: async (id, make) => {
      if (!keys.has(id) && make) keys.set(id, KEY)
      const k = keys.get(id)
      return k ? { ok: true, publicKey: k } : null
    },
    commit: async () => COMMIT,
    archive: async () => archive,
    editNodes: editNodesAdding,
    follow: () => {
      followed++
      if (o.linkUp !== false) link.set({ state: 'online' })
    },
    links: () => (followed ? link.links : null),
    bundles: () => ({
      syncIfBehind: async (id: string) => {
        syncs.push(id)
        return o.bundle ? o.bundle() : report(true)
      },
    }),
    hostName: () => 'Laptop.local',
    onChange: () => {},
    log: l => void logs.push(l),
    now: () => Date.now(),
    newId: () => `r${++ids}`,
    linkWaitMs: 1500,
    pause: ms => Bun.sleep(Math.min(ms, 20)),
  })
  const server = { host: 'ssh.example.com', user: 'admin' }
  return {
    setup,
    root,
    admin,
    link,
    store,
    syncs,
    logs,
    archive,
    followed: () => followed,
    config: (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8')),
    look: (more: Record<string, unknown> = {}) => setup.look({ ...server, ...more }),
    undoLook: (more: Record<string, unknown> = {}) => setup.undoLook({ ...server, ...more }),
    async until(phases: NodeSetupView['phase'][], ms = SLOW): Promise<NodeSetupView> {
      const end = Date.now() + ms
      while (!phases.includes(setup.view().phase)) {
        if (Date.now() > end) throw new Error(`still ${setup.view().phase}: ${JSON.stringify(setup.view())}`)
        await Bun.sleep(25)
      }
      return setup.view()
    },
  }
}

const statesOf = (v: NodeSetupView): string[] => v.master.map(s => `${s.id} ${s.state}`)
const runOf = (v: NodeSetupView): string[] => (v.run?.steps ?? []).map(s => `${s.id} ${s.state}`)
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const MASTERS = '/home/agent-board/.local/state/herdr/plugins/agent-board/node/masters.json'
const NODE_CONFIG = '/home/agent-board/.config/herdr/plugins/config/agent-board/config.json'

describe('Look', () => {
  test('a fresh server: its key pinned at first sight and shown, the plan in words with the ceiling proposed, nothing changed there', async () => {
    const b = useSetup()
    const etc = b.root.etc()
    const a = await b.look()
    expect(a).toEqual({ status: 200, body: { ok: true } })
    const v = b.setup.view()
    expect(v.phase).toBe('plan')
    expect(v.hostKey).toEqual({ fingerprint: 'SHA256:fakeHostKey (ED25519)', pinnedNow: true })
    expect(v.sudo).toBe('nopasswd')
    expect(v.device).toEqual({ id: 'server-1', port: 12430 })
    expect(v.found).toMatchObject({ os: 'Ubuntu 24.04.1 LTS', node: null, record: false, bun: null })
    expect(v.refusals).toEqual([])
    expect(v.plan?.ceiling).toEqual(ceilingFor({ memTotalMb: 7957, memAvailableMb: 7128 }))
    expect(v.plan?.words.map(w => w.key)).toContain('node.plan.users')
    expect(v.plan?.words.map(w => w.key)).not.toContain('node.setup.already')
    expect(v.plan?.steps.map(s => s.id)).toEqual([
      'check',
      'user',
      'slice',
      'linger',
      'profile',
      'bun',
      'herdr',
      'claude',
      'plugin',
      'config',
      'install',
      'unit',
      'link',
      'hello',
    ])
    expect(statesOf(v)).toEqual([
      'token wait',
      'key wait',
      'archive wait',
      'upload wait',
      'config wait',
      'link wait',
      'status wait',
      'thresholds wait',
      'bundle wait',
      'login wait',
    ])
    // Look only reads: the server is as it was, and nothing was sent but the probe and the look
    expect(b.root.etc()).toEqual(etc)
    expect(b.admin.calls.map(c => c.kind)).toEqual(['probe', 'look'])
    expect(b.admin.calls[0]?.args).toContain('StrictHostKeyChecking=accept-new')
    expect(b.admin.calls[1]?.args).toContain('StrictHostKeyChecking=yes')
    // and here: no token, no key, no config
    expect(b.store.token('server-1')).toBeNull()
    expect(b.config().nodes).toBeUndefined()
  })

  test('a server too small or of another system is refused in words, with no plan', async () => {
    const root = fakeRoot('include', { node: true })
    writeFileSync(
      root.path('/proc/meminfo'),
      'MemTotal:        2048000 kB\nMemAvailable:    1900000 kB\nSwapTotal:       0 kB\n',
    )
    writeFileSync(root.path('/etc/os-release'), 'ID=alpine\nVERSION_ID="3.20"\nPRETTY_NAME="Alpine Linux v3.20"\n')
    const b = useSetup({ root })
    await b.look()
    const v = b.setup.view()
    expect(v.phase).toBe('plan')
    expect(v.plan).toBeNull()
    expect(v.refusals.map(r => r.key)).toEqual(['node.refuse.os', 'node.refuse.small'])
    expect(await b.setup.apply({ plan: 'r1' })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
  })

  test("an id that is another server's device is refused; one the owner gives is taken", async () => {
    const nodes = {
      id: 'laptop',
      devices: { 'server-1': { link: { kind: 'ssh', host: 'other.example.com', user: 'agent-board-link' } } },
    }
    const b = useSetup({ nodes })
    await b.look()
    expect(b.setup.view().refusals.map(r => r.key)).toEqual(['node.setup.refuse.idTaken'])
    await b.look({ id: 'box-2' })
    expect(b.setup.view().refusals).toEqual([])
    expect(b.setup.view().device?.id).toBe('box-2')
    expect(await b.look({ id: 'Local' })).toMatchObject({ status: 409, body: { field: 'id' } })
  })

  test("the login's password goes to the askpass only, never into an argument or stdin; Apply without it is asked for it", async () => {
    const b = useSetup({ admin: { loginPassword: SENTINEL, sudo: 'password', sudoPassword: SENTINEL } })
    expect(await b.look()).toMatchObject({ status: 409, body: { hint: 'loginPassword', need: 'password' } })
    const before = b.admin.calls.length
    expect(await b.look({ password: SENTINEL })).toEqual({ status: 200, body: { ok: true } })
    expect(b.setup.view().sudo).toBe('password')
    for (const c of b.admin.calls) {
      expect(c.args.join(' ')).not.toContain(SENTINEL)
      if (c.kind === 'look') expect(c.stdin).toBe(`${SENTINEL}\n`)
    }
    expect(b.admin.calls.slice(before).map(c => [c.kind, c.login])).toEqual([
      ['probe', SENTINEL],
      ['look', SENTINEL],
    ])
    expect(JSON.stringify(b.setup.view())).not.toContain(SENTINEL)
    const plan = b.setup.view().plan?.id
    expect(await b.setup.apply({ plan })).toMatchObject({
      status: 409,
      body: { hint: 'loginPassword', need: 'password' },
    })
  })

  test('Cancel drops the plan: Apply then asks for a Look', async () => {
    const b = useSetup()
    await b.look()
    const plan = b.setup.view().plan?.id
    expect(b.setup.cancel()).toEqual({ status: 200, body: { ok: true } })
    expect(b.setup.view().phase).toBe('idle')
    expect(await b.setup.apply({ plan })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
  })
})

describe('Apply and the master’s half', () => {
  test(
    'a fresh server on a board without nodes: the server is made a node, nodes is made here, the link, the thresholds, the profile, and the login is what is left; a second Apply changes nothing; Undo takes it all away',
    async () => {
      const b = useSetup({ admin: { sudo: 'password', sudoPassword: SENTINEL } })
      await b.look({ sudoPassword: SENTINEL })
      const plan = b.setup.view().plan?.id
      expect(await b.setup.apply({ plan, sudoPassword: SENTINEL })).toEqual({ status: 200, body: { ok: true } })
      const v = await b.until(['done', 'failed'])
      expect(v.phase).toBe('done')
      expect(runOf(v).every(s => s.endsWith(' ok'))).toBe(true)
      expect(v.run?.result).toBe('applied')
      expect(statesOf(v)).toEqual([
        'token ok',
        'key ok',
        'archive ok',
        'upload ok',
        'config ok',
        'link ok',
        'status ok',
        'thresholds ok',
        'bundle ok',
        'login wait',
      ])
      expect(v.login).toEqual({ device: 'server-1', profiles: [{ id: 'default', loggedIn: false }] })
      expect(v.master.at(-1)?.said).toEqual({ key: 'node.setup.said.login', params: { device: 'server-1' } })
      expect(v.bundle).toEqual({ ok: true, applied: 2, kept: 0, sent: 3, why: null })
      expect(b.syncs).toEqual(['server-1'])
      // config.json: the section made, this computer's id from its name, the device first and local after
      expect(b.config().nodes).toEqual({
        id: 'laptop-local',
        order: ['server-1', 'local'],
        whenFull: 'local',
        devices: {
          'server-1': {
            link: { kind: 'ssh', host: 'ssh.example.com', sshPort: 22, user: 'agent-board-link', port: 12430 },
            maxSessions: 4,
            minFreeMemMb: 1194,
            maxLoad: 0.9,
          },
        },
      })
      // the token is here; only its hash is there, and the link key's public half
      const token = b.store.token('server-1') as string
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const masters = JSON.parse(readFileSync(b.root.path(MASTERS), 'utf8')) as {
        id: string
        name: string
        tokenHash: string
      }[]
      expect(masters).toMatchObject([
        { id: 'laptop-local', name: 'Laptop.local', tokenHash: sha(token), via: 'install' },
      ])
      expect(JSON.stringify(b.root.home())).not.toContain(token)
      expect(readFileSync(b.root.path('/etc/ssh/authorized_keys/agent-board-link'), 'utf8')).toContain(KEY)
      // the plugin there is stamped with this board's commit: the node's status reports it
      expect(readFileSync(b.root.path('/home/agent-board/agent-board/.archive-commit'), 'utf8')).toBe(`${COMMIT}\n`)
      // the archive's folder is gone from /var/tmp
      expect(readdirSync(b.root.path('/var/tmp')).filter(n => n.startsWith('agent-board-node.'))).toEqual([])
      // the password is in no file here or there, no argument, no view
      for (const c of b.admin.calls) expect(c.args.join(' ')).not.toContain(SENTINEL)
      expect(JSON.stringify(b.setup.view())).not.toContain(SENTINEL)
      const files = (dir: string): string[] =>
        existsSync(dir)
          ? readdirSync(dir, { recursive: true, withFileTypes: true })
              .filter(e => e.isFile())
              .map(e => join(e.parentPath, e.name))
          : []
      for (const f of [...files(configDir()), ...files(stateDir())])
        expect(readFileSync(f, 'utf8')).not.toContain(SENTINEL)
      expect(JSON.stringify(b.root.etc()) + JSON.stringify(b.root.home())).not.toContain(SENTINEL)

      // a second Apply: Look says it is a node already, every step skips, nothing changes on either side
      const cfgBefore = readFileSync(configFile(), 'utf8')
      const etc = b.root.etc()
      const home = b.root.home()
      await b.look({ sudoPassword: SENTINEL })
      expect(b.setup.view().found?.node).toBe('server-1')
      expect(b.setup.view().plan?.words[0]).toEqual({ key: 'node.setup.already', params: { id: 'server-1' } })
      await b.setup.apply({ plan: b.setup.view().plan?.id, sudoPassword: SENTINEL })
      const v2 = await b.until(['done', 'failed'])
      expect(v2.phase).toBe('done')
      // the hello is asked again every time: it changes nothing
      expect(runOf(v2).filter(s => !s.endsWith(' skip'))).toEqual(['check ok', 'hello ok'])
      expect(statesOf(v2).slice(0, 2)).toEqual(['token skip', 'key ok'])
      expect(statesOf(v2)).toContain('config skip')
      expect(statesOf(v2)).toContain('thresholds skip')
      expect(readFileSync(configFile(), 'utf8')).toBe(cfgBefore)
      expect(b.root.etc()).toEqual(etc)
      expect(b.root.home()).toEqual(home)
      expect(b.store.token('server-1')).toBe(token)

      // Undo: the record's Undo there, and the device's token, key and entry here
      await b.undoLook({ sudoPassword: SENTINEL })
      const u = b.setup.view()
      expect(u.kind).toBe('undo')
      expect(u.plan?.work).toBe(false)
      expect(await b.setup.undo({ plan: u.plan?.id, sudoPassword: SENTINEL })).toEqual({
        status: 200,
        body: { ok: true },
      })
      const done = await b.until(['undone', 'failed'])
      expect(done.phase).toBe('undone')
      expect(existsSync(b.root.path('/etc/agent-board-node/setup.json'))).toBe(false)
      expect(existsSync(b.root.path('/etc/ssh/authorized_keys/agent-board-link'))).toBe(false)
      expect(b.store.token('server-1')).toBeNull()
      expect(b.config().nodes).toEqual({ id: 'laptop-local', order: ['local'], whenFull: 'local', devices: {} })
    },
    SLOW,
  )

  test(
    'a node set up by hand: Look says so, herdr that runs is never restarted, and only what is missing is done',
    async () => {
      const b = useSetup()
      await b.look()
      await b.setup.apply({ plan: b.setup.view().plan?.id })
      expect((await b.until(['done', 'failed'])).phase).toBe('done')
      // by hand: no record, a unit of the owner's own, the door on a port of the owner's, herdr
      // running and its board holding that port
      rmSync(b.root.path('/etc/agent-board-node/setup.json'))
      const unit = b.root.path('/home/agent-board/.config/systemd/user/herdr.service')
      writeFileSync(unit, `${readFileSync(unit, 'utf8')}# mine\n`)
      const nodeCfg = b.root.path(NODE_CONFIG)
      writeFileSync(nodeCfg, `${JSON.stringify({ language: 'en', node: { id: 'server-1', port: 12440 } }, null, 2)}\n`)
      writeFileSync(
        b.root.path('/state/listen'),
        'LISTEN 0 4096 127.0.0.1:12440 0.0.0.0:* users:(("bun",pid=77,fd=12))\n',
      )
      // the link user's key and fence for that port, as the owner set them up (the fence's paths as
      // the fake root spells them, as a run there writes them)
      writeFileSync(b.root.path(LINK_KEYS), `${linkKeysLine(KEY, 12440)}\n`)
      writeFileSync(b.root.path(LINK_FENCE), linkFence(12440).replaceAll('/etc/', `${b.root.R}/etc/`))
      expect(existsSync(b.root.path('/state/user-active'))).toBe(true)
      const logBefore = b.root.log().length
      await b.look()
      const v = b.setup.view()
      expect(v.found).toMatchObject({ node: 'server-1', record: false })
      // the node's own port, which its board holds: no refusal
      expect(v.device).toEqual({ id: 'server-1', port: 12440 })
      expect(v.refusals).toEqual([])
      expect(v.plan?.words[0]).toEqual({ key: 'node.setup.already', params: { id: 'server-1' } })
      await b.setup.apply({ plan: v.plan?.id })
      const v2 = await b.until(['done', 'failed'])
      expect(v2.phase).toBe('done')
      // the unit file only; config.json, the key and the fence there as the owner left them
      expect(runOf(v2).filter(s => !s.endsWith(' skip'))).toEqual(['check ok', 'unit ok', 'hello ok'])
      expect(readFileSync(b.root.path(LINK_KEYS), 'utf8')).toBe(`${linkKeysLine(KEY, 12440)}\n`)
      expect(JSON.parse(readFileSync(nodeCfg, 'utf8')).node).toEqual({ id: 'server-1', port: 12440 })
      expect(
        (b.config().nodes as { devices: Record<string, { link: { port: number } }> }).devices['server-1']?.link.port,
      ).toBe(12440)
      expect(v2.run?.warnings).toEqual(['herdr runs on as it was started: the new unit takes effect at its next start'])
      const after = b.root.log().slice(logBefore)
      expect(after).not.toContain('restart')
      expect(after).not.toContain('systemctl --user start')
      expect(existsSync(b.root.path('/etc/agent-board-node/setup.json'))).toBe(true)
    },
    SLOW,
  )

  test(
    'a step that fails is undone on the server, and the master writes nothing into config.json',
    async () => {
      const b = useSetup({ admin: { env: { FAKE_CLAUDE_FAIL: '1' } } })
      await b.look()
      await b.setup.apply({ plan: b.setup.view().plan?.id })
      const v = await b.until(['done', 'failed'])
      expect(v.phase).toBe('failed')
      expect(v.run?.result).toBe('rolled-back')
      expect(runOf(v)).toContain('claude fail')
      expect(v.next).toEqual({ key: 'node.setup.next.again' })
      expect(v.error).toContain('claude: the install failed')
      expect(
        statesOf(v)
          .slice(4)
          .every(s => s.endsWith(' wait')),
      ).toBe(true)
      expect(b.config().nodes).toBeUndefined()
      expect(b.followed()).toBe(0)
      expect(existsSync(b.root.path('/etc/agent-board-node/setup.json'))).toBe(false)
      expect(b.root.passwd()).not.toContain('agent-board')
    },
    SLOW,
  )

  test('the archive refused on the server: nothing runs there, and the form says to Apply again', async () => {
    const b = useSetup({ admin: { failUpload: true } })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.phase).toBe('failed')
    expect(statesOf(v).slice(0, 5)).toEqual(['token ok', 'key ok', 'archive ok', 'upload fail', 'config wait'])
    expect(v.error).toBe('could not make a folder under /var/tmp')
    expect(b.admin.calls.map(c => c.kind)).toEqual(['probe', 'look', 'upload'])
    expect(runOf(v).every(s => s.endsWith(' wait'))).toBe(true)
  })

  test('the packages tick is asked for when a tool is missing, and Apply without it is refused', async () => {
    const b = useSetup({ admin: { lacks: ['unzip'] } })
    await b.look()
    const v = b.setup.view()
    expect(v.refusals).toEqual([])
    expect(v.plan?.packagesNeeded).toBe(true)
    expect(v.plan?.steps.map(s => s.id)).toContain('packages')
    expect(await b.setup.apply({ plan: v.plan?.id })).toMatchObject({ status: 409 })
    expect(b.admin.calls.map(c => c.kind)).toEqual(['probe', 'look'])
  })

  test('a board with nodes: the device goes in before local and the rest of the section stays as it was', async () => {
    const nodes = {
      id: 'desk',
      order: ['box-9', 'local'],
      lanes: ['atlas'],
      whenFull: 'wait',
      devices: {
        'box-9': { link: { kind: 'direct', url: 'http://127.0.0.1:1' }, maxSessions: 2 },
        local: { maxSessions: 6 },
      },
    }
    const b = useSetup({ nodes, admin: { run: ['@@step check ok', '@@result applied'] } })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    expect((await b.until(['done', 'failed'])).phase).toBe('done')
    expect(b.config().nodes).toEqual({
      ...nodes,
      order: ['box-9', 'server-1', 'local'],
      devices: {
        ...nodes.devices,
        'server-1': {
          link: { kind: 'ssh', host: 'ssh.example.com', sshPort: 22, user: 'agent-board-link', port: 12430 },
          maxSessions: 4,
          minFreeMemMb: 1194,
          maxLoad: 0.9,
        },
      },
    })
    const masters = b.admin.calls.find(c => c.kind === 'apply')
    expect(masters).toBeDefined()
  })

  test('the link does not come: the form stops at the link and says what to do; Continue finishes once it is up', async () => {
    const b = useSetup({ linkUp: false, admin: { run: ['@@result applied'] } })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.phase).toBe('failed')
    expect(statesOf(v).slice(4)).toEqual([
      'config ok',
      'link fail',
      'status wait',
      'thresholds wait',
      'bundle wait',
      'login wait',
    ])
    expect(v.master.find(s => s.id === 'link')?.said).toEqual({ key: 'node.setup.said.noAnswer', params: { s: '2' } })
    expect(v.next).toEqual({ key: 'node.setup.next.link' })
    // a host key the link refuses fails at once with its reason
    b.link.set({ state: 'refused', reason: 'host-key', detail: '' })
    await b.setup.finish()
    expect(b.setup.view().master.find(s => s.id === 'link')).toEqual({
      id: 'link',
      state: 'fail',
      said: { key: 'node.setup.why.host-key', params: { detail: '' } },
    })
    b.link.set({ state: 'online' })
    expect(await b.setup.finish()).toEqual({ status: 200, body: { ok: true } })
    const v2 = b.setup.view()
    expect(v2.phase).toBe('done')
    expect(statesOf(v2).slice(4)).toEqual([
      'config skip',
      'link ok',
      'status ok',
      'thresholds ok',
      'bundle ok',
      'login wait',
    ])
  })

  test('a token the door does not take yet: the link is asked again at once, once', async () => {
    const b = useSetup({ linkUp: false, admin: { run: ['@@result applied'] } })
    await b.look()
    b.link.set({ state: 'refused', reason: 'token' })
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    await b.until(['done', 'failed'])
    expect(b.link.retries).toEqual(['server-1'])
  })

  test('the profile does not go: the form says so, and Continue sends it again', async () => {
    let n = 0
    const b = useSetup({
      admin: { run: ['@@result applied'] },
      bundle: () => (++n === 1 ? report(false, 'timeout') : report(true)),
    })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.phase).toBe('failed')
    expect(statesOf(v).slice(-2)).toEqual(['bundle fail', 'login wait'])
    expect(v.bundle).toMatchObject({ ok: false, why: 'timeout' })
    expect(v.next).toEqual({ key: 'node.setup.next.bundle' })
    await b.setup.finish()
    expect(b.setup.view().phase).toBe('done')
    expect(b.syncs).toEqual(['server-1', 'server-1'])
  })

  test('a profile logged in there ends the form on done, nothing left to do', async () => {
    const b = useSetup({ admin: { run: ['@@result applied'] } })
    b.link.set({}, { ...STATUS, profiles: [{ id: 'default', loggedIn: true, bundle: null }] })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.master.at(-1)).toEqual({
      id: 'login',
      state: 'ok',
      said: { key: 'node.setup.said.loggedIn', params: { device: 'server-1' } },
    })
  })

  test('a config.json that does not parse is left as it is, and the form says what to do', async () => {
    const b = useSetup({ admin: { run: ['@@result applied'] } })
    await b.look()
    writeFileSync(configFile(), '{ "language": "en", }')
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.phase).toBe('failed')
    expect(v.master.find(s => s.id === 'config')?.state).toBe('fail')
    expect(v.next).toEqual({ key: 'node.setup.next.config' })
    expect(readFileSync(configFile(), 'utf8')).toBe('{ "language": "en", }')
  })
})

describe('the form while it works', () => {
  test('the archive changed on its way: removed from the server, nothing run there', async () => {
    const b = useSetup({ admin: { shaLie: true } })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect(v.master.find(s => s.id === 'upload')).toEqual({
      id: 'upload',
      state: 'fail',
      said: { key: 'node.setup.said.uploadChanged' },
    })
    expect(b.admin.calls.map(c => c.kind)).toEqual(['probe', 'look', 'upload', 'clean'])
    expect(readdirSync(b.root.path('/var/tmp')).filter(n => n.startsWith('agent-board-node.'))).toEqual([])
  })

  test('the connection went while the server ran: the form says the run goes on there and to Look again', async () => {
    const b = useSetup({
      admin: {
        run: ['@@step check start', '@@step check ok'],
        runEnd: { code: 255, err: 'Connection to ssh.example.com closed by remote host.' },
      },
    })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    const v = await b.until(['done', 'failed'])
    expect([v.phase, v.hint, v.next]).toEqual(['failed', 'lost', { key: 'node.setup.next.lost' }])
    expect(b.config().nodes).toBeUndefined()
  })

  test("a password that is one of the run's own words leaves its step lines whole; what the steps say is masked", async () => {
    const b = useSetup({
      admin: {
        loginPassword: 'check',
        run: ['@@step check start', 'checking the server', '@@step check ok', '@@result applied'],
      },
    })
    await b.look({ password: 'check' })
    await b.setup.apply({ plan: b.setup.view().plan?.id, password: 'check' })
    const v = await b.until(['done', 'failed'])
    expect(v.phase).toBe('done')
    expect(v.run?.steps[0]).toEqual({ id: 'check', state: 'ok' })
    expect(v.run?.said).toEqual(['••••ing the server'])
  })

  test('busy while a run goes on, and Cancel waits for the server; Cancel while the master waits for the link stops it there', async () => {
    const b = useSetup({ linkUp: false, admin: { run: ['@@result applied'], slowRun: 600 } })
    await b.look()
    await b.setup.apply({ plan: b.setup.view().plan?.id })
    expect(await b.look()).toMatchObject({ status: 409, body: { hint: 'busy' } })
    while (b.admin.calls.at(-1)?.kind !== 'apply') await Bun.sleep(10)
    expect(b.setup.cancel()).toMatchObject({ status: 409, body: { hint: 'busy' } })
    await b.until(['finishing'])
    expect(b.setup.cancel()).toEqual({ status: 200, body: { ok: true } })
    // the link's wait ends on its own after the cancel: the form stays idle
    await Bun.sleep(1800)
    expect(b.setup.view().phase).toBe('idle')
  })

  test("the owner's ceiling out of range and a door on the board's own port are refused before anything is made", async () => {
    const b = useSetup()
    expect(await b.look({ port: 12422 })).toMatchObject({ status: 409, body: { field: 'port' } })
    await b.look()
    const r = await b.setup.apply({ plan: b.setup.view().plan?.id, ceiling: { memoryMaxMb: 100 } })
    expect(r).toMatchObject({ status: 409, body: { field: 'ceiling' } })
    expect(b.store.token('server-1')).toBeNull()
    expect(b.admin.calls.map(c => c.kind)).toEqual(['probe', 'look'])
  })
})

describe('Undo', () => {
  const OURS = {
    id: 'laptop',
    order: ['server-1', 'local'],
    devices: { 'server-1': { link: { kind: 'ssh', host: 'ssh.example.com', user: 'agent-board-link', port: 12430 } } },
  }
  const recorded = (root: FakeRoot): void => {
    mkdirSync(root.path('/etc/agent-board-node'), { recursive: true })
    writeFileSync(
      root.path('/etc/agent-board-node/setup.json'),
      '{"v":1,"run":"r1","at":"2026-11-21T10:00:00Z","state":"applied","node":{"id":"server-1","port":12430},"items":[{"kind":"keys"}]}\n',
    )
  }

  test('the device is paused here before the server is undone; a config.json that will not take its removal is said, and Continue finishes it', async () => {
    const root = fakeRoot('include', { node: true })
    recorded(root)
    let pausedSeen: unknown = null
    const b = useSetup({
      root,
      nodes: OURS,
      admin: {
        run: ['@@result undone'],
        onRun: () => {
          pausedSeen = (
            JSON.parse(readFileSync(configFile(), 'utf8')) as {
              nodes: { devices: Record<string, { paused?: boolean }> }
            }
          ).nodes.devices['server-1']?.paused
          writeFileSync(configFile(), '{ "nodes": ')
        },
      },
    })
    b.store.setToken('server-1', 'x'.repeat(43))
    await b.undoLook()
    await b.setup.undo({ plan: b.setup.view().plan?.id })
    const v = await b.until(['undone', 'failed'])
    expect(pausedSeen).toBe(true)
    expect([v.phase, v.next]).toEqual(['failed', { key: 'node.setup.next.undoConfig' }])
    // the credentials stay while the entry is still there
    expect(b.store.token('server-1')).toBe('x'.repeat(43))
    writeFileSync(configFile(), JSON.stringify({ language: 'en', nodes: OURS }))
    expect(await b.setup.finish()).toEqual({ status: 200, body: { ok: true } })
    expect(b.setup.view().phase).toBe('undone')
    expect(b.config().nodes).toEqual({ id: 'laptop', order: ['local'], devices: {} })
    expect(b.store.token('server-1')).toBeNull()
  })

  test('a server with no record of a run: nothing to undo, said so', async () => {
    const b = useSetup()
    expect(await b.undoLook()).toMatchObject({
      status: 409,
      body: { error: 'Nothing of a run of this board is on that server: there is nothing to undo.' },
    })
    expect(b.setup.view().phase).toBe('idle')
  })
})
