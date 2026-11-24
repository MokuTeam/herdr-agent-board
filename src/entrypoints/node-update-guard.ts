// The guard of a Windows node's update (#699, services/node/update-guard.ts): `bun node-update-guard.ts
// <pending file>`, started by the board from the copy of the plugin it made before the update, and
// left running beside it. It puts the new copy in place when the board says go, and puts the copy
// before back when the board does not come back on it. It ends when the record is settled.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { knobMs, pause } from '../adapters/pacing.ts'
import { stateDir } from '../adapters/paths.ts'
import {
  applyUpdate,
  claimPending,
  readPending,
  removeAlive,
  removeTree,
  restorePlugin,
  touchCode,
  writeAlive,
  writePending,
} from '../adapters/plugin-update.ts'
import { GO_MS, GUARD_MS, GUARD_POLL_MS, guardUpdate, RETRIES } from '../services/node/update-guard.ts'

const file = process.argv[2]
if (!file) process.exit(2)

const log = (text: string): void => {
  try {
    appendFileSync(join(stateDir(), 'web.log'), `${new Date().toISOString()} ${text}\n`)
  } catch {}
}
const leave = (code: number): never => {
  try {
    removeAlive(file)
  } catch {}
  process.exit(code)
}
process.on('uncaughtException', err => {
  log(`node-update-guard: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  leave(1)
})

const result = await guardUpdate({
  file,
  waitMs: knobMs('BOARD_NODE_GUARD_MS', GUARD_MS),
  pollMs: GUARD_POLL_MS,
  goMs: GO_MS,
  retries: RETRIES,
  read: readPending,
  write: writePending,
  claim: claimPending,
  alive: writeAlive,
  apply: applyUpdate,
  restore: restorePlugin,
  drop: fresh => {
    try {
      removeTree(fresh)
    } catch (err) {
      log(`node-update-guard: ${fresh} could not be removed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
  touch: touchCode,
  log,
  sleep: pause,
  now: Date.now,
})
leave(result === 'failed' ? 1 : 0)
