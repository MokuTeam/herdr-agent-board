import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardDevice } from '../../src/core/payload.ts'
import type { LaunchView } from '../../src/core/types.ts'
import { browserPlatform, deviceStart, LAUNCH_DEVICE, pathMatchesPlatform } from '../../web/src/models/launch-device.ts'
import { item } from './support/board.tsx'
import { type LaunchScene, type LaunchSide, OPTIONS, reactLaunchSide } from './support/launch-sides.tsx'

const dev = (
  id: string,
  title: string,
  {
    online = true,
    platform = 'linux',
    kind = id === 'local' ? null : 'ssh',
  }: { online?: boolean; platform?: string; kind?: BoardDevice['kind'] } = {},
): BoardDevice => ({
  id,
  title,
  kind,
  link: kind ? { state: online ? 'online' : 'offline', since: 1, heardAt: 1 } : null,
  status: null,
  sameCommit: true,
  payloadAt: 1,
  paused: false,
  drain: false,
  maxSessions: 4,
  minFreeMemMb: 1024,
  maxLoad: 0.9,
  platform,
})

const MASTER = dev('local', 'server-2', { platform: 'linux' })
const LAPTOP = dev('win-laptop', 'laptop', { platform: 'win32', online: true })
const MAC_OFFLINE = dev('mac-mini', 'mac', { platform: 'darwin', online: false })

const cat = (id: string, title: string, paths: string[] = []): BoardCategory => ({
  id,
  title,
  color: '#007AFF',
  colorName: 'blue',
  paths,
  configured: true,
  fallback: false,
})

const CATEGORIES = [cat('acme', 'Acme', ['C:\\Work\\BB', '/srv/web']), cat('other', 'Other')]
const MASTER_ITEM = item({ key: 's1', name: 'srv', cwd: '/srv/web', category: 'acme', workspace: 'Ops', activity: 40 })
const WIN_ITEM = item({
  key: '@win-laptop:w1',
  device: 'win-laptop',
  name: 'bb',
  cwd: 'C:\\Work\\BB',
  category: 'acme',
  workspace: 'WinWS',
  activity: 50,
})

function multiScene(over: Partial<LaunchScene> = {}): LaunchScene {
  return {
    t: translator('en'),
    categories: CATEGORIES,
    items: [MASTER_ITEM, WIN_ITEM],
    launches: [],
    filter: 'all',
    canMutate: true,
    devices: [MASTER, LAPTOP, MAC_OFFLINE],
    browserOs: () => 'linux',
    ...over,
  }
}

async function idle(side: LaunchSide): Promise<void> {
  for (let i = 0; i < 6; i++) await side.world.flush()
}

const WIN_MACHINE: Record<string, { entries: string[]; git?: { root: string; branch: string } }> = {
  'C:\\': { entries: ['Work'] },
  'C:\\Work': { entries: ['BB', 'Other'] },
  'C:\\Work\\BB': { entries: ['src'], git: { root: 'C:\\Work\\BB', branch: 'main' } },
  'C:\\Work\\Other': { entries: [] },
}

function winListing(raw: string, git: boolean): Record<string, unknown> {
  if (!raw.trim()) return { path: '', exists: true, dir: true, roots: [{ name: 'C:', path: 'C:\\' }], entries: [] }
  const clean = raw.trim().replace(/\//g, '\\').replace(/\\+$/, '')
  const key = /^[A-Za-z]:$/.test(clean) ? `${clean}\\` : clean
  const hit = WIN_MACHINE[key]
  if (!hit) return { path: key, exists: false }
  return {
    path: key,
    exists: true,
    dir: true,
    entries: hit.entries,
    truncated: false,
    parent: '',
    sep: '\\',
    error: null,
    ...(git ? { git: hit.git ?? null } : {}),
  }
}

const WIN_OPTIONS = {
  launcher: { kind: 'herdr', agent: 'claude' },
  agents: [
    { id: 'claude', title: 'Claude Code' },
    { id: 'codex', title: 'Codex CLI' },
  ],
  codexModels: { 'gpt-5': ['medium', 'high'] },
  agent: 'claude',
  workspaces: [
    { id: 'w1', label: 'Board' },
    { id: 'ww1', label: 'WinWS' },
  ],
  focused: 'ww1',
  board: 'Board',
  recent: ['C:\\Work\\BB'],
  linkedWorkspaces: false,
  takesModel: true,
  error: '',
}

const MASTER_OPTIONS = {
  ...OPTIONS,
  agents: [{ id: 'claude', title: 'Claude Code' }],
  agent: 'claude',
  recent: ['/srv/web'],
  takesModel: false,
}

describe('launch-device model (#948)', () => {
  test('browserPlatform and pathMatchesPlatform map desktop OSes cleanly', () => {
    expect(browserPlatform({ userAgentData: { platform: 'Windows' } })).toBe('win32')
    expect(browserPlatform({ platform: 'MacIntel' })).toBe('darwin')
    expect(browserPlatform({ platform: 'Linux x86_64' })).toBe('linux')
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBeNull()
    expect(pathMatchesPlatform('C:\\Work\\BB', 'win32')).toBe(true)
    expect(pathMatchesPlatform('/srv/web', 'win32')).toBe(false)
    expect(pathMatchesPlatform('/srv/web', 'linux')).toBe(true)
    expect(pathMatchesPlatform('C:\\Work\\BB', 'linux')).toBe(false)
    expect(pathMatchesPlatform('~/proj', 'win32')).toBe(true)
  })

  test('deviceStart follows exact priority order and returns null on single-machine boards', () => {
    const devices = [MASTER, LAPTOP, MAC_OFFLINE]
    expect(deviceStart({}, { devices: undefined })).toBeNull()
    expect(deviceStart({}, { devices: [MASTER] })).toBeNull()

    // 1. Context card / retry wins over filter, storage, relayed, browserOs.
    const retry: LaunchView = {
      id: 'L1',
      name: 'r',
      cwd: 'C:\\Work\\BB',
      category: 'acme',
      workspace: 'WinWS',
      workspaceId: 'ww1',
      state: 'failed',
      step: 'prepare',
      error: 'x',
      kind: '',
      pane: null,
      key: null,
      startedAt: 1,
      doneAt: null,
      message: '',
      worktree: null,
      newWorkspace: false,
      device: 'win-laptop',
    }
    expect(deviceStart({ retry }, { devices, filterDevice: 'local', remembered: 'local', browserOs: 'linux' })).toBe(
      'win-laptop',
    )
    expect(
      deviceStart({ item: WIN_ITEM }, { devices, filterDevice: 'local', remembered: 'local', browserOs: 'linux' }),
    ).toBe('win-laptop')

    // 2. Active board device filter
    expect(deviceStart({}, { devices, filterDevice: 'win-laptop', remembered: 'local', browserOs: 'linux' })).toBe(
      'win-laptop',
    )

    // 3. Remembered browser choice (skipped if offline)
    expect(deviceStart({}, { devices, filterDevice: 'all', remembered: 'win-laptop', browserOs: 'linux' })).toBe(
      'win-laptop',
    )
    expect(deviceStart({}, { devices, filterDevice: 'all', remembered: 'mac-mini', browserOs: 'linux' })).toBe('local')

    // 4. Node self page (`relayedDevices`) prefers local over browser OS match
    expect(deviceStart({}, { devices, relayedDevices: { master: 'server-2' }, browserOs: 'win32' })).toBe('local')

    // 5. Browser OS match when browser OS differs from master OS and online remote matches
    expect(deviceStart({}, { devices, browserOs: 'win32' })).toBe('win-laptop')
    // Offline matching OS node is skipped -> falls back to local
    expect(deviceStart({}, { devices, browserOs: 'darwin' })).toBe('local')

    // 6. Fallback to local
    expect(deviceStart({}, { devices, browserOs: 'linux' })).toBe('local')
  })
})

describe('LaunchDialog multi-node device picker (#948)', () => {
  test('single-machine board renders no device row and sends unchanged requests without device/pin', async () => {
    const side = reactLaunchSide({
      ...multiScene(),
      devices: undefined,
    })
    try {
      await side.open({})
      await idle(side)
      await side.world.tick(30)
      await side.world.tick(160)
      await side.world.settle()
      expect(side.snapshot()).not.toContain('device-row')
      expect(side.log.some(l => l.includes('?device='))).toBe(false)
      expect(side.log.some(l => l.includes('"device"'))).toBe(false)
      await side.world.fire(side.el('.launch-go'), 'click')
      await idle(side)
      const launchCall = side.log.find(l => l.startsWith('POST /api/launch '))
      expect(launchCall).toBeDefined()
      expect(launchCall).not.toContain('"pin"')
      expect(side.world.storage.get(LAUNCH_DEVICE)).toBeUndefined()
    } finally {
      await side.dispose()
    }
  })

  test('adaptive Windows browser OS preselects online win32 node, browses node FS, and submits pin', async () => {
    const side = reactLaunchSide(multiScene({ browserOs: () => 'win32' }))
    side.server.optionsByDevice = { 'win-laptop': WIN_OPTIONS }
    side.server.options = MASTER_OPTIONS
    side.server.dirsByDevice = { 'win-laptop': winListing }
    try {
      await side.open({})
      await idle(side)
      await side.world.tick(30)
      await side.world.tick(160)
      await side.world.settle()

      // Device row rendered with win-laptop pressed and mac-mini disabled offline.
      expect(side.el('[data-device="win-laptop"]').getAttribute('aria-pressed')).toBe('true')
      expect(side.el('[data-device="mac-mini"]').hasAttribute('disabled')).toBe(true)
      // Clicking disabled offline chip is ignored.
      await side.world.fire(side.el('[data-device="mac-mini"]'), 'click')
      await idle(side)
      expect(side.el('[data-device="win-laptop"]').getAttribute('aria-pressed')).toBe('true')

      // Fetched options for win-laptop, checked C:\Work\BB with device:'win-laptop', offered Codex CLI from win-laptop.
      expect(side.log.some(l => l.startsWith('GET /api/launch/options?device=win-laptop'))).toBe(true)
      expect(side.el('.launch [name="cwd"]').value).toBe('C:\\Work\\BB')
      expect(side.log.some(l => l.includes('POST /api/fs/dirs') && l.includes('"device":"win-laptop"'))).toBe(true)
      expect(side.el('[data-agent="codex"]')).toBeDefined()

      // Submit sends pin: { device: 'win-laptop' } and saves choice in localStorage.
      await side.world.fire(side.el('.launch-go'), 'click')
      await idle(side)
      const launchCall = side.log.find(l => l.startsWith('POST /api/launch '))
      expect(launchCall).toContain('"pin":{"device":"win-laptop"}')
      expect(launchCall).toContain('"cwd":"C:\\\\Work\\\\BB"')
      expect(side.world.storage.get(LAUNCH_DEVICE)).toBe('win-laptop')
    } finally {
      await side.dispose()
    }
  })

  test('switching device guards against stale options responses and updates options, suggestions, and dirs', async () => {
    const side = reactLaunchSide(multiScene({ browserOs: () => 'linux' }))
    side.server.options = MASTER_OPTIONS
    side.server.optionsByDevice = { 'win-laptop': WIN_OPTIONS }
    side.server.dirsByDevice = { 'win-laptop': winListing }
    try {
      await side.open({})
      await idle(side)
      await side.world.tick(30)
      await side.world.tick(160)
      await side.world.settle()
      expect(side.el('[data-device="local"]').getAttribute('aria-pressed')).toBe('true')
      expect(side.el('.launch [name="cwd"]').value).toBe('/srv/web')

      // Hold win-laptop options, switch to win-laptop, then switch back to local before win-laptop resolves.
      side.server.hold('options:win-laptop')
      await side.world.fire(side.el('[data-device="win-laptop"]'), 'click')
      await idle(side)
      await side.world.fire(side.el('[data-device="local"]'), 'click')
      await idle(side)
      side.server.release('options:win-laptop')
      await idle(side)
      await side.world.tick(160)
      await side.world.settle()

      // Stale win-laptop response must NOT overwrite local's folder/workspaces/agent!
      expect(side.el('[data-device="local"]').getAttribute('aria-pressed')).toBe('true')
      expect(side.el('.launch [name="cwd"]').value).toBe('/srv/web')
      expect(side.world.document.documentElement.querySelector('.launch [data-agent="codex"]')).toBeNull()

      // Now switch cleanly to win-laptop and verify folder suggestion, dirs check, and agent/workspace refresh.
      await side.world.fire(side.el('[data-device="win-laptop"]'), 'click')
      await idle(side)
      await side.world.tick(160)
      await side.world.settle()
      expect(side.el('[data-device="win-laptop"]').getAttribute('aria-pressed')).toBe('true')
      expect(side.el('.launch [name="cwd"]').value).toBe('C:\\Work\\BB')
      expect(side.el('.launch [name="workspace"]').value).toBe('ww1')
      expect(side.el('.launch [data-agent="codex"]')).toBeDefined()
    } finally {
      await side.dispose()
    }
  })

  test('node self page requests ?device=local for own options and omits device in /api/fs/dirs', async () => {
    const side = reactLaunchSide(
      multiScene({
        relayedDevices: { master: 'server-2' },
        browserOs: () => 'win32',
        devices: [
          dev('local', 'win-laptop', { platform: 'win32' }),
          dev('server-2', 'server-2', { platform: 'linux' }),
        ],
      }),
    )
    side.server.optionsByDevice = { local: WIN_OPTIONS, 'server-2': MASTER_OPTIONS }
    try {
      await side.open({})
      await idle(side)
      await side.world.tick(30)
      await side.world.tick(160)
      await side.world.settle()

      expect(side.el('[data-device="local"]').getAttribute('aria-pressed')).toBe('true')
      expect(side.log.some(l => l.startsWith('GET /api/launch/options?device=local'))).toBe(true)
      const dirReq = side.log.find(l => l.startsWith('POST /api/fs/dirs '))
      expect(dirReq).toBeDefined()
      expect(dirReq).not.toContain('"device"')
    } finally {
      await side.dispose()
    }
  })
})
