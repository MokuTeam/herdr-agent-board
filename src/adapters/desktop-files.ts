// The agents' browsers on the board's server (core/desktop.ts): what the board's install puts in
// place for them as the board's user, and what `board doctor` reads of them. chrome-devtools-mcp
// at its pinned version in the board's state folder (desktop/mcp), and the board's MCP server
// (`board browser-mcp`) in each shown Claude profile's .claude.json, user scope; out of them again
// when the server mode goes. Server mode only: the install action calls nothing here on a PC.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_MCP,
  browserMcpEntry,
  CHROME_BINS,
  DEVTOOLS_MCP,
  DEVTOOLS_MCP_VERSION,
  type DesktopDoctorFacts,
  withBrowserMcp,
} from '../core/desktop.ts'
import { DEFAULT_PROFILE, type Profile } from '../core/profiles.ts'
import { replaceFile } from './json-store.ts'
import { stateDir } from './paths.ts'
import { claudeJsonOf } from './profile-sync.ts'

/** The desktops' folder: their sessions, the named profiles, chrome-devtools-mcp. */
export const desktopDir = (): string => join(stateDir(), 'desktop')
const mcpDir = (): string => join(desktopDir(), 'mcp')

/** chrome-devtools-mcp's version in place, or null. */
export function devtoolsMcpVersion(): string | null {
  try {
    const p = JSON.parse(readFileSync(join(mcpDir(), 'node_modules', DEVTOOLS_MCP, 'package.json'), 'utf8'))
    return typeof p.version === 'string' ? p.version : null
  } catch {
    return null
  }
}

/** chrome-devtools-mcp's program (its package's bin), or null when it is not in place. */
export function devtoolsMcpBin(): string | null {
  try {
    const dir = join(mcpDir(), 'node_modules', DEVTOOLS_MCP)
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bin = typeof p.bin === 'string' ? p.bin : p.bin?.[DEVTOOLS_MCP]
    return typeof bin === 'string' && existsSync(join(dir, bin)) ? join(dir, bin) : null
  } catch {
    return null
  }
}

/** chrome-devtools-mcp at its pinned version, by `bun` (the one running the install); what it did, or why not. */
export async function installDevtoolsMcp(bun: string): Promise<string> {
  if (devtoolsMcpVersion() === DEVTOOLS_MCP_VERSION) return `${DEVTOOLS_MCP} ${DEVTOOLS_MCP_VERSION}: in place`
  mkdirSync(mcpDir(), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(mcpDir(), 'package.json'),
    `${JSON.stringify({ private: true, dependencies: { [DEVTOOLS_MCP]: DEVTOOLS_MCP_VERSION } }, null, 2)}\n`,
  )
  const proc = Bun.spawn([bun, 'install', '--production', '--no-save'], {
    cwd: mcpDir(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0 || devtoolsMcpVersion() !== DEVTOOLS_MCP_VERSION)
    throw new Error(
      `${DEVTOOLS_MCP} ${DEVTOOLS_MCP_VERSION} not installed: ${err.trim().split('\n').at(-1) ?? `exit ${code}`}`,
    )
  return `${DEVTOOLS_MCP} ${DEVTOOLS_MCP_VERSION}: installed`
}

/** A profile's .claude.json, where its user-scope MCP servers are. */
const claudeJsonFile = (p: Pick<Profile, 'id' | 'dir'>): string =>
  claudeJsonOf(p.dir, p.id === DEFAULT_PROFILE ? 'default' : p.id, homedir())

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return {}
    throw new Error(`${file} is not valid JSON: left as it is`)
  }
}

/**
 * The board's MCP server in a profile's .claude.json (on), or out of it (off): its file, and
 * whether it changed. The board command (`board`, an absolute path) runs it. Its mode stays
 * the file's (Claude keeps it 0600).
 */
export function setBrowserMcp(
  p: Pick<Profile, 'id' | 'dir'>,
  on: boolean,
  board: string,
): { file: string; changed: boolean } {
  const file = claudeJsonFile(p)
  if (!on && !existsSync(file)) return { file, changed: false }
  const next = withBrowserMcp(readJsonFile(file), on ? browserMcpEntry(board) : null)
  if (!next) return { file, changed: false }
  let mode = 0o600
  try {
    mode = statSync(file).mode & 0o777
  } catch {}
  replaceFile(file, `${JSON.stringify(next, null, 2)}\n`)
  try {
    chmodSync(file, mode)
  } catch {}
  return { file, changed: true }
}

/** Whether a profile has the board's MCP server. */
export function hasBrowserMcp(p: Pick<Profile, 'id' | 'dir'>): boolean {
  try {
    const cj = readJsonFile(claudeJsonFile(p)) as { mcpServers?: Record<string, unknown> }
    return !!cj?.mcpServers?.[BROWSER_MCP]
  } catch {
    return false
  }
}

/** What `board doctor` reads of the desktops: the programs, the fonts, chrome-devtools-mcp, each shown profile. */
export function desktopDoctorFacts(profiles: readonly Profile[]): DesktopDoctorFacts {
  const PATH = `${process.env.PATH ?? ''}:/usr/bin:/bin:/opt/google/chrome`
  return {
    xvnc: Bun.which('Xvnc', { PATH }),
    chrome: CHROME_BINS.map(b => Bun.which(b, { PATH })).find(Boolean) ?? null,
    fonts: ['/usr/share/fonts/truetype/noto', '/usr/share/fonts/opentype/noto'].some(d => existsSync(d)),
    mcp: devtoolsMcpVersion(),
    profiles: profiles.map(p => ({ title: p.title || p.id, has: hasBrowserMcp(p) })),
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The install's part for the agents' browsers, on the board's own server: the board's MCP server
 * in every shown profile whose folder is there (the default one always), and chrome-devtools-mcp
 * at its pinned version. What fails is said, and the rest goes on.
 */
export async function putBrowserParts(
  profiles: readonly Profile[],
  o: { board: string; bun: string; say: (line: string) => void },
): Promise<void> {
  for (const p of profiles) {
    if (p.id !== DEFAULT_PROFILE && !isFolder(p.dir)) continue
    try {
      const r = setBrowserMcp(p, true, o.board)
      o.say(`browser: the MCP server ${BROWSER_MCP} in ${r.file}${r.changed ? '' : ' (there)'}`)
    } catch (err) {
      o.say(`browser: the MCP server ${BROWSER_MCP} not in ${p.dir}: ${messageOf(err)}`)
    }
  }
  try {
    o.say(`browser: ${await installDevtoolsMcp(o.bun)}`)
  } catch (err) {
    o.say(`browser: ${messageOf(err)}`)
  }
}

/** The server mode off: the board's MCP server out of every profile (hidden ones too), chrome-devtools-mcp's folder gone. */
export function takeBrowserParts(profiles: readonly Profile[], say: (line: string) => void): void {
  for (const p of profiles) {
    try {
      if (setBrowserMcp(p, false, '').changed) say(`browser: the MCP server ${BROWSER_MCP} out of ${p.dir}`)
    } catch (err) {
      say(`browser: ${messageOf(err)}`)
    }
  }
  rmSync(mcpDir(), { recursive: true, force: true })
}
