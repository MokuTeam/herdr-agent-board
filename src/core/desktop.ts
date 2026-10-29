// Each agent's own browser on the board's server (the board-on-own-server spec's "Later: each
// agent's own browser"): per session, on demand, an X display of its own (Xvnc: the X server and
// its VNC in one, VNC on a Unix socket only, X with a cookie of its own), a headed Chrome on it
// with its own profile folder and its DevTools on a pipe (no TCP port), watched and taken over from
// the board over VNC through its login, and reached by the agent through the board's MCP wrapper
// (`board browser-mcp`: chrome-devtools-mcp pointed at the board's keyed bridge to that pipe, its
// calls held while the owner has the browser). Server mode only: a board on a PC has none of it.
//
// Here: the slots (displays), the programs' arguments, the X cookie file, the profile
// names, the control, the card's field, the MCP server's entry in a profile's .claude.json and
// `board doctor`'s checks. Pure, with no node: import.
import type { SetupCheck } from './setup.ts'
import type { ItemDesktop, Translator } from './types.ts'

/** The first display a desktop takes (:100), clear of a person's own (:0, :1, …). */
export const DISPLAY_BASE = 100
/** At most this many desktops at once (each takes about 300–500 MB). */
export const MAX_DESKTOPS = 32
/** The screen: Chrome's window fills it. */
export const SCREEN = { width: 1440, height: 900 } as const
/** chrome-devtools-mcp, pinned: the board's install puts this version in place. */
export const DEVTOOLS_MCP_VERSION = '1.11.0'
export const DEVTOOLS_MCP = 'chrome-devtools-mcp'
/** The board's MCP server in a Claude profile (user scope): the agent's tools are mcp__board-browser__*. */
export const BROWSER_MCP = 'board-browser'
/** How long the wrapper holds a call while the owner has the browser, by default. */
export const HOLD_MS = 10 * 60_000
/** The browsers the board runs, in this order: Google Chrome stable, then Debian's Chromium. */
export const CHROME_BINS = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'] as const
/** What the install adds for the desktops (as root, by apt): Xvnc, and fonts so pages look right. */
export const DESKTOP_PACKAGES = [
  'tigervnc-standalone-server',
  'fonts-noto-core',
  'fonts-noto-cjk',
  'fonts-noto-color-emoji',
  'fonts-liberation',
] as const
/** The browser's package on x86_64 (Google's .deb, which adds Google's repository for updates). */
export const CHROME_PACKAGE = 'google-chrome-stable'
export const CHROME_DEB = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'
/** On arm64, Debian's own Chromium (Ubuntu's is a snap, which a server without snapd does not run). */
export const CHROMIUM_PACKAGE = 'chromium'
/**
 * On Ubuntu's arm64, the board's own Chromium: Chrome for Testing's arm64 build, put in place by
 * Playwright's CLI, pinned (`playwright-core@<this> install --no-shell chromium`), as the board's
 * user, in the desktops' folder (adapters/desktop-files.ts); its libraries as root with apt.
 */
export const PLAYWRIGHT_VERSION = '1.64.1'
/** Its folder in the desktops' folder (PLAYWRIGHT_BROWSERS_PATH). */
export const BOARD_CHROMIUM_DIR = 'chromium'

/** The browser the install puts in place: Google Chrome, Debian's Chromium, the board's own (Playwright's), or none. */
export type BrowserKind = 'chrome' | 'chromium' | 'playwright' | null

/** Which browser a machine gets (`process.arch`'s name, /etc/os-release): x86_64 Google Chrome; arm64 Debian's Chromium, Ubuntu's the board's own. */
export function browserFor(arch: string, osRelease: string): BrowserKind {
  if (arch === 'x64') return 'chrome'
  if (arch !== 'arm64') return null
  if (/^ID=debian$/m.test(osRelease)) return 'chromium'
  if (/^ID=ubuntu$/m.test(osRelease)) return 'playwright'
  return null
}

/** Playwright's `install-deps` list for its Chromium on Ubuntu 22.04 (playwright-core's nativeDeps, chromium; the fonts are the desktops' own). */
const CHROMIUM_LIBS_2204 = [
  'libasound2',
  'libatk-bridge2.0-0',
  'libatk1.0-0',
  'libatspi2.0-0',
  'libcairo2',
  'libcups2',
  'libdbus-1-3',
  'libdrm2',
  'libgbm1',
  'libglib2.0-0',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libwayland-client0',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
] as const
/** The same for Ubuntu 24.04 and 26.04 (the t64 names). */
const CHROMIUM_LIBS_2404 = [
  'libasound2t64',
  'libatk-bridge2.0-0t64',
  'libatk1.0-0t64',
  'libatspi2.0-0t64',
  'libcairo2',
  'libcups2t64',
  'libdbus-1-3',
  'libdrm2',
  'libgbm1',
  'libglib2.0-0t64',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
] as const

/** The board's own Chromium's libraries for an Ubuntu (its /etc/os-release): 22.04's names, the t64 ones from 24.04 on. */
export const chromiumLibs = (osRelease: string): readonly string[] =>
  /^VERSION_ID="?22\.04"?$/m.test(osRelease) ? CHROMIUM_LIBS_2204 : CHROMIUM_LIBS_2404

/** Whether a package is one of those libraries (the install's record keeps them apart: Undo hands them back to apt). */
export const isChromiumLib = (pkg: string): boolean =>
  (CHROMIUM_LIBS_2204 as readonly string[]).includes(pkg) || (CHROMIUM_LIBS_2404 as readonly string[]).includes(pkg)

/** The board's own Chromium's programs in its folder's entries (`chromium-<revision>/…`, relative), the newest first. */
export const chromiumPrograms = (entries: readonly string[]): string[] =>
  entries
    .map(e => /^chromium-(\d+)$/.exec(e)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(Number)
    .sort((a, b) => b - a)
    .map(r => `chromium-${r}/chrome-linux-arm64/chrome`)

/**
 * What the install adds for the desktops (services/server-install.ts): Xvnc and the fonts not
 * there yet; on x86_64 Google Chrome and on arm64 Debian its Chromium, where no browser is; on
 * arm64 Ubuntu the board's own Chromium (`chromium`: put in place as the user) and its libraries
 * not there yet, a browser on the PATH or not (Ubuntu's is a snap's wrapper).
 */
export async function desktopNeeds(o: {
  arch: string
  osRelease: () => string
  installed: (pkg: string) => boolean | Promise<boolean>
  browserThere: () => boolean
}): Promise<{ packages: string[]; chromium: boolean }> {
  const packages: string[] = []
  for (const p of DESKTOP_PACKAGES) if (!(await o.installed(p))) packages.push(p)
  if (o.arch === 'arm64') {
    const os = o.osRelease()
    if (browserFor(o.arch, os) === 'playwright') {
      for (const p of chromiumLibs(os)) if (!(await o.installed(p))) packages.push(p)
      return { packages, chromium: true }
    }
  }
  if (!o.browserThere()) {
    if (o.arch === 'x64') packages.push(CHROME_PACKAGE)
    else if (/^ID=debian$/m.test(o.osRelease())) packages.push(CHROMIUM_PACKAGE)
  }
  return { packages, chromium: false }
}

export type Control = 'agent' | 'owner'

/** A slot's display (:100 and up). */
export const slotDisplay = (slot: number): number => DISPLAY_BASE + slot

/** The lowest slot no desktop uses and nothing else holds (an X display's lock), or null when all are. */
export async function pickSlot(
  used: ReadonlySet<number>,
  held: (slot: number) => boolean | Promise<boolean>,
  max = MAX_DESKTOPS,
): Promise<number | null> {
  for (let slot = 0; slot < max; slot++) {
    if (used.has(slot)) continue
    if (await held(slot)) continue
    return slot
  }
  return null
}

/** A browser profile's name: letters, digits, `.`, `_` and `-`, 1 to 40, lower case; `github`, `client-x`. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** A profile's name as asked: null for none (the session's own), the name in lower case, or why not. */
export function profileName(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null || v === '') return null
  const name = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!PROFILE_NAME.test(name) || name.includes('..'))
    return { error: 'a profile name is 1 to 40 letters, digits, ".", "_" and "-"' }
  return name
}

/** The control a body asks for (`{ "to": "owner" | "agent" }`), or null. */
export function controlOf(body: unknown): Control | null {
  const to = body && typeof body === 'object' ? (body as { to?: unknown }).to : undefined
  return to === 'owner' || to === 'agent' ? to : null
}

/** A viewer's clipboard text longer than this closes it (no viewer of the board's sends one). */
const MAX_CUT = 1 << 20

/**
 * What a viewer sends a desktop's VNC (RFB, client to server), cut into its messages: the bytes
 * that go on. The handshake (the version, the security type, ClientInit) and what only asks for
 * the picture (its pixel format, encodings, updates, continuous updates, fences) always go on;
 * what acts on the display (a key, the mouse, the clipboard, its size, xvp) only while `input`
 * (the owner has the browser): the server never sees a watcher's. Null: bytes it cannot read on
 * from (another protocol, a security type other than None, a message it does not know), and the
 * viewer is closed. One per viewer: a message cut across WebSocket frames waits for its rest.
 */
export function rfbInputFilter(): (bytes: Uint8Array, input: boolean) => Uint8Array | null {
  let buf = new Uint8Array(0)
  let step: 'version' | 'security' | 'init' | 'messages' = 'version'
  let failed = false
  const u16 = (at: number): number => ((buf[at] ?? 0) << 8) | (buf[at + 1] ?? 0)
  const s32 = (at: number): number =>
    ((buf[at] ?? 0) << 24) | ((buf[at + 1] ?? 0) << 16) | ((buf[at + 2] ?? 0) << 8) | (buf[at + 3] ?? 0)
  /** The length of the message at the start of `buf` and whether it acts on the display; 0: not all of it here yet; null: unknown. */
  function message(): { n: number; acts: boolean } | null {
    const have = buf.length
    const need = (n: number, acts = false) => ({ n: have >= n ? n : 0, acts })
    switch (buf[0]) {
      case 0: // SetPixelFormat
        return need(20)
      case 2: // SetEncodings
        return have < 4 ? { n: 0, acts: false } : need(4 + 4 * u16(2))
      case 3: // FramebufferUpdateRequest
        return need(10)
      case 4: // KeyEvent
        return need(8, true)
      case 5: // PointerEvent
        return need(6, true)
      case 6: {
        // ClientCutText (a negative length: the extended clipboard's)
        if (have < 8) return { n: 0, acts: true }
        const len = Math.abs(s32(4))
        return len > MAX_CUT ? null : need(8 + len, true)
      }
      case 150: // EnableContinuousUpdates
        return need(10)
      case 248: // ClientFence
        return have < 9 ? { n: 0, acts: false } : need(9 + (buf[8] ?? 0))
      case 250: // xvp
        return need(4, true)
      case 251: // SetDesktopSize
        return have < 8 ? { n: 0, acts: true } : need(8 + 16 * (buf[6] ?? 0), true)
      default:
        return null
    }
  }
  const fail = (): null => {
    failed = true
    return null
  }
  return (bytes, input) => {
    if (failed) return null
    const joined = new Uint8Array(buf.length + bytes.length)
    joined.set(buf)
    joined.set(bytes, buf.length)
    buf = joined
    const out: Uint8Array[] = []
    const take = (n: number, keep: boolean) => {
      if (keep) out.push(buf.subarray(0, n))
      buf = buf.subarray(n)
    }
    for (;;) {
      if (step === 'version') {
        if (buf.length < 12) break
        const m = /^RFB 003\.(\d{3})\n$/.exec(new TextDecoder().decode(buf.subarray(0, 12)))
        if (!m) return fail()
        step = Number(m[1]) >= 7 ? 'security' : 'init'
        take(12, true)
      } else if (step === 'security') {
        if (buf.length < 1) break
        // None: nothing more of the viewer's before ClientInit
        if (buf[0] !== 1) return fail()
        step = 'init'
        take(1, true)
      } else if (step === 'init') {
        if (buf.length < 1) break
        step = 'messages'
        take(1, true)
      } else {
        if (buf.length < 1) break
        const m = message()
        if (!m) return fail()
        if (m.n === 0) break
        take(m.n, !m.acts || input)
      }
    }
    // what is kept waits in a copy of its own: the frame's buffer is the WebSocket's
    buf = buf.slice()
    const size = out.reduce((n, o) => n + o.length, 0)
    const all = new Uint8Array(size)
    let at = 0
    for (const o of out) {
      all.set(o, at)
      at += o.length
    }
    return all
  }
}

/** What a session's desktop is, for the card (core/types.ts ItemDesktop). */
export interface DesktopFacts {
  running: boolean
  profile: string | null
  control: Control
  asks: boolean
}

/** The card's field: `asks` only while the card still asks (the agent went on, or the user answered: it is over). */
export const desktopView = (d: DesktopFacts, cardAsks: boolean): ItemDesktop => ({
  running: d.running,
  profile: d.profile,
  control: d.control,
  asks: d.asks && cardAsks,
})

/**
 * Xvnc's arguments: the display, VNC on a Unix socket only (`-rfbport -1`: with a socket alone it
 * still takes 5900 + the display on every address), no VNC password (the
 * socket is the board's user's alone, 0600, and the board's login is in front of it), X only for
 * the cookie in `auth` and never over TCP, several viewers at once.
 */
export function xvncArgs(o: { display: number; socket: string; auth: string; name: string }): string[] {
  return [
    `:${o.display}`,
    '-geometry',
    `${SCREEN.width}x${SCREEN.height}`,
    '-depth',
    '24',
    '-rfbunixpath',
    o.socket,
    '-rfbunixmode',
    '0600',
    '-rfbport',
    '-1',
    '-localhost',
    '-SecurityTypes',
    'None',
    '-AlwaysShared',
    '-nolisten',
    'tcp',
    '-auth',
    o.auth,
    '-desktop',
    o.name,
  ]
}

/**
 * Chrome's arguments: headed on the display, its own profile folder, its DevTools on the pipe its
 * holder gives it (fds 3 and 4: no port any account could reach, services/cdp-pipe.ts), its window
 * over the whole screen (there is no window manager), no first-run questions, no keyring (none on
 * a server), /tmp for its shared memory.
 */
export function chromeArgs(o: { profileDir: string; extra?: readonly string[] }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-dev-shm-usage',
    '--hide-crash-restore-bubble',
    '--window-position=0,0',
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    ...(o.extra ?? []),
    'about:blank',
  ]
}

/**
 * An X authority file with one cookie for `display` (MIT-MAGIC-COOKIE-1, any host): Xvnc takes
 * the cookies in it (-auth), Chrome finds it by XAUTHORITY. Every field is a 16-bit length (big
 * endian) and its bytes, after the family (0xFFFF: any address).
 */
export function xauthority(display: number, cookie: Uint8Array): Uint8Array {
  const enc = new TextEncoder()
  const fields = [new Uint8Array(0), enc.encode(String(display)), enc.encode('MIT-MAGIC-COOKIE-1'), cookie]
  const size = 2 + fields.reduce((n, f) => n + 2 + f.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0xffff)
  let at = 2
  for (const f of fields) {
    view.setUint16(at, f.length)
    out.set(f, at + 2)
    at += 2 + f.length
  }
  return out
}

/** The board's MCP server for a profile (user scope): the board command's `browser-mcp`, by its absolute path. */
export const browserMcpEntry = (board: string): Record<string, unknown> => ({
  type: 'stdio',
  command: board,
  args: ['browser-mcp'],
  env: {},
})

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A profile's .claude.json with the board's MCP server in it (`entry`) or out of it (null);
 * null when it is as asked already. Nothing else in it changes.
 */
export function withBrowserMcp(
  claudeJson: unknown,
  entry: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const cj = isRecord(claudeJson) ? claudeJson : {}
  const servers = isRecord(cj.mcpServers) ? cj.mcpServers : {}
  const now = servers[BROWSER_MCP]
  if (entry === null) {
    if (now === undefined) return null
    const { [BROWSER_MCP]: _, ...rest } = servers
    return { ...cj, mcpServers: rest }
  }
  if (JSON.stringify(now) === JSON.stringify(entry)) return null
  return { ...cj, mcpServers: { ...servers, [BROWSER_MCP]: entry } }
}

/** What `board doctor` finds of the desktops (services/desktop.ts desktopFacts). */
export interface DesktopDoctorFacts {
  xvnc: string | null
  chrome: string | null
  fonts: boolean
  /** chrome-devtools-mcp's version in place, or null. */
  mcp: string | null
  /** The shown profiles, and whether each has the board's MCP server. */
  profiles: { title: string; has: boolean }[]
}

/** `board doctor`'s checks of the desktops, in server mode: Xvnc, the browser, the fonts, chrome-devtools-mcp, the MCP server in each profile. */
export function desktopChecks(f: DesktopDoctorFacts, tr: Translator): SetupCheck[] {
  const check = (c: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'level' | 'title'>): SetupCheck => ({
    detail: '',
    fix: '',
    code: '',
    ...c,
  })
  const install = tr('desktop.check.installFix')
  const checks: SetupCheck[] = [
    f.xvnc
      ? check({ id: 'desktop-xvnc', level: 'ok', title: tr('desktop.check.xvnc'), detail: f.xvnc })
      : check({ id: 'desktop-xvnc', level: 'warn', title: tr('desktop.check.noXvnc'), fix: install }),
    f.chrome
      ? check({ id: 'desktop-chrome', level: 'ok', title: tr('desktop.check.chrome'), detail: f.chrome })
      : check({ id: 'desktop-chrome', level: 'warn', title: tr('desktop.check.noChrome'), fix: install }),
    f.fonts
      ? check({ id: 'desktop-fonts', level: 'ok', title: tr('desktop.check.fonts') })
      : check({ id: 'desktop-fonts', level: 'warn', title: tr('desktop.check.noFonts'), fix: install }),
    f.mcp === DEVTOOLS_MCP_VERSION
      ? check({ id: 'desktop-mcp', level: 'ok', title: tr('desktop.check.mcp', { version: f.mcp }) })
      : check({
          id: 'desktop-mcp',
          level: 'warn',
          title: tr('desktop.check.noMcp', { version: DEVTOOLS_MCP_VERSION }),
          detail: f.mcp ?? '',
          fix: tr('desktop.check.mcpFix'),
          code: 'herdr plugin action invoke agent-board.install',
        }),
  ]
  const missing = f.profiles.filter(p => !p.has).map(p => p.title)
  checks.push(
    missing.length
      ? check({
          id: 'desktop-profiles',
          level: 'warn',
          title: tr('desktop.check.noProfiles', { profiles: missing.join(', ') }),
          fix: tr('desktop.check.mcpFix'),
          code: 'herdr plugin action invoke agent-board.install',
        })
      : check({ id: 'desktop-profiles', level: 'ok', title: tr('desktop.check.profiles', { mcp: BROWSER_MCP }) }),
  )
  return checks
}
