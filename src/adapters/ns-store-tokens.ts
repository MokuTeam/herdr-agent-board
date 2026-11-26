// The NetSuite session store's bridge tokens (#860, contract ns-store-contract-v1.md): one per
// MokuTab bridge state dir on this computer, in `<bridge state dir>/ns-store-token` (0600) next to
// the bridge's default-profile.json. Line 1: the token. Line 2, only when the store is not at
// http://127.0.0.1:12422/api/ns-sessions: its base URL. The bridge reads it (again when its mtime
// changes) and sends X-NS-Store-Token. The board that wrote it checks it: a node before it relays
// (the token never leaves this computer), the master for its own bridges. Never logged.
//
// The state dirs are found, not configured: a folder that holds default-profile.json. A computer
// without MokuTab gets nothing, and its bridge's module stays off (store_unconfigured). Written at
// the board's start, rescanned periodically (every minute) so a dir appearing later or missing its
// token file gets one without waiting for a miss or restart, and rescanned on a token miss (at most
// once a minute).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { replaceFile } from './json-store.ts'

export const NS_TOKEN_FILE = 'ns-store-token'
export const NS_TOKEN_HEADER = 'x-ns-store-token'
export const NS_DEFAULT_URL = 'http://127.0.0.1:12422/api/ns-sessions'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
export const NS_TOKEN_RESCAN_MS = 60_000

/** A bridge's state dir: the folder its default-profile.json is in. */
const isBridgeDir = (p: string): boolean => existsSync(join(p, 'default-profile.json'))

/**
 * The MokuTab bridge state dirs on this computer, those that hold default-profile.json:
 * `BOARD_NS_BRIDGE_DIRS` (a path list) when set; else the bridge's own as it picks it
 * (`MOKUTAB_UPDATE_STATE_DIR`, else %LOCALAPPDATA%\\mcp-chrome-bridge on Windows,
 * ~/Library/Logs/mcp-chrome-bridge on macOS, ${XDG_STATE_HOME:-~/.local/state}/mcp-chrome-bridge
 * elsewhere), and each browser profile's of a server node (`~/browser/state/<profile>/state/
 * mcp-chrome-bridge`, docs/design/nodes/browser).
 */
export function nsBridgeDirs(
  home: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const given = env.BOARD_NS_BRIDGE_DIRS
  if (given !== undefined) return given.split(delimiter).filter(d => d && isBridgeDir(d))
  const found = [
    env.MOKUTAB_UPDATE_STATE_DIR ||
      (platform === 'win32'
        ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'mcp-chrome-bridge')
        : platform === 'darwin'
          ? join(home, 'Library', 'Logs', 'mcp-chrome-bridge')
          : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'mcp-chrome-bridge')),
  ]
  const states = join(home, 'browser', 'state')
  let profiles: string[] = []
  try {
    profiles = readdirSync(states).sort()
  } catch {}
  for (const p of profiles) found.push(join(states, p, 'state', 'mcp-chrome-bridge'))
  return [...new Set(found)].filter(isBridgeDir)
}

/**
 * `<dir>/ns-store-token` as it should be: its token kept when it has one, line 2 only for a URL
 * other than the default, the file rewritten only when it says something else. Returns the token,
 * or null when the folder cannot take it.
 */
export function ensureNsToken(dir: string, url: string = NS_DEFAULT_URL): string | null {
  const file = join(dir, NS_TOKEN_FILE)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {}
  const had = text.split(/\r?\n/)[0]?.trim() ?? ''
  const token = TOKEN.test(had) ? had : randomBytes(32).toString('base64url')
  const want = url === NS_DEFAULT_URL ? `${token}\n` : `${token}\n${url}\n`
  let mode = -1
  try {
    mode = statSync(file).mode & 0o777
  } catch {}
  if (text === want && (process.platform === 'win32' || mode === 0o600)) return token
  try {
    replaceFile(file, want, undefined, 0o600)
    return token
  } catch {
    return null
  }
}

export interface NsTokens {
  /** Whether `given` is the token of one of this computer's bridges. */
  check(given: string | null): boolean
  /** Writes the token files of the bridges found now; returns how many there are. */
  refresh(): number
  /** Starts periodic rescans of the bridge state dirs (default NS_TOKEN_RESCAN_MS). */
  start(intervalMs?: number): void
  /** Stops periodic rescans. */
  stop(): void
}

export function createNsTokens(o: {
  dirs: () => string[]
  /** The store's base URL on this board (http://127.0.0.1:<port>/api/ns-sessions). */
  url: () => string
  log?: (line: string) => void
  now?: () => number
}): NsTokens {
  const now = o.now ?? Date.now
  let tokens: Buffer[] = []
  let scanned = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setInterval> | undefined

  function refresh(): number {
    scanned = now()
    const next: Buffer[] = []
    const url = o.url()
    for (const dir of o.dirs()) {
      const t = ensureNsToken(dir, url)
      if (t) next.push(Buffer.from(t))
      else o.log?.(`ns-sessions: could not write ${NS_TOKEN_FILE} in ${dir}`)
    }
    tokens = next
    return next.length
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  function start(intervalMs: number = NS_TOKEN_RESCAN_MS): void {
    stop()
    if (!(intervalMs > 0)) return
    timer = setInterval(() => {
      try {
        refresh()
      } catch (err) {
        o.log?.(`ns-sessions: token rescan failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, intervalMs)
    timer.unref?.()
  }

  const matches = (given: Buffer): boolean => tokens.some(t => t.length === given.length && timingSafeEqual(t, given))

  return {
    refresh,
    start,
    stop,
    check(given) {
      if (!given || !TOKEN.test(given)) return false
      const g = Buffer.from(given)
      if (matches(g)) return true
      if (now() - scanned < NS_TOKEN_RESCAN_MS) return false
      refresh()
      return matches(g)
    },
  }
}
