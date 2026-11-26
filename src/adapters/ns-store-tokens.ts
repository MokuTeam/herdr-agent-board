// The NetSuite session store's bridge tokens (#860, contract ns-contract-final.md): one per
// MokuTab bridge data dir on this computer, in `<data dir>/ns-store.json` (0600)
// { url, token, node }, which the bridge reads (again when its mtime changes) and sends as
// X-NS-Store-Token. The board that wrote it checks it: a node before it relays (the token never
// leaves this computer), the master for its own bridges. Never logged.
//
// The data dirs are found, not configured, and only folders that exist get a file: a computer
// without MokuTab gets nothing, and its bridge's module stays off (store_unconfigured). Written at
// the board's start; a token that does not match rescans (at most once a minute), so a bridge
// installed after the board started gets one too.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { replaceFile } from './json-store.ts'

export const NS_STORE_FILE = 'ns-store.json'
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

/** `MOKUTAB_DATA_DIR` as a host wrapper exports it, or null (a wrapper that sets none uses ~/.mokutab). */
export function wrapperDataDir(text: string, home: string): string | null {
  const m = /^\s*(?:export\s+)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*MOKUTAB_DATA_DIR=("([^"]*)"|'([^']*)'|(\S+))/m.exec(text)
  const dir = m?.[2] ?? m?.[3] ?? m?.[4]
  if (!dir || dir.includes('$(') || dir.includes('`')) return null
  return dir.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home)
}

/**
 * The MokuTab bridge data dirs on this computer that exist: `BOARD_NS_BRIDGE_DIRS` (a path list)
 * when set; else `MOKUTAB_DATA_DIR` or ~/.mokutab, and the data dir each installed host wrapper
 * of a server node exports (`~/browser/bin/mokutab-host-*`, docs/design/nodes/browser).
 */
export function nsBridgeDirs(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const given = env.BOARD_NS_BRIDGE_DIRS
  if (given !== undefined) return given.split(delimiter).filter(d => d && isDir(d))
  const found = [env.MOKUTAB_DATA_DIR || join(home, '.mokutab')]
  const bin = join(home, 'browser', 'bin')
  let wrappers: string[] = []
  try {
    wrappers = readdirSync(bin)
      .filter(f => f.startsWith('mokutab-host-'))
      .sort()
  } catch {}
  for (const w of wrappers) {
    try {
      const dir = wrapperDataDir(readFileSync(join(bin, w), 'utf8'), home)
      if (dir) found.push(dir)
    } catch {}
  }
  return [...new Set(found)].filter(isDir)
}

export interface NsStoreFile {
  url: string
  token: string
  node: string
}

/**
 * `<dir>/ns-store.json` as it should be: its token kept when it has one, the file rewritten only
 * when it says something else. Returns the token, or null when the folder cannot take it.
 */
export function ensureNsStoreFile(dir: string, url: string, node: string): string | null {
  const file = join(dir, NS_STORE_FILE)
  let had: Partial<NsStoreFile> = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') had = raw as Partial<NsStoreFile>
  } catch {}
  const token =
    typeof had.token === 'string' && TOKEN.test(had.token) ? had.token : randomBytes(32).toString('base64url')
  const mode = (() => {
    try {
      return statSync(file).mode & 0o777
    } catch {
      return -1
    }
  })()
  if (had.token === token && had.url === url && had.node === node && (process.platform === 'win32' || mode === 0o600))
    return token
  try {
    replaceFile(file, `${JSON.stringify({ url, token, node }, null, 2)}\n`, undefined, 0o600)
    return token
  } catch {
    return null
  }
}

export interface NsTokens {
  /** Whether `given` is the token of one of this computer's bridges. */
  check(given: string | null): boolean
  /** Writes the files of the bridges found now; returns how many there are. */
  refresh(): number
}

export function createNsTokens(o: {
  dirs: () => string[]
  /** The store's base URL on this board (http://127.0.0.1:<port>/api/ns-sessions). */
  url: () => string
  /** This machine's name, as the bridge reports it. */
  node: () => string
  log?: (line: string) => void
  now?: () => number
}): NsTokens {
  const now = o.now ?? Date.now
  let tokens: Buffer[] = []
  let scanned = Number.NEGATIVE_INFINITY

  function refresh(): number {
    scanned = now()
    const next: Buffer[] = []
    const url = o.url()
    const node = o.node()
    for (const dir of o.dirs()) {
      const t = ensureNsStoreFile(dir, url, node)
      if (t) next.push(Buffer.from(t))
      else o.log?.(`ns-sessions: could not write ${NS_STORE_FILE} in ${dir}`)
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
