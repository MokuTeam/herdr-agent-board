// The NetSuite session store's bridge tokens (#860): one per MokuTab bridge on this computer, in
// `<bridge data dir>/ns-store-token` (0600), which the bridge reads and sends as X-NS-Store-Token
// on the store's value endpoints. The board checks it against what it wrote; a node checks it
// before it relays, and the token itself never leaves this computer. Never logged.
//
// The bridge data dirs are found, not configured: only folders that exist get a file, so a
// computer without MokuTab gets nothing. Written at the board's start; a token that does not match
// rescans (at most once a minute), so a bridge installed after the board started gets one too.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { replaceFile } from './json-store.ts'

export const NS_TOKEN_FILE = 'ns-store-token'
export const NS_TOKEN_HEADER = 'x-ns-store-token'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const RESCAN_MS = 60_000

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The MokuTab bridge data dirs on this computer that exist: `BOARD_NS_BRIDGE_DIRS` (a path list)
 * when set; else the bridge's own state dir as the bridge picks it (its default-profile.json's
 * folder: `MOKUTAB_UPDATE_STATE_DIR`, else %LOCALAPPDATA%\\mcp-chrome-bridge on Windows,
 * ~/Library/Logs/mcp-chrome-bridge on macOS, ${XDG_STATE_HOME:-~/.local/state}/mcp-chrome-bridge
 * elsewhere) and each browser profile's bridge of a server node (`~/browser/state/<profile>/state/
 * mcp-chrome-bridge`, docs/design/nodes/browser).
 */
export function nsBridgeDirs(
  home: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const given = env.BOARD_NS_BRIDGE_DIRS
  if (given !== undefined) return given.split(delimiter).filter(d => d && isDir(d))
  const own =
    env.MOKUTAB_UPDATE_STATE_DIR ||
    (platform === 'win32'
      ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'mcp-chrome-bridge')
      : platform === 'darwin'
        ? join(home, 'Library', 'Logs', 'mcp-chrome-bridge')
        : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'mcp-chrome-bridge'))
  const out: string[] = isDir(own) ? [own] : []
  const states = join(home, 'browser', 'state')
  let profiles: string[] = []
  try {
    profiles = readdirSync(states).sort()
  } catch {}
  for (const p of profiles) {
    const dir = join(states, p, 'state', 'mcp-chrome-bridge')
    if (dir !== own && isDir(dir)) out.push(dir)
  }
  return out
}

/** The token in `dir`, written when there is none (or one that is not a token). Null when the folder cannot take it. */
export function ensureNsToken(dir: string): string | null {
  const file = join(dir, NS_TOKEN_FILE)
  try {
    if (existsSync(file)) {
      const had = readFileSync(file, 'utf8').trim()
      if (TOKEN.test(had)) {
        try {
          chmodSync(file, 0o600)
        } catch {}
        return had
      }
    }
    const token = randomBytes(32).toString('base64url')
    replaceFile(file, `${token}\n`, undefined, 0o600)
    return token
  } catch {
    return null
  }
}

export interface NsTokens {
  /** Whether `given` is the token of one of this computer's bridges. */
  check(given: string | null): boolean
  /** Writes the tokens of the bridges found now; returns how many there are. */
  refresh(): number
}

export function createNsTokens(o: {
  dirs: () => string[]
  log?: (line: string) => void
  now?: () => number
}): NsTokens {
  const now = o.now ?? Date.now
  let tokens: Buffer[] = []
  let scanned = Number.NEGATIVE_INFINITY

  function refresh(): number {
    scanned = now()
    const next: Buffer[] = []
    for (const dir of o.dirs()) {
      const t = ensureNsToken(dir)
      if (t) next.push(Buffer.from(t))
      else o.log?.(`ns-sessions: could not write the bridge token in ${dir}`)
    }
    tokens = next
    return next.length
  }

  const matches = (given: Buffer): boolean => tokens.some(t => t.length === given.length && timingSafeEqual(t, given))

  return {
    refresh,
    check(given) {
      if (!given || !TOKEN.test(given)) return false
      const g = Buffer.from(given)
      if (matches(g)) return true
      if (now() - scanned < RESCAN_MS) return false
      refresh()
      return matches(g)
    },
  }
}
