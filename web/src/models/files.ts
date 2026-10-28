// The chat's files without the DOM: the icons, what a file is by its name, the raw-bytes URL,
// paths taken apart and put together with either separator, sizes and dates, the quick look's
// footer and actions, history excerpts, and how long what the server said about a path holds.
// The chips and the quick look draw from here (components/files/), as the old page's files.js did.
import type { Translator } from '../../../src/core/types.ts'
import type { ZoomState } from './zoom.ts'

const DOC = '<path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5Z"/><path d="M11.5 2.5V6H15"/>'

/** The inside of each icon (20 × 20, stroked by the stylesheet). */
export const ICON_PATHS = {
  dir: '<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  file: DOC,
  text: `${DOC}<path d="M8 10h4.5M8 12.5h4.5M8 15h3"/>`,
  markdown: `${DOC}<path d="M7.6 15v-3.6l1.3 1.6 1.3-1.6V15m2-1.4 1 1.2 1-1.2m-1 1.2v-3.4"/>`,
  json: `${DOC}<path d="m8.6 10.2-1.6 1.6 1.6 1.6m2.8-3.2 1.6 1.6-1.6 1.6"/>`,
  csv: '<rect x="3" y="4" width="14" height="12" rx="1.6"/><path d="M3 8h14M3 12h14M8 4v12"/>',
  image:
    '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m4 15 4.5-4.5 3 3 2-2 3.5 3.5"/>',
  pdf: `${DOC}<path d="M7.5 11h5M7.5 13.5h5M7.5 16h3"/>`,
  video: '<rect x="2.5" y="5" width="11" height="10" rx="2"/><path d="m13.5 9 4-2.5v7l-4-2.5"/>',
  audio: '<path d="M8 14.5V5l8-1.5V13"/><circle cx="6" cy="14.5" r="2"/><circle cx="14" cy="13" r="2"/>',
  missing: `${DOC}<path d="m8 10.5 4 4m0-4-4 4"/>`,
  link: '<path d="M7 4.5h8.5V13M15 5 5 15"/>',
  reveal:
    '<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M10 9v5m-2.2-2.2L10 14l2.2-2.2"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7"/>',
  back: '<path d="m12 4.5-5.5 5.5 5.5 5.5"/>',
  close: '<path d="m5.5 5.5 9 9m0-9-9 9"/>',
  changes:
    '<circle cx="6" cy="4.8" r="1.8"/><circle cx="6" cy="15.2" r="1.8"/><circle cx="14" cy="7.6" r="1.8"/><path d="M6 6.6v6.8M14 9.4c0 3-2.6 3.6-6.4 4.6"/>',
  clean: '<circle cx="10" cy="10" r="7"/><path d="m6.8 10.2 2.2 2.2 4.2-4.6"/>',
  refresh: '<path d="M15.6 10a5.6 5.6 0 1 1-1.7-4M15.6 3.8V7h-3.2"/>',
  history: '<path d="M3.6 10a6.4 6.4 0 1 0 1.9-4.5M3.5 3.5v3h3"/><path d="M10 6.5V10l2.4 1.6"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
} as const

export type IconName = keyof typeof ICON_PATHS

const isIconName = (kind: unknown): kind is IconName => typeof kind === 'string' && Object.hasOwn(ICON_PATHS, kind)

/** The icon a kind of file shows: its own, else a plain file for binary, else text. */
export const iconName = (kind: unknown): IconName => (isIconName(kind) ? kind : kind === 'binary' ? 'file' : 'text')

const KIND_BY_EXTENSION = new Map(
  Object.entries({
    md: 'markdown',
    markdown: 'markdown',
    json: 'json',
    csv: 'csv',
    tsv: 'csv',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    svg: 'image',
    pdf: 'pdf',
  }),
)

/** The kind of a file by its name, for the icon only (the server decides the rest). */
export const kindOfName = (p: string): string =>
  KIND_BY_EXTENSION.get((p.split('.').pop() ?? '').toLowerCase()) ?? 'text'

/** The bytes of an image, PDF, video or audio file: the run's token stands for the X-Board header. */
export const rawUrl = (path: string, token: string | null | undefined): string =>
  `/api/fs/raw?path=${encodeURIComponent(path)}&t=${encodeURIComponent(token ?? '')}`

// ---------------------------------------------------------------- paths, either separator

/** The last part of a path. */
export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export interface Crumb {
  name: string
  path: string
}

/** The folders above a path, each a step to walk to; for changes and history down to the folder itself. */
export function crumbs(path: string | undefined, kind: string | undefined): Crumb[] {
  const parts = String(path ?? '')
    .split(/[\\/]/)
    .filter((p, i) => p || i === 0)
  const sep = path?.includes('\\') ? '\\' : '/'
  const own = kind === 'changes' || kind === 'history'
  return parts.slice(0, own ? parts.length : -1).map((name, i) => ({
    name: name || sep,
    path: parts.slice(0, i + 1).join(sep) + (i === 0 ? sep : ''),
  }))
}

/** The folder a file is in. */
export const parentOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

const sepOf = (path: string) => (path.includes('\\') ? '\\' : '/')

/** A name in a folder, with the folder's own separator. */
export const inFolder = (dir: string, name: string): string => dir.replace(/[\\/]$/, '') + sepOf(dir) + name

/** A path as git gives it (with /) inside the checkout at `root`, with the root's separator. */
export const inCheckout = (root: string, rel: string): string =>
  root.replace(/[\\/]$/, '') + sepOf(root) + rel.split('/').join(sepOf(root))

// ---------------------------------------------------------------- what the quick look shows

/** A folder's entry in its preview. */
export interface FolderEntry {
  name: string
  dir: boolean
  size?: number | null | undefined
  mtime?: number | null | undefined
  kind?: string | undefined
}

/**
 * A file or folder as POST /api/fs/preview answers (adapters/files.ts preview), or the error the
 * page makes of a refusal; `line` is where it was opened at.
 */
export interface Preview {
  path?: string | undefined
  name?: string | undefined
  exists?: boolean | undefined
  dir?: boolean | undefined
  size?: number | null | undefined
  mtime?: number | null | undefined
  kind?: string | undefined
  error?: string | null | undefined
  entries?: FolderEntry[] | undefined
  total?: number | undefined
  text?: string | undefined
  truncated?: boolean | undefined
  lines?: number | undefined
  rows?: string[][] | undefined
  line?: number | null | undefined
}

/** The quick look's head: its icon, name and the folders above. */
export interface LookHead {
  kind?: string | undefined
  name?: string | undefined
  path?: string | undefined
  dir?: boolean | undefined
  error?: string | null | undefined
}

/** The head's icon: missing, a folder, else the kind. */
export const lookIcon = (d: LookHead): IconName => iconName(d.error === 'missing' ? 'missing' : d.dir ? 'dir' : d.kind)

/** The body's class: the kind it shows (the stylesheet lays each out). */
export const bodyClass = (d: Pick<LookHead, 'dir' | 'kind'>): string => `ql-body k-${d.dir ? 'dir' : d.kind}`

/**
 * Which of open, reveal and copy are off: all of them without a path that is there (a folder
 * that cannot be read is there); open and reveal also without the board (`canEdit`).
 */
export function actionsOff(d: Pick<LookHead, 'error' | 'path'> | null, canEdit: boolean) {
  const exists = (!d?.error || d.error === 'denied') && !!d?.path
  return { open: !exists || !canEdit, reveal: !exists || !canEdit, copy: !exists }
}

export function sizeText(n: number | null | undefined, t: Translator): string {
  if (n == null) return ''
  if (n < 1024) return t('size.b', { n })
  return n < 1 << 20 ? t('size.kb', { n: Math.round(n / 1024) }) : t('size.mb', { n: (n / (1 << 20)).toFixed(1) })
}

export const dateText = (ms: number, lang: string): string =>
  new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })

export const clockOf = (ms: number, lang: string): string =>
  new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })

const MEDIA = new Set(['image', 'pdf', 'video', 'audio'])

/** A preview's media are drawn from the raw bytes; text comes with the preview. */
export const isMedia = (kind: string | undefined): boolean => MEDIA.has(kind ?? '')

/** A CSV with rows is drawn as a table. */
export const isTable = (d: Preview): boolean => d.kind === 'csv' && !!d.rows?.length

/** The footer of a file or folder: what it holds, how big, how far it reads, when it changed. */
export function previewFoot(d: Preview, t: Translator): string[] {
  const foot: string[] = []
  const modified = (ms: number) => t('ql.modified', { date: dateText(ms, t.lang) })
  if (d.error) {
    // Nothing about it, but a folder that cannot be read still says when it changed (below).
  } else if (d.dir) {
    foot.push(t('ql.items', { n: d.total ?? 0 }))
    if ((d.total ?? 0) > (d.entries?.length ?? 0)) foot.push(t('ql.firstItems', { n: d.entries?.length ?? 0 }))
  } else {
    foot.push(sizeText(d.size, t))
    if (!isMedia(d.kind) && (typeof d.text === 'string' || isTable(d))) {
      foot.push(isTable(d) ? t('ql.rows', { n: (d.rows?.length ?? 1) - 1 }) : t('ql.lines', { n: d.lines ?? 0 }))
      if (d.truncated) foot.push(t('ql.truncated'))
    }
    if (d.mtime) foot.push(modified(d.mtime))
  }
  if (d.dir && d.mtime) foot.push(modified(d.mtime))
  return foot.filter(Boolean)
}

/** What the zoom bar shows of a zoom (models/zoom.ts ZoomState): the scale, and the button in to 100% or back to fit. */
export interface ZoomBarText {
  level: string
  label: string
  hint: string
}

const percents = new Map<string, Intl.NumberFormat>()
function percent(s: number, lang: string): string {
  let format = percents.get(lang)
  if (!format) {
    format = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 })
    percents.set(lang, format)
  }
  return format.format(s)
}

/**
 * What the zoom bar shows now; a zoom calls on every frame, so it is drawn again only when this
 * changes (a whole percent, or where the button goes).
 */
export const zoomShown = (z: { s: number; fit: boolean; to: number } | null): string =>
  z ? `${Math.round(z.s * 100)}|${z.fit ? Math.round(z.to * 100) : 'fit'}` : ''

/**
 * What the zoom bar draws from: the zoom on show (`now`, null when there is none, and the bar
 * hidden) and the one it showed last, whose texts it keeps while hidden, as the old bar did.
 */
export interface ZoomFoot {
  now: ZoomState | null
  last: ZoomState | null
}

export const NO_ZOOM: ZoomFoot = { now: null, last: null }

export const zoomFootAfter = (foot: ZoomFoot, z: ZoomState | null): ZoomFoot => ({ now: z, last: z ?? foot.last })

/** The zoom bar's texts: the scale, and the button in to the scale a zoom from fit goes to, or back to fit. */
export function zoomBar(z: { s: number; fit: boolean; to: number }, t: Translator): ZoomBarText {
  const label = z.fit ? percent(z.to, t.lang) : t('ql.fit')
  return { level: percent(z.s, t.lang), label, hint: z.fit ? t('ql.zoomTo', { pct: label }) : t('ql.fitHint') }
}

/** Text in numbered lines: a final line break ends the last line, it starts none. */
export function codeLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

// ---------------------------------------------------------------- past sessions

export interface MarkPart {
  text: string
  hit: boolean
}

/** The text in parts, every place the query matches (case aside) a hit. */
export function markParts(text: string, query: string | undefined): MarkPart[] {
  const low = text.toLowerCase()
  const q = String(query ?? '').toLowerCase()
  const parts: MarkPart[] = []
  const plain = (s: string) => s && parts.push({ text: s, hit: false })
  let i = 0
  for (let at = q ? low.indexOf(q) : -1; at >= 0; at = low.indexOf(q, i)) {
    plain(text.slice(i, at))
    parts.push({ text: text.slice(at, at + q.length), hit: true })
    i = at + q.length
  }
  plain(text.slice(i))
  return parts
}

/** A hit's excerpt without Markdown's marks; `cut` when the message goes on before it. */
export const excerptOf = (r: { text: string; excerpt: string }): { cut: boolean; text: string } => ({
  cut: r.text.indexOf(r.excerpt) > 0,
  text: r.excerpt.replace(/\*\*|__|`/g, ''),
})

// ---------------------------------------------------------------- what the server said about a path

/** One path as POST /api/fs/stat answers it: `raw` as the chat wrote it, `path` resolved. */
export interface PathInfo {
  raw: string
  path: string
  name: string
  exists: boolean
  dir?: boolean | undefined
  kind?: string | undefined
  line?: number | null | undefined
}

/** A path that was there holds a while; one that was not is asked again soon (the agent may make it). */
export const FRESH_MS = { found: 300_000, missing: 15_000 }

/** What the server said about paths, by the session folder they were written in. */
export function statBook() {
  const known = new Map<string, { at: number; info: PathInfo }>()
  const key = (cwd: string, raw: string) => `${cwd}\n${raw}`
  return {
    get(cwd: string, raw: string, now: number): PathInfo | null {
      const hit = known.get(key(cwd, raw))
      if (!hit) return null
      return now - hit.at > (hit.info.exists ? FRESH_MS.found : FRESH_MS.missing) ? null : hit.info
    },
    put(cwd: string, info: PathInfo, now: number): void {
      known.set(key(cwd, info.raw), { at: now, info })
    },
  }
}

export type StatBook = ReturnType<typeof statBook>
