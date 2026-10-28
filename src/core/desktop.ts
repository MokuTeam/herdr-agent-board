// Each agent's own browser on the board's server (the board-on-own-server spec's "Later: each
// agent's own browser"): per session, on demand, an X display of its own (Xvnc: the X server and
// its VNC in one, VNC on a Unix socket only, X with a cookie of its own), a headed Chrome on it
// with its own profile folder and DevTools port on 127.0.0.1, watched and taken over from the
// board over VNC through its login, and reached by the agent through the board's MCP wrapper
// (`board browser-mcp`: chrome-devtools-mcp pointed at that Chrome, its calls held while the owner
// has the browser). Server mode only: a board on a PC has none of it.
//
// Here: the slots (display and port), the programs' arguments, the X cookie file, the profile
// names, the control, the card's field, the MCP server's entry in a profile's .claude.json and
// `board doctor`'s checks. Pure, with no node: import.
import type { SetupCheck } from './setup.ts'
import type { ItemDesktop, Translator } from './types.ts'

/** The first display a desktop takes (:100), clear of a person's own (:0, :1, …). */
export const DISPLAY_BASE = 100
/** The first DevTools port; a slot's is this plus its number. */
export const PORT_BASE = 9300
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

export type Control = 'agent' | 'owner'

/** A slot's display (:100 and up) and DevTools port (9300 and up). */
export const slotDisplay = (slot: number): number => DISPLAY_BASE + slot
export const slotPort = (slot: number): number => PORT_BASE + slot

/** The lowest slot no desktop uses and nothing else holds (an X display's lock, the port), or null when all are. */
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
 * Chrome's arguments: headed on the display, its own profile folder and DevTools port (on
 * 127.0.0.1, Chrome's default), its window over the whole screen (there is no window manager),
 * no first-run questions, no keyring (none on a server), /tmp for its shared memory.
 */
export function chromeArgs(o: { profileDir: string; port: number; extra?: readonly string[] }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    `--remote-debugging-port=${o.port}`,
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
