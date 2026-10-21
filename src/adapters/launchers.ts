// claude-tg on disk (#119): the board's launchers (core/wake/launchers.ts) written into a bin
// folder, as launcherPlan says: the install refreshes those of ours already there; the panel's
// "Install claude-tg" writes both. A file without our mark is never written over, and herdr-wake's
// claude-tg-key.mjs beside them is left alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LauncherName, launcherFiles, launcherPlan } from '../core/wake/launchers.ts'

/** A file's text; null when there is none; '' when it is there but cannot be read (a folder, say): not ours. */
function textOf(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** The launchers into `binDir` (made when one is written): the files written and those left as someone else's. */
export function installLaunchers(
  binDir: string,
  o: { onlyWhereThere: boolean },
): { written: string[]; foreign: string[] } {
  const path = (name: LauncherName): string => join(binDir, name)
  const plan = launcherPlan(
    { 'claude-tg': textOf(path('claude-tg')), 'claude-tg.cmd': textOf(path('claude-tg.cmd')) },
    o,
  )
  const files = launcherFiles()
  if (plan.write.length) mkdirSync(binDir, { recursive: true })
  for (const name of plan.write) writeFileSync(path(name), files[name], { mode: 0o755 })
  return { written: plan.write.map(path), foreign: plan.foreign.map(path) }
}
