// What the tests of the board's own wake (#119, call 28) set up in a sandbox: a session asleep in
// pane p1 as wake's session file has it (written by hand: the wake process is its one writer), its
// transcript in its profile folder, the herdr that shows its pane as a shell until `board resume`
// is run in it, wake's status file saying it runs (L30), and `board` on PATH (L5). Folders with a
// space, Cyrillic and `%`, as Review Focus 1 asks.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Sandbox } from './sandbox.ts'
import { SID } from './wake-fixtures.ts'

export { SID }

/** When the session went to sleep. */
export const SLEPT = Date.UTC(2026, 9, 21, 8)

/** The board's state folder (wake's files beside the board's). */
export const stateDir = (box: Sandbox): string =>
  join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
export const scheduleDir = (box: Sandbox): string => join(stateDir(box), 'schedule')
export const wakeFile = (box: Sandbox): string => join(stateDir(box), 'wake-sessions.json')

/** The session's project folder, the cwd herdr shows for its pane. */
export function projectDir(box: Sandbox): string {
  const dir = join(box.dir, 'Проект x 50%')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The default profile and Work, Work's folder under a user name with a space, Cyrillic and `%`; as config.json lists them. */
export function twoProfiles(box: Sandbox) {
  const home = box.env.HOME as string
  const own = join(home, '.claude')
  const work = join(home, 'Иван Петров', '.claude-work 100%')
  for (const dir of [own, work]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
  }
  const list = [
    { id: 'default', title: 'Default', dir: own, color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false },
  ]
  return { own, work, list }
}

/** The session's card, as its hooks reported its profile folder. */
export function card(box: Sandbox, profileDir: string, session = SID): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${session}.json`), JSON.stringify({ key: session, profileDir }))
}

/** The session's transcript in its profile folder `dir`, where Claude Code keeps it for `cwd`. */
export function transcript(dir: string, cwd: string, session = SID): void {
  const folder = join(dir, 'projects', projectFolderName(cwd))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${session}.jsonl`), `${JSON.stringify({ type: 'user', cwd, sessionId: session })}\n`)
}

/** Wake's session file with the session asleep in p1 (its folder and listed id, when given); its text, to compare later. */
export function asleepInFile(box: Sandbox, o: { cwd: string; profileDir?: string; profile?: string }): string {
  mkdirSync(stateDir(box), { recursive: true })
  const text = JSON.stringify({
    p1: {
      session: SID,
      name: 'Report',
      cwd: o.cwd,
      seen_at: SLEPT,
      slept_at: SLEPT,
      ...(o.profileDir && { profileDir: o.profileDir }),
      ...(o.profile && { profile: o.profile }),
    },
  })
  writeFileSync(wakeFile(box), text)
  return text
}

export const wakeFileText = (box: Sandbox): string => readFileSync(wakeFile(box), 'utf8')

/** wake-status.json saying wake runs: with wake on, the board talks to the new wake (L30). */
export function wakeRuns(box: Sandbox): void {
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(join(stateDir(box), 'wake-status.json'), JSON.stringify({ state: 'running', at: Date.now() }))
}

/** `board` on PATH, as the install puts it there (the stub is never run): the env to run with. */
export function boardOnPath(box: Sandbox): Record<string, string> {
  const bin = join(box.dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'board'), '#!/bin/sh\n# agent-board\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'board.cmd'), '@rem agent-board\r\n@exit /b 0\r\n')
  return { PATH: `${bin}${delimiter}${box.env.PATH}` }
}

/** Claude's input box as `herdr agent read --ansi` shows it, empty but for a dim suggestion. */
const RULE = '─'.repeat(40)
export const SCREEN = ['● done', RULE, `❯ \x1b[2mtry: run the tests\x1b[0m`, RULE, '  ⏵⏵ bypass permissions on'].join(
  '\n',
)

const SHELL_PID = 4242

/**
 * herdr with the session asleep in p1 (a shell, in workspace "Отчёты 50%") until `pane run` was
 * called; from then on Claude runs the session there, idle. `shell`: the pane's shell as herdr's
 * process info names it. `extra`: replies of the test's own (a herdr call that fails).
 */
export function herdrAsleep(
  box: Sandbox,
  cwd: string,
  { shell = 'pwsh.exe', extra = {} }: { shell?: string; extra?: Record<string, unknown> } = {},
): void {
  const shellPane = { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', cwd }
  const claudePane = {
    ...shellPane,
    agent: 'claude',
    agent_session: { value: SID },
    agent_status: 'idle',
    terminal_title_stripped: 'Report',
  }
  const snapshot = (pane: Record<string, unknown>) => ({
    result: {
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'Отчёты 50%' }],
        tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
        panes: [pane],
      },
    },
  })
  const woken = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    ...before,
    until: ['pane run'],
    // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply once the line ran (test/support/fake-herdr.ts)
    then: after,
  })
  box.state({
    'api snapshot': woken(snapshot(shellPane), snapshot(claudePane)),
    'pane get': woken({ result: { pane: shellPane } }, { result: { pane: claudePane } }),
    'agent get': woken(
      { result: { agent: null } },
      { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
    ),
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
    'pane process-info': woken(
      { result: { process_info: { shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID, name: shell }] } } },
      {
        result: {
          process_info: {
            shell_pid: SHELL_PID,
            foreground_processes: [
              { pid: SHELL_PID, name: shell },
              { pid: SHELL_PID + 1, name: 'claude' },
            ],
          },
        },
      },
    ),
    'pane send-keys': { result: {} },
    'pane run': { result: {} },
    'pane rename': { result: {} },
    ...extra,
  })
}

/** herdr with the session running in p1, idle (as a wake through wake's API leaves it). */
export function herdrAwake(box: Sandbox, cwd: string): void {
  const pane = {
    pane_id: 'p1',
    workspace_id: 'w1',
    tab_id: 't1',
    cwd,
    agent: 'claude',
    agent_session: { value: SID },
    agent_status: 'idle',
    terminal_title_stripped: 'Report',
  }
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'Отчёты 50%' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
          panes: [pane],
        },
      },
    },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
}

/** herdr's calls on panes (not the reads of `pane get`), in order. */
export const paneCalls = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'pane' && c[1] !== 'get')
