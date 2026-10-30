import { mock, onTestFinished } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

/**
 * Point the board's config and state folders, and the home folder (HOME and USERPROFILE: `<dir>/home`),
 * at a fresh temp dir for this test, without the CLAUDE_CONFIG_DIR of the shell that runs the tests
 * (paths are read at call time). ssh and ssh-keygen are files there that do not exist, so a test
 * that forgets the fake (fake-ssh-bin.ts) reaches no real one; bw and PowerShell likewise.
 */
export function isolatedHome(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'board-adapters-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  const saved = {
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    BOARD_SSH_BIN_PATH: process.env.BOARD_SSH_BIN_PATH,
    BOARD_SSH_KEYGEN_BIN_PATH: process.env.BOARD_SSH_KEYGEN_BIN_PATH,
    BOARD_BW_BIN_PATH: process.env.BOARD_BW_BIN_PATH,
    BOARD_POWERSHELL_BIN_PATH: process.env.BOARD_POWERSHELL_BIN_PATH,
    HERDR_BOARD_CARDS_DIR: process.env.HERDR_BOARD_CARDS_DIR,
  }
  process.env.APPDATA = join(dir, 'config')
  process.env.LOCALAPPDATA = join(dir, 'state')
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.BOARD_SSH_BIN_PATH = join(dir, 'no-ssh.exe')
  process.env.BOARD_SSH_KEYGEN_BIN_PATH = join(dir, 'no-ssh-keygen.exe')
  // nor the owner's Bitwarden or PowerShell (secret sinks, #273: fake-secrets-bin.ts)
  process.env.BOARD_BW_BIN_PATH = join(dir, 'no-bw.exe')
  process.env.BOARD_POWERSHELL_BIN_PATH = join(dir, 'no-powershell.exe')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.HERDR_BOARD_CARDS_DIR
  // Bun on macOS can cache homedir() before HOME changes. Keep the fixture isolated there
  // too, including modules that already imported the named export; restore it after the test.
  const originalOs = { ...os }
  const cachedHome = os.homedir() !== home
  if (cachedHome) mock.module('node:os', () => ({ ...originalOs, homedir: () => home }))
  onTestFinished(() => {
    if (cachedHome) mock.module('node:os', () => originalOs)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
