// The board's MCP server written into, or taken out of, each harness's own config on this computer
// (#814, core/mcp-register.ts says what goes there): Claude Code's .claude.json of each shown
// profile, Codex's config.toml, Antigravity CLI's mcp_config.json and pi's mcp.json. Each file is
// copied to `<file>.bak-agent-board` before the board first rewrites it (a backup there already is
// kept), then written beside itself and renamed, through a link to where it really is, with the
// mode it had; Claude's state file is read again when a running session rewrote it meanwhile
// (adapters/bundle-files.ts editJson). A file that does not parse is left as it was and said.
//
// Only where the harness is the board's: every shown Claude profile; Codex in a CODEX_HOME whose
// hooks.json has the board's hook (install.ts --codex); agy where hooks.json has the board's group
// (install.ts --agy); pi where pi's own folder is there. Taking the entries out goes to every one
// of those files that is there, whatever its harness's hooks say.
import { constants, copyFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGY_HOOK_KEY } from '../core/agy-hooks.ts'
import {
  BOARD_MCP,
  boardMcpUrl,
  claudeMcpEntry,
  planCodexToml,
  planMcpServers,
  stdioMcpEntry,
} from '../core/mcp-register.ts'
import { claudeStateFile } from '../core/move.ts'
import { DEFAULT_PROFILE } from '../core/profiles.ts'
import { editJson, writeWhole } from './bundle-files.ts'

type Env = Record<string, string | undefined>
export type Harness = 'claude' | 'codex' | 'agy' | 'pi'

/** One file's outcome: written, already as it should be, or why it was left as it was. */
export interface McpRegistered {
  harness: Harness
  file: string
  action: 'written' | 'removed' | 'same' | 'failed'
  error?: string
}

export interface McpRegisterOptions {
  /** true: put the board's server in; false: take it out (install.ts --no-mcp). */
  on: boolean
  /** config.json's `port`: the endpoint of the Claude and Codex entries. */
  port: unknown
  /** The Bun and the `board` entrypoint of the stdio entries. */
  bun: string
  cli: string
  /** The shown Claude profiles (core/profiles.ts shownProfiles). */
  profiles: readonly { id: string; dir: string }[]
  /** config.json `codexHome` (install.ts --codex-home), when set. */
  codexHome?: string | null
  /** Which harnesses; all of them when not said. */
  only?: readonly Harness[]
  home?: string
  env?: Env
  platform?: string
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
const parsed = (text: string | null): unknown => {
  const t = text?.replace(/^\uFEFF/, '').trim()
  return t ? JSON.parse(t) : undefined
}

/** A copy of `file` beside it before the board first rewrites it; one there already is kept. */
function backUpOnce(file: string): void {
  if (!existsSync(file)) return
  try {
    copyFileSync(file, `${file}.bak-agent-board`, constants.COPYFILE_EXCL)
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err
  }
}

/** The board's server in (or out of) a JSON config's `mcpServers`; `entry` null takes it out. */
export function editMcpJson(harness: Harness, file: string, entry: Record<string, unknown> | null): McpRegistered {
  const failed = (error: string): McpRegistered => ({ harness, file, action: 'failed', error })
  try {
    // Nothing to change, nothing written and no backup made: read once first.
    let first: Record<string, unknown> | null
    try {
      first = planMcpServers(parsed(readText(file)), entry, file)
    } catch (err) {
      return failed(err instanceof SyntaxError ? `${file} is not valid JSON; left as it was` : messageOf(err))
    }
    if (first === null) return { harness, file, action: 'same' }
    backUpOnce(file)
    let refused = ''
    const done = editJson(file, value => {
      try {
        return planMcpServers(value, entry, file)
      } catch (err) {
        refused = messageOf(err)
        return null
      }
    })
    if (refused) return failed(refused)
    if (done === 'parse') return failed(`${file} is not valid JSON; left as it was`)
    if (done === 'busy') return failed(`${file} was rewritten each time it was read; left as it was`)
    return { harness, file, action: done === 'same' ? 'same' : entry ? 'written' : 'removed' }
  } catch (err) {
    return failed(messageOf(err))
  }
}

/** The board's table in (or out of) Codex's config.toml; `url` null takes it out. */
export function editCodexToml(file: string, url: string | null): McpRegistered {
  try {
    const next = planCodexToml(readText(file), url)
    if (next === null) return { harness: 'codex', file, action: 'same' }
    let target = file
    let mode: number | undefined
    try {
      // Through a link (a dedicated CODEX_HOME links config.toml to ~/.codex's), with its mode.
      target = realpathSync(file)
      mode = statSync(target).mode & 0o777
    } catch {}
    backUpOnce(target)
    writeWhole(target, next, mode)
    return { harness: 'codex', file, action: url ? 'written' : 'removed' }
  } catch (err) {
    return { harness: 'codex', file, action: 'failed', error: messageOf(err) }
  }
}

/** Whether a Codex home has the board's hooks (install.ts --codex). */
const codexHasBoardHooks = (dir: string): boolean =>
  /entrypoints[\\/]+codex-hook\.ts/.test(readText(join(dir, 'hooks.json')) ?? '')

/** Whether agy's hooks.json has the board's group (install.ts --agy). */
function agyHasBoardHooks(dir: string): boolean {
  try {
    const v = parsed(readText(join(dir, 'hooks.json')))
    return !!v && typeof v === 'object' && Object.hasOwn(v, AGY_HOOK_KEY)
  } catch {
    return false
  }
}

/** The folders each harness keeps its config in, as the board finds them elsewhere. */
export function harnessDirs(o: Pick<McpRegisterOptions, 'codexHome' | 'home' | 'env'>): {
  codex: string[]
  agy: string
  pi: string
} {
  const home = o.home ?? homedir()
  const env = o.env ?? process.env
  const codex = [env.CODEX_HOME || join(home, '.codex'), ...(o.codexHome ? [o.codexHome] : [])]
  return {
    codex: [...new Set(codex)],
    agy: env.ANTIGRAVITY_CONFIG_DIR || join(home, '.gemini', 'config'),
    pi: env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
  }
}

/**
 * The board's server put into (`on`) or taken out of every harness here that is the board's (see
 * above). Never throws: each file's outcome is in the list, a failed one with why.
 */
export function registerBoardMcp(o: McpRegisterOptions): McpRegistered[] {
  const home = o.home ?? homedir()
  const platform = o.platform ?? process.platform
  const wants = (h: Harness): boolean => !o.only || o.only.includes(h)
  const url = boardMcpUrl(o.port)
  const dirs = harnessDirs(o)
  const out: McpRegistered[] = []
  if (wants('claude'))
    for (const p of o.profiles) {
      // Another profile's folder that is not there is not made for this; the default one's state is ~/.claude.json.
      if (p.id !== DEFAULT_PROFILE && !isFolder(p.dir)) continue
      const file = claudeStateFile(p.dir, home, platform)
      if (!o.on && !existsSync(file)) continue
      out.push(editMcpJson('claude', file, o.on ? claudeMcpEntry(url) : null))
    }
  if (wants('codex'))
    for (const dir of dirs.codex) {
      const file = join(dir, 'config.toml')
      if (o.on ? !codexHasBoardHooks(dir) : !existsSync(file)) continue
      out.push(editCodexToml(file, o.on ? url : null))
    }
  if (wants('agy')) {
    const file = join(dirs.agy, 'mcp_config.json')
    if (o.on ? agyHasBoardHooks(dirs.agy) : existsSync(file))
      out.push(editMcpJson('agy', file, o.on ? stdioMcpEntry(o.bun, o.cli) : null))
  }
  if (wants('pi')) {
    const file = join(dirs.pi, 'mcp.json')
    if (o.on ? isFolder(dirs.pi) : existsSync(file))
      out.push(editMcpJson('pi', file, o.on ? stdioMcpEntry(o.bun, o.cli) : null))
  }
  return out
}

const HARNESS: Record<Harness, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity CLI', pi: 'pi' }

/** One line for the install's output. */
export function registeredLine(r: McpRegistered): string {
  const what = `board MCP (${BOARD_MCP}) for ${HARNESS[r.harness]}`
  if (r.action === 'failed') return `${what}: not changed: ${r.error}`
  if (r.action === 'removed') return `${what}: removed from ${r.file}`
  return `${what}: ${r.file}`
}
