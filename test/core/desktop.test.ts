// The agents' own browsers' pure parts (core/desktop.ts): slots, the programs' arguments, the X
// cookie file, profile names, the card's field, the MCP server's entry, doctor's checks, and the
// install's packages script and record (core/server-install.ts).
import { expect, test } from 'bun:test'
import {
  BROWSER_MCP,
  browserMcpEntry,
  CHROME_DEB,
  chromeArgs,
  controlOf,
  DEVTOOLS_MCP_VERSION,
  desktopChecks,
  desktopView,
  pickSlot,
  profileName,
  slotDisplay,
  slotPort,
  withBrowserMcp,
  xauthority,
  xvncArgs,
} from '../../src/core/desktop.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { mergeClaudeJson } from '../../src/core/profile-sync/rewrite.ts'
import { shareClaudeJson } from '../../src/core/profile-sync/secrets.ts'
import {
  BOARD_SOCKET,
  desktopRemoveScript,
  desktopScript,
  installRecord,
  installWill,
} from '../../src/core/server-install.ts'

const en = translator('en')
const ru = translator('ru')

test('a slot: the lowest no desktop uses and nothing else holds; none when all are taken', async () => {
  expect(await pickSlot(new Set(), () => false)).toBe(0)
  expect(await pickSlot(new Set([0, 1]), () => false)).toBe(2)
  // :102's lock is someone else's, 9303's port too
  expect(await pickSlot(new Set([0, 1]), s => s === 2 || s === 3)).toBe(4)
  expect(await pickSlot(new Set([0]), async s => s === 1)).toBe(2)
  expect(await pickSlot(new Set([0, 1, 2]), () => false, 3)).toBeNull()
  expect([slotDisplay(0), slotPort(0), slotDisplay(5), slotPort(5)]).toEqual([100, 9300, 105, 9305])
})

test('Xvnc: VNC on its Unix socket only (no TCP), no VNC password, X with its cookie only', () => {
  const a = xvncArgs({ display: 101, socket: '/s/vnc.sock', auth: '/s/Xauthority', name: 'agent-board x' })
  expect(a[0]).toBe(':101')
  const flag = (f: string): string | undefined => a[a.indexOf(f) + 1]
  expect(flag('-rfbunixpath')).toBe('/s/vnc.sock')
  expect(flag('-rfbunixmode')).toBe('0600')
  expect(flag('-SecurityTypes')).toBe('None')
  expect(flag('-nolisten')).toBe('tcp')
  expect(flag('-auth')).toBe('/s/Xauthority')
  expect(a).not.toContain('-rfbport')
  expect(a).toContain('-AlwaysShared')
})

test('Chrome: headed, its own profile folder and DevTools port, a test server’s extra arguments last', () => {
  const a = chromeArgs({ profileDir: '/p/github', port: 9301, extra: ['--no-sandbox'] })
  expect(a).toContain('--user-data-dir=/p/github')
  expect(a).toContain('--remote-debugging-port=9301')
  expect(a).toContain('--password-store=basic')
  expect(a.some(x => x.startsWith('--headless'))).toBe(false)
  expect(a.slice(-2)).toEqual(['--no-sandbox', 'about:blank'])
})

test('the X cookie file: one MIT-MAGIC-COOKIE-1 entry for the display, any host', () => {
  const cookie = new Uint8Array(16).map((_, i) => i + 1)
  const f = xauthority(105, cookie)
  const v = new DataView(f.buffer)
  expect(v.getUint16(0)).toBe(0xffff)
  expect(v.getUint16(2)).toBe(0) // no address
  expect(v.getUint16(4)).toBe(3)
  expect(new TextDecoder().decode(f.slice(6, 9))).toBe('105')
  expect(v.getUint16(9)).toBe(18)
  expect(new TextDecoder().decode(f.slice(11, 29))).toBe('MIT-MAGIC-COOKIE-1')
  expect(v.getUint16(29)).toBe(16)
  expect([...f.slice(31)]).toEqual([...cookie])
  expect(f.length).toBe(47)
})

test('profile names: none is the session’s own; a name in lower case; anything else refused', () => {
  for (const none of [undefined, null, '']) expect(profileName(none)).toBeNull()
  expect(profileName('GitHub')).toBe('github')
  expect(profileName(' client-x ')).toBe('client-x')
  expect(profileName('a.b_c-1')).toBe('a.b_c-1')
  for (const bad of ['../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(41), 7, 'имя'])
    expect(profileName(bad)).toEqual({ error: expect.any(String) })
})

test('control: owner or agent, nothing else', () => {
  expect(controlOf({ to: 'owner' })).toBe('owner')
  expect(controlOf({ to: 'agent' })).toBe('agent')
  for (const bad of [{}, { to: 'me' }, null, 'owner', []]) expect(controlOf(bad)).toBeNull()
})

test('the card’s field: asks only while the card still asks', () => {
  const d = { running: true, profile: 'github', control: 'owner' as const, asks: true }
  expect(desktopView(d, true)).toEqual({ running: true, profile: 'github', control: 'owner', asks: true })
  expect(desktopView(d, false).asks).toBe(false)
  expect(desktopView({ ...d, asks: false }, true).asks).toBe(false)
})

test('the MCP server in a profile’s .claude.json: added, kept when there, taken out; nothing else changes', () => {
  const entry = browserMcpEntry('/home/agent/.local/bin/board')
  expect(entry).toEqual({ type: 'stdio', command: '/home/agent/.local/bin/board', args: ['browser-mcp'], env: {} })
  const cj = { oauthAccount: { a: 1 }, mcpServers: { other: { command: 'x' } }, projects: { '/p': {} } }
  const added = withBrowserMcp(cj, entry)
  expect(added).toEqual({ ...cj, mcpServers: { other: { command: 'x' }, [BROWSER_MCP]: entry } })
  expect(withBrowserMcp(added, entry)).toBeNull()
  expect(withBrowserMcp(added, null)).toEqual(cj)
  expect(withBrowserMcp(cj, null)).toBeNull()
  expect(withBrowserMcp(null, entry)).toEqual({ mcpServers: { [BROWSER_MCP]: entry } })
})

test('doctor: each piece there or what to do, in both languages', () => {
  const all = {
    xvnc: '/usr/bin/Xvnc',
    chrome: '/usr/bin/google-chrome-stable',
    fonts: true,
    mcp: DEVTOOLS_MCP_VERSION,
    profiles: [{ title: 'default', has: true }],
  }
  expect(desktopChecks(all, en).map(c => c.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  const none = desktopChecks(
    { xvnc: null, chrome: null, fonts: false, mcp: '1.0.0', profiles: [{ title: 'work', has: false }] },
    en,
  )
  expect(none.map(c => c.level)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn'])
  expect(none[4]?.title).toBe('The agents’ browsers: no MCP server in work')
  expect(none[3]?.code).toBe('herdr plugin action invoke agent-board.install')
  expect(desktopChecks(all, ru)[0]?.title).toBe('Браузеры агентов: Xvnc (TigerVNC)')
})

test('the install’s packages: apt for Xvnc and the fonts, Google’s .deb for Chrome; Undo purges what it added', () => {
  const s = desktopScript(['tigervnc-standalone-server', 'fonts-noto-core', 'google-chrome-stable'])
  expect(s).toContain('apt-get install -y -qq --no-install-recommends tigervnc-standalone-server fonts-noto-core\n')
  expect(s).toContain(CHROME_DEB)
  expect(s).toContain('apt-get install -y -qq "$d/chrome.deb"')
  expect(desktopScript(['fonts-noto-core'])).not.toContain('chrome')
  expect(desktopScript(['x; rm -rf /'])).not.toContain('rm -rf /')
  expect(desktopRemoveScript(['google-chrome-stable', 'bad name'])).toBe(
    'DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq google-chrome-stable',
  )
  const r = {
    v: 1,
    user: 'agent',
    home: '/home/agent',
    domain: 'w.example.com',
    socket: BOARD_SOCKET,
    source: { kind: 'archive', commit: 'a'.repeat(40), changes: false },
    sudo: false,
    at: 'x',
  }
  expect(installRecord(r)).toEqual(r as never)
  expect(installRecord({ ...r, desktop: ['google-chrome-stable', 'a b'] })?.desktop).toEqual(['google-chrome-stable'])
})

test('the profile sync never carries the board’s browser MCP server either way; the target keeps its own', () => {
  const entry = browserMcpEntry('/home/agent/.local/bin/board')
  const source = { mcpServers: { [BROWSER_MCP]: entry, other: { command: 'npx', args: ['x'] } } }
  const shared = shareClaudeJson(source, null).value
  expect(shared.mcpServers).toEqual({ other: { command: 'npx', args: ['x'] } })
  const target = { mcpServers: { [BROWSER_MCP]: browserMcpEntry('/srv/board') } }
  const merged = mergeClaudeJson(target, { mcpServers: { [BROWSER_MCP]: entry, other: { command: 'npx' } } })
  expect(merged.mcpServers).toEqual({ [BROWSER_MCP]: browserMcpEntry('/srv/board'), other: { command: 'npx' } })
})

test('the install’s plan says what the browsers need, only when something is missing', () => {
  const base = {
    user: 'agent',
    userThere: true,
    sudoThere: false,
    sudo: false,
    source: { kind: 'archive' as const, commit: 'a'.repeat(40), changes: false },
    keysFrom: null,
  }
  expect(installWill(base, en).some(l => l.includes('browsers'))).toBe(false)
  expect(installWill({ ...base, desktop: [] }, en).some(l => l.includes('browsers'))).toBe(false)
  expect(installWill({ ...base, desktop: ['tigervnc-standalone-server', 'google-chrome-stable'] }, en).at(-1)).toBe(
    'Install what the agents’ own browsers need, as root with apt (about 300–500 MB of memory for each browser open): tigervnc-standalone-server, google-chrome-stable.',
  )
  expect(installWill({ ...base, desktop: ['fonts-noto-core'] }, ru).at(-1)).toContain('браузерам агентов')
})
