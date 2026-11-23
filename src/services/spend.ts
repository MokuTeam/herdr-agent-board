// On-demand token spend service (#636): single-session spend for card detail and cross-lane
// aggregation across Claude, Codex, and pi transcripts. Nothing runs until asked.
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { listArchive } from '../adapters/archive-store.ts'
import { allCards } from '../adapters/cards.ts'
import { cwdOf } from '../adapters/claude-home.ts'
import { dedicatedCodexHome } from '../adapters/codex-home.ts'
import { readTranscriptSpend } from '../adapters/spend-reader.ts'
import { isAgyItem } from '../core/agy.ts'
import { categoryFor } from '../core/categories.ts'
import { isCodexItem, isCodexSession } from '../core/codex.ts'
import { normDir } from '../core/launch/names.ts'
import { isPiItem, piSessionCwd, piSessionId } from '../core/pi.ts'
import {
  type AggregateSessionInput,
  addDays,
  aggregateSpend,
  localZone,
  type SessionSpend,
  type SpendAgent,
  type SpendReport,
} from '../core/spend.ts'
import { timeConfig } from '../core/time.ts'
import type { Config, Item } from '../core/types.ts'
import type { Deps } from './deps.ts'

const DAY_MS = 86_400_000
const READ_CONCURRENCY = 8

/** Time zone used to bucket spend into local days: configured time zone, else the computer's own. */
export function spendZone(cfg: Pick<Config, 'time'>): string {
  return timeConfig(cfg.time)?.zone ?? localZone()
}

/** Single-session spend for `GET /api/session/<key>`; returns null for agy or sessions without usage. */
export async function sessionSpend(
  deps: Pick<Deps, 'cfg' | 'codex'>,
  item: Item,
  opts: { zone?: string } = {},
): Promise<SessionSpend | null> {
  if (isAgyItem(item)) return null
  let agent: SpendAgent
  let path: string | null = null
  if (isCodexItem(item)) {
    agent = 'codex'
    path = deps.codex.transcriptPath(item.session)
  } else if (isPiItem(item)) {
    agent = 'pi'
    path = item.session
  } else if (item.transcript) {
    agent = 'claude'
    path = item.transcript
  } else {
    return null
  }
  if (!path) return null
  const zone = opts.zone ?? spendZone(deps.cfg)
  const minAt = item.fork?.at && item.fork.at > 0 ? item.fork.at : undefined
  const read = await readTranscriptSpend(path, agent, { zone, ...(minAt !== undefined && { minAt }) })
  return read && read.spend.total.total > 0 ? read.spend : null
}

export interface CollectSpendOptions {
  cfg: Config
  deps: Pick<Deps, 'profiles' | 'homes' | 'codex'>
  /** Active and sleeping board items when called from the server; optional for CLI. */
  items?: readonly Item[]
  from: string
  to: string
  lane?: string | null
  zone?: string
  /** Optional roots for tests (defaults to real Codex and pi locations). */
  codexRoots?: readonly string[]
  piRoots?: readonly string[]
}

interface Candidate {
  key: string
  name: string
  lane: string
  agent: SpendAgent
  path: string
  minAt?: number
}

async function piFirstLineCwd(file: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const buf = Buffer.allocUnsafe(4096)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    return piSessionCwd(nl >= 0 ? text.slice(0, nl) : text)
  } catch {
    return ''
  } finally {
    await fh?.close()
  }
}

function defaultCodexRoots(): string[] {
  const first = process.env.CODEX_HOME || join(homedir(), '.codex')
  const dedicated = dedicatedCodexHome()
  return dedicated && dedicated !== first ? [first, dedicated] : [first]
}

function defaultPiRoots(): string[] {
  const roots = [
    process.env.PI_CODING_AGENT_SESSION_DIR,
    join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions'),
  ].filter((x): x is string => !!x)
  return [...new Set(roots)]
}

async function safeDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Scan active and past Claude, Codex, and pi transcripts modified within the range and aggregate
 * their token spend by session, lane, and local day.
 */
export async function collectSpend(opts: CollectSpendOptions): Promise<SpendReport> {
  const { cfg, deps, items = [], from, to, lane = null } = opts
  const zone = opts.zone ?? spendZone(cfg)
  // Pad the mtime cutoff back by 1 day in UTC so no timezone offset skips a transcript written on `from`.
  const cutoffMs = Date.parse(`${addDays(from, -1)}T00:00:00Z`) - DAY_MS

  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  const candidates: Candidate[] = []

  const addCandidate = (c: Candidate): void => {
    const resolved = resolve(c.path)
    const pathKey = normDir(resolved)
    const idKey = c.agent === 'pi' ? normDir(c.key) : c.key
    if (seenPaths.has(pathKey) || seenIds.has(idKey)) return
    seenPaths.add(pathKey)
    seenIds.add(idKey)
    candidates.push({ ...c, path: resolved })
  }

  for (const item of items) {
    if (isAgyItem(item)) continue
    let agent: SpendAgent | null = null
    let path: string | null = null
    if (isCodexItem(item)) {
      agent = 'codex'
      path = deps.codex.transcriptPath(item.session)
    } else if (isPiItem(item)) {
      agent = 'pi'
      path = item.session
    } else if (item.transcript) {
      agent = 'claude'
      path = item.transcript
    }
    if (!agent || !path) continue
    addCandidate({
      key: item.key,
      name: item.name,
      lane: item.category || 'other',
      agent,
      path,
      ...(item.fork?.at && item.fork.at > 0 && { minAt: item.fork.at }),
    })
    if (item.session) seenIds.add(isPiItem(item) ? normDir(item.session) : item.session)
  }

  const cards = allCards()
  const cardsByNorm = new Map<string, ReturnType<typeof cards.get>>()
  for (const [k, v] of cards) cardsByNorm.set(normDir(k), v)
  const archived = listArchive()
  const archivedBySession = new Map<string, (typeof archived)[number]>()
  const archivedByNorm = new Map<string, (typeof archived)[number]>()
  for (const rec of archived) {
    if (rec.session && !archivedBySession.has(rec.session)) archivedBySession.set(rec.session, rec)
    if (rec.key && !archivedBySession.has(rec.key)) archivedBySession.set(rec.key, rec)
    if (rec.session) archivedByNorm.set(normDir(rec.session), rec)
    if (rec.key) archivedByNorm.set(normDir(rec.key), rec)
  }

  const profiles = deps.profiles()
  const profileDirs: string[] = []
  const seenDirs = new Set<string>()
  for (const dir of [profiles.inheritedDir, ...profiles.list.map(p => p.dir)]) {
    const norm = normDir(dir)
    if (seenDirs.has(norm)) continue
    seenDirs.add(norm)
    profileDirs.push(dir)
  }
  const live = deps.homes.liveSessions(profileDirs)

  // Claude projects: <profileDir>/projects/<encoded>/<sessionId>.jsonl
  for (const dir of profileDirs) {
    const projectsDir = join(dir, 'projects')
    for (const proj of await safeDir(projectsDir)) {
      if (!proj.isDirectory()) continue
      const projDir = join(projectsDir, proj.name)
      for (const file of await safeDir(projDir)) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        const sessionId = file.name.slice(0, -6)
        if (!sessionId || seenIds.has(sessionId)) continue
        const full = join(projDir, file.name)
        const st = await stat(full).catch(() => null)
        if (!st?.isFile() || st.size === 0 || st.mtimeMs < cutoffMs) continue
        const card = cards.get(sessionId)
        const arch = archivedBySession.get(sessionId)
        const reg = live.get(sessionId)?.session
        let sessionLane = card?.category || arch?.category || ''
        if (!sessionLane) {
          const cwd = reg?.cwd || arch?.cwd || (await cwdOf(full)) || ''
          sessionLane = (cwd && categoryFor(cfg, cwd)) || 'other'
        }
        const name = card?.name || reg?.name || arch?.name || ''
        const minAt = typeof card?.forkAt === 'number' && card.forkAt > 0 ? card.forkAt : undefined
        addCandidate({
          key: sessionId,
          name,
          lane: sessionLane,
          agent: 'claude',
          path: full,
          ...(minAt !== undefined && { minAt }),
        })
      }
    }
  }

  // Codex rollouts: <root>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
  const codexRoots = opts.codexRoots ?? defaultCodexRoots()
  for (const root of codexRoots) {
    const sessionsDir = join(root, 'sessions')
    for (const yr of await safeDir(sessionsDir)) {
      if (!yr.isDirectory() || !/^\d{4}$/.test(yr.name)) continue
      const yrDir = join(sessionsDir, yr.name)
      for (const mo of await safeDir(yrDir)) {
        if (!mo.isDirectory() || !/^\d{2}$/.test(mo.name)) continue
        const moDir = join(yrDir, mo.name)
        for (const dy of await safeDir(moDir)) {
          if (!dy.isDirectory() || !/^\d{2}$/.test(dy.name)) continue
          const dyDir = join(moDir, dy.name)
          for (const file of await safeDir(dyDir)) {
            if (!file.isFile() || !file.name.startsWith('rollout-') || !file.name.endsWith('.jsonl')) continue
            const id = file.name.slice(-42, -6).toLowerCase()
            if (!isCodexSession(id) || seenIds.has(id)) continue
            const full = join(dyDir, file.name)
            const st = await stat(full).catch(() => null)
            if (!st?.isFile() || st.size === 0 || st.mtimeMs < cutoffMs) continue
            const card = cards.get(id)
            const arch = archivedBySession.get(id)
            let sessionLane = card?.category || arch?.category || ''
            if (!sessionLane) {
              const cwd = arch?.cwd || (await cwdOf(full)) || ''
              sessionLane = (cwd && categoryFor(cfg, cwd)) || 'other'
            }
            const name = card?.name || arch?.name || id.slice(0, 8)
            addCandidate({ key: id, name, lane: sessionLane, agent: 'codex', path: full })
          }
        }
      }
    }
  }

  // pi sessions: <root>/*.jsonl or <root>/<proj>/*.jsonl
  const piRoots = opts.piRoots ?? defaultPiRoots()
  const inspectPiFile = async (full: string): Promise<void> => {
    const resolved = resolve(full)
    const normRes = normDir(resolved)
    const normFull = normDir(full)
    if (seenPaths.has(normRes) || seenIds.has(normRes) || seenIds.has(normFull)) return
    const st = await stat(full).catch(() => null)
    if (!st?.isFile() || st.size === 0 || st.mtimeMs < cutoffMs) return
    const card = cards.get(full) ?? cards.get(resolved) ?? cardsByNorm.get(normRes) ?? cardsByNorm.get(normFull)
    const arch =
      archivedBySession.get(full) ??
      archivedBySession.get(resolved) ??
      archivedByNorm.get(normRes) ??
      archivedByNorm.get(normFull)
    let sessionLane = card?.category || arch?.category || ''
    if (!sessionLane) {
      const cwd = arch?.cwd || (await piFirstLineCwd(full))
      sessionLane = (cwd && categoryFor(cfg, cwd)) || 'other'
    }
    const name = card?.name || arch?.name || ''
    addCandidate({ key: full, name, lane: sessionLane, agent: 'pi', path: full })
  }

  for (const root of piRoots) {
    for (const entry of await safeDir(root)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        await inspectPiFile(join(root, entry.name))
      } else if (entry.isDirectory()) {
        const sub = join(root, entry.name)
        for (const file of await safeDir(sub)) {
          if (file.isFile() && file.name.endsWith('.jsonl')) await inspectPiFile(join(sub, file.name))
        }
      }
    }
  }

  const readSessions = await mapConcurrent(
    candidates,
    READ_CONCURRENCY,
    async (c): Promise<AggregateSessionInput | null> => {
      const read = await readTranscriptSpend(c.path, c.agent, {
        zone,
        ...(c.minAt !== undefined && { minAt: c.minAt }),
      })
      if (!read || read.spend.total.total <= 0) return null
      const fallbackName = c.agent === 'pi' ? piSessionId(c.path).slice(0, 8) || c.key : c.key.slice(0, 8)
      const name = c.name || read.title || fallbackName
      return { key: c.key, name, lane: c.lane, agent: c.agent, spend: read.spend }
    },
  )

  return aggregateSpend({
    from,
    to,
    zone,
    lane,
    sessions: readSessions.filter((s): s is AggregateSessionInput => s !== null),
  })
}
