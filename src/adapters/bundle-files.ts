// Walking a Claude profile folder for its bundle (design: docs/design/nodes, 9.1): `skills/`,
// `agents/`, `commands/` and `CLAUDE.md` as files hashed by content, `settings.json`, and only
// `mcpServers` out of `.claude.json`. Nothing else of the folder is opened: no credentials, no
// transcripts, no per-project memory. core/bundle.ts classifies what this finds.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from 'node:fs'
import { basename as baseName, join } from 'node:path'
import type { BundleFile, ProfileParts, SkipWhy } from '../core/bundle.ts'

/** A file over this many bytes stays on the master, with a line in the report. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
/** Folders that are never walked into, wherever they are. */
export const SKIP_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', '.venv', '__pycache__'])
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

/** Nothing is built from a folder whose settings.json or .claude.json does not parse: an empty part would remove the node's. */
export type ReadResult = { ok: true; parts: ProfileRead } | { ok: false; why: 'settings' | 'claude-json'; file: string }

export interface ReadOptions {
  /**
   * The profile's .claude.json: `<dir>/.claude.json` when not given, as for a profile with
   * CLAUDE_CONFIG_DIR set. The default profile's is `~/.claude.json`, beside the folder.
   */
  claudeJson?: string
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
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
  } catch {
    return { ok: false }
  }
}

/**
 * What of the profile folder `dir` a bundle is built from. Links are followed and their target's
 * content travels, except a link into a part of the profile folder that is never sent
 * (credentials, transcripts) and one back to a folder the walk is in. Every file or folder left out
 * is in `skipped` with the reason.
 */
export function readProfile(dir: string, opts: ReadOptions = {}): ReadResult {
  const platform = opts.platform ?? process.platform
  const settingsFile = join(dir, 'settings.json')
  const settings = parseJson(settingsFile)
  if (!settings.ok) return { ok: false, why: 'settings', file: settingsFile }
  const claudeJson = opts.claudeJson ?? join(dir, '.claude.json')
  const state = parseJson(claudeJson)
  if (!state.ok) return { ok: false, why: 'claude-json', file: claudeJson }
  const mcpServers =
    state.value && typeof state.value === 'object' && !Array.isArray(state.value)
      ? (state.value as Record<string, unknown>).mcpServers
      : undefined

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
  // The parts that travel, by where they are under the profile folder's real path: a link that
  // leads anywhere else under it (credentials, transcripts, the folder itself) is not followed.
  const sent = [...PROFILE_FOLDERS, ...PROFILE_FILES].map(p => `${root}/${fold(p)}`)
  const within = (p: string, folder: string): boolean => p === folder || p.startsWith(`${folder}/`)
  const intoProfile = (target: string): boolean => within(target, root) && !sent.some(s => within(target, s))

  const visit = (full: string, path: string, stack: readonly string[]): void => {
    const link = lstatSync(full).isSymbolicLink()
    const here = real(full)
    if (!here) {
      skipped.push({ path, why: 'link-broken' })
      return
    }
    if (intoProfile(here)) {
      skipped.push({ path, why: 'link-into-profile' })
      return
    }
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_FOLDERS.has(baseName(path))) {
        skipped.push({ path, why: 'skipped-folder' })
        return
      }
      if (stack.includes(here)) {
        skipped.push({ path, why: 'link-loop' })
        return
      }
      if (link) followed.push(path)
      const names = readdirSync(full).sort()
      for (const name of names) visit(join(full, name), `${path}/${name}`, [...stack, here])
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path, why: 'too-big' })
        return
      }
      if (link) followed.push(path)
      const bytes = readFileSync(full)
      const source = link ? realpathSync(full) : full
      files.push({ path, sha256: sha256(bytes), mode: modeOf(st, bytes, platform), source, size: st.size })
    }
  }

  for (const part of [...PROFILE_FOLDERS, ...PROFILE_FILES]) {
    const full = join(dir, part)
    let there = true
    try {
      lstatSync(full)
    } catch {
      there = false
    }
    if (!there) continue
    const isFolder = (PROFILE_FOLDERS as readonly string[]).includes(part)
    // `skills` that is a file, or `CLAUDE.md` that is a folder, is nothing Claude reads.
    const st = real(full) ? statSync(full) : null
    if (st && (isFolder ? !st.isDirectory() : !st.isFile())) continue
    visit(full, part, [])
  }
  return { ok: true, parts: { files, skipped, followed, settings: settings.value, mcpServers } }
}
