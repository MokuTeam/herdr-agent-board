// Local files and folders the chat mentions: what a path is, a preview of it, and opening it
// with the system. Paths come as agents write them: absolute, herdr-reveal: or file: links,
// ~/..., or relative to the session's folder, with an optional :line(:column).
// Only the board's own page reaches this: its POSTs carry the X-Board header, and raw bytes
// (for <img>, <video>, the PDF viewer) need FILE_TOKEN, which only that page can read.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, type Dirent, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'

export const FILE_TOKEN = randomBytes(18).toString('base64url')

const TEXT_LIMIT = 512 << 10 // bytes of a text file shown
const LINE_LIMIT = 5000
// A CSV is a table of many thousand rows; the page draws them as they scroll into view.
const CSV_LIMIT = 4 << 20
const CSV_ROWS = 20_000
const DIR_LIMIT = 1000

const EXT = {
  image: 'png jpg jpeg gif webp bmp ico svg avif',
  pdf: 'pdf',
  video: 'mp4 webm m4v mov ogv',
  audio: 'mp3 wav ogg oga m4a flac aac opus',
  markdown: 'md markdown mdx',
  json: 'json jsonc webmanifest',
  csv: 'csv tsv',
  text: 'txt log text ini cfg conf toml yaml yml xml html htm css scss less js mjs cjs jsx ts tsx mts cts vue svelte py rb go rs java kt kts swift c h cc cpp hpp cs fs vb php pl lua r sql sh bash zsh fish ps1 psm1 psd1 bat cmd gradle properties env gitignore gitattributes editorconfig dockerfile makefile lock jsonl ndjson diff patch srt vtt rst tex bib graphql proto',
}
const KIND_OF = new Map<string, string>(
  Object.entries(EXT).flatMap(([kind, list]) => list.split(' ').map((e): [string, string] => [e, kind])),
)
const NAMED = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile'])

export const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/ogg',
}

export interface FileInfo {
  path: string
  name: string
  exists: boolean
  dir?: boolean
  size?: number | null
  mtime?: number | null
  kind?: string
}

export interface FileEntry {
  name: string
  dir: boolean
  size: number | null
  mtime: number | null
  kind: string
}

export interface Preview extends FileInfo {
  error?: string
  entries?: FileEntry[]
  total?: number
  text?: string
  truncated?: boolean
  lines?: number
  rows?: string[][]
}

const ext = (p: string): string => extname(p).slice(1).toLowerCase()

/** What a file is by its name: image, pdf, video, audio, markdown, json, csv, text, or file (unknown). */
export function kindOf(path: string): string {
  const e = ext(path)
  const known = KIND_OF.get(e)
  if (known) return known
  return NAMED.has(basename(path).toLowerCase()) ? 'text' : 'file'
}

/**
 * A path as an agent wrote it to { path, line }, absolute: herdr-reveal: / file: prefixes and
 * %-escapes off, ~ expanded, relative ones resolved against the session's folder, :line(:col) split off.
 */
export function resolvePath(raw: unknown, cwd = ''): { path: string; line: number | null } {
  let p = String(raw ?? '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
  if (/^herdr-reveal:/i.test(p) || /^file:/i.test(p)) {
    // file:///work/x keeps its root slash; file:///C:/x loses it below.
    p = p.replace(/^herdr-reveal:/i, '').replace(/^file:(\/\/)?/i, '')
    try {
      p = decodeURIComponent(p)
    } catch {}
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1) // file:///C:/x
  }
  let line: number | null = null
  const m = /^(.*?[^:]):(\d+)(?::\d+)?$/.exec(p)
  const [, prefix = '', lineText = ''] = m ?? []
  if (m && !/^[A-Za-z]$/.test(prefix)) {
    p = prefix
    line = Number(lineText)
  }
  if (/^~(?=$|[\\/])/.test(p)) p = homedir() + p.slice(1)
  if (!p) return { path: '', line }
  if (!isAbsolute(p)) {
    if (!cwd) return { path: '', line }
    p = resolve(cwd, p)
  } else p = resolve(p)
  return { path: p, line }
}

/** What is at `path`: { path, name, exists, dir, size, mtime, kind }. */
export function describe(path: string): FileInfo {
  const name = basename(path) || path
  const st = path ? statSync(path, { throwIfNoEntry: false }) : null
  if (!st) return { path, name, exists: false }
  const dir = st.isDirectory()
  return {
    path,
    name,
    exists: true,
    dir,
    size: dir ? null : st.size,
    mtime: st.mtimeMs,
    kind: dir ? 'dir' : kindOf(path),
  }
}

/** The first `limit` bytes of a file and whether there was more. */
function head(path: string, size: number, limit: number): { buf: Buffer; cut: boolean } {
  const n = Math.min(size, limit)
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (!r) break
      got += r
    }
    return { buf: buf.subarray(0, got), cut: size > limit }
  } finally {
    closeSync(fd)
  }
}

/**
 * Bytes to text, or null for binary: BOMs honored, NUL bytes mean binary. `legacy`: bytes that
 * are not UTF-8 are read in the system's old code page, as Excel saves a CSV (legacyCodePage);
 * UTF-8 with a broken byte here and there (at most one in a hundred above ASCII) stays UTF-8.
 */
function decode(buf: Buffer, legacy = false): string | null {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  const sample = buf.subarray(0, 8192)
  if (sample.includes(0)) return null
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  if (!legacy) return new TextDecoder('utf-8').decode(body)
  // Streamed: a character the cut at the size limit split in two does not count as broken.
  const text = new TextDecoder('utf-8').decode(body, { stream: true })
  const broken = text.split('\uFFFD').length - 1
  if (!broken) return text
  let high = 0
  for (const b of body) if (b >= 0x80) high++
  return broken * 100 <= high ? text : new TextDecoder(legacyCodePage(body)).decode(body)
}

/** A letter above ASCII in Windows-1251 (А to я, Ё, ё) or Windows-1252 (À to ÿ). */
const highLetter = (b: number): boolean => b >= 0xc0 || b === 0xa8 || b === 0xb8
const asciiLetter = (b: number): boolean => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)

/**
 * Which old code page bytes that are not UTF-8 are in, by where their letters above ASCII sit:
 * next to each other, as in a Cyrillic word ("да", "Алёна"), Windows-1251; next to ASCII
 * letters, as a Western language's accents ("café", "Größe"), Windows-1252.
 */
export function legacyCodePage(bytes: Uint8Array): 'windows-1251' | 'windows-1252' {
  let cyrillic = 0
  let western = 0
  const end = Math.min(bytes.length, 64 << 10)
  for (let i = 1; i < end; i++) {
    const [a, b] = [bytes[i - 1] as number, bytes[i] as number]
    if (highLetter(a) && highLetter(b)) cyrillic++
    else if ((highLetter(a) && asciiLetter(b)) || (asciiLetter(a) && highLetter(b))) western++
  }
  return cyrillic > western ? 'windows-1251' : 'windows-1252'
}

const SEPARATORS = [',', ';', '\t', '|']
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

/**
 * The separator of a CSV: the one of , ; tab and | that splits the first lines into the same
 * number of fields most often (outside quotes), the one that makes more fields on a tie, the
 * comma when none splits anything. Excel with a locale whose decimals have a comma (Russian,
 * German) writes `;`, and its numbers then have commas: commas only ever between digits, with
 * another separator there, are decimal commas.
 */
export function csvSeparator(text: string): string {
  const perLine: number[][] = []
  let line = SEPARATORS.map(() => 0)
  let quoted = false
  let looseComma = false
  for (let i = 0; i < text.length && perLine.length < 50; i++) {
    const c = text[i] as string
    if (c === '"') quoted = !quoted
    else if (quoted) continue
    else if (c === '\n') {
      perLine.push(line)
      line = SEPARATORS.map(() => 0)
    } else {
      const k = SEPARATORS.indexOf(c)
      if (k >= 0) line[k] = (line[k] as number) + 1
      if (c === ',' && !(isDigit(text[i - 1]) && isDigit(text[i + 1]))) looseComma = true
    }
  }
  if (line.some(Boolean)) perLine.push(line)
  const decimalCommas = !looseComma && perLine.some(l => l.some((n, k) => k > 0 && n > 0))
  let best = { sep: ',', score: 0, fields: 0 }
  SEPARATORS.forEach((sep, k) => {
    if (sep === ',' && decimalCommas) return
    const tally = new Map<number, number>()
    for (const l of perLine) {
      const n = l[k] as number
      if (n) tally.set(n, (tally.get(n) ?? 0) + 1)
    }
    for (const [fields, score] of tally)
      if (score > best.score || (score === best.score && fields > best.fields)) best = { sep, score, fields }
  })
  return best.sep
}

/**
 * A CSV or TSV as a table: Excel's `sep=` line, else csvSeparator; the first CSV_ROWS rows, and
 * truncated when there were more or the file was cut at CSV_LIMIT (its last row cut with it, so
 * left out). The text comes too only when there are no rows, for the quick look to show as it is.
 */
function csvPreview(info: FileInfo, read: { buf: Buffer; cut: boolean }, extension: string): Preview {
  let text = decode(read.buf, true)
  if (text === null) return { ...info, kind: 'binary' }
  const excel = /^sep=(.)\r?\n/.exec(text)
  if (excel) text = text.slice(excel[0].length)
  const sep = excel?.[1] ?? (extension === 'tsv' ? '\t' : csvSeparator(text))
  const parsed = parseCsv(text, sep, CSV_ROWS + 1)
  const more = parsed.length > CSV_ROWS
  if (!more && read.cut && parsed.length > 1) parsed.pop()
  const rows = more ? parsed.slice(0, CSV_ROWS) : parsed
  const out: Preview = { ...info, kind: 'csv', rows, truncated: read.cut || more, lines: rows.length }
  if (!rows.length) out.text = text
  return out
}

/** Simple CSV/TSV: quoted fields with "" escapes and line breaks inside quotes. */
export function parseCsv(text: string, sep = ',', maxRows = CSV_ROWS): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if ((field || row.length) && rows.length < maxRows) rows.push([...row, field])
  return rows
}

/**
 * A preview of a file or folder for the board's quick look:
 *   folder: entries (folders first), each { name, dir, size, mtime, kind }
 *   markdown, json, csv, text: the text (cut at TEXT_LIMIT bytes / LINE_LIMIT lines), csv also rows
 *   image, pdf, video, audio: metadata; the bytes come from /api/fs/raw
 *   file: metadata only (binary or unknown)
 */
export function preview(path: string): Preview {
  const info = describe(path)
  if (!info.exists) return { ...info, error: 'missing' }
  if (info.dir) {
    let dirents: Dirent[] = []
    try {
      dirents = readdirSync(path, { withFileTypes: true })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      return { ...info, error: e.code === 'EPERM' || e.code === 'EACCES' ? 'denied' : e.message }
    }
    dirents.sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    )
    const entries = dirents.slice(0, DIR_LIMIT).map(d => {
      const full = resolve(path, d.name)
      const st = statSync(full, { throwIfNoEntry: false })
      const dir = st ? st.isDirectory() : d.isDirectory()
      return {
        name: d.name,
        dir,
        size: dir || !st ? null : st.size,
        mtime: st?.mtimeMs ?? null,
        kind: dir ? 'dir' : kindOf(d.name),
      }
    })
    return { ...info, entries, total: dirents.length }
  }
  const infoKind = info.kind ?? 'file'
  if (['image', 'pdf', 'video', 'audio'].includes(infoKind)) return info
  let read: { buf: Buffer; cut: boolean }
  try {
    read = head(path, info.size ?? 0, infoKind === 'csv' ? CSV_LIMIT : TEXT_LIMIT)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ...info, error: e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY' ? 'denied' : e.message }
  }
  if (infoKind === 'csv') return csvPreview(info, read, ext(path))
  let text = decode(read.buf)
  if (text === null) return { ...info, kind: infoKind === 'file' ? 'file' : 'binary' }
  let cut = read.cut
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop() // a final line break ends the last line, it starts none
  if (lines.length > LINE_LIMIT) {
    text = lines.slice(0, LINE_LIMIT).join('\n')
    cut = true
  }
  const kind = infoKind === 'file' ? 'text' : infoKind
  const out: Preview = { ...info, kind, text, truncated: cut, lines: Math.min(lines.length, LINE_LIMIT) }
  if (kind === 'json' && !cut) {
    try {
      out.text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {}
  }
  return out
}

/** The system command that opens a file or folder (how: open) or shows it in its folder (reveal), or opens a URL. */
export function openCommand(
  target: string,
  how: 'open' | 'reveal' = 'open',
  platform: string = process.platform,
): [string, string[]] {
  if (platform === 'win32')
    return how === 'reveal' ? ['explorer.exe', [`/select,${target}`]] : ['explorer.exe', [target]]
  if (platform === 'darwin') return how === 'reveal' ? ['open', ['-R', target]] : ['open', [target]]
  return ['xdg-open', [how === 'reveal' ? dirname(target) : target]]
}

/** Run openCommand; resolves when it started. explorer.exe exits 1 even when it worked, so its code is ignored. */
export function openWith(target: string, how: 'open' | 'reveal' = 'open'): Promise<{ ok: boolean; error?: string }> {
  const [cmd, args] = openCommand(target, how)
  return new Promise(res => {
    const child = execFile(cmd, args, { windowsHide: false }, () => {})
    child.once('error', err => res({ ok: false, error: err.message }))
    child.once('spawn', () => res({ ok: true }))
  })
}
