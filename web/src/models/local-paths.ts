// The board seen from another computer (models/remote-page.ts) whose disk has the server's folders
// shared (Samba: /data/work as Z:\ on Windows, /Volumes/work on a Mac): where a file the chat
// names is on this device. Each device keeps its own list of server folder → folder here in its
// browser; with none kept it starts from a suggestion for its system. Nothing here opens a file.

/** One server folder and where it is on this device. */
export interface PathMap {
  server: string
  local: string
}

/** The server's shared folder the suggestions start from. */
export const SERVER_ROOT = '/data/work'

export const LOCAL_PATHS_KEY = 'agent-board:local-paths'

export type DevicePlatform = 'windows' | 'mac' | 'other'

/** The device's system as its browser says it (userAgentData where there is one, else the user agent). */
export function devicePlatform(nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } }) {
  const said = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`
  // An iPad says Macintosh too, but has no /Volumes to open from; a phone has no shares at all.
  if (/iPhone|iPad|iPod|Android/i.test(said)) return 'other'
  if (/Win/i.test(said)) return 'windows'
  return /Mac/i.test(said) ? 'mac' : 'other'
}

/** What a device with nothing kept starts from. */
export function suggestedMaps(platform: DevicePlatform, server = SERVER_ROOT): PathMap[] {
  if (platform === 'windows') return [{ server, local: 'Z:\\' }]
  return platform === 'mac' ? [{ server, local: '/Volumes/work' }] : []
}

const isMap = (m: unknown): m is PathMap =>
  !!m && typeof (m as PathMap).server === 'string' && typeof (m as PathMap).local === 'string'

/** The list kept in the browser: null when there is none (or it cannot be read), the suggestion's turn. */
export function mapsOf(kept: string | null): PathMap[] | null {
  if (kept === null) return null
  try {
    const list: unknown = JSON.parse(kept)
    return Array.isArray(list) ? list.filter(isMap) : null
  } catch {
    return null
  }
}

/** A drive (Z:\) or a share (\\host\work): this device writes paths with backslashes. */
const windowsish = (local: string) => /^[A-Za-z]:/.test(local) || local.startsWith('\\\\')

/** A server folder as it is compared: its trailing slashes off, the root kept. */
const folder = (path: string) => path.trim().replace(/\/+$/, '') || (path.trim().startsWith('/') ? '/' : '')

/**
 * Where `path` (on the server) is on this device: the longest server folder it is inside, whole
 * names only (/data/work does not take /data/workshop), joined onto its folder here with that
 * folder's separators. Null when no folder takes it.
 */
export function localPath(path: string, maps: readonly PathMap[]): string | null {
  let best: { server: string; local: string } | null = null
  for (const m of maps) {
    const server = folder(m.server)
    const local = m.local.trim()
    if (!server || !local) continue
    const inside = path === server || path.startsWith(server === '/' ? '/' : `${server}/`)
    if (inside && (!best || server.length > best.server.length)) best = { server, local }
  }
  if (!best) return null
  const rest = path.slice(best.server === '/' ? 0 : best.server.length).replace(/^\/+/, '')
  if (windowsish(best.local)) {
    const base = best.local.replace(/[\\/]+$/, '')
    const root = /^[A-Za-z]:$/.test(base) ? `${base}\\` : base
    return rest ? `${base}\\${rest.split('/').join('\\')}` : root
  }
  const base = best.local.replace(/\/+$/, '')
  return rest ? `${base}/${rest}` : base || '/'
}

/** Any file as a download: the run's token stands for the X-Board header an <a> cannot send. */
export const downloadUrl = (path: string, token: string | null | undefined): string =>
  `/api/fs/download?path=${encodeURIComponent(path)}&t=${encodeURIComponent(token ?? '')}`

/**
 * The quick look's tools for the board on another device (`maps` null: the board at the computer,
 * none of them): a file that is there downloads; anything there inside a kept folder has a path here.
 */
export function remoteTools(
  d: { path?: string | undefined; dir?: boolean | undefined; error?: string | null | undefined } | null,
  maps: readonly PathMap[] | null,
  token: string | null | undefined,
): { download: string | null; local: string | null } {
  const path = d?.path
  if (!maps || !path || (d.error && d.error !== 'denied')) return { download: null, local: null }
  return { download: d.dir || d.error ? null : downloadUrl(path, token), local: localPath(path, maps) }
}
