// A session's conversation copied into another Claude profile's folder (#250, `board move`), and
// the source profile's trust in its project folder with it (core/move.ts). Copied, never moved:
// the originals stay where they are. What Claude keeps of a session: the transcript
// `projects/<project folder>/<id>.jsonl`, the session's own folder beside it (subagents, tool
// results) and `file-history/<id>/`. A session moved back (#256) finds its older copy from the
// move before in the target: one the source's transcript goes on from is brought up to date.
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { trustedKey, withTrust } from '../core/move.ts'
import { projectFolderName } from '../core/resume.ts'
import { renameWithRetry, replaceFile } from './json-store.ts'

/** The session's transcript under the profile's `projects/`: in the folder for `cwd` first, else in any. */
export function findTranscript(dir: string, session: string, cwd: string): string | null {
  const projects = join(dir, 'projects')
  const file = `${session}.jsonl`
  if (cwd) {
    const guess = join(projects, projectFolderName(cwd), file)
    if (statSync(guess, { throwIfNoEntry: false })?.isFile()) return guess
  }
  let names: string[]
  try {
    names = readdirSync(projects)
  } catch {
    return null
  }
  for (const name of names) {
    const p = join(projects, name, file)
    if (statSync(p, { throwIfNoEntry: false })?.isFile()) return p
  }
  return null
}

/** What a copy did: the transcript's new path, and whether the session's folder and its file history went with it. */
export interface CopiedSession {
  transcript: string
  folder: boolean
  history: boolean
  /** The target had the same transcript already: a move cut off halfway, finished now. */
  again: boolean
  /** The target had an older copy of it, which this one goes on from (a move there before): replaced. */
  back: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const CHUNK = 1 << 20

/**
 * Whether the file `older` holds the first bytes of `newer`, all of them: no longer than it, and
 * the same bytes as far as it goes. Read a piece at a time, never a whole transcript at once.
 */
export function isPrefixFile(older: string, newer: string): boolean {
  const size = statSync(older).size
  if (size > statSync(newer).size) return false
  const a = openSync(older, 'r')
  try {
    const b = openSync(newer, 'r')
    try {
      const x = Buffer.allocUnsafe(Math.min(CHUNK, size))
      const y = Buffer.allocUnsafe(x.length)
      for (let at = 0; at < size; ) {
        const n = Math.min(x.length, size - at)
        const got = readSync(a, x, 0, n, at)
        if (got !== n || readSync(b, y, 0, n, at) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false
        at += n
      }
      return true
    } finally {
      closeSync(b)
    }
  } finally {
    closeSync(a)
  }
}

/**
 * The session's files copied from the profile in `from` to the one in `to`, under the same
 * project folder. Refused (nothing copied) when `from` has no transcript of it, or `to` has
 * another one under its id. The side folders go first and the transcript last, through a temp file
 * renamed into place, so a copy cut off halfway leaves no transcript, or a whole one: a second try
 * copies the side folders over what it left, and takes a transcript the same as the source's as
 * copied (the move then goes on with the card), so a move cut off halfway can be run again. A
 * transcript in `to` that the source's begins with, byte for byte, is this conversation as a move
 * there before left it (#256): replaced the same way, its side folders copied over the old ones.
 */
export function copySession(
  from: string,
  to: string,
  session: string,
  cwd: string,
): { ok: true; copied: CopiedSession } | { ok: false; error: string } {
  const source = findTranscript(from, session, cwd)
  if (!source) return { ok: false, error: `no conversation ${session} in ${from}` }
  const there = findTranscript(to, session, cwd)
  // What the target has under its id: nothing, this transcript, or an older copy of it.
  let same = false
  try {
    if (there && !isPrefixFile(there, source))
      return { ok: false, error: `${to} has another conversation under ${session} already (${there})` }
    same = !!there && statSync(there).size === statSync(source).size
  } catch (err) {
    return { ok: false, error: `comparing with ${there} failed: ${messageOf(err)}` }
  }
  const target = there ?? join(to, 'projects', basename(dirname(source)), `${session}.jsonl`)
  const side = (src: string, dst: string): boolean => {
    if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) return false
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
    return true
  }
  try {
    const folder = side(join(dirname(source), session), join(dirname(target), session))
    const history = side(join(from, 'file-history', session), join(to, 'file-history', session))
    if (!same) {
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      try {
        copyFileSync(source, tmp)
        renameWithRetry(tmp, target)
      } catch (err) {
        try {
          unlinkSync(tmp)
        } catch {}
        throw err
      }
    }
    return { ok: true, copied: { transcript: target, folder, history, again: same, back: !!there && !same } }
  } catch (err) {
    return { ok: false, error: `copying into ${to} failed: ${messageOf(err)}` }
  }
}

/** A JSON file's value, a BOM taken off; null when there is none. Throws when it is there but does not parse. */
function readState(file: string): unknown {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

/**
 * The source profile's trust in `cwd` written into the target's Claude state file (core/move.ts
 * withTrust), read, changed and replaced at once, its mode kept (it holds the account): 'copied';
 * 'trusted' when the target trusts the folder already; 'none' when it does not and nothing was
 * copied (the source does not trust it, no folder is known, or the target has no state file yet):
 * Claude will ask there once. Throws when a file cannot be read or written.
 */
export function copyTrust(
  fromFile: string,
  toFile: string,
  cwd: string,
  platform: string = process.platform,
): 'copied' | 'trusted' | 'none' {
  const target = readState(toFile)
  if (cwd && trustedKey(target, cwd) !== null) return 'trusted'
  const next = withTrust(readState(fromFile), target, cwd, platform)
  if (!next) return 'none'
  const mode = process.platform === 'win32' ? undefined : statSync(toFile).mode & 0o777
  replaceFile(toFile, `${JSON.stringify(next, null, 2)}\n`, undefined, mode)
  return 'copied'
}
