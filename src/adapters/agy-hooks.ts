// Only Antigravity CLI's `~/.gemini/config/hooks.json` and its backup.
// Herdr's `"herdr"` hook group and any other user/plugin hooks stay untouched.
import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { planAgyHooks } from '../core/agy-hooks.ts'

export function agyConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.ANTIGRAVITY_CONFIG_DIR || join(home, '.gemini', 'config')
}

export function agyHooksPlan(dir: string, script: string): { file: string; before: string | null; after: string } {
  const file = join(dir, 'hooks.json')
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err
  }
  let settings: unknown
  try {
    const text = before?.replace(/^\uFEFF/, '').trim()
    settings = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`${file} is not valid JSON; left as it was`)
  }
  const next = planAgyHooks(settings, script)
  const unchanged = before !== null && JSON.stringify(settings) === JSON.stringify(next)
  return { file, before, after: unchanged && before !== null ? before : `${JSON.stringify(next, null, 2)}\n` }
}

export function installAgyHooks(plan: ReturnType<typeof agyHooksPlan>): void {
  if (plan.before === plan.after) return
  if (plan.before !== null) {
    try {
      copyFileSync(plan.file, `${plan.file}.bak-agent-board`, constants.COPYFILE_EXCL)
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err
    }
  }
  mkdirSync(dirname(plan.file), { recursive: true })
  writeFileSync(plan.file, plan.after)
}
