import { onTestFinished } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point the board's config and state folders, and the home folder (HOME and USERPROFILE: `<dir>/home`),
 * at a fresh temp dir for this test, without the CLAUDE_CONFIG_DIR of the shell that runs the tests
 * (paths are read at call time).
 */
export function isolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-adapters-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  const saved = {
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }
  process.env.APPDATA = join(dir, 'config')
  process.env.LOCALAPPDATA = join(dir, 'state')
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.CLAUDE_CONFIG_DIR
  onTestFinished(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
