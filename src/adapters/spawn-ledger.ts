// The ledger of agent starts (#815, core/spawn-limits.ts): spawns.json in the board's state folder,
// written under its lock by spawn-agent itself, so starts from several sessions at once each see the
// others. No file: no session has started one; the owner's starts are never written.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { kept, type SpawnEntry, type SpawnParty } from '../core/spawn-limits.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export interface SpawnLedger {
  entries: SpawnEntry[]
}

export const spawnLedgerFile = (): string => join(stateDir(), 'spawns.json')

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512
const isParty = (v: unknown): v is SpawnParty =>
  isRecord(v) && (v.session === undefined || str(v.session)) && (v.pane === undefined || str(v.pane))
const isEntry = (v: unknown): v is SpawnEntry =>
  isRecord(v) &&
  str(v.id) &&
  typeof v.at === 'number' &&
  Number.isFinite(v.at) &&
  isParty(v.by) &&
  typeof v.name === 'string' &&
  (v.child === undefined || isParty(v.child))

/** The ledger as it is on disk; an entry that is not one is left out. */
const isLedger = (v: unknown): v is SpawnLedger => isRecord(v) && Array.isArray(v.entries)
const entriesOf = (l: SpawnLedger | null): SpawnEntry[] => (l ? l.entries.filter(isEntry) : [])

/** The entries on record (none without a file). */
export function readSpawns(file = spawnLedgerFile()): SpawnEntry[] {
  return entriesOf(readJson(file, isLedger))
}

/**
 * Under the ledger's lock: `decide` gets the entries younger than a week and says whether the
 * start may go; a start that may is written, without its session yet. Returns what `decide` said
 * and the new entry's id (null when it was refused).
 */
export function reserveSpawn<V extends { ok: boolean }>(
  by: SpawnParty,
  name: string,
  now: number,
  decide: (entries: SpawnEntry[]) => V,
  file = spawnLedgerFile(),
): { verdict: V; id: string | null } {
  mkdirSync(join(file, '..'), { recursive: true })
  let verdict: V | undefined
  let id: string | null = null
  updateJson(
    file,
    (cur: SpawnLedger | null): SpawnLedger | undefined => {
      const entries = kept(entriesOf(cur), now)
      verdict = decide(entries)
      if (!verdict.ok) return undefined
      id = randomUUID()
      return { entries: [...entries, { id, at: now, by, name: name.slice(0, 200) }] }
    },
    isLedger,
  )
  return { verdict: verdict as V, id }
}

/**
 * What became of a start written by reserveSpawn: the session it is (`{}` when the start did not
 * say), or null when it did not start, which takes the entry out.
 */
export function settleSpawn(id: string, child: SpawnParty | null, file = spawnLedgerFile()): void {
  updateJson(
    file,
    (cur: SpawnLedger | null): SpawnLedger | undefined => {
      const entries = entriesOf(cur)
      if (!entries.some(e => e.id === id)) return undefined
      return {
        entries:
          child === null ? entries.filter(e => e.id !== id) : entries.map(e => (e.id === id ? { ...e, child } : e)),
      }
    },
    isLedger,
  )
}
