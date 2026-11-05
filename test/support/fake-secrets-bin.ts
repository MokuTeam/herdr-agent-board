// The fake Bitwarden CLI and PowerShell (fake-bw.ts, fake-powershell.ts) as real executables, for
// BOARD_BW_BIN_PATH and BOARD_POWERSHELL_BIN_PATH, their state and logs in `dir`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFake } from './fake-herdr-bin.ts'

const bwSource = fileURLToPath(new URL('./fake-bw.ts', import.meta.url))
const psSource = fileURLToPath(new URL('./fake-powershell.ts', import.meta.url))

const lines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []

/** The fakes' env for `dir` (into process.env, or a sandbox's run), and what they kept. */
export async function fakeSecretBins(dir: string) {
  const [bw, ps] = await Promise.all([compileFake(bwSource, 'fake-bw'), compileFake(psSource, 'fake-powershell')])
  const files = {
    bwState: join(dir, 'bw-vault.json'),
    bwLog: join(dir, 'bw-calls.jsonl'),
    envState: join(dir, 'user-env.json'),
    psLog: join(dir, 'ps-calls.jsonl'),
  }
  return {
    files,
    env: {
      BOARD_BW_BIN_PATH: bw,
      BOARD_POWERSHELL_BIN_PATH: ps,
      FAKE_BW_STATE: files.bwState,
      FAKE_BW_LOG: files.bwLog,
      FAKE_ENV_STATE: files.envState,
      FAKE_PS_LOG: files.psLog,
    },
    vault: (value: unknown): void => writeFileSync(files.bwState, JSON.stringify(value)),
    readVault: (): { folders: { id: string; name: string }[]; items: Record<string, unknown>[] } =>
      JSON.parse(readFileSync(files.bwState, 'utf8')),
    userEnv: (): Record<string, string> =>
      existsSync(files.envState) ? JSON.parse(readFileSync(files.envState, 'utf8')) : {},
    bwCalls: () => lines(files.bwLog) as { argv: string[]; session: boolean; noInteraction?: string; stdin: boolean }[],
    psCalls: () => lines(files.psLog) as string[][],
  }
}
