// The board's install on a server of the owner's (core/server-install.ts), run as root by
// server-install.sh with root's own Bun and copy of the board:
//
//   server-install.ts --domain <domain> [--ref <ref>] [--repo <git url>] [--user agent] [--sudo]
//                     [--archive <pack>] [--yes] [--lang en|ru]
//   server-install.ts --undo [--remove-user] [--user agent] [--yes]
//
// It asks once on the terminal before it changes anything (--yes: path B, where the panel asked);
// with no --domain, it asks for one there. Its own part as the board's user, which the install
// runs as that user with the user's Bun and checkout:
//
//   server-install.ts --user-part on '<{"domain","socket"}>' '<source>'   the server mode on, where the code came from
//   server-install.ts --user-part off                                      the server mode off
import { closeSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setServerMode } from '../adapters/config-file.ts'
import { putBrowserParts, takeBrowserParts } from '../adapters/desktop-files.ts'
import { configDir, stateDir } from '../adapters/paths.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { t, useLanguage } from '../core/lang.ts'
import { shownProfiles } from '../core/profiles.ts'
import { BOARD_SOCKET, installFlags, SOURCE_FILE, sourceOf } from '../core/server-install.ts'
import { fieldProblem } from '../core/tunnel.ts'
import { createDesktops } from '../services/desktop.ts'
import { type Io, install, undo } from '../services/server-install.ts'

/** A line typed on the terminal, the question written there; null without a terminal. */
function readTty(question: string): string | null {
  let fd: number
  try {
    fd = openSync('/dev/tty', 'r+')
  } catch {
    return null
  }
  try {
    writeSync(fd, question)
    const buf = Buffer.alloc(256)
    let line = ''
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      line += buf.toString('utf8', 0, n)
      if (line.includes('\n')) break
    }
    return line.split('\n')[0]?.trim() ?? ''
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

async function userPart(args: string[]): Promise<number> {
  const [what, mode, source] = args
  const say = (line: string): void => console.log(line)
  const profiles = loadProfiles({ shownDir: inheritedProfileDir() })
  if (what === 'off') {
    setServerMode(null)
    // the agents' browsers: those still running stopped, the MCP server out of every profile
    await createDesktops({
      root: join(stateDir(), 'desktop'),
      items: () => [],
      writeCard: () => {},
      readCard: () => null,
      onChange: () => {},
      log: say,
    }).stopAll()
    takeBrowserParts(profiles, say)
    return 0
  }
  let m: unknown = null
  let s: unknown = null
  try {
    m = JSON.parse(mode ?? '')
    s = sourceOf(JSON.parse(source ?? ''))
  } catch {}
  const domain = (m as { domain?: unknown } | null)?.domain
  if (what !== 'on' || typeof domain !== 'string' || fieldProblem('domain', domain) || domain === '' || !s) {
    console.error('usage: server-install.ts --user-part on <mode> <source> | off')
    return 2
  }
  setServerMode({ domain, socket: BOARD_SOCKET })
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), SOURCE_FILE), `${JSON.stringify(s, null, 2)}\n`)
  // the install action ran before the server mode was on: the agents' browsers' part now
  await putBrowserParts(shownProfiles(profiles), {
    board: join(homedir(), '.local', 'bin', 'board'),
    bun: process.execPath,
    say,
  })
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--user-part') return userPart(argv.slice(1))
  const f = installFlags(argv)
  if ('error' in f) {
    console.error(`agent-board: ${f.error}`)
    return 2
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage(f.lang ?? (/^ru/i.test(process.env.LANG ?? '') ? 'ru' : 'en'))
  const io: Io = {
    say: (...lines) => {
      for (const l of lines) console.log(l)
    },
    ask: async question => {
      const a = readTty(question)
      return a === null ? null : /^(y|yes|д|да)$/i.test(a)
    },
  }
  if (f.undo) return undo(f, io)
  if (!f.domain && !f.yes) {
    const d = readTty(t('install.askDomain'))?.toLowerCase().replace(/\.$/, '') ?? ''
    if (d && !fieldProblem('domain', d)) f.domain = d
  }
  return install(f, io)
}

process.exit(await main())
