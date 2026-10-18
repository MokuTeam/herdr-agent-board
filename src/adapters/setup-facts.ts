// What the setup checks (core/setup.ts) look at, read from this computer: the commands on PATH,
// Claude Code's settings.json, herdr's config.toml, herdr-wake, how new sessions start.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { shimTarget } from '../core/install-plan.ts'
import { launcherLabel } from '../core/launch/launcher-command.ts'
import { claudeCommand, shellLine } from '../core/launch/spawn-args.ts'
import {
  boardFiles,
  type CommandFinds,
  type CommandHit,
  type LauncherFacts,
  type ProgramFound,
  type SetupFacts,
} from '../core/setup.ts'
import type { Config } from '../core/types.ts'
import { ROOT } from './paths.ts'

type Env = Record<string, string | undefined>

/** herdr's config.toml: under %APPDATA% on Windows, ~/.config elsewhere (as the plugin config). */
export const herdrConfigFile = (env: Env = process.env, home = homedir()): string =>
  join(env.APPDATA || join(home, '.config'), 'herdr', 'config.toml')

/** A text file as a string (a BOM taken off, as Windows PowerShell writes one), or null. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

// Our command files are a few hundred bytes; claude.exe or bun.exe on PATH is not read.
const SHIM_MAX = 4096
const sizeOf = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
const isFolder = (file: string): boolean => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

export interface FindOptions {
  env?: Env
  platform?: string
  exists?: (file: string) => boolean
  read?: (file: string) => string | null
  size?: (file: string) => number
}

/**
 * Where each shell finds a command: { ps, sh } with the file and, for one of ours, the script it
 * runs. PowerShell takes a .ps1 before a .cmd in the same folder, Git Bash and Unix shells the
 * file of that very name.
 */
export function findCommand(
  name: string,
  {
    env = process.env,
    platform = process.platform,
    exists = existsSync,
    read = readText,
    size = sizeOf,
  }: FindOptions = {},
): CommandFinds {
  // Paths as `platform` writes them, which need not be the system this runs on (the tests).
  const paths = platform === 'win32' ? win32 : posix
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(paths.delimiter)
    .filter(Boolean)
  const exts = [
    '.ps1',
    ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .map(e => e.toLowerCase()),
  ]
  const hit = (list: string[]): CommandHit | null => {
    for (const dir of dirs) {
      for (const n of list) {
        const file = paths.join(dir, n)
        if (!exists(file) || isFolder(file)) continue
        const target = size(file) <= SHIM_MAX ? shimTarget(read(file)) : null
        return { file, target, ...(target && !exists(target) && { gone: true as const }) }
      }
    }
    return null
  }
  return platform === 'win32'
    ? { ps: hit(exts.map(e => name + e)), sh: hit([name, `${name}.exe`]) }
    : { sh: hit([name]) }
}

async function probe(url: string, timeoutMs = 1500): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    const e = err as { cause?: { code?: unknown }; name?: unknown; message?: unknown }
    return { ok: false, error: String(e?.cause?.code || e?.name || e?.message || err) }
  }
}

/** The program a launcher runs, found the way the board would: a path as it is, else on PATH. */
function program(name: string, env: Env, platform: string): ProgramFound | null {
  if (!name) return null
  if (isAbsolute(name) || /[\\/]/.test(name)) return { file: resolve(name), found: existsSync(resolve(name)) }
  const f = findCommand(name, { env, platform })
  const found = f.ps ?? f.sh
  return { file: found?.file ?? name, found: !!found }
}

/** How new sessions start, from `launch` in config.json. */
function launcherFacts(launch: Config['launch'], env: Env, platform: string): LauncherFacts {
  if (launch?.command) {
    const cmd: unknown[] = Array.isArray(launch.command) ? launch.command : []
    const script = cmd
      .flat()
      .map(String)
      .find(s => /\.(ps1|sh|mjs|cjs|js|py)$/i.test(s) && !/\{/.test(s))
    return {
      kind: 'command',
      name: launcherLabel(cmd),
      program: program(String(cmd[0] ?? ''), env, platform),
      script: script ? { file: script, found: existsSync(script) } : null,
    }
  }
  if (launch?.agent) return { kind: 'herdr', agent: String(launch.agent) }
  let claude: string[] | null = null
  let error = ''
  try {
    claude = claudeCommand(launch?.claude, launch?.args)
    shellLine(claude)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return { kind: 'builtin', claude, error, program: claude ? program(claude[0] ?? '', env, platform) : null }
}

export interface GatherOptions {
  root?: string
  env?: Env
  platform?: string
  home?: string
}

/** Everything the checks look at, read from this computer. */
export async function gatherFacts(
  cfg: Partial<Config> | null | undefined,
  { root = ROOT, env = process.env, platform = process.platform, home = homedir() }: GatherOptions = {},
): Promise<SetupFacts> {
  const settingsFile = join(home, '.claude', 'settings.json')
  const settingsText = readText(settingsFile)
  let settings: unknown = null
  let settingsError = ''
  if (settingsText !== null) {
    try {
      settings = JSON.parse(settingsText)
    } catch (err) {
      // Only where it broke: the parser's message may quote the file around it, and this goes to the page.
      const at = /position \d+/.exec(err instanceof Error ? err.message : '')
      settingsError = `not valid JSON${at ? ` (${at[0]})` : ''}`
    }
  }
  const configFile = herdrConfigFile(env, home)
  const wakeUrl = typeof cfg?.wakeUrl === 'string' && cfg.wakeUrl ? cfg.wakeUrl : null
  return {
    platform,
    root,
    node: process.versions.node ?? '',
    binDir: join(home, '.local', 'bin'),
    path: String(env.PATH ?? env.Path ?? ''),
    files: boardFiles(root),
    commands: {
      board: findCommand('board', { env, platform }),
      'spawn-agent': findCommand('spawn-agent', { env, platform }),
    },
    settingsFile,
    settings,
    settingsError,
    herdrConfigFile: configFile,
    herdrConfig: readText(configFile),
    wakeUrl,
    wake: wakeUrl ? await probe(`${wakeUrl.replace(/\/+$/, '')}/status`) : null,
    launcher: launcherFacts(cfg?.launch, env, platform),
  }
}
