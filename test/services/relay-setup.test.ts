// "Relay on the server" (#511, services/nodes/relay-setup.ts): Look, Apply, Continue and Undo
// on the fake root via fake admin SSH (password + askpass + sudo) AND locally on the same server
// (local: true and adminHost: 127.0.0.1, epic #702).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editNodesAdding, loadConfig } from '../../src/adapters/config-file.ts'
import { dropRelayCredentials, nodesDir, relayKeyPath } from '../../src/adapters/node-store.ts'
import { configDir, stateDir } from '../../src/adapters/paths.ts'
import type { RemoteEnd, RemoteRun, spawnRemote } from '../../src/adapters/ssh.ts'
import type { RelaySetupView } from '../../src/core/relay-setup.ts'
import { RELAY_FENCE, RELAY_MASTER_KEYS, RELAY_MASTER_USER } from '../../src/core/relay-texts.ts'
import { createRelaySetup } from '../../src/services/nodes/relay-setup.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakeRoot, fakeRoot, sh } from '../support/fake-root.ts'
import { prepScript, relayKind, unpackNodeRun } from '../support/fake-root-prep.ts'
import { ENROL_KEY, MASTER_KEY } from '../support/relay-root.ts'

const SENTINEL = `R3lay%$'"\`Ж`

interface Admin {
  loginPassword?: string
  sudo?: 'nopasswd' | 'password'
  sudoPassword?: string
  env?: Record<string, string>
}

interface Call {
  args: string[]
  login: string | null
  kind: string | null
}

const REMOTE =
  /^(env LC_ALL=C sudo -n -- |env LC_ALL=C sudo -S -p '' -- )?sh -c 'eval "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/

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
    const command = args.at(-1) ?? ''
    const m = REMOTE.exec(command)
    const script = m ? Buffer.from(m[2] ?? '', 'base64').toString('utf8') : ''
    const kind = relayKind(script) ?? (script.includes('# agent-board: probe') ? 'probe' : null)
    calls.push({ args, login: login?.password ?? null, kind })
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
        say('err', 'admin@relay.example.com: Permission denied (publickey,password).')
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
      const wanted = mode === 'nopasswd' ? 'env LC_ALL=C sudo -n -- ' : "env LC_ALL=C sudo -S -p '' -- "
      if ((m[1] ?? '') !== wanted) {
        say('err', `fake: ${kind} run behind the wrong sudo`)
        return end(2)
      }
      if (wanted.includes('sudo -S') && text !== `${a.sudoPassword}\n`) {
        say('err', 'Sorry, try again.', 'sudo: 1 incorrect password attempt')
        return end(1)
      }
      const body = kind === 'apply' || kind === 'undo' ? unpackNodeRun(script) : script
      if (body === null) {
        say('err', 'fake: relay run not packed')
        return end(2)
      }
      const res = await root.runAsync(body, a.env)
      for (const l of res.lines) if (l) say('out', l)
      if (res.err) for (const l of res.err.split(/\r?\n/)) if (l) say('err', l)
      return end(res.code)
    })()
    return {
      onLine: fn => void listeners.push(fn),
      done,
      kill: () => {},
    }
  }
  return { spawn, calls, isPinned: () => pinned }
}

function fakeLocal(root: FakeRoot, mode: 'root' | 'nopasswd' | 'password' = 'root', sudoPassword?: string) {
  const calls: { command: string; kind: string | null }[] = []
  const spawnLocal = (command: string, stdin: string | null, _ms: number): RemoteRun => {
    const listeners: ((line: string, from: 'out' | 'err') => void)[] = []
    let settle: (e: RemoteEnd) => void = () => {}
    const done = new Promise<RemoteEnd>(r => {
      settle = r
    })
    const m = REMOTE.exec(command)
    const script = m ? Buffer.from(m[2] ?? '', 'base64').toString('utf8') : ''
    const kind = relayKind(script) ?? (script.includes('# agent-board: probe') ? 'probe' : null)
    calls.push({ command, kind })
    const say = (from: 'out' | 'err', ...lines: string[]): void => {
      for (const line of lines) for (const fn of listeners) fn(line.replaceAll(root.R, ''), from)
    }
    void (async () => {
      await Promise.resolve()
      if (!m) {
        say('err', 'unexpected local command')
        return settle({ code: 2, error: null })
      }
      if (kind === 'probe') {
        say('out', `@@uid ${mode === 'root' ? 0 : 1000}`)
        say('out', mode === 'password' ? '@@sudo sudo: a password is required' : '@@sudo ok')
        say('out', '@@flavor Sudo version 1.9.16p2')
        return settle({ code: 0, error: null })
      }
      if (mode === 'password' && stdin !== `${sudoPassword}\n`) {
        say('err', 'Sorry, try again.')
        return settle({ code: 1, error: null })
      }
      const body = kind === 'apply' || kind === 'undo' ? unpackNodeRun(script) : script
      if (body === null) return settle({ code: 2, error: null })
      const res = await root.runAsync(body)
      for (const l of res.lines) if (l) say('out', l)
      if (res.err) for (const l of res.err.split(/\r?\n/)) if (l) say('err', l)
      return settle({ code: res.code, error: null })
    })()
    return {
      onLine: fn => void listeners.push(fn),
      done,
      kill: () => {},
    }
  }
  return { spawnLocal, calls }
}

const until = async (view: () => RelaySetupView, phases: RelaySetupView['phase'][], ms = 20_000) => {
  const end = Date.now() + ms
  while (!phases.includes(view().phase) && Date.now() < end) await Bun.sleep(25)
  return view()
}

describe.skipIf(!sh)('relay-setup service', () => {
  test('remote admin SSH Look, Apply and Undo with password keeps password out of files, logs and view', async () => {
    isolatedHome()
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configFile(), JSON.stringify({ language: 'en' }, null, 2))
    const cfg = loadConfig()
    const root = fakeRoot('include', { relay: true })
    const admin = fakeAdmin(root, { loginPassword: SENTINEL, sudo: 'password', sudoPassword: SENTINEL })
    const logs: string[] = []
    let followed = 0
    const setup = createRelaySetup({
      cfg,
      ssh: () => '/usr/bin/ssh',
      sshVersion: async () => 'OpenSSH_9.6p1',
      knownHosts: () => join(stateDir(), 'known_hosts'),
      hostKeyPinned: async () => admin.isPinned(),
      hostKeyFingerprint: async () => 'SHA256:FAKEfingerprint',
      spawn: admin.spawn,
      relayKey: async (kind, make) => {
        const p = relayKeyPath(kind)
        if (!existsSync(p) && make) {
          mkdirSync(join(nodesDir(), 'relay'), { recursive: true })
          writeFileSync(p, `PRIVATE-${kind}`)
          writeFileSync(`${p}.pub`, kind === 'master' ? MASTER_KEY : ENROL_KEY)
        }
        return existsSync(`${p}.pub`) ? { ok: true, publicKey: readFileSync(`${p}.pub`, 'utf8') } : null
      },
      dropRelayKeys: () => dropRelayCredentials(),
      editNodes: editNodesAdding,
      follow: () => void followed++,
      hostName: () => 'atlas',
      onChange: () => {},
      log: l => void logs.push(l),
      now: () => Date.now(),
      newId: () => 'r1',
    })

    const req = { host: 'relay.example.com', sshPort: 2222, user: 'admin', password: SENTINEL, sudoPassword: SENTINEL }
    expect((await setup.look(req)).status).toBe(200)
    const looked = setup.view()
    expect(looked.phase).toBe('plan')
    expect(looked.refusals).toEqual([])
    expect(looked.hostKey).toEqual({ fingerprint: 'SHA256:FAKEfingerprint', pinnedNow: true })

    expect((await setup.apply({ ...req, plan: looked.plan?.id })).status).toBe(200)
    const done = await until(setup.view, ['done', 'failed'])
    expect([done.phase, done.error, done.run?.result]).toEqual(['done', null, 'applied'])
    expect(followed).toBe(1)
    const written = JSON.parse(readFileSync(configFile(), 'utf8')) as { nodes: Record<string, unknown> }
    expect(written.nodes.relay).toEqual({ host: 'relay.example.com', sshPort: 2222, user: RELAY_MASTER_USER })
    expect(existsSync(root.path(RELAY_FENCE))).toBe(true)
    expect(existsSync(root.path(RELAY_MASTER_KEYS))).toBe(true)

    // Password never lands anywhere on disk, in logs or in the view
    expect(logs.join('\n')).not.toContain(SENTINEL)
    expect(JSON.stringify(setup.view())).not.toContain(SENTINEL)
    const allFiles = [configDir(), stateDir()].flatMap(d =>
      existsSync(d)
        ? readdirSync(d, { recursive: true, withFileTypes: true })
            .filter(e => e.isFile())
            .map(e => join(e.parentPath, e.name))
        : [],
    )
    for (const f of allFiles) expect(readFileSync(f, 'utf8')).not.toContain(SENTINEL)

    // Undo removes relay on server, nodes.relay in config.json, and relay keys
    expect((await setup.undoLook(req)).status).toBe(200)
    expect((await setup.undo({ ...req, plan: setup.view().plan?.id })).status).toBe(200)
    const undone = await until(setup.view, ['undone', 'failed'])
    expect([undone.phase, undone.run?.result]).toEqual(['undone', 'undone'])
    const afterUndo = JSON.parse(readFileSync(configFile(), 'utf8')) as { nodes: Record<string, unknown> }
    expect(afterUndo.nodes).not.toHaveProperty('relay')
    expect(existsSync(relayKeyPath('master'))).toBe(false)
    expect(existsSync(relayKeyPath('enrol'))).toBe(false)
    expect(existsSync(root.path(RELAY_FENCE))).toBe(false)
  }, 60_000)

  test('same-server via adminHost dials 127.0.0.1 while saving public host in nodes.relay', async () => {
    isolatedHome()
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configFile(), JSON.stringify({ language: 'en' }, null, 2))
    const cfg = loadConfig()
    const root = fakeRoot('include', { relay: true })
    const admin = fakeAdmin(root, { sudo: 'nopasswd' })
    const setup = createRelaySetup({
      cfg,
      ssh: () => '/usr/bin/ssh',
      sshVersion: async () => 'OpenSSH_9.6p1',
      knownHosts: () => join(stateDir(), 'known_hosts'),
      hostKeyPinned: async () => admin.isPinned(),
      hostKeyFingerprint: async () => 'SHA256:FAKEfingerprint',
      spawn: admin.spawn,
      relayKey: async (kind, make) => {
        const p = relayKeyPath(kind)
        if (!existsSync(p) && make) {
          mkdirSync(join(nodesDir(), 'relay'), { recursive: true })
          writeFileSync(p, `PRIVATE-${kind}`)
          writeFileSync(`${p}.pub`, kind === 'master' ? MASTER_KEY : ENROL_KEY)
        }
        return existsSync(`${p}.pub`) ? { ok: true, publicKey: readFileSync(`${p}.pub`, 'utf8') } : null
      },
      dropRelayKeys: () => dropRelayCredentials(),
      editNodes: editNodesAdding,
      follow: () => {},
      hostName: () => 'atlas',
      onChange: () => {},
      log: () => {},
      now: () => Date.now(),
      newId: () => 'r2',
    })

    const req = { host: 'pub.example.com', adminHost: '127.0.0.1', sshPort: 22, user: 'admin' }
    expect((await setup.look(req)).status).toBe(200)
    expect((await setup.apply({ ...req, plan: setup.view().plan?.id })).status).toBe(200)
    expect((await until(setup.view, ['done', 'failed'])).phase).toBe('done')
    // SSH dialed 127.0.0.1, config.json recorded pub.example.com
    expect(admin.calls.every(c => c.args.includes('admin@127.0.0.1'))).toBe(true)
    const written = JSON.parse(readFileSync(configFile(), 'utf8')) as { nodes: Record<string, unknown> }
    expect(written.nodes.relay).toEqual({ host: 'pub.example.com', sshPort: 22, user: RELAY_MASTER_USER })
  }, 60_000)

  test('same-server local mode runs without SSH, preserves existing devices, and refuses on non-Linux', async () => {
    isolatedHome()
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(
      configFile(),
      JSON.stringify(
        {
          language: 'en',
          nodes: {
            id: 'atlas-main',
            order: ['server-1', 'local'],
            lanes: ['agent-board'],
            devices: {
              'server-1': {
                link: { kind: 'ssh', host: '203.0.113.10', sshPort: 22, user: 'agent-board-link', port: 12430 },
              },
            },
          },
        },
        null,
        2,
      ),
    )
    const cfg = loadConfig()
    const root = fakeRoot('include', { relay: true })
    const local = fakeLocal(root, 'root')
    let sshCalls = 0
    let plat = 'darwin'
    const setup = createRelaySetup({
      cfg,
      ssh: () => {
        sshCalls++
        return '/usr/bin/ssh'
      },
      sshVersion: async () => 'OpenSSH_9.6p1',
      knownHosts: () => join(stateDir(), 'known_hosts'),
      hostKeyPinned: async () => false,
      hostKeyFingerprint: async () => null,
      spawn: (() => {
        sshCalls++
        throw new Error('ssh must not run in local mode')
      }) as unknown as typeof spawnRemote,
      spawnLocal: local.spawnLocal,
      platform: () => plat,
      relayKey: async (kind, make) => {
        const p = relayKeyPath(kind)
        if (!existsSync(p) && make) {
          mkdirSync(join(nodesDir(), 'relay'), { recursive: true })
          writeFileSync(p, `PRIVATE-${kind}`)
          writeFileSync(`${p}.pub`, kind === 'master' ? MASTER_KEY : ENROL_KEY)
        }
        return existsSync(`${p}.pub`) ? { ok: true, publicKey: readFileSync(`${p}.pub`, 'utf8') } : null
      },
      dropRelayKeys: () => dropRelayCredentials(),
      editNodes: editNodesAdding,
      follow: () => {},
      hostName: () => 'atlas-main',
      onChange: () => {},
      log: () => {},
      now: () => Date.now(),
      newId: () => 'r3',
    })

    // Refuses non-Linux for local same-server mode
    const macRes = await setup.look({ local: true, host: 'master.example.com' })
    expect(macRes.status).toBe(409)
    expect(sshCalls).toBe(0)

    // Switch to Linux with custom sshPort: works with zero SSH calls
    plat = 'linux'
    expect((await setup.look({ local: true, host: 'master.example.com', sshPort: 2222 })).status).toBe(200)
    const looked = setup.view()
    expect(looked.phase).toBe('plan')
    expect(looked.server?.local).toBe(true)
    expect((await setup.apply({ plan: looked.plan?.id })).status).toBe(200)
    expect((await until(setup.view, ['done', 'failed'])).phase).toBe('done')
    expect(sshCalls).toBe(0)
    expect(local.calls.map(c => c.kind)).toEqual(['probe', 'look', 'apply'])

    const written = JSON.parse(readFileSync(configFile(), 'utf8')) as { nodes: Record<string, unknown> }
    expect(written.nodes.relay).toEqual({ host: 'master.example.com', sshPort: 2222, user: RELAY_MASTER_USER })
    expect(written.nodes.order).toEqual(['server-1', 'local'])
    expect(written.nodes.lanes).toEqual(['agent-board'])
    expect((written.nodes.devices as Record<string, unknown>)['server-1']).toBeDefined()

    // Undo locally (host and sshPort optional in local undoLook, still removes config.json + keys)
    expect((await setup.undoLook({ local: true })).status).toBe(200)
    expect((await setup.undo({ plan: setup.view().plan?.id })).status).toBe(200)
    expect((await until(setup.view, ['undone', 'failed'])).phase).toBe('undone')
    expect(sshCalls).toBe(0)
    const afterUndo = JSON.parse(readFileSync(configFile(), 'utf8')) as { nodes: Record<string, unknown> }
    expect(afterUndo.nodes).not.toHaveProperty('relay')
    expect(existsSync(relayKeyPath('master'))).toBe(false)
    expect(existsSync(relayKeyPath('enrol'))).toBe(false)
    expect((afterUndo.nodes.devices as Record<string, unknown>)['server-1']).toBeDefined()
  }, 60_000)

  test('undo clears busy flag when hostKeyPinned throws during login', async () => {
    isolatedHome()
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configFile(), JSON.stringify({ language: 'en' }, null, 2))
    const cfg = loadConfig()
    const root = fakeRoot('include', { relay: true })
    const admin = fakeAdmin(root, { sudo: 'nopasswd' })
    let failPin = false
    const setup = createRelaySetup({
      cfg,
      ssh: () => '/usr/bin/ssh',
      sshVersion: async () => 'OpenSSH_9.6p1',
      knownHosts: () => join(stateDir(), 'known_hosts'),
      hostKeyPinned: async () => {
        if (failPin) throw new Error('pin read failed')
        return admin.isPinned()
      },
      hostKeyFingerprint: async () => 'SHA256:FAKEfingerprint',
      spawn: admin.spawn,
      relayKey: async (kind, make) => {
        const p = relayKeyPath(kind)
        if (!existsSync(p) && make) {
          mkdirSync(join(nodesDir(), 'relay'), { recursive: true })
          writeFileSync(p, `PRIVATE-${kind}`)
          writeFileSync(`${p}.pub`, kind === 'master' ? MASTER_KEY : ENROL_KEY)
        }
        return existsSync(`${p}.pub`) ? { ok: true, publicKey: readFileSync(`${p}.pub`, 'utf8') } : null
      },
      dropRelayKeys: () => dropRelayCredentials(),
      editNodes: editNodesAdding,
      follow: () => {},
      hostName: () => 'atlas',
      onChange: () => {},
      log: () => {},
      now: () => Date.now(),
      newId: () => 'r4',
    })
    const req = { host: 'relay.example.com', sshPort: 22, user: 'admin' }
    expect((await setup.look(req)).status).toBe(200)
    expect((await setup.apply({ ...req, plan: setup.view().plan?.id })).status).toBe(200)
    expect((await until(setup.view, ['done', 'failed'])).phase).toBe('done')

    expect((await setup.undoLook(req)).status).toBe(200)
    failPin = true
    const errRes = await setup.undo({ ...req, plan: setup.view().plan?.id })
    expect(errRes.status).toBe(200)
    expect(setup.view().phase).toBe('failed')
    failPin = false
    // busy must not remain stuck; another undoLook succeeds
    expect((await setup.undoLook(req)).status).toBe(200)
  }, 60_000)

  test('prepScript helper works with fake ssh paths', () => {
    expect(prepScript('/r', 'PATH=/usr/local/sbin:/bin; export PATH\n/var/lib/agent-board-relay/a.sock')).toContain(
      '/r/var/lib/agent-board-relay/a.sock',
    )
  })
})
