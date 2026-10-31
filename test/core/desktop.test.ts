// The agents' own browsers' pure parts (core/desktop.ts): slots, the programs' arguments, the X
// cookie file, profile names, the card's field, the MCP server's entry, doctor's checks, and the
// install's packages script and record (core/server-install.ts).
import { expect, test } from 'bun:test'
import {
  BROWSER_MCP,
  browserFor,
  browserMcpEntry,
  CHROME_DEB,
  chromeArgs,
  chromiumLibs,
  chromiumPrograms,
  controlOf,
  DEVTOOLS_MCP_VERSION,
  desktopChecks,
  desktopNeeds,
  desktopView,
  handedBackText,
  PLAYWRIGHT_VERSION,
  pickSlot,
  profileName,
  rfbInputFilter,
  slotDisplay,
  withBrowserMcp,
  xauthority,
  xvncArgs,
} from '../../src/core/desktop.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { reminderNotice } from '../../src/core/notices.ts'
import { mergeClaudeJson } from '../../src/core/profile-sync/rewrite.ts'
import { shareClaudeJson } from '../../src/core/profile-sync/secrets.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import {
  BOARD_SOCKET,
  desktopLibsUndoScript,
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
  // :102's and :103's locks are someone else's
  expect(await pickSlot(new Set([0, 1]), s => s === 2 || s === 3)).toBe(4)
  expect(await pickSlot(new Set([0]), async s => s === 1)).toBe(2)
  expect(await pickSlot(new Set([0, 1, 2]), () => false, 3)).toBeNull()
  expect([slotDisplay(0), slotDisplay(5)]).toEqual([100, 105])
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
  // with a socket alone, Xvnc still listens on 5900 + the display on every address
  expect(flag('-rfbport')).toBe('-1')
  expect(a).toContain('-localhost')
  expect(a).toContain('-AlwaysShared')
})

test('Chrome: headed, its own profile folder, DevTools on its pipe and no port, a test server’s extra arguments last', () => {
  const a = chromeArgs({ profileDir: '/p/github', extra: ['--no-sandbox'] })
  expect(a).toContain('--user-data-dir=/p/github')
  expect(a).toContain('--remote-debugging-pipe')
  expect(a.some(x => x.startsWith('--remote-debugging-port') || x.startsWith('--remote-debugging-address'))).toBe(false)
  expect(a).toContain('--password-store=basic')
  expect(a.some(x => x.startsWith('--headless'))).toBe(false)
  // a wheel step one frame on the display, not a smooth scroll's dozen; pages as they are (no reduced motion)
  expect(a).toContain('--disable-smooth-scrolling')
  expect(a.some(x => x.includes('reduced-motion'))).toBe(false)
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

test('a viewer’s RFB bytes: the handshake and picture requests go on; keys, the mouse, the clipboard and the size only with control', () => {
  const enc = (t: string) => [...new TextEncoder().encode(t)]
  const handshake = [...enc('RFB 003.008\n'), 1, 1]
  const pixelFormat = [0, 0, 0, 0, ...new Array(16).fill(7)]
  const encodings = [2, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 5]
  const request = [3, 1, 0, 0, 0, 0, 0, 4, 0, 2]
  const key = [4, 1, 0, 0, 0, 0, 0, 0x61]
  const pointer = [5, 1, 0, 1, 0, 1]
  const cut = [6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]
  const size = [251, 0, 4, 0, 3, 0, 1, 0, ...new Array(16).fill(0)]
  const fence = [248, 0, 0, 0, 0, 0, 0, 0, 2, 9, 9]
  const all = [...handshake, ...pixelFormat, ...encodings, ...request, ...key, ...pointer, ...cut, ...size, ...fence]
  const watched = rfbInputFilter()
  // byte by byte: a message cut anywhere waits for its rest
  const out: number[] = []
  for (const b of all) out.push(...(watched(Uint8Array.of(b), false) ?? [NaN]))
  expect(out).toEqual([...handshake, ...pixelFormat, ...encodings, ...request, ...fence])
  const owner = rfbInputFilter()
  expect([...(owner(Uint8Array.from(all), true) ?? [])]).toEqual(all)
  // control given back on the way: what comes after it is dropped
  const mixed = rfbInputFilter()
  expect([...(mixed(Uint8Array.from([...handshake, ...key]), true) ?? [])]).toEqual([...handshake, ...key])
  expect([...(mixed(Uint8Array.from([...pointer, ...request]), false) ?? [])]).toEqual(request)
  // 3.3 has no security byte
  const old = rfbInputFilter()
  const old33 = [...enc('RFB 003.003\n'), 1, ...key]
  expect([...(old(Uint8Array.from(old33), false) ?? [])]).toEqual(old33.slice(0, 13))
  // what it cannot read on from (an unknown message, another greeting, another security type): the viewer closes
  expect(rfbInputFilter()(Uint8Array.from([...handshake, 99]), false)).toBeNull()
  expect(rfbInputFilter()(Uint8Array.from(enc('GET / HTTP/1.1\r\n')), false)).toBeNull()
  expect(rfbInputFilter()(Uint8Array.from([...enc('RFB 003.008\n'), 2]), false)).toBeNull()
})

test('the card’s field: asks only while the card still asks', () => {
  const d = { running: true, profile: 'github', control: 'owner' as const, asks: true }
  expect(desktopView(d, true)).toEqual({ running: true, profile: 'github', control: 'owner', asks: true })
  expect(desktopView(d, false).asks).toBe(false)
  expect(desktopView({ ...d, asks: false }, true).asks).toBe(false)
  // what was asked, while the ask stands, whether the card shows it now or not
  const asked = { ...d, ask: 'Sign in to GitHub' }
  expect(desktopView(asked, false)).toEqual({ ...desktopView(d, false), ask: 'Sign in to GitHub' })
  expect('ask' in desktopView({ ...asked, asks: false }, true)).toBe(false)
  expect('ask' in desktopView(d, true)).toBe(false)
})

test('the hand-back’s word to the agent: a board reminder, which the thread shows as one; the ask on one line, clipped', () => {
  const text = handedBackText('Sign in to GitHub\n  as acme-bot')
  expect(text).toBe(
    'The owner handed your browser back (the ask was: "Sign in to GitHub as acme-bot"). Check the page and go on.',
  )
  expect(handedBackText('x'.repeat(400))).toContain(`"${'x'.repeat(299)}…")`)
  const prompt = promptOf({ id: 'a1b2c3', key: 's1', text, next: 1, at: 1, by: 'board' }, 1)
  expect(prompt).toBe(`[board reminder] ${text}`)
  expect(reminderNotice(prompt)).toMatchObject({ kind: 'reminder', name: text })
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
    ffmpeg: '/usr/bin/ffmpeg',
    chrome: '/usr/bin/google-chrome-stable',
    fonts: true,
    mcp: DEVTOOLS_MCP_VERSION,
    profiles: [{ title: 'default', has: true }],
  }
  expect(desktopChecks(all, en).map(c => c.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
  const none = desktopChecks(
    { xvnc: null, ffmpeg: null, chrome: null, fonts: false, mcp: '1.0.0', profiles: [{ title: 'work', has: false }] },
    en,
  )
  expect(none.map(c => c.level)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn', 'warn'])
  expect(none[5]?.title).toBe('The agents’ browsers: no MCP server in work')
  expect(none[4]?.code).toBe('herdr plugin action invoke agent-board.install')
  expect(desktopChecks(all, ru)[0]?.title).toBe('Браузеры агентов: Xvnc (TigerVNC)')
})

test('doctor: ffmpeg for the live view as video; without it a warning, the install its fix (the view is VNC’s pictures)', () => {
  const base = {
    xvnc: '/usr/bin/Xvnc',
    chrome: '/usr/bin/google-chrome-stable',
    fonts: true,
    mcp: DEVTOOLS_MCP_VERSION,
    profiles: [{ title: 'default', has: true }],
  }
  const there = desktopChecks({ ...base, ffmpeg: '/usr/bin/ffmpeg' }, en).find(c => c.id === 'desktop-ffmpeg')
  expect(there).toMatchObject({
    level: 'ok',
    title: 'The agents’ browsers: ffmpeg (their live view as H.264 video)',
    detail: '/usr/bin/ffmpeg',
  })
  const missing = desktopChecks({ ...base, ffmpeg: null }, en).find(c => c.id === 'desktop-ffmpeg')
  expect(missing).toMatchObject({
    level: 'warn',
    title: 'The agents’ browsers: no ffmpeg (their live view stays VNC pictures, slower)',
    fix: 'Run the board’s install again on the server, as root (server-install.sh); it adds them.',
  })
  expect(desktopChecks({ ...base, ffmpeg: null }, ru).find(c => c.id === 'desktop-ffmpeg')?.title).toBe(
    'Браузеры агентов: нет ffmpeg (их показ остаётся картинками VNC, медленнее)',
  )
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

const DEBIAN = ['PRETTY_NAME="Debian GNU/Linux 13 (trixie)"', 'VERSION_ID="13"', 'ID=debian', ''].join('\n')
const UBUNTU = (v: string) =>
  [`PRETTY_NAME="Ubuntu ${v} LTS"`, `VERSION_ID="${v}"`, 'ID=ubuntu', 'ID_LIKE=debian', ''].join('\n')
const FEDORA = 'ID=fedora\nVERSION_ID=42\n'

test('the browser per machine: Google Chrome on x86_64, Debian’s Chromium on arm64 Debian, Playwright’s on arm64 Ubuntu', () => {
  for (const os of [DEBIAN, UBUNTU('22.04'), UBUNTU('24.04'), '']) expect(browserFor('x64', os)).toBe('chrome')
  expect(browserFor('arm64', DEBIAN)).toBe('chromium')
  for (const v of ['22.04', '24.04', '26.04']) expect(browserFor('arm64', UBUNTU(v))).toBe('playwright')
  expect(browserFor('arm64', FEDORA)).toBeNull()
  expect(browserFor('arm64', '')).toBeNull()
  expect(PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

test('Chromium’s libraries on Ubuntu: 22.04’s names, and 24.04’s t64 ones from then on; no fonts, no Xvfb', () => {
  const jammy = chromiumLibs(UBUNTU('22.04'))
  expect(jammy).toContain('libnss3')
  expect(jammy).toContain('libasound2')
  expect(jammy).toContain('libwayland-client0')
  for (const v of ['24.04', '26.04']) {
    const l = chromiumLibs(UBUNTU(v))
    expect(l).toContain('libasound2t64')
    expect(l).toContain('libgbm1')
    expect(l).not.toContain('libasound2')
  }
  for (const l of [jammy, chromiumLibs(UBUNTU('24.04'))]) expect(l.some(p => /^(xvfb|fonts-)/.test(p))).toBe(false)
})

test('the board’s own Chromium in its folder: the newest revision’s program; nothing else counts', () => {
  expect(
    chromiumPrograms(['chromium-1200', '.links', 'chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013']),
  ).toEqual(['chromium-1248/chrome-linux-arm64/chrome', 'chromium-1200/chrome-linux-arm64/chrome'])
  expect(chromiumPrograms([])).toEqual([])
  expect(chromiumPrograms(['chromium-x', 'chromium-1248.tmp'])).toEqual([])
})

test('what the install adds for the browsers, per machine: x86_64 and arm64 Debian as before; arm64 Ubuntu Chromium’s libraries', async () => {
  const has = (list: string[]) => (p: string) => list.includes(p)
  const needs = (arch: string, os: string, there: string[], browser: boolean) =>
    desktopNeeds({ arch, osRelease: () => os, installed: has(there), browserThere: () => browser })
  // x86_64: Google Chrome where no browser is; the os-release not read
  const noOs = () => {
    throw new Error('read')
  }
  expect(
    await desktopNeeds({ arch: 'x64', osRelease: noOs, installed: () => false, browserThere: () => false }),
  ).toEqual({
    packages: [
      'tigervnc-standalone-server',
      'ffmpeg',
      'fonts-noto-core',
      'fonts-noto-cjk',
      'fonts-noto-color-emoji',
      'fonts-liberation',
      'google-chrome-stable',
    ],
    chromium: false,
  })
  expect(await desktopNeeds({ arch: 'x64', osRelease: noOs, installed: () => true, browserThere: () => true })).toEqual(
    { packages: [], chromium: false },
  )
  // arm64 Debian: its Chromium where no browser is
  expect(
    await needs(
      'arm64',
      DEBIAN,
      [
        'tigervnc-standalone-server',
        'ffmpeg',
        'fonts-noto-core',
        'fonts-noto-cjk',
        'fonts-noto-color-emoji',
        'fonts-liberation',
      ],
      false,
    ),
  ).toEqual({
    packages: ['chromium'],
    chromium: false,
  })
  expect(await needs('arm64', DEBIAN, [], true)).toEqual({
    packages: [
      'tigervnc-standalone-server',
      'ffmpeg',
      'fonts-noto-core',
      'fonts-noto-cjk',
      'fonts-noto-color-emoji',
      'fonts-liberation',
    ],
    chromium: false,
  })
  // arm64 Ubuntu: Chromium's libraries not there yet, and the board's Chromium, a browser there or not (a snap's)
  for (const browser of [false, true]) {
    const u = await needs('arm64', UBUNTU('22.04'), ['libnss3', 'fonts-liberation'], browser)
    expect(u.chromium).toBe(true)
    expect(u.packages).toContain('tigervnc-standalone-server')
    expect(u.packages).toContain('ffmpeg')
    expect(u.packages).toContain('libasound2')
    expect(u.packages).not.toContain('libnss3')
    expect(u.packages).not.toContain('fonts-liberation')
    expect(u.packages).not.toContain('chromium')
  }
  expect((await needs('arm64', UBUNTU('24.04'), [], false)).packages).toContain('libasound2t64')
  // anything else on arm64: nothing but Xvnc and the fonts
  expect(await needs('arm64', FEDORA, [], false)).toEqual({
    packages: [
      'tigervnc-standalone-server',
      'ffmpeg',
      'fonts-noto-core',
      'fonts-noto-cjk',
      'fonts-noto-color-emoji',
      'fonts-liberation',
    ],
    chromium: false,
  })
})

test('the install’s plan and record for Ubuntu’s arm64: Chromium as the user; its libraries handed back to apt on Undo, never purged', () => {
  const base = {
    user: 'agent',
    userThere: true,
    sudoThere: false,
    sudo: false,
    source: { kind: 'archive' as const, commit: 'a'.repeat(40), changes: false },
    keysFrom: null,
  }
  expect(installWill({ ...base, desktop: ['libnss3'] }, en).some(l => l.includes('Playwright'))).toBe(false)
  const will = installWill({ ...base, desktop: ['libnss3'], chromium: true }, en)
  expect(will.at(-1)).toContain(`Playwright ${PLAYWRIGHT_VERSION}`)
  expect(will.at(-1)).toContain('agent')
  expect(installWill({ ...base, chromium: true }, ru).at(-1)).toContain(`Playwright ${PLAYWRIGHT_VERSION}`)
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
  expect(installRecord({ ...r, desktopLibs: ['libnss3', 'a;b'] })?.desktopLibs).toEqual(['libnss3'])
  expect(installRecord(r)).toEqual(r as never)
  const undo = desktopLibsUndoScript(['libnss3', 'libasound2', 'x; rm -rf /'])
  expect(undo).toContain('apt-mark auto')
  expect(undo).toContain('libnss3 libasound2')
  expect(undo).not.toContain('rm -rf')
  expect(undo).not.toContain('purge')
})
