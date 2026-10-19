// The Claude homes (claude-home.ts) of every profile folder the board reads: one per folder, made
// on first use and kept, so each keeps its caches. Read across them: the sessions running in any
// of the folders, each with the home it runs in, and the folders recent sessions ran in.
import { normDir, sameDir } from '../core/launch/names.ts'
import { type ClaudeHome, createClaudeHome, type LiveSession } from './claude-home.ts'

/** A running session and the home whose registry has it. */
export interface LiveHit {
  session: LiveSession
  home: ClaudeHome
}

export interface ProfileHomes {
  /** One ClaudeHome per folder (by normDir), made on first use. */
  forDir(dir: string): ClaudeHome
  /** Running sessions in every folder given, each with the home it was found in. */
  liveSessions(dirs: readonly string[]): Map<string, LiveHit>
  /**
   * Recent session folders of the given homes, the newest of all first (each home's own order
   * kept, a tie to the earlier home), deduplicated (sameDir), no more than `limit`.
   */
  recentFolders(dirs: readonly string[], limit?: number): Promise<string[]>
}

export function createProfileHomes(): ProfileHomes {
  const homes = new Map<string, ClaudeHome>()

  function forDir(dir: string): ClaudeHome {
    const key = normDir(dir)
    let home = homes.get(key)
    if (!home) {
      home = createClaudeHome(dir)
      homes.set(key, home)
    }
    return home
  }

  /** The homes of `dirs`, each once, in their order. */
  const homesOf = (dirs: readonly string[]): ClaudeHome[] => [...new Set(dirs.map(forDir))]

  function liveSessions(dirs: readonly string[]): Map<string, LiveHit> {
    const byId = new Map<string, LiveHit>()
    for (const home of homesOf(dirs))
      for (const [id, session] of home.liveSessions()) if (!byId.has(id)) byId.set(id, { session, home })
    return byId
  }

  async function recentFolders(dirs: readonly string[], limit = 12): Promise<string[]> {
    // Each home's list is newest first: a stable sort by when merges them (a tie to the earlier
    // home), so a home with many recent folders never crowds out a newer one of another.
    const lists = await Promise.all(homesOf(dirs).map(home => home.recentFoldersAt(limit)))
    const found: string[] = []
    for (const { dir } of lists.flat().sort((x, y) => y.at - x.at))
      if (!found.some(f => sameDir(f, dir))) found.push(dir)
    return found.slice(0, limit)
  }

  return { forDir, liveSessions, recentFolders }
}
