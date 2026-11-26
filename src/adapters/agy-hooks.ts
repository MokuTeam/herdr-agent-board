// Only Antigravity CLI's `~/.gemini/config/hooks.json`, `mcp_config.json`,
// `~/.gemini/antigravity-cli/settings.json`, and their backups.
// Herdr's `"herdr"` hook group and any other user/plugin hooks, MCP servers or custom statusLine stay untouched.
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { planAgyHooks, planAgyMcp, planAgySettings } from '../core/agy-hooks.ts'
import { agyConfigured } from '../core/launch/agents.ts'
import type { LaunchSpec } from '../core/types.ts'
import { findCommand } from './setup-facts.ts'

export interface AgyDetectOptions {
  launch?: LaunchSpec | undefined
  env?: Record<string, string | undefined> | undefined
  home?: string | undefined
  platform?: string | undefined
  exists?: ((file: string) => boolean) | undefined
}

const isFolder = (file: string): boolean => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether Antigravity CLI (`agy`) is installed or configured on this machine: via `launch.agy`,
 * `agy` on PATH (including `.cmd`/`.exe`/`.ps1` on Windows), or standard user install folders
 * (`~/.local/bin`, and `%APPDATA%\npm` on Windows) when a daemon's PATH omits them.
 */
export function detectAgy(o: AgyDetectOptions = {}): boolean {
  if (agyConfigured(o.launch)) return true
  const env = o.env ?? process.env
  const home = o.home ?? homedir()
  const platform = o.platform ?? process.platform
  const exists = o.exists ?? existsSync
  const found = findCommand('agy', { env, platform, exists })
  if (found.ps ?? found.sh) return true
  const candidates = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy.ps1', 'agy'] : ['agy']
  const joinFor = (dir: string, ...parts: string[]): string =>
    platform === 'win32' && !dir.startsWith('/') ? win32.join(dir, ...parts) : posix.join(dir, ...parts)
  const dirs = [
    joinFor(home, '.local', 'bin'),
    ...(platform === 'win32' && env.APPDATA ? [joinFor(env.APPDATA, 'npm')] : []),
  ]
  for (const dir of dirs) {
    for (const name of candidates) {
      const file = joinFor(dir, name)
      if (exists(file) && !isFolder(file)) return true
    }
  }
  return false
}

export function agyConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.ANTIGRAVITY_CONFIG_DIR || join(home, '.gemini', 'config')
}

export function agySettingsDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.ANTIGRAVITY_APP_DATA_DIR || join(home, '.gemini', 'antigravity-cli')
}

function readJsonFile(file: string): { before: string | null; parsed: unknown } {
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err
  }
  try {
    const text = before?.replace(/^\uFEFF/, '').trim()
    return { before, parsed: text ? JSON.parse(text) : undefined }
  } catch {
    throw new Error(`${file} is not valid JSON; left as it was`)
  }
}

export function agyHooksPlan(dir: string, script: string): { file: string; before: string | null; after: string } {
  const file = join(dir, 'hooks.json')
  const { before, parsed: settings } = readJsonFile(file)
  const next = planAgyHooks(settings, script)
  const unchanged = before !== null && JSON.stringify(settings) === JSON.stringify(next)
  return { file, before, after: unchanged && before !== null ? before : `${JSON.stringify(next, null, 2)}\n` }
}

export function agyMcpPlan(
  dir: string,
  bun: string,
  cli: string,
): { file: string; before: string | null; after: string } {
  const file = join(dir, 'mcp_config.json')
  const { before, parsed: config } = readJsonFile(file)
  const next = planAgyMcp(config, bun, cli)
  const unchanged = before !== null && JSON.stringify(config) === JSON.stringify(next)
  return { file, before, after: unchanged && before !== null ? before : `${JSON.stringify(next, null, 2)}\n` }
}

function writeWithBackup(plan: { file: string; before: string | null; after: string }): void {
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

export function installAgyHooks(plan: ReturnType<typeof agyHooksPlan>): void {
  writeWithBackup(plan)
}

export function agySettingsPlan(
  dir: string,
  bun: string,
  statusline: string,
): { file: string; before: string | null; after: string; statusLineSet: boolean } {
  const file = join(dir, 'settings.json')
  const { before, parsed: settings } = readJsonFile(file)
  const { settings: next, statusLineSet } = planAgySettings(settings, bun, statusline)
  const unchanged = before !== null && JSON.stringify(settings) === JSON.stringify(next)
  return {
    file,
    before,
    after: unchanged && before !== null ? before : `${JSON.stringify(next, null, 2)}\n`,
    statusLineSet,
  }
}

export function installAgyMcp(plan: ReturnType<typeof agyMcpPlan>): void {
  writeWithBackup(plan)
}

export function installAgySettings(plan: ReturnType<typeof agySettingsPlan>): void {
  writeWithBackup(plan)
}
