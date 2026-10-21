// What wake's tests write on disk: a running Claude session in a profile folder (its registry entry
// and its transcript, as Claude Code keeps them) and the board's config.json with its profiles.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'

/** Two Claude session ids. */
export const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
export const SID2 = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d'

/** How long a session has been idle unless the test says otherwise: well past any idleMinutes it sets. */
const IDLE_FOR_MS = 3 * 3_600_000

let nextFile = 1

/**
 * Claude's registry entry (<dir>/sessions/<n>.json, this test's pid, so it counts as running) and
 * its transcript (<dir>/projects/<projectFolderName(cwd)>/<id>.jsonl, a first line with "cwd",
 * then `lines`). `status` is idle and `statusUpdatedAt` hours ago unless given; a null
 * `statusUpdatedAt` writes none (Claude did not record it). `n` names the registry file.
 */
export function runningSession(
  dir: string,
  s: {
    id: string
    name: string
    cwd: string
    status?: string
    statusUpdatedAt?: number | null
    n?: number
    lines?: string[]
  },
): void {
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const updated = s.statusUpdatedAt === undefined ? Date.now() - IDLE_FOR_MS : s.statusUpdatedAt
  writeFileSync(
    join(sessions, `${s.n ?? nextFile++}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: s.id,
      kind: 'interactive',
      name: s.name,
      cwd: s.cwd,
      status: s.status ?? 'idle',
      ...(updated !== null && { statusUpdatedAt: updated }),
    }),
  )
  const project = join(dir, 'projects', projectFolderName(s.cwd))
  mkdirSync(project, { recursive: true })
  const first = { type: 'user', cwd: s.cwd, sessionId: s.id, timestamp: new Date().toISOString() }
  writeFileSync(join(project, `${s.id}.jsonl`), `${[JSON.stringify(first), ...(s.lines ?? [])].join('\n')}\n`)
}

/** The board's config.json under `appData` (as APPDATA): these profiles, then `extra`'s fields. */
export function profilesConfig(
  appData: string,
  profiles: { id: string; title?: string; dir: string }[],
  extra: Record<string, unknown> = {},
): void {
  const dir = join(appData, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ profiles, ...extra }, null, 2))
}
