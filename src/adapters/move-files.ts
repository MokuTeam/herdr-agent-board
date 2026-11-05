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

/** Where a copy stands before it starts: the source's transcript, and what the target has under its id. */
interface CopyPlan {
  source: string
  there: string | null
  /** The size of the target's transcript as it was compared; 0 for none. */
  size: number
  /** The target's is the source's, whole. */
  same: boolean
}

/**
 * What a copy from `from` to `to` would find, or why it is refused: no transcript in `from`, or
 * one in `to` that is not the start of it (longer, or another conversation). Nothing is written.
 */
function planCopy(
  from: string,
  to: string,
  session: string,
  cwd: string,
): { ok: true; plan: CopyPlan } | { ok: false; error: string } {
  const source = findTranscript(from, session, cwd)
  if (!source) return { ok: false, error: `no conversation ${session} in ${from}` }
  const there = findTranscript(to, session, cwd)
  if (!there) return { ok: true, plan: { source, there, size: 0, same: false } }
  try {
    if (!isPrefixFile(there, source))
      return { ok: false, error: `${to} has a longer or different copy of this conversation (${there})` }
    const size = statSync(there).size
    return { ok: true, plan: { source, there, size, same: size === statSync(source).size } }
  } catch (err) {
    return { ok: false, error: `comparing with ${there} failed: ${messageOf(err)}` }
  }
}

/**
 * Whether the session's files could be copied from `from` to `to` (copySession's refusals that are
 * known before anything is done), without writing anything: a move asks before it puts a running
 * session to sleep (services/move.ts, #256).
 */
export function checkCopy(
  from: string,
  to: string,
  session: string,
  cwd: string,
): { ok: true } | { ok: false; error: string } {
  const plan = planCopy(from, to, session, cwd)
  return plan.ok ? { ok: true } : plan
}

/**
 * The session's files copied from the profile in `from` to the one in `to`, under the same
 * project folder. Refused (nothing copied) when `from` has no transcript of it, or `to` has a
 * longer or different one under its id (planCopy). The side folders go first and the transcript
 * last, through a temp file renamed into place, so a copy cut off halfway leaves no transcript, or
 * a whole one: a second try copies the side folders over what it left, and takes a transcript the
 * same as the source's as copied (the move then goes on with the card), so a move cut off halfway
 * can be run again. A
 * transcript in `to` that the source's begins with, byte for byte, is this conversation as a move
 * there before left it (#256): replaced the same way, its side folders copied over the old ones;
 * refused, the copy taken back, when it changed meanwhile (a session writes it). `copy`: how the
 * transcript is copied to the temp file (a test's).
 */
export function copySession(
  from: string,
  to: string,
  session: string,
  cwd: string,
  copy: (src: string, dst: string) => void = copyFileSync,
): { ok: true; copied: CopiedSession } | { ok: false; error: string } {
  const planned = planCopy(from, to, session, cwd)
  if (!planned.ok) return planned
  const { source, there, size, same } = planned.plan
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
        copy(source, tmp)
        // Its older copy written meanwhile (a session resumed there): those turns would be lost.
        if (there && statSync(there).size !== size) throw new Error(`${there} changed while it was copied`)
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
