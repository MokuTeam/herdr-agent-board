// Folders this computer already works in (#816), for a node that gets a start by a repository's
// address: it runs in a checkout of that repository it already has instead of cloning a second
// one (services/node/checkout.ts). Read only when such a start comes; nothing here is written.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { claudeStateFile } from '../core/move.ts'

/**
 * The folders a Claude profile was used in: the keys of `projects` in its `.claude.json` that are
 * paths of this computer (Claude also keeps `ssh:` ones there). Nothing when the file is missing
 * or does not read.
 */
export function claudeProjects(file: string): string[] {
  try {
    const projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown } | null)?.projects
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return []
    return Object.keys(projects).filter(k => isAbsolute(k))
  } catch {
    return []
  }
}

/**
 * The folders, most telling first, each once: the board's sessions here, then its archived ones
 * (newest first, as the archive lists them), then the folders each of its Claude profiles was used
 * in. The caller asks git which repository each one is in, and only as far as it needs.
 */
export function knownFolders(o: {
  sessions: readonly { cwd?: unknown }[]
  archived: readonly { cwd?: unknown }[]
  profileDirs: readonly string[]
  home: string
  platform?: string
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (folder: unknown): void => {
    if (typeof folder !== 'string' || !folder || seen.has(folder)) return
    seen.add(folder)
    out.push(folder)
  }
  for (const s of o.sessions) add(s.cwd)
  for (const a of o.archived) add(a.cwd)
  for (const dir of o.profileDirs) for (const f of claudeProjects(claudeStateFile(dir, o.home, o.platform))) add(f)
  return out
}
