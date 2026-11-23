// Browser profile discovery, mokutab-bridge lease/tab inspection, and safe CDP tab closure (#652).
// Only invoked when `housekeeping.tabs.on` is true or `board housekeeping --dry-run` is run;
// boards without housekeeping never touch Chrome, CDP, or mokutab.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type BrowserProfileConfig, type BrowserTabInfo, type TabLeaseInfo, tabSeenKey } from '../core/housekeeping.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import { stateDir } from './paths.ts'

export interface DiscoveredProfile {
  name: string
  cdpPort?: number
  mokutabPort?: number
}

export interface BrowserInspection {
  /** False when mokutab-bridge was unreachable or returned an invalid profile list. */
  reachable: boolean
  leasesKnown: boolean
  leases: TabLeaseInfo[]
  profiles: { name: string; cdpPort?: number; tabs: BrowserTabInfo[]; error?: boolean }[]
  note?: string
}

export type TabCloseOutcome =
  | { closed: true }
  | { closed: false; reason: 'beforeunload' | 'not-found' | 'ambiguous' | 'error'; detail?: string }

/** State file remembering when tabs without Chrome lastAccessed were first observed. */
export const housekeepingTabsFile = (): string => join(stateDir(), 'housekeeping-tabs.json')

const isSeenMap = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.values(v).every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)

export function readTabSeen(file: string = housekeepingTabsFile()): Record<string, number> {
  return readJson(file, isSeenMap) ?? {}
}

/**
 * Update seen timestamps for live tabs and prune entries for tabs that no longer exist.
 * When `reachable` is false (mokutab-bridge transiently down), returns `prev` untouched without
 * overwriting the state file. Profiles whose tab query failed (`p.error === true`) keep their
 * previously recorded timestamps instead of being wiped.
 */
export function updateTabSeen(
  prev: Readonly<Record<string, number>>,
  profiles: readonly { name: string; tabs: readonly BrowserTabInfo[]; error?: boolean }[],
  now: number,
  file: string = housekeepingTabsFile(),
  persist = true,
  reachable = true,
): Record<string, number> {
  if (!reachable) return { ...prev }
  const next: Record<string, number> = {}
  const failedProfiles = new Set<string>()
  for (const p of profiles) {
    if (p.error) {
      failedProfiles.add(p.name)
      continue
    }
    for (const t of p.tabs) {
      const k = tabSeenKey(p.name, t.tabId)
      next[k] = t.lastAccessed ?? prev[k] ?? now
    }
  }
  if (failedProfiles.size) {
    for (const [k, v] of Object.entries(prev)) {
      const sep = k.indexOf(':')
      if (sep > 0 && failedProfiles.has(k.slice(0, sep))) next[k] = v
    }
  }
  if (persist) {
    try {
      replaceFile(file, JSON.stringify(next), undefined, 0o600)
    } catch {}
  }
  return next
}

/** Discover browser profiles from `~/browser/profiles/*.env` (standard node layout). */
export function discoverBrowserProfiles(home: string = homedir()): DiscoveredProfile[] {
  const dir = join(home, 'browser', 'profiles')
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith('.env'))
      .sort()
  } catch {
    return []
  }
  const out: DiscoveredProfile[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8')
      const kv = new Map<string, string>()
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
        if (m?.[1] && m[2]) kv.set(m[1], m[2].replace(/^["']|["']$/g, ''))
      }
      const name = kv.get('PROFILE') || file.slice(0, -4)
      const cdp = Number(kv.get('CDP_PORT'))
      const moku = Number(kv.get('MOKUTAB_PORT'))
      out.push({
        name,
        ...(Number.isInteger(cdp) && cdp > 0 && cdp < 65536 && { cdpPort: cdp }),
        ...(Number.isInteger(moku) && moku > 0 && moku < 65536 && { mokutabPort: moku }),
      })
    } catch {}
  }
  return out
}

interface McpReply {
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean }
}

/** Parse either plain JSON or SSE (`data: {...}`) MCP HTTP response body. */
function parseMcpBody(text: string): McpReply | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as McpReply
    } catch {
      return null
    }
  }
  let last: McpReply | null = null
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      last = JSON.parse(line.slice(5).trim()) as McpReply
    } catch {}
  }
  return last
}

/** Minimal MCP Streamable HTTP client for local `mokutab-bridge` on 127.0.0.1. */
async function createMokutabClient(
  port: number,
  timeoutMs = 5000,
): Promise<{ call(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> } | null> {
  const url = `http://127.0.0.1:${port}/mcp`
  let sessionId: string | null = null
  let nextId = 1
  const post = async (body: unknown): Promise<{ res: Response; parsed: McpReply | null }> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    return { res, parsed: parseMcpBody(text) }
  }
  try {
    const init = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'agent-board-housekeeping', version: '1.0.0' },
      },
    })
    if (!init.res.ok) return null
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {})
  } catch {
    return null
  }
  return {
    async call(name, args) {
      const { res, parsed } = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      })
      if (!res.ok || parsed?.result?.isError) return null
      const text = parsed?.result?.content?.find(c => typeof c.text === 'string')?.text
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        return null
      }
    },
    async close() {
      if (!sessionId) return
      await fetch(url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId },
        signal: AbortSignal.timeout(1000),
      }).catch(() => {})
    },
  }
}

function parseTabsFromMokutab(raw: unknown): BrowserTabInfo[] {
  const r = isRecord(raw) ? raw : null
  const windows = Array.isArray(r?.windows) ? r.windows : []
  const tabs: BrowserTabInfo[] = []
  for (const win of windows) {
    if (!isRecord(win) || typeof win.windowId !== 'number') continue
    const list = Array.isArray(win.tabs) ? win.tabs : []
    for (const tab of list) {
      if (!isRecord(tab)) continue
      const tabId = typeof tab.tabId === 'number' ? tab.tabId : typeof tab.id === 'number' ? tab.id : null
      if (tabId === null) continue
      const url = typeof tab.url === 'string' ? tab.url : ''
      const lastAccessed =
        typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0
          ? tab.lastAccessed
          : null
      tabs.push({
        tabId,
        windowId: win.windowId,
        url,
        pinned: tab.pinned === true,
        active: tab.active === true,
        lastAccessed,
      })
    }
  }
  return tabs
}

/**
 * Inspect connected browser profiles, their tabs, and active mokutab leases.
 * Uses `mokutab-bridge` on 127.0.0.1:<mokutabPort> (the source of truth for leases, windows, pinned,
 * and lastAccessed), combined with discovered/configured CDP ports for safe beforeunload-aware closing.
 */
export async function inspectBrowsers(opts: {
  mokutabPort: number
  configuredProfiles: readonly BrowserProfileConfig[]
  home?: string
  timeoutMs?: number
}): Promise<BrowserInspection> {
  const discovered = discoverBrowserProfiles(opts.home)
  const cdpByProfile = new Map<string, number>()
  for (const d of discovered) if (d.cdpPort) cdpByProfile.set(d.name, d.cdpPort)
  for (const c of opts.configuredProfiles) if (c.cdpPort) cdpByProfile.set(c.name, c.cdpPort)

  const client = await createMokutabClient(opts.mokutabPort, opts.timeoutMs ?? 5000)
  if (!client) {
    return {
      reachable: false,
      leasesKnown: false,
      leases: [],
      profiles: [],
      note: `mokutab-bridge not reachable on 127.0.0.1:${opts.mokutabPort}`,
    }
  }
  try {
    const info = await client.call('chrome_list_profiles', {})
    const r = isRecord(info) ? info : null
    if (!r) {
      return {
        reachable: false,
        leasesKnown: false,
        leases: [],
        profiles: [],
        note: 'mokutab-bridge returned an invalid profile list',
      }
    }
    const connected = Array.isArray(r.connected_profiles)
      ? r.connected_profiles.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : []
    const leases: TabLeaseInfo[] = []
    if (Array.isArray(r.leases)) {
      for (const l of r.leases) {
        if (isRecord(l) && typeof l.profile === 'string' && typeof l.tabId === 'number') {
          leases.push({ profile: l.profile, tabId: l.tabId })
        }
      }
    }
    const wantNames = opts.configuredProfiles.length
      ? opts.configuredProfiles.map(p => p.name).filter(n => connected.includes(n))
      : connected

    const profiles: BrowserInspection['profiles'] = []
    for (const name of wantNames) {
      const rawTabs = await client.call('get_windows_and_tabs', { profile: name })
      const cdpPort = cdpByProfile.get(name)
      if (!isRecord(rawTabs) || !Array.isArray(rawTabs.windows)) {
        profiles.push({ name, ...(cdpPort !== undefined && { cdpPort }), tabs: [], error: true })
        continue
      }
      const tabs = parseTabsFromMokutab(rawTabs)
      profiles.push({ name, ...(cdpPort !== undefined && { cdpPort }), tabs })
    }
    return {
      reachable: true,
      leasesKnown: Array.isArray(r.leases),
      leases,
      profiles,
      ...(!wantNames.length && { note: 'no connected Chrome profiles in mokutab-bridge' }),
    }
  } finally {
    await client.close()
  }
}

interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * Safely close a tab via CDP `Page.close`, cancelling and keeping the tab if a `beforeunload` dialog
 * opens. Refuses when multiple page targets match `url` (ambiguous target could hit a pinned or
 * leased tab). Never forces close over an unsaved-form confirmation.
 */
export async function closeTabViaCdp(cdpPort: number, url: string, timeoutMs = 4000): Promise<TabCloseOutcome> {
  let targets: CdpTarget[]
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { closed: false, reason: 'error', detail: `CDP HTTP ${res.status}` }
    const raw = (await res.json()) as unknown
    targets = Array.isArray(raw) ? (raw as CdpTarget[]) : []
  } catch (err) {
    return { closed: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  const matches = targets.filter(t => t.type === 'page' && t.url === url && typeof t.webSocketDebuggerUrl === 'string')
  if (matches.length === 0) return { closed: false, reason: 'not-found' }
  if (matches.length > 1) return { closed: false, reason: 'ambiguous', detail: 'multiple tabs share this URL' }
  const target = matches[0]
  if (!target?.webSocketDebuggerUrl) return { closed: false, reason: 'not-found' }

  return new Promise<TabCloseOutcome>(resolve => {
    let settled = false
    let sentClose = false
    let beforeUnloadSeen = false
    const finish = (outcome: TabCloseOutcome, ws?: WebSocket): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {}
      resolve(outcome)
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl as string)
    const timer = setTimeout(() => finish({ closed: false, reason: 'error', detail: 'CDP timeout' }, ws), timeoutMs)
    ws.onopen = () => {
      sentClose = true
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
      ws.send(JSON.stringify({ id: 2, method: 'Page.close' }))
    }
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number
          method?: string
          params?: { type?: string }
          error?: { message?: string }
        }
        if (msg.method === 'Page.javascriptDialogOpening' && msg.params?.type === 'beforeunload') {
          beforeUnloadSeen = true
          ws.send(JSON.stringify({ id: 3, method: 'Page.handleJavaScriptDialog', params: { accept: false } }))
          setTimeout(() => finish({ closed: false, reason: 'beforeunload' }, ws), 150)
          return
        }
        if (msg.id === 2 && msg.error) {
          finish({ closed: false, reason: 'error', ...(msg.error.message ? { detail: msg.error.message } : {}) }, ws)
        }
      } catch {}
    }
    ws.onclose = () => {
      if (beforeUnloadSeen) finish({ closed: false, reason: 'beforeunload' })
      else if (!sentClose) finish({ closed: false, reason: 'error', detail: 'CDP closed before Page.close' })
      else finish({ closed: true })
    }
    ws.onerror = () => finish({ closed: false, reason: 'error', detail: 'CDP websocket error' }, ws)
  })
}

/** Close a tab via CDP when `cdpPort` is known (enforcing beforeunload guard), else refuse safely. */
export async function closeBrowserTabSafely(opts: {
  cdpPort?: number
  url: string
  timeoutMs?: number
}): Promise<TabCloseOutcome> {
  if (!opts.cdpPort) {
    return { closed: false, reason: 'error', detail: 'no CDP port for beforeunload check' }
  }
  return closeTabViaCdp(opts.cdpPort, opts.url, opts.timeoutMs)
}
