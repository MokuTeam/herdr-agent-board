// Who the owner has welcomed into the team on this board (#355), in the state folder:
// team-welcome.json, `{ v: 1, since, done: { <peer id>: <when> } }`. A peer first seen after
// `since` (its pin's `at`) and not done yet is offered the panel's one welcome screen. Made the
// first time the running board with `team` set asks for it, with `since` = now, so the members
// already there are not all offered at once.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export interface Welcomed {
  since: number
  done: Record<string, number>
}

type WelcomeFile = { v: 1 } & Welcomed

const isWelcomeFile = (v: unknown): v is WelcomeFile =>
  isRecord(v) &&
  v.v === 1 &&
  typeof v.since === 'number' &&
  isRecord(v.done) &&
  Object.values(v.done).every(t => typeof t === 'number')

export const teamWelcomeFile = (): string => join(stateDir(), 'team-welcome.json')

const PRIVATE = { mode: 0o600 } as const

/** Who was welcomed; the first time, the file is made with `since` = now. */
export function readWelcomed(now: number): Welcomed {
  const have = readJson(teamWelcomeFile(), isWelcomeFile)
  if (have) return { since: have.since, done: { ...have.done } }
  mkdirSync(stateDir(), { recursive: true })
  const made = updateJson(
    teamWelcomeFile(),
    (cur: WelcomeFile | null) => cur ?? { v: 1 as const, since: now, done: {} },
    isWelcomeFile,
    PRIVATE,
  )
  return { since: made.since, done: { ...made.done } }
}

/** The owner settled a peer's welcome screen. */
export function markWelcomed(peer: string, now: number): void {
  mkdirSync(stateDir(), { recursive: true })
  updateJson(
    teamWelcomeFile(),
    (cur: WelcomeFile | null) => {
      const f = cur ?? { v: 1 as const, since: now, done: {} }
      return { ...f, done: { ...f.done, [peer]: now } }
    },
    isWelcomeFile,
    PRIVATE,
  )
}
