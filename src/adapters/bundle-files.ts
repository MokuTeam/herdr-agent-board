// Walking a Claude profile folder for its bundle (design: docs/design/nodes, 9.1): `skills/`,
// `agents/`, `commands/` and `CLAUDE.md` as files hashed by content, the files of the folder a hook
// that travels names (its script), `settings.json`, and only `mcpServers` out of `.claude.json`.
// Nothing else of the folder is opened: no credentials, no transcripts, no per-project memory.
// core/bundle.ts classifies what this finds.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  type BundleContext,
  type BundleFile,
  classifySettings,
  type ProfileParts,
  type SkipWhy,
} from '../core/bundle.ts'

/** A file over this many bytes stays on the master, with a line in the report. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
/** Folders that are never walked into, wherever they are. */
export const SKIP_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', '.venv', '__pycache__'])
/** Names never read, wherever a link leads: Claude's credentials and state, ssh keys. */
export const DENIED: ReadonlySet<string> = new Set(['.credentials.json', '.claude.json', '.ssh'])
/** The folders and the file of a profile that travel. */
export const PROFILE_FOLDERS = ['skills', 'agents', 'commands'] as const
export const PROFILE_FILES = ['CLAUDE.md'] as const

/** A walked file: what the manifest lists, and where its bytes are for sending. */
export interface WalkedFile extends BundleFile {
  /** The file read, a link's target for a link. */
  source: string
  size: number
}

export interface ProfileRead extends ProfileParts {
  files: WalkedFile[]
}

/**
 * Nothing is built from a folder that is not there, or whose settings.json or .claude.json does
 * not parse: an empty part would remove what the node has.
 */
export type ReadResult =
  | { ok: true; parts: ProfileRead }
  | { ok: false; why: 'no-folder' | 'settings' | 'claude-json'; file: string }

export interface ReadOptions extends Pick<BundleContext, 'to' | 'home' | 'boardDir'> {
  /**
   * The profile's .claude.json: `<dir>/.claude.json` for a profile CLAUDE_CONFIG_DIR names, but
   * `~/.claude.json`, beside the folder, for the default one. Asked for, as a wrong guess would
   * send no servers and so remove the node's.
   */
  claudeJson: string
  /** The platform the folder is on; the running one when not given. */
  platform?: string
}

/**
 * A file's mode for the manifest. Windows keeps no executable bit, so there a file that starts
 * with `#!` is 0755 (a hook script the node runs) and any other 0644.
 */
export function modeOf(st: Pick<Stats, 'mode'>, head: Uint8Array, platform: string): number {
  if (platform !== 'win32') return st.mode & 0o777
  return head[0] === 0x23 && head[1] === 0x21 ? 0o755 : 0o644
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function parseJson(file: string): { ok: true; value: unknown } | { ok: false } {
  if (!existsSync(file)) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }
  } catch {
    return { ok: false }
  }
}

/**
 * What of the profile folder `dir` a bundle is built from. Links are followed and their target's
 * content travels, except a link to the profile folder or a folder above it, into a part of it
 * that is never sent, to a name in DENIED, or back to a folder the walk is in. Every file or folder
 * left out is in `skipped` with the reason.
 */
export function readProfile(dir: string, opts: ReadOptions): ReadResult {
  const platform = opts.platform ?? process.platform
  let isFolder = false
  try {
    isFolder = statSync(dir).isDirectory()
  } catch {}
  if (!isFolder) return { ok: false, why: 'no-folder', file: dir }
  const settingsFile = join(dir, 'settings.json')
  const settings = parseJson(settingsFile)
  if (!settings.ok) return { ok: false, why: 'settings', file: settingsFile }
  const state = parseJson(opts.claudeJson)
  if (!state.ok) return { ok: false, why: 'claude-json', file: opts.claudeJson }
  const mcpServers =
    state.value && typeof state.value === 'object' && !Array.isArray(state.value)
      ? (state.value as Record<string, unknown>).mcpServers
      : undefined
  const ctx: BundleContext = { from: platform, to: opts.to, profileDir: dir }
  if (opts.home) ctx.home = opts.home
  if (opts.boardDir) ctx.boardDir = opts.boardDir
  const scripts = classifySettings(settings.value, ctx).scripts

  const files: WalkedFile[] = []
  const skipped: { path: string; why: SkipWhy }[] = []
  const followed: string[] = []
  const fold = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
  }
  const real = (p: string): string | null => {
    try {
      return fold(realpathSync(p))
    } catch {
      return null
    }
  }
  const root = real(dir) ?? fold(dir)
  // The parts that travel, by where they are under the profile folder's real path.
  const sent = [...PROFILE_FOLDERS, ...PROFILE_FILES, ...scripts].map(p => `${root}/${fold(p)}`)
  const within = (p: string, folder: string): boolean => p === folder || p.startsWith(`${folder}/`)
  // The profile folder, a folder above it, or a part of it that is never sent.
  const fenced = (target: string): boolean =>
    within(root, target) || (within(target, root) && !sent.some(s => within(target, s)))

  const visit = (full: string, path: string, stack: readonly string[]): void => {
    const link = lstatSync(full).isSymbolicLink()
    const here = real(full)
    if (!here) {
      skipped.push({ path, why: 'link-broken' })
      return
    }
    if (DENIED.has(basename(full)) || DENIED.has(basename(here))) {
      skipped.push({ path, why: 'denied' })
      return
    }
    if (fenced(here)) {
      skipped.push({ path, why: 'link-into-profile' })
      return
    }
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_FOLDERS.has(basename(full))) {
        skipped.push({ path, why: 'skipped-folder' })
        return
      }
      if (stack.includes(here)) {
        skipped.push({ path, why: 'link-loop' })
        return
      }
      if (link) followed.push(path)
      for (const name of readdirSync(full).sort()) guarded(join(full, name), `${path}/${name}`, [...stack, here])
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path, why: 'too-big' })
        return
      }
      const bytes = readFileSync(full)
      if (link) followed.push(path)
      const source = link ? realpathSync(full) : full
      files.push({ path, sha256: sha256(bytes), mode: modeOf(st, bytes, platform), source, size: st.size })
    }
  }
  // A file gone or locked while the walk reads it is a line of the report, not a failed build.
  const guarded = (full: string, path: string, stack: readonly string[]): void => {
    try {
      visit(full, path, stack)
    } catch {
      skipped.push({ path, why: 'unreadable' })
    }
  }

  const kindOf = (full: string): 'folder' | 'file' | 'other' | null => {
    try {
      const st = statSync(full)
      return st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other'
    } catch {
      return existsLink(full) ? 'other' : null
    }
  }
  const existsLink = (full: string): boolean => {
    try {
      return lstatSync(full).isSymbolicLink()
    } catch {
      return false
    }
  }
  for (const part of PROFILE_FOLDERS) {
    const full = join(dir, part)
    const kind = kindOf(full)
    // `skills` that is a file is nothing Claude reads; a broken link is reported.
    if (kind === 'folder' || (kind === 'other' && existsLink(full))) guarded(full, part, [])
  }
  for (const part of PROFILE_FILES) {
    const full = join(dir, part)
    const kind = kindOf(full)
    if (kind === 'file' || (kind === 'other' && existsLink(full))) guarded(full, part, [])
  }
  const taken = new Set(files.map(f => f.path))
  for (const path of scripts) {
    if (taken.has(path)) continue
    const full = join(dir, ...path.split('/'))
    if (kindOf(full) !== 'file') skipped.push({ path, why: 'missing' })
    else guarded(full, path, [])
  }
  return { ok: true, parts: { files, skipped, followed, settings: settings.value, mcpServers } }
}
