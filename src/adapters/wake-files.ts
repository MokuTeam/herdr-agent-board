// Wake's files in the board's state folder: the session file (`wake-sessions.json`, the last Claude
// session seen in each pane, core/wake/sessions.ts), wake's status (`wake-status.json`,
// core/wake/status.ts) and wake's log (`wake.log`). The session file has one writer, the wake
// process: it saves it atomically, and sets a file that does not read as sessions aside instead of
// overwriting it (a copy of it, when only some entries do not read). The board only peeks at it.
// The status file is written atomically too, its unknown fields kept. The log is rotated to
// `wake.log.1` past 2 MB. Wake's start holds `wake-start.lock` while it runs, so two starts never
// open two panes. Paths are computed at call time, as paths.ts does.
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { asSavedBoard } from '../core/board-pane.ts'
import { asWakeSessions, type WakeSessions } from '../core/wake/sessions.ts'
import { asWakeStatus, type WakeStatusFile } from '../core/wake/status.ts'
import { renameWithRetry, replaceFile } from './json-store.ts'
import { boardFile, stateDir } from './paths.ts'

export const wakeSessionsFile = (): string => join(stateDir(), 'wake-sessions.json')
export const wakeLogFile = (): string => join(stateDir(), 'wake.log')
export const wakeStatusFile = (): string => join(stateDir(), 'wake-status.json')
export const wakeStartLockFile = (): string => join(stateDir(), 'wake-start.lock')

/** Past this size the log becomes `wake.log.1` before the next line. */
const LOG_MAX_BYTES = 2_000_000
/** The log's tail is read back from its end this many bytes at a time. */
const TAIL_CHUNK = 64 * 1024

const errorCode = (err: unknown): unknown => (err && typeof err === 'object' && 'code' in err ? err.code : undefined)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The file's text, a BOM taken off (Windows PowerShell writes one); null when there is no file. Other errors are thrown. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  }
}

/** The text as JSON; undefined (which JSON never gives) when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `<file>.broken-<ms>`, a name no earlier copy has. */
function brokenName(file: string): string {
  for (let ms = Date.now(); ; ms++) {
    const name = `${file}.broken-${ms}`
    if (!existsSync(name)) return name
  }
}

/**
 * The wake process's read of its session file. {} when there is none; a file that does not read as
 * sessions is renamed `<file>.broken-<ms>` (never overwritten) and {} returned; `log` hears it.
 * Entries that do not read as sessions (core's narrowing drops them) are left out, and the file as
 * it was is first copied to `<file>.broken-<ms>`, so the next save loses nothing for good; `log`
 * hears which panes and where the copy is. A file that cannot be read at all, set aside or copied
 * is an error: taken for none, the next save would overwrite it.
 */
export function readWakeSessions(file = wakeSessionsFile(), log: (text: string) => void = () => {}): WakeSessions {
  const text = readText(file)
  if (text === null) return {}
  const raw = parsed(text)
  const sessions = asWakeSessions(raw)
  if (!sessions) {
    const aside = brokenName(file)
    try {
      renameWithRetry(file, aside)
    } catch (err) {
      log(`${file} does not read as sessions and could not be set aside: ${messageOf(err)}`)
      throw err
    }
    log(`${file} did not read as sessions: set aside as ${aside}, wake starts with none`)
    return {}
  }
  const panes = raw && typeof raw === 'object' ? Object.keys(raw) : []
  const dropped = panes.filter(pane => !Object.hasOwn(sessions, pane))
  if (dropped.length === 0) return sessions
  const panesSaid = dropped.join(', ')
  const copy = brokenName(file)
  try {
    copyFileSync(file, copy, constants.COPYFILE_EXCL)
  } catch (err) {
    log(`${file}: ${panesSaid} do not read as sessions, and the file could not be copied aside: ${messageOf(err)}`)
    throw err
  }
  log(`${file}: ${panesSaid} did not read as sessions and are left out; the file as it was is kept as ${copy}`)
  return sessions
}

/** The board's read of wake's session file: {} for a missing or broken one; never renames, copies, writes or logs. */
export function peekWakeSessions(file = wakeSessionsFile()): WakeSessions {
  try {
    return asWakeSessions(parsed(readText(file) ?? '{}')) ?? {}
  } catch {
    return {}
  }
}

/** Wake's status file (core/wake/status.ts) as it is: null when there is none or it does not read as one. */
export function readWakeStatus(file = wakeStatusFile()): WakeStatusFile | null {
  try {
    return asWakeStatus(parsed(readText(file) ?? ''))
  } catch {
    return null
  }
}

const STATUS_FIELDS = ['state', 'at', 'pane', 'pid', 'error', 'crashes', 'port']

/**
 * Atomic (json-store.ts replaceFile): the status as given, with the fields of the file on disk this
 * code does not know kept (a newer board's). Throws when it cannot be written.
 */
export function writeWakeStatus(status: WakeStatusFile, file = wakeStatusFile()): void {
  let kept: Record<string, unknown> = {}
  try {
    const raw = parsed(readText(file) ?? '')
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !STATUS_FIELDS.includes(key)))
  } catch {}
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, `${JSON.stringify({ ...kept, ...status }, null, 1)}\n`)
}

/** The pane board.json names (the board's own, which wake never closes); null when there is none. */
export function boardPaneNow(file = boardFile()): string | null {
  try {
    return asSavedBoard(parsed(readText(file) ?? ''))?.pane ?? null
  } catch {
    return null
  }
}

interface StartLock {
  pid: number
  at: number
}
const asStartLock = (v: unknown): StartLock | null => {
  const r = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  return r && Number.isInteger(r.pid) && Number(r.pid) > 0 && typeof r.at === 'number' && Number.isFinite(r.at)
    ? { pid: Number(r.pid), at: r.at }
    : null
}

/**
 * Wake's start's lock: `wake-start.lock` beside the status file, made exclusively ('wx') with
 * `{ pid, at }`. Gives the function that removes it (only while it is still this one's; once), or
 * null while another start holds it. A lock is taken over when its process is gone or it is older
 * than `maxAgeMs` (a start ends by its deadline); one that does not read as a lock (being written,
 * say) only once its file is that old. A stale lock is first moved aside under a name of this
 * process's: when what was moved is not what was judged stale (another start took it over meanwhile),
 * it is put back and that start keeps it.
 */
export function takeWakeStartLock(
  o: { pid: number; now: number; maxAgeMs: number; alive: (pid: number) => boolean },
  file = wakeStartLockFile(),
): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true })
  const mine = `${JSON.stringify({ pid: o.pid, at: o.now })}\n`
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' })
      let held = true
      return () => {
        if (!held) return
        held = false
        try {
          if (readText(file) === mine) rmSync(file, { force: true })
        } catch {}
      }
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }
    const text = readText(file)
    if (text === null) continue
    const lock = asStartLock(parsed(text))
    const fresh = lock
      ? o.alive(lock.pid) && o.now - lock.at < o.maxAgeMs
      : o.now - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < o.maxAgeMs
    if (fresh) return null
    const aside = `${file}.${o.pid}-${tries}`
    try {
      renameSync(file, aside)
    } catch (err) {
      if (errorCode(err) === 'ENOENT') continue
      throw err
    }
    const moved = readText(aside)
    rmSync(aside, { force: true })
    if (moved !== text) {
      try {
        if (moved !== null) writeFileSync(file, moved, { flag: 'wx' })
      } catch {}
      return null
    }
  }
  return null
}

/** Atomic: a temporary file, then a rename (json-store.ts replaceFile). */
export function saveWakeSessions(sessions: WakeSessions, file = wakeSessionsFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, `${JSON.stringify(sessions, null, 1)}\n`)
}

/** One line `<ISO time> <text>`; past 2_000_000 bytes the file becomes `wake.log.1` first. Never throws. */
export function wakeLog(text: string, file = wakeLogFile()): void {
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {}
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${text.replace(/[\r\n]+/g, ' ')}\n`)
  } catch {}
}

/** The log's last `lines` lines, read from its end; '' when there is no log or it cannot be read. */
export function wakeLogTail(lines: number, file = wakeLogFile()): string {
  if (!(lines >= 1)) return ''
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    let start = fstatSync(fd).size
    const chunks: Buffer[] = []
    let breaks = 0
    // Back from the end until more line breaks than lines asked for are read (or the whole file),
    // so a first line read from its middle is never among the last ones.
    while (start > 0 && breaks <= lines) {
      const length = Math.min(TAIL_CHUNK, start)
      start -= length
      const chunk = Buffer.alloc(length)
      readSync(fd, chunk, 0, length, start)
      chunks.unshift(chunk)
      for (const byte of chunk) if (byte === 0x0a) breaks++
    }
    const all = Buffer.concat(chunks).toString('utf8').split('\n')
    if (all.at(-1) === '') all.pop()
    return all.slice(-lines).join('\n')
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}
