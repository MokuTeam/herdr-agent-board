// The fake gh and git (fake-gh.ts, fake-git.ts) as real executables, for BOARD_GH_BIN_PATH and
// BOARD_GIT_BIN_PATH (#609). Their state lives under the HOME they run with, so a master and its
// node, each a sandbox with a home of its own, keep theirs apart with one env.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFake } from './fake-herdr-bin.ts'

const ghSource = fileURLToPath(new URL('./fake-gh.ts', import.meta.url))
const gitSource = fileURLToPath(new URL('./fake-git.ts', import.meta.url))

const lines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []

/** A path no program is at: a board given it finds no such program. */
export const NO_PROGRAM = join(process.cwd(), 'no-such-program-here.exe')

export interface FakeGitHome {
  /** The calls each fake was given, argv and whether it had a stdin. */
  ghCalls(): { argv: string[]; stdin: boolean }[]
  gitCalls(): { argv: string[]; stdin: boolean }[]
  /** gh's "keyring": per host the account and token. */
  gh(): { hosts: Record<string, { user: string; token: string }>; setupGit?: string[] }
  /** git's global config and its store. */
  git(): { config: Record<string, string[]>; store: { host: string; username: string; password: string }[] }
  /** What the fakes logged of their calls, as text: argv and whether there was a stdin. */
  logs(): string[]
}

/** The fakes' env (BOARD_GH_BIN_PATH, BOARD_GIT_BIN_PATH). */
export async function fakeGitBins(): Promise<{ env: Record<string, string> }> {
  const [gh, git] = await Promise.all([compileFake(ghSource, 'fake-gh'), compileFake(gitSource, 'fake-git')])
  return { env: { BOARD_GH_BIN_PATH: gh, BOARD_GIT_BIN_PATH: git } }
}

/** What the fakes keep under `home`, and how to seed it before a board starts. */
export function fakeGitHome(home: string, ghConfigDir: string) {
  const ghDir = join(home, '.fake-gh')
  const gitDir = join(home, '.fake-git')
  const read = <T>(file: string, empty: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : empty)
  const view: FakeGitHome = {
    ghCalls: () => lines(join(ghDir, 'calls.jsonl')) as { argv: string[]; stdin: boolean }[],
    gitCalls: () => lines(join(gitDir, 'calls.jsonl')) as { argv: string[]; stdin: boolean }[],
    gh: () => read(join(ghDir, 'state.json'), { hosts: {} }),
    git: () => read(join(gitDir, 'state.json'), { config: {}, store: [] }),
    logs: () =>
      [join(ghDir, 'calls.jsonl'), join(gitDir, 'calls.jsonl')].filter(existsSync).map(f => readFileSync(f, 'utf8')),
  }
  return {
    ...view,
    /** gh logged in to these hosts, its hosts file written as gh writes it; `fail`, `hang`: a command that fails, that never ends. */
    seedGh(
      hosts: Record<string, { user: string; token: string }>,
      more: { accounts?: Record<string, string>; fail?: string; hang?: string } = {},
    ): void {
      mkdirSync(ghDir, { recursive: true })
      writeFileSync(join(ghDir, 'state.json'), JSON.stringify({ hosts, ...more }))
      mkdirSync(ghConfigDir, { recursive: true })
      writeFileSync(
        join(ghConfigDir, 'hosts.yml'),
        Object.entries(hosts)
          .map(
            ([h, v]) =>
              `${h}:\n    users:\n        ${v.user}:\n            oauth_token: ${v.token}\n    git_protocol: https\n    oauth_token: ${v.token}\n    user: ${v.user}\n`,
          )
          .join(''),
      )
    },
    /** git's global config and store as given. */
    seedGit(
      config: Record<string, string[]>,
      store: { host: string; username: string; password: string }[] = [],
    ): void {
      mkdirSync(gitDir, { recursive: true })
      writeFileSync(join(gitDir, 'state.json'), JSON.stringify({ config, store }))
    },
  }
}
