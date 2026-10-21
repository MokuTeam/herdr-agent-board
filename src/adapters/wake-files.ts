// Wake's files in the board's state folder: the session file (`wake-sessions.json`, the last Claude
// session seen in each pane, core/wake/sessions.ts) and wake's log (`wake.log`). The session file
// has one writer, the wake process: it saves it atomically, and sets a file that does not read as
// sessions aside instead of overwriting it. The board only peeks at it. The log is rotated to
// `wake.log.1` past 2 MB. Paths are computed at call time, as paths.ts does.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { asWakeSessions, type WakeSessions } from '../core/wake/sessions.ts'
import { renameWithRetry, replaceFile } from './json-store.ts'
import { stateDir } from './paths.ts'

export const wakeSessionsFile = (): string => join(stateDir(), 'wake-sessions.json')
export const wakeLogFile = (): string => join(stateDir(), 'wake.log')

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

/** The text as sessions (core's narrowing), or null when it is not JSON or not sessions. */
function asSessions(text: string): WakeSessions | null {
  try {
    return asWakeSessions(JSON.parse(text))
  } catch {
    return null
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
 * sessions is renamed `<file>.broken-<ms>` (never overwritten) and {} returned; `log` hears it. A
 * file that cannot be read at all, or set aside, is an error: taken for none, the next save would
 * overwrite it.
 */
export function readWakeSessions(file = wakeSessionsFile(), log: (text: string) => void = () => {}): WakeSessions {
  const text = readText(file)
  if (text === null) return {}
  const sessions = asSessions(text)
  if (sessions) return sessions
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

/** The board's read of wake's session file: {} for a missing or broken one; never renames, writes or logs. */
export function peekWakeSessions(file = wakeSessionsFile()): WakeSessions {
  try {
    return asSessions(readText(file) ?? '{}') ?? {}
  } catch {
    return {}
  }
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
