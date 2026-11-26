// A node's status (services/node/status.ts, docs/design/nodes 6.3): facts from the sources it is
// given, the machine's load from the fixtures of each system, and nothing decided.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findCommand } from '../../src/adapters/setup-facts.ts'
import { type NodeConfig, nodeStatusOf } from '../../src/core/nodes.ts'
import type { Profile } from '../../src/core/profiles.ts'
import { bytesToMb, loadOf, meminfoAvailableMb, vmStatAvailableMb } from '../../src/core/sysload.ts'
import type { Item, LaunchView } from '../../src/core/types.ts'
import { agentsOf, createNodeStatus, expandHome, loggedIn, type StatusSources } from '../../src/services/node/status.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dir, '..', 'fixtures', 'sysload', name), 'utf8')

const NODE: NodeConfig = {
  id: 'server-1',
  port: 12430,
  workRoot: '~/work',
  listen: 'loopback',
  tls: false,
  relay: null,
}
const item = (key: string, over: Partial<Item> = {}): Item => ({ key, status: 'idle', ...over }) as Item
const launch = (id: string, state: LaunchView['state']): LaunchView => ({ id, state }) as LaunchView
const profile = (id: string, dir: string): Profile => ({ id, title: id, dir, color: 'gray', hidden: false })

function sources(over: Partial<StatusSources> = {}): StatusSources {
  return {
    node: () => NODE,
    items: () => [
      item('a', { status: 'working' }),
      item('b', { status: 'idle' }),
      item('c', { status: 'idle', sleeping: true }),
      item('d', { status: 'sleeping', sleeping: true }),
    ],
    launches: () => [launch('1', 'starting'), launch('2', 'trust'), launch('3', 'done'), launch('4', 'failed')],
    profiles: () => [profile('default', '/home/owner/.claude'), profile('work', '/home/owner/.claude-work')],
    version: '0.1.0',
    commit: async () => 'ee32fc89',
    load: async () => ({
      cpus: 8,
      memTotalMb: 32013,
      memAvailableMb: meminfoAvailableMb(fixture('meminfo-linux.txt')),
      load: loadOf('linux', [0.42, 0.61, 0.58]),
    }),
    freeMb: () => 148000,
    exists: file => file.replaceAll('\\', '/') === '/home/owner/.claude/.credentials.json',
    launch: () => undefined,
    piFound: () => false,
    agyFound: () => false,
    codexFound: () => false,
    platform: 'linux',
    arch: 'x64',
    home: '/home/owner',
    now: () => 1795210000000,
    ...over,
  }
}

describe('the status', () => {
  test("the answer of 6.3, field for field, from a Linux node's facts", async () => {
    let asked = ''
    const status = createNodeStatus(
      sources({
        freeMb: dir => {
          asked = dir
          return 148000
        },
      }),
    )
    expect(await status.answer()).toEqual({
      api: 1,
      id: 'server-1',
      version: '0.1.0',
      commit: 'ee32fc89',
      platform: 'linux',
      arch: 'x64',
      cpus: 8,
      memTotalMb: 32013,
      memAvailableMb: 21480,
      load: [0.42, 0.61, 0.58],
      sessions: { awake: 2, working: 1, asleep: 2 },
      launches: 2,
      workRootFreeMb: 148000,
      profiles: [
        { id: 'default', loggedIn: true, bundle: null },
        { id: 'work', loggedIn: false, bundle: null },
      ],
      agents: ['claude'],
      at: 1795210000000,
    })
    expect(asked.replaceAll('\\', '/')).toMatch(/\/home\/owner\/work$/)
  })

  test('macOS: memory from vm_stat; a profile without the file may still be logged in (the Keychain)', async () => {
    const status = createNodeStatus(
      sources({
        platform: 'darwin',
        arch: 'arm64',
        load: async () => ({
          cpus: 10,
          memTotalMb: 16384,
          memAvailableMb: vmStatAvailableMb(fixture('vm_stat-arm64.txt')),
          load: loadOf('darwin', [1.2, 1.1, 1]),
        }),
      }),
    )
    const s = await status.answer()
    expect(s?.memAvailableMb).toBe(6250)
    expect(s?.load).toEqual([1.2, 1.1, 1])
    expect(s?.profiles).toEqual([
      { id: 'default', loggedIn: true, bundle: null },
      { id: 'work', loggedIn: null, bundle: null },
    ])
  })

  test('Windows: the free physical memory the system gives, and no load', async () => {
    const win = JSON.parse(fixture('windows.json')) as { freemem: number; totalmem: number; loadavg: number[] }
    const status = createNodeStatus(
      sources({
        platform: 'win32',
        load: async () => ({
          cpus: 16,
          memTotalMb: bytesToMb(win.totalmem) ?? 0,
          memAvailableMb: bytesToMb(win.freemem),
          load: loadOf('win32', win.loadavg),
        }),
      }),
    )
    const s = await status.answer()
    expect([s?.memTotalMb, s?.memAvailableMb, s?.load]).toEqual([32651, 8704, null])
  })

  test('the commit is read once, however often the status is asked', async () => {
    let reads = 0
    const status = createNodeStatus(
      sources({
        commit: async () => {
          reads += 1
          return 'abc12345'
        },
      }),
    )
    await status.answer()
    await status.answer()
    expect((await status.answer())?.commit).toBe('abc12345')
    expect(reads).toBe(1)
  })

  test('no node in config.json (it went meanwhile): no answer, nothing read', async () => {
    let read = false
    const status = createNodeStatus(
      sources({
        node: () => null,
        load: async () => {
          read = true
          return { cpus: 1, memTotalMb: 1, memAvailableMb: 1, load: null }
        },
      }),
    )
    expect(await status.answer()).toBeNull()
    expect(read).toBe(false)
  })
})

describe('its helpers', () => {
  test("the agents: what the node's new-session window offers, by the board's own rule", () => {
    const none = (): boolean => false
    expect(agentsOf(undefined, none, none)).toEqual(['claude'])
    expect(agentsOf(undefined, () => true, none)).toEqual(['claude', 'pi'])
    expect(agentsOf(undefined, none, () => true)).toEqual(['claude', 'agy'])
    expect(
      agentsOf(
        undefined,
        () => true,
        () => true,
      ),
    ).toEqual(['claude', 'pi', 'agy'])
    expect(agentsOf({ pi: 'pi --model x' } as never, none, none)).toEqual(['claude', 'pi'])
    expect(agentsOf({ agy: ['agy', '--dangerously-skip-permissions'] } as never, none, none)).toEqual(['claude', 'agy'])
    // The config's own launcher starts every session: Claude Code.
    expect(
      agentsOf(
        { command: 'my-launcher {cwd}' } as never,
        () => true,
        () => true,
      ),
    ).toEqual(['claude'])
  })

  test('a node reports Codex when codex is on its PATH, so its master may place a Codex start there (#902)', async () => {
    const none = (): boolean => false
    expect(agentsOf(undefined, none, none, () => true)).toEqual(['claude', 'codex'])
    expect(agentsOf(undefined, none, none, none)).toEqual(['claude'])
    // The config's own launcher starts every session: Claude Code, Codex on PATH or not.
    expect(agentsOf({ command: 'my-launcher {cwd}' } as never, none, none, () => true)).toEqual(['claude'])
    expect((await createNodeStatus(sources({ codexFound: () => true })).answer())?.agents).toEqual(['claude', 'codex'])
    expect((await createNodeStatus(sources()).answer())?.agents).toEqual(['claude'])
  })

  test('createNodeStatus reports agy on PATH (including Windows .exe/.cmd/.ps1) and launch.agy (#898)', async () => {
    const withAgy = await createNodeStatus(sources({ agyFound: () => true })).answer()
    expect(withAgy?.agents).toEqual(['claude', 'agy'])
    const withConfig = await createNodeStatus(
      sources({ launch: () => ({ agy: ['agy', '--dangerously-skip-permissions'] }) }),
    ).answer()
    expect(withConfig?.agents).toEqual(['claude', 'agy'])
    for (const ext of ['.exe', '.cmd', '.ps1']) {
      const hit = findCommand('agy', {
        platform: 'win32',
        env: { PATH: 'C:\\Tools\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        exists: f => f === `C:\\Tools\\bin\\agy${ext}`,
        read: () => null,
        size: () => 0,
      })
      expect(Boolean(hit.ps ?? hit.sh)).toBe(true)
    }
  })

  test('the work root under the home folder', () => {
    expect(expandHome('~', '/home/owner')).toBe('/home/owner')
    expect(expandHome('~/work', '/home/owner').replaceAll('\\', '/')).toMatch(/\/home\/owner\/work$/)
  })

  test('logged in: the credentials file; without it, unknown on macOS only', () => {
    const none = (): boolean => false
    expect(loggedIn('/p', 'linux', () => true)).toBe(true)
    expect(loggedIn('/p', 'linux', none)).toBe(false)
    expect(loggedIn('/p', 'win32', none)).toBe(false)
    expect(loggedIn('/p', 'darwin', none)).toBeNull()
    expect(loggedIn('/p', 'darwin', () => true)).toBe(true)
  })
})

describe('the programs a hook may run (#603)', () => {
  test('which of them the node has, asked once however often the status is', async () => {
    let asked = 0
    const status = createNodeStatus(
      sources({
        programs: () => {
          asked++
          return ['python3', 'bash']
        },
      }),
    )
    expect((await status.answer())?.programs).toEqual(['python3', 'bash'])
    expect((await status.answer())?.programs).toEqual(['python3', 'bash'])
    expect(asked).toBe(1)
  })

  test('without the source, as the master asks its own: no programs in the status', async () => {
    const s = await createNodeStatus(sources()).answer()
    expect(s && 'programs' in s).toBe(false)
  })

  test("the master keeps a node's list of names, and reads a node of an older board as having said nothing", async () => {
    const s = await createNodeStatus(sources({ programs: () => ['python3'] })).answer()
    expect(nodeStatusOf(JSON.parse(JSON.stringify(s)))?.programs).toEqual(['python3'])
    const older = JSON.parse(JSON.stringify({ ...s, programs: undefined }))
    expect(nodeStatusOf(older) && 'programs' in (nodeStatusOf(older) ?? {})).toBe(false)
    expect('programs' in (nodeStatusOf({ ...s, programs: [1, 'x'] }) ?? {})).toBe(false)
  })
})

describe('Antigravity (Gemini) usage on a node (#647)', () => {
  test('omits agyLimits when agy is not installed, and propagates null or readings when installed', async () => {
    const none = await createNodeStatus(sources({ agyLimits: () => undefined })).answer()
    expect(none && 'agyLimits' in none).toBe(false)

    const unknown = await createNodeStatus(sources({ agyLimits: () => null })).answer()
    expect(unknown?.agyLimits).toBeNull()
    expect(nodeStatusOf(JSON.parse(JSON.stringify(unknown)))?.agyLimits).toBeNull()

    const now = Date.now()
    const reading = {
      source: 'statusline' as const,
      observedAt: now - 5000,
      stale: false,
      planTier: 'Pro',
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 48, resetsAt: now + 3_600_000, expired: false },
      ],
    }
    const withAgy = await createNodeStatus(sources({ agyLimits: () => reading })).answer()
    expect(withAgy?.agyLimits).toEqual(reading)
    expect(nodeStatusOf(JSON.parse(JSON.stringify(withAgy)))?.agyLimits).toEqual(reading)
  })
})

describe('how the node takes an update (#793)', () => {
  test('said only when given: git or archive; the master keeps those two and drops anything else', async () => {
    const without = await createNodeStatus(sources()).answer()
    expect(without && 'updates' in without).toBe(false)
    for (const how of ['git', 'archive'] as const) {
      const s = await createNodeStatus(sources({ updates: () => how })).answer()
      expect(s?.updates).toBe(how)
      expect(nodeStatusOf(s)?.updates).toBe(how)
    }
    const odd = nodeStatusOf({ ...(without as object), updates: 'tarball' })
    expect(odd && 'updates' in odd).toBe(false)
    expect(nodeStatusOf(without)).toEqual(without as never)
  })
})

describe('own profiles (#802)', () => {
  test('a node with node.ownProfiles says so in its status; one without says nothing of it', async () => {
    const own = await createNodeStatus(sources({ node: () => ({ ...NODE, ownProfiles: true }) })).answer()
    expect(own?.ownProfiles).toBe(true)
    const plain = await createNodeStatus(sources()).answer()
    expect(plain && 'ownProfiles' in plain).toBe(false)
  })
})
