// The agents' own browsers' pure parts (core/desktop.ts): slots, the programs' arguments, the X
// cookie file, profile names, the card's field, the MCP server's entry, doctor's checks, and the
// install's packages script and record (core/server-install.ts).
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_MCP,
  browserFor,
  browserMcpEntry,
  CHROME_DEB,
  chromeArgs,
  chromiumLibs,
  chromiumPrograms,
  controlOf,
  DESK_KEYED,
  DESK_LETTERS,
  DESK_MARKS,
  DEVTOOLS_MCP_VERSION,
  deskKeymap,
  deskLanguages,
  desktopChecks,
  desktopNeeds,
  desktopView,
  handedBackText,
  MAX_OPEN_URL,
  openerScript,
  openUrl,
  PLAYWRIGHT_VERSION,
  pickSlot,
  profileName,
  rfbInputFilter,
  runEnv,
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
  expect(a).not.toContain('--restore-last-session')
})

test('Chrome without its startup infobars (Chrome for Testing’s "only for automated testing"), and still not as automation (no --enable-automation: navigator.webdriver, Google’s sign-in), however it starts', () => {
  for (const a of [
    chromeArgs({ profileDir: '/p' }),
    chromeArgs({ profileDir: '/p', restore: true, languages: ['ru', 'en'], extra: ['--no-sandbox'] }),
  ]) {
    expect(a).toContain('--disable-infobars')
    expect(a.some(x => x.startsWith('--enable-automation') || x.startsWith('--test-type'))).toBe(false)
  }
})

test('Chrome started again after its stop (browser_close, idle): its last tabs reopened (and its session cookies), no blank tab beside them', () => {
  const a = chromeArgs({ profileDir: '/p/own', extra: ['--no-sandbox'], restore: true })
  const fresh = chromeArgs({ profileDir: '/p/own', extra: ['--no-sandbox'] })
  expect(a).toContain('--restore-last-session')
  expect(a).not.toContain('about:blank')
  // everything else as on a first start
  expect(a.filter(x => x !== '--restore-last-session')).toEqual(fresh.filter(x => x !== 'about:blank'))
  expect(chromeArgs({ profileDir: '/p/own', restore: false })).toEqual(chromeArgs({ profileDir: '/p/own' }))
})

test('Chrome with the owner’s languages: navigator.languages and Accept-Language both of them (not cut to the first), its own UI language left as it is; none given, as before', () => {
  const a = chromeArgs({ profileDir: '/p', languages: ['ru', 'en'] })
  expect(a).toContain('--accept-lang=ru,en')
  expect(a).toContain('--disable-features=ReduceAcceptLanguage,ReduceAcceptLanguageHTTP')
  expect(a.some(x => x.startsWith('--lang'))).toBe(false)
  for (const none of [chromeArgs({ profileDir: '/p' }), chromeArgs({ profileDir: '/p', languages: null })])
    expect(
      none.some(x => x.startsWith('--accept-lang') || x.startsWith('--disable-features') || x.startsWith('--lang')),
    ).toBe(false)
  // the board in Russian: Russian, then English; in English or following the system: Chrome's own
  expect(deskLanguages('ru')).toEqual(['ru', 'en'])
  expect(deskLanguages('en')).toBeNull()
  expect(deskLanguages('auto')).toBeNull()
  expect(deskLanguages('')).toBeNull()
})

test('Chrome with WebGL: SwiftShader’s, there being no GPU on the server; for WebGL only, not all its drawing', () => {
  for (const a of [
    chromeArgs({ profileDir: '/p' }),
    chromeArgs({ profileDir: '/p', restore: true, languages: ['ru'] }),
  ]) {
    expect(a).toContain('--enable-unsafe-swiftshader')
    expect(a.some(x => x.startsWith('--use-angle'))).toBe(false)
  }
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

test('the display’s keymap: Xvnc’s own, and the letters (each with its capital) and marks on keys of their own, none Chrome acts on nor Xvnc keeps free', () => {
  const map = deskKeymap()
  expect(map).toContain('include "evdev+aliases(qwerty)"')
  expect(map).toContain('include "pc+us+inet(evdev)"')
  const char = (hex: string | undefined) => String.fromCodePoint(Number.parseInt(hex ?? '', 16))
  const letters = [...map.matchAll(/key <(\w+)> \{ type = "ALPHABETIC", \[ U([0-9A-F]+), U([0-9A-F]+) \] \};/g)]
  expect(letters.map(k => char(k[2])).join('')).toBe(DESK_LETTERS)
  // each with its capital (ß’s is ẞ)
  expect(letters.map(k => char(k[3])).join('')).toBe(DESK_LETTERS.replace('ß', 'ẞ').toUpperCase())
  for (const ch of 'ёЁїЇґҐўЎéÉçÇñÑßẞ«»—№₽') expect(DESK_KEYED).toContain(ch)
  // the marks two to a key, the second with Shift
  const marks = [...map.matchAll(/key <(\w+)> \{ type = "TWO_LEVEL", \[ U([0-9A-F]+), U([0-9A-F]+) \] \};/g)]
  expect(marks.flatMap(k => [char(k[2]), char(k[3])]).join('')).toBe(DESK_MARKS)
  const keys = [...letters, ...marks].map(k => k[1] as string)
  expect(new Set(keys).size).toBe(keys.length)
  // Back, Forward, Reload: Chrome acts on them instead of typing
  for (const no of ['I166', 'I167', 'I181']) expect(keys).not.toContain(no)
  // those Xvnc leaves free for what it puts on the way
  for (const free of [93, 97, 103, 120, 132, 149, 154, 168, 178, 183, 184, 217, 219, 222, 230, 248])
    expect(keys).not.toContain(`I${free}`)
  // real keys (8 to 255)
  for (const k of keys) if (k.startsWith('I')) expect(Number(k.slice(1))).toBeLessThanOrEqual(255)
})

test('the extended clipboard through the filter: what the viewer can do, and its letting go, go on watched too; its text announced, sent or asked for only with control', () => {
  const handshake = [...new TextEncoder().encode('RFB 003.008\n'), 1, 1]
  /** An extended ClientCutText: its flags, then what follows them. */
  const clip = (flags: number, ...body: number[]) => {
    const n = -(4 + body.length)
    return [
      6,
      0,
      0,
      0,
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
      ...[24, 16, 8, 0].map(s => (flags >>> s) & 255),
      ...body,
    ]
  }
  const caps = clip((1 << 24) | 1 | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28), 0, 4, 0, 0)
  const empty = clip(1 << 27)
  const has = clip((1 << 27) | 1)
  const ask = clip((1 << 25) | 1)
  const provide = clip((1 << 28) | 1, 0x78, 0x01, 0, 0, 0, 0xff, 0xff)
  const plain = [6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]
  const all = [...handshake, ...caps, ...has, ...ask, ...provide, ...plain, ...empty]
  const watched = rfbInputFilter()
  const out: number[] = []
  // byte by byte: the flags too wait for the rest of them
  for (const b of all) out.push(...(watched(Uint8Array.of(b), false) ?? [Number.NaN]))
  expect(out).toEqual([...handshake, ...caps, ...empty])
  const owner = rfbInputFilter()
  expect([...(owner(Uint8Array.from(all), true) ?? [])]).toEqual(all)
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

// SuiteCloud CLI 3.1.1's browser login (its Java SDK's PKCE flow), as it opens it: the address it gives xdg-open.
const SUITECLOUD_LOGIN =
  'https://system.netsuite.com/app/login/oauth2/authorize.nl?scope=restlets&redirect_uri=http%3A%2F%2F127.0.0.1%3A52300%2Fsuitecloud-auth&response_type=code&client_id=6da57bf05a6247fc876c6d228184ff487760a382a43ac7e93eaff743803d22ac&state=0357efc8-8cad-45f6-a288-938ec75d5a44&code_challenge=fKinHf_CbajU44RKS3YP6ZedNm3enkKZa9PzF57RmRA&code_challenge_method=S256'

test('board browser open: http and https addresses as they came (a CLI login’s, its query intact), nothing Chrome could take for a switch, a script or a file', () => {
  expect(openUrl(SUITECLOUD_LOGIN)).toBe(SUITECLOUD_LOGIN)
  expect(openUrl('http://127.0.0.1:52300/suitecloud-auth?code=x&state=y')).toBe(
    'http://127.0.0.1:52300/suitecloud-auth?code=x&state=y',
  )
  expect(openUrl(' https://github.com/login/device ')).toBe('https://github.com/login/device')
  expect(openUrl('https://example.com/путь?q=a b%')).toBe('https://example.com/%D0%BF%D1%83%D1%82%D1%8C?q=a%20b%')
  for (const bad of [
    '',
    '   ',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'data:text/html,hi',
    '--user-data-dir=/tmp/x',
    '--headless',
    'example.com',
    `https://example.com/${'a'.repeat(MAX_OPEN_URL)}`,
    undefined,
    null,
    42,
    ['https://example.com'],
  ])
    expect(openUrl(bad)).toBeNull()
})

test('board browser run: its program’s xdg-open hands the address to `board browser open` by this board command, with the ask when there is one; paths with spaces and quotes stay whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opener-'))
  try {
    // a "bun" that says what it was run with, in a folder whose name has a space and a quote
    const odd = join(dir, "my bun's dir")
    mkdirSync(odd)
    const bun = join(odd, 'bun')
    writeFileSync(bun, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\n`, { mode: 0o755 })
    const opener = join(dir, 'xdg-open')
    writeFileSync(opener, openerScript(bun, "/opt/agent board/src/entrypoints/it's cli.ts"), { mode: 0o700 })
    const run = (env: Record<string, string>) =>
      Bun.spawnSync([opener, SUITECLOUD_LOGIN], { env: { PATH: '/usr/bin:/bin', ...env } }).stdout.toString()
    expect(run({})).toBe(`[/opt/agent board/src/entrypoints/it's cli.ts][browser][open][${SUITECLOUD_LOGIN}]`)
    expect(run({ BOARD_BROWSER_ASK: 'Войди в NetSuite: bb-success-platform-dev (100% "ok")' })).toBe(
      `[/opt/agent board/src/entrypoints/it's cli.ts][browser][open][${SUITECLOUD_LOGIN}][--ask][Войди в NetSuite: bb-success-platform-dev (100% "ok")]`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('board browser run: its program gets the session’s display and X cookie, the board’s xdg-open first on the PATH and as BROWSER, and the ask only when given', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/a', HERDR_PANE_ID: 'w0:p1', BOARD_BROWSER_ASK: 'from outside' }
  const o = { display: 104, xauthority: '/state/desktop/sessions/104/Xauthority', opener: '/state/desktop/run/open-x' }
  expect(runEnv(base, o)).toEqual({
    PATH: '/state/desktop/run/open-x:/usr/bin:/bin',
    HOME: '/home/a',
    HERDR_PANE_ID: 'w0:p1',
    DISPLAY: ':104',
    XAUTHORITY: '/state/desktop/sessions/104/Xauthority',
    BROWSER: '/state/desktop/run/open-x/xdg-open',
  })
  expect(runEnv({ DISPLAY: ':0' }, { ...o, ask: 'Sign in to NetSuite' })).toEqual({
    DISPLAY: ':104',
    XAUTHORITY: '/state/desktop/sessions/104/Xauthority',
    BROWSER: '/state/desktop/run/open-x/xdg-open',
    PATH: '/state/desktop/run/open-x',
    BOARD_BROWSER_ASK: 'Sign in to NetSuite',
  })
})
