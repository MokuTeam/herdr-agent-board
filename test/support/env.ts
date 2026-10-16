import { onTestFinished } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Point the board's config and state folders at a fresh temp dir for this test (paths are read at call time). */
export function isolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-adapters-'))
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = join(dir, 'config')
  process.env.LOCALAPPDATA = join(dir, 'state')
  onTestFinished(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
