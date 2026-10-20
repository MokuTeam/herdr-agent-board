// The fake ssh (fake-ssh.ts) as a real executable, for BOARD_SSH_BIN_PATH and
// BOARD_SSH_KEYGEN_BIN_PATH: one file serves as both ssh and ssh-keygen.
import { onTestFinished } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedHome } from './env.ts'
import { compileFake } from './fake-herdr-bin.ts'

const source = fileURLToPath(new URL('./fake-ssh.ts', import.meta.url))

export function fakeSshBin(): Promise<string> {
  return compileFake(source, 'fake-ssh')
}

/**
 * A fresh isolatedHome() with the fake as both ssh and ssh-keygen, its state and its log in that
 * folder (isolatedHome restores the BOARD_SSH_* variables, this the others).
 */
export async function useFakeSsh() {
  const bin = await fakeSshBin()
  const dir = isolatedHome()
  const log = join(dir, 'ssh-calls.jsonl')
  const stateFile = join(dir, 'ssh-state.json')
  const saved = {
    FAKE_SSH_LOG: process.env.FAKE_SSH_LOG,
    FAKE_SSH_STATE: process.env.FAKE_SSH_STATE,
    BUN_FEATURE_FLAG_NO_ORPHANS: process.env.BUN_FEATURE_FLAG_NO_ORPHANS,
  }
  process.env.FAKE_SSH_LOG = log
  process.env.FAKE_SSH_STATE = stateFile
  // A fake ssh that holds its forward ends with this test process, should the run be cut off (as sandbox() does).
  process.env.BUN_FEATURE_FLAG_NO_ORPHANS = '1'
  process.env.BOARD_SSH_BIN_PATH = bin
  process.env.BOARD_SSH_KEYGEN_BIN_PATH = bin
  onTestFinished(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  return {
    bin,
    dir,
    state: (value: unknown): void => writeFileSync(stateFile, JSON.stringify(value)),
    calls: (): string[][] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as string[])
        : [],
  }
}
