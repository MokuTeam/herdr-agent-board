import { mock, onTestFinished } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'BOARD_SSH_BIN_PATH',
  'BOARD_SSH_KEYGEN_BIN_PATH',
  'BOARD_BW_BIN_PATH',
  'BOARD_POWERSHELL_BIN_PATH',
  'HERDR_BOARD_CARDS_DIR',
] as const

type SavedEnv = Record<(typeof ENV_KEYS)[number], string | undefined>

export interface IsolatedHomeNames {
  home?: string
  appData?: string
  localAppData?: string
}

// Snapshot the outermost pre-test env/os once per test and restore in a single cleanup so
// repeated isolatedHome() calls inside one test never overwrite the real env with an earlier
// sandbox's paths, regardless of callback order. Mutates process.env globally, so tests calling
// isolatedHome() must run sequentially (not test.concurrent).
let active: { saved: SavedEnv; originalOs: typeof os; mockedOs: boolean; dirs: string[] } | null = null

/**
 * Point the board's config and state folders, and the home folder (HOME and USERPROFILE: `<dir>/home`
 * unless `names.home` overrides it), at a fresh temp dir for this test, without the
 * CLAUDE_CONFIG_DIR of the shell that runs the tests (paths are read at call time). ssh and
 * ssh-keygen are files there that do not exist, so a test that forgets the fake (fake-ssh-bin.ts)
 * reaches no real one; bw and PowerShell likewise. Not concurrency-safe (mutates process.env).
 */
export function isolatedHome(names: IsolatedHomeNames = {}): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'board-adapters-'))
  const home = join(dir, names.home ?? 'home')
  mkdirSync(home, { recursive: true })
  if (!active) {
    const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) as SavedEnv
    const state = { saved, originalOs: { ...os }, mockedOs: false, dirs: [dir] }
    try {
      onTestFinished(() => {
        active = null
        for (const [k, v] of Object.entries(state.saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
        try {
          if (state.mockedOs) mock.module('node:os', () => state.originalOs)
        } finally {
          for (const d of state.dirs) {
            try {
              rmSync(d, { recursive: true, force: true })
            } catch {
              // Best-effort cleanup (e.g. Windows EBUSY) must not skip remaining temp dirs.
            }
          }
        }
      })
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw err
    }
    active = state
  } else {
    active.dirs.push(dir)
  }
  process.env.APPDATA = join(dir, names.appData ?? 'config')
  process.env.LOCALAPPDATA = join(dir, names.localAppData ?? 'state')
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.BOARD_SSH_BIN_PATH = join(dir, 'no-ssh.exe')
  process.env.BOARD_SSH_KEYGEN_BIN_PATH = join(dir, 'no-ssh-keygen.exe')
  // nor the owner's Bitwarden or PowerShell (secret sinks, #273: fake-secrets-bin.ts)
  process.env.BOARD_BW_BIN_PATH = join(dir, 'no-bw.exe')
  process.env.BOARD_POWERSHELL_BIN_PATH = join(dir, 'no-powershell.exe')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.HERDR_BOARD_CARDS_DIR
  // Bun on macOS (and Linux) can cache homedir() before HOME changes. Keep the fixture isolated
  // there too, including modules that already imported the named export; restore it after the test.
  if (active.originalOs.homedir() !== home || active.mockedOs) {
    const originalOs = active.originalOs
    mock.module('node:os', () => ({ ...originalOs, homedir: () => home }))
    active.mockedOs = true
  }
  return dir
}
