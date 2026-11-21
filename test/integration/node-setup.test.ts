// "Add a server" on real servers (#509, design 11.1, 14 T13), off unless BOARD_SERVER_IT=1: the
// server-setup harness's Debian 13, Ubuntu 24.04 and Ubuntu 26.04 servers (BOARD_SERVER_IT_LANES
// picks some), one fresh server each. The service (services/nodes/setup.ts) runs here as the board
// runs it, with Windows' own ssh and the admin's password through the askpass only: Look, Apply
// (the plugin is this checkout at its commit, the installers are the real ones, so the servers
// need the internet), then the master's half with the real link and bundle sync: the hello and
// the first status through the link user. After it: the link user opens the door's port and
// nothing else (another port, a shell, a TTY are refused), and the admin's password is in no file
// of the server's file system nor under this board's folders, its log or the view (all searched
// for it). Undo then
// takes the server back.
//
//   BOARD_SERVER_IT=1 bun test test/integration/node-setup.test.ts --timeout 3600000
//
// Skipped, saying so, while Docker does not answer.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile, editNodesAdding, loadConfig } from '../../src/adapters/config-file.ts'
import { archiveCommit, headCommit } from '../../src/adapters/git.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { configDir, ROOT, stateDir } from '../../src/adapters/paths.ts'
import {
  generateKey,
  hostKeyFingerprint,
  hostKeyPinned,
  knownHostsReady,
  protectKey,
  publicKeyOf,
  spawnRemote,
  sshVersion,
} from '../../src/adapters/ssh.ts'
import type { NodeSetupView } from '../../src/core/node-setup.ts'
import { LINK_USER } from '../../src/core/node-texts.ts'
import { createBundleSync } from '../../src/services/nodes/bundle-sync.ts'
import { createNodeLinks, type NodeLinks } from '../../src/services/nodes/links.ts'
import { createNodeSetup } from '../../src/services/nodes/setup.ts'
import { isolatedHome } from '../support/env.ts'
import {
  buildImage,
  closeLane,
  type Distro,
  dockerUp,
  type Lane,
  noCr,
  removeRun,
  removeStale,
  run,
  startLane,
  startMirror,
  startServer,
  type TestServer,
} from './server/harness.ts'

const ON = process.env.BOARD_SERVER_IT === '1'
function dockerAnswers(): boolean {
  try {
    const r = Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 60_000,
      windowsHide: true,
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}
const DOCKER = ON && dockerAnswers()
if (ON && !DOCKER)
  console.warn('node-setup: BOARD_SERVER_IT=1, but Docker does not answer: skipped (start Docker Desktop)')
const WINDOWS = process.platform === 'win32'
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const SSH = WINDOWS ? join(SYSTEM32, 'OpenSSH', 'ssh.exe') : 'ssh'
const KEYGEN = WINDOWS ? join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen'
const LANES: Distro[] = (['debian13', 'ubuntu2404', 'ubuntu2604'] as Distro[]).filter(
  d => !process.env.BOARD_SERVER_IT_LANES || process.env.BOARD_SERVER_IT_LANES.split(',').includes(d),
)
/** The admin's login password: the sentinel searched for on both sides afterwards. */
const PASSWORD = `N0de%$'"\`Ж-${Math.random().toString(16).slice(2, 8)}`
const MIN = 60_000
const lanes = new Map<Distro, Lane>()
let dir = ''
let adminKey = ''

async function keygen(path: string): Promise<void> {
  await run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', path])
  const rights = await protectKey(path)
  if (!rights.ok) throw new Error(rights.error)
}

/** ssh from this PC as the link user with the device's link key, the board's known_hosts. */
function asLink(s: TestServer, key: string, more: string[]) {
  const r = Bun.spawnSync(
    [
      SSH,
      '-F',
      'none',
      '-T',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsReady().replaceAll('\\', '/')}`,
      '-p',
      String(s.sshPort),
      ...more,
      `${LINK_USER}@127.0.0.1`,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
  )
  return { code: r.exitCode, out: Buffer.from(r.stdout ?? []).toString(), err: Buffer.from(r.stderr ?? []).toString() }
}

/** A local forward as the link user to a port of the server, the first answer through it, and the forward ended. */
async function through(s: TestServer, key: string, remotePort: number): Promise<string | null> {
  const local = 20000 + Math.floor(Math.random() * 20000)
  const p = Bun.spawn(
    [
      SSH,
      '-F',
      'none',
      '-N',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsReady().replaceAll('\\', '/')}`,
      '-L',
      `127.0.0.1:${local}:127.0.0.1:${remotePort}`,
      '-p',
      String(s.sshPort),
      `${LINK_USER}@127.0.0.1`,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  )
  try {
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(250)
      try {
        const res = await fetch(`http://127.0.0.1:${local}/api/hello`, { signal: AbortSignal.timeout(3000) })
        return await res.text()
      } catch {}
    }
    return null
  } finally {
    p.kill()
  }
}

async function scenario(l: Lane): Promise<void> {
  const s = await startServer(l, { tag: 'node', withDocker: false, adminKey, password: PASSWORD })
  isolatedHome()
  process.env.BOARD_SSH_BIN_PATH = SSH
  process.env.BOARD_SSH_KEYGEN_BIN_PATH = KEYGEN
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify({ language: 'en' }, null, 2))
  // the master's profile, which the first bundle carries
  const profileDir = join(dir, `profile-${l.distro}`)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'CLAUDE.md'), 'rules')
  const cfg = loadConfig()
  const store = createDeviceStore()
  // what the board would put in web.log: searched for the password too
  const logs: string[] = []
  const log = (line: string): void => void logs.push(line)
  // made the first time the service follows config.json, as app.ts makes them
  const made: { links: NodeLinks | null; bundles: ReturnType<typeof createBundleSync> | null } = {
    links: null,
    bundles: null,
  }
  const setup = createNodeSetup({
    cfg,
    ssh: () => SSH,
    sshVersion,
    knownHosts: knownHostsReady,
    hostKeyPinned,
    hostKeyFingerprint,
    spawn: spawnRemote,
    store: createDeviceStore(),
    linkKey: async (id, make) => {
      const key = store.keyPath(id)
      if (existsSync(key)) return publicKeyOf(key)
      return make ? generateKey(`agent-board it to ${id}`, key) : null
    },
    commit: () => headCommit(ROOT),
    archive: commit => archiveCommit(ROOT, commit),
    editNodes: editNodesAdding,
    follow: () => {
      if (made.links) return made.links.configChanged()
      const links = createNodeLinks({ cfg, log })
      made.links = links
      made.bundles = createBundleSync({
        cfg,
        links,
        profiles: () => [{ id: 'default', title: 'Default', dir: profileDir, color: 'indigo', hidden: false }],
        store: createDeviceStore(),
        log,
      })
    },
    links: () => made.links,
    bundles: () => made.bundles,
    hostName: () => hostname(),
    onChange: () => {},
    log,
    now: () => Date.now(),
    newId: () => Math.random().toString(36).slice(2, 10),
    linkWaitMs: 3 * MIN,
    pause: ms => Bun.sleep(ms),
  })
  const until = async (phases: NodeSetupView['phase'][], ms: number): Promise<NodeSetupView> => {
    const end = Date.now() + ms
    while (!phases.includes(setup.view().phase) && Date.now() < end) await Bun.sleep(500)
    return setup.view()
  }
  try {
    const server = { host: '127.0.0.1', sshPort: s.sshPort, user: 'admin', password: PASSWORD, sudoPassword: PASSWORD }
    // the admin's key is not the board's: the login goes by password, through the askpass
    expect(await setup.look({ ...server, id: 'server-1' })).toEqual({ status: 200, body: { ok: true } })
    const looked = setup.view()
    expect(looked.refusals).toEqual([])
    expect(looked.hostKey?.pinnedNow).toBe(true)
    expect(await setup.apply({ ...server, plan: looked.plan?.id, packages: true })).toEqual({
      status: 200,
      body: { ok: true },
    })
    const v = await until(['done', 'failed'], 40 * MIN)
    expect([v.phase, v.error, v.run?.result]).toEqual(['done', null, 'applied'])
    expect(v.master.filter(m => m.state === 'fail')).toEqual([])
    // the hello through the link user, on the door's port
    const key = store.keyPath('server-1')
    const hello = JSON.parse((await through(s, key, 12430)) ?? 'null') as { node?: { api: number; id: string } } | null
    expect(hello?.node).toMatchObject({ api: 1, id: 'server-1' })
    // nothing else: another port, a shell, a TTY
    expect(await through(s, key, 22)).toBeNull()
    expect(asLink(s, key, ['id']).code).not.toBe(0)
    expect(asLink(s, key, ['-t', 'sh']).code).not.toBe(0)
    // the admin's password in no file there, nor here
    const found = await s.sh(
      'grep -rlF -- "$P" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=run 2>/dev/null | head -n 5; true',
      { env: { P: PASSWORD }, timeoutMs: 10 * MIN },
    )
    expect(noCr(found.stdout).trim()).toBe('')
    const files = (d: string): string[] =>
      existsSync(d)
        ? readdirSync(d, { recursive: true, withFileTypes: true })
            .filter(e => e.isFile())
            .map(e => join(e.parentPath, e.name))
        : []
    expect(logs.join('\n')).not.toContain(PASSWORD)
    expect(JSON.stringify(setup.view())).not.toContain(PASSWORD)
    for (const f of [...files(configDir()), ...files(stateDir())])
      expect([f, readFileSync(f, 'latin1').includes(PASSWORD)]).toEqual([f, false])

    // Undo: the server as it was, the link user's key gone
    await made.links?.close()
    expect(await setup.undoLook({ ...server })).toEqual({ status: 200, body: { ok: true } })
    expect(await setup.undo({ ...server, plan: setup.view().plan?.id })).toEqual({ status: 200, body: { ok: true } })
    expect((await until(['undone', 'failed'], 10 * MIN)).phase).toBe('undone')
    expect(noCr((await s.sh(`getent passwd ${LINK_USER} || echo gone`)).stdout).trim()).toBe('gone')
    expect(asLink(s, key, ['true']).code).not.toBe(0)
  } finally {
    await made.links?.close()
    await s.stop()
  }
}

describe.skipIf(!DOCKER)('Add a server on Debian and Ubuntu test servers', () => {
  beforeAll(async () => {
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    dir = mkdtempSync(join(tmpdir(), 'board-node-it-'))
    adminKey = join(dir, 'admin_ed25519')
    await keygen(adminKey)
    await startMirror()
    await Promise.all(LANES.map(d => buildImage(d, false)))
    for (const l of await Promise.all(LANES.map(d => startLane(d)))) lanes.set(l.distro, l)
  }, 60 * MIN)

  afterAll(async () => {
    for (const l of lanes.values()) closeLane(l)
    await removeRun()
  }, 20 * MIN)

  for (const d of LANES)
    test(
      `${d}: Look, Apply, the hello through the link user and nothing else, the password nowhere, Undo`,
      async () => {
        const l = lanes.get(d)
        if (!l) throw new Error(`no lane for ${d}`)
        await scenario(l)
      },
      60 * MIN,
    )
})
