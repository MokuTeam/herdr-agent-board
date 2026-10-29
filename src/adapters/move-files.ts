// A session's conversation copied into another Claude profile's folder (#250, `board move`), and
// the source profile's trust in its project folder with it (core/move.ts). Copied, never moved:
// the originals stay where they are. What Claude keeps of a session: the transcript
// `projects/<project folder>/<id>.jsonl`, the session's own folder beside it (subagents, tool
// results) and `file-history/<id>/`.
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { withTrust } from '../core/move.ts'
import { projectFolderName } from '../core/resume.ts'
import { replaceFile } from './json-store.ts'

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
}

/**
 * The session's files copied from the profile in `from` to the one in `to`, under the same
 * project folder. Refused (nothing copied) when `from` has no transcript of it or `to` has one
 * already. The side folders go first and the transcript last, so a copy cut off halfway leaves no
 * transcript, and a second try copies over what it left.
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
  if (there) return { ok: false, error: `${to} has a conversation ${session} already (${there})` }
  const project = basename(dirname(source))
  const target = join(to, 'projects', project, `${session}.jsonl`)
  const side = (src: string, dst: string): boolean => {
    if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) return false
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
    return true
  }
  try {
    const folder = side(join(dirname(source), session), join(dirname(target), session))
    const history = side(join(from, 'file-history', session), join(to, 'file-history', session))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target, constants.COPYFILE_EXCL)
    return { ok: true, copied: { transcript: target, folder, history } }
  } catch (err) {
    return { ok: false, error: `copying into ${to} failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** A JSON file's value, a BOM taken off; null when there is none. Throws when it is there but does not parse. */
function readState(file: string): unknown {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

/**
 * The source profile's trust in `cwd` written into the target's Claude state file (core/move.ts
 * withTrust), read, changed and replaced at once: true when it was copied, false when nothing was
 * to change (the target trusts it already, the source does not, or the target has no state file
 * yet). Throws when a file cannot be read or written.
 */
export function copyTrust(fromFile: string, toFile: string, cwd: string, platform: string = process.platform): boolean {
  const next = withTrust(readState(fromFile), readState(toFile), cwd, platform)
  if (!next) return false
  replaceFile(toFile, `${JSON.stringify(next, null, 2)}\n`)
  return true
}
