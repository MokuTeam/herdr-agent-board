// A session's conversation copied into another Claude profile's folder (#250, `board move`), and
// the source profile's trust in its project folder with it (core/move.ts). Copied, never moved:
// the originals stay where they are. What Claude keeps of a session: the transcript
// `projects/<project folder>/<id>.jsonl`, the session's own folder beside it (subagents, tool
// results) and `file-history/<id>/`.
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
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
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Whether two files hold the same bytes: their sizes, then their SHA-256. */
function sameFile(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false
  const hash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
  return hash(a) === hash(b)
}

/**
 * The session's files copied from the profile in `from` to the one in `to`, under the same
 * project folder. Refused (nothing copied) when `from` has no transcript of it, or `to` has
 * another one under its id. The side folders go first and the transcript last, through a temp file
 * renamed into place, so a copy cut off halfway leaves no transcript, or a whole one: a second try
 * copies the side folders over what it left, and takes a transcript the same as the source's as
 * copied (the move then goes on with the card), so a move cut off halfway can be run again.
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
  try {
    if (there && !sameFile(source, there))
      return { ok: false, error: `${to} has another conversation under ${session} already (${there})` }
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
    if (!there) {
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
    return { ok: true, copied: { transcript: target, folder, history, again: !!there } }
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
