// The owner's read marks on the team's threads (#355), in the state folder: team-reads.json,
// `{ v: 1, since, threads: { <thread key>: <when last read> } }`. Made the first time the running
// board with `team` set asks for it; nothing else writes it. core/team-unread.ts reads the marks.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Reads } from '../core/team-unread.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

type ReadsFile = { v: 1 } & Reads

const isReadsFile = (v: unknown): v is ReadsFile =>
  isRecord(v) &&
  v.v === 1 &&
  typeof v.since === 'number' &&
  isRecord(v.threads) &&
  Object.values(v.threads).every(t => typeof t === 'number')

export const teamReadsFile = (): string => join(stateDir(), 'team-reads.json')

const bare = ({ since, threads }: ReadsFile): Reads => ({ since, threads: { ...threads } })

/** The marks, without making the file: null while there is none. */
export function peekReads(): Reads | null {
  const r = readJson(teamReadsFile(), isReadsFile)
  return r ? bare(r) : null
}

/** The marks; the first time, the file is made with `since` = now, so what came before is not news. */
export function readReads(now: number): Reads {
  const have = peekReads()
  if (have) return have
  mkdirSync(stateDir(), { recursive: true })
  return bare(
    updateJson(
      teamReadsFile(),
      (cur: ReadsFile | null) => cur ?? { v: 1 as const, since: now, threads: {} },
      isReadsFile,
    ),
  )
}

/** `thread` read up to `at` (a mark only moves forward). */
export function markRead(thread: string, at: number): void {
  mkdirSync(stateDir(), { recursive: true })
  updateJson(
    teamReadsFile(),
    (cur: ReadsFile | null) => {
      const base = cur ?? { v: 1 as const, since: at, threads: {} }
      if ((base.threads[thread] ?? 0) >= at) return base
      return { ...base, threads: { ...base.threads, [thread]: at } }
    },
    isReadsFile,
  )
}
