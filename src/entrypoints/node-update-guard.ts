// The guard of a Windows node's update (#699, services/node/update-guard.ts): `bun node-update-guard.ts
// <pending file>`, started by the board before an update changes its files and left running beside
// it. It ends when the new board has confirmed the update, or after it put the copy before back.
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { knobMs, pause } from '../adapters/pacing.ts'
import { stateDir } from '../adapters/paths.ts'
import { claimPending, mirrorTree, touchCode } from '../adapters/plugin-update.ts'
import { GUARD_MS, GUARD_POLL_MS, guardUpdate } from '../services/node/update-guard.ts'

const file = process.argv[2]
if (!file) process.exit(2)

const log = (text: string): void => {
  try {
    appendFileSync(join(stateDir(), 'web.log'), `${new Date().toISOString()} ${text}\n`)
  } catch {}
}
process.on('uncaughtException', err => {
  log(`node-update-guard: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})

const result = await guardUpdate({
  file,
  waitMs: knobMs('BOARD_NODE_GUARD_MS', GUARD_MS),
  pollMs: GUARD_POLL_MS,
  pending: existsSync,
  claim: claimPending,
  restore: (old, root) => mirrorTree(old, root),
  touch: touchCode,
  log,
  sleep: pause,
  now: Date.now,
})
process.exit(result === 'failed' ? 1 : 0)
