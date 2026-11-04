// MokuPilot's call in progress as the board reads it (#276): call.json in its state folder while
// a call runs; no file, a file of a process that is gone, one older than a day or not of MokuPilot's
// shape is no call; one that cannot be read says nothing.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  callAgents,
  callAgentsFolder,
  callFile,
  callInProgress,
  mokupilotHere,
  taskBoard,
  taskBoardsFolder,
} from '../../src/adapters/mokupilot-call.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = 1_800_000_000_000
const write = (file: string, value: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

test('a call: its process and start; none without the file or its process', () => {
  const home = isolatedHome()
  const file = callFile(home)
  expect(file).toBe(join(home, '.meeting-copilot', 'call.json'))
  const read = (alive = true) => callInProgress({ file, now: () => NOW, alive: () => alive })
  expect(mokupilotHere(home)).toBe(false)
  expect(read()).toBeNull()
  write(file, { pid: 4242, started: NOW / 1000 - 600 })
  expect(mokupilotHere(home)).toBe(true)
  expect(read()).toEqual({ id: `4242:${NOW / 1000 - 600}`, started: NOW - 600_000 })
  expect(read(false)).toBeNull()
  // The process it names, asked for real: this one runs.
  write(file, { pid: process.pid, started: Date.now() / 1000 })
  expect(callInProgress({ file })?.id).toMatch(new RegExp(`^${process.pid}:`))
})

test('a file that cannot be read is no answer, not the end of a call', () => {
  const home = isolatedHome()
  const file = callFile(home)
  // A folder where the file should be: reading it fails as a file held by another program does.
  mkdirSync(file, { recursive: true })
  expect(callInProgress({ file, now: () => NOW, alive: () => true })).toBeUndefined()
})

test('a stale or foreign file is no call', () => {
  const home = isolatedHome()
  const file = callFile(home)
  const read = () => callInProgress({ file, now: () => NOW, alive: () => true })
  for (const bad of [
    { pid: 4242, started: NOW / 1000 - 25 * 3600 },
    { pid: 4242, started: NOW / 1000 + 3600 },
    { pid: 0, started: NOW / 1000 },
    { pid: -3, started: NOW / 1000 },
    { pid: '4242', started: NOW / 1000 },
    { pid: 4242.5, started: NOW / 1000 },
    { pid: 4242, started: '2026-10-30' },
    { pid: 4242 },
    [],
    null,
    'not json',
  ]) {
    write(file, bad === 'not json' ? bad : JSON.stringify(bad))
    expect(read()).toBeNull()
  }
})

// #326: the call agents MokuPilot writes, one file each in call-agents/, and their task boards.
const AGENT = '1f0c9a3e-0000-4000-8000-000000000001'
const agentFile = (over: Record<string, unknown> = {}) => ({
  format: 'mokupilot-call-agent',
  version: 1,
  pid: 4242,
  session_id: AGENT,
  harness: 'claude',
  parent_session_id: '',
  config_dir: '',
  cwd: '/work',
  started: NOW / 1000 - 60,
  call: 'on',
  busy: false,
  updated: NOW / 1000,
  ...over,
})

test('call agents: none without the folder; each live file, the rest left out', () => {
  const home = isolatedHome()
  const folder = callAgentsFolder(home)
  expect(folder).toBe(join(home, '.meeting-copilot', 'call-agents'))
  const read = (alive: (pid: number) => boolean = pid => pid === 4242) => callAgents({ folder, now: () => NOW, alive })
  expect(read()).toEqual([])
  // An old MokuPilot: call.json only, no folder.
  write(callFile(home), { pid: 4242, started: NOW / 1000 - 600 })
  expect(read()).toEqual([])
  write(join(folder, `${AGENT}.json`), agentFile())
  write(join(folder, 'other.json'), agentFile({ session_id: 'other', pid: 7 }))
  write(join(folder, 'broken.json'), '{"format":')
  write(join(folder, `.${AGENT}.tmp.json`), agentFile())
  write(join(folder, 'notes.txt'), 'x')
  expect(read().map(a => a.session)).toEqual([AGENT])
  expect(
    read(() => true)
      .map(a => a.session)
      .sort(),
  ).toEqual([AGENT, 'other'])
})

test('a call agent’s task board: its harness’s file, AGENT_BOARDS_DIR first', () => {
  const home = isolatedHome()
  const items = [{ id: 'b1', text: 'Check the totals', status: 'doing' }]
  const boardFile = (root: string, harness = 'claude') => join(root, harness, `${AGENT}.json`)
  const saved = process.env.AGENT_BOARDS_DIR
  delete process.env.AGENT_BOARDS_DIR
  try {
    expect(taskBoardsFolder(home)).toBe(join(home, '.agent-boards'))
    expect(taskBoard({ harness: 'claude', session: AGENT }, taskBoardsFolder(home))).toEqual([])
    write(boardFile(join(home, '.agent-boards')), { format: 'agent-board', version: 1, items })
    expect(taskBoard({ harness: 'claude', session: AGENT }, taskBoardsFolder(home))).toEqual([
      { id: 'b1', text: 'Check the totals', status: 'doing' },
    ])
    // pi's folder is its own; a name that would leave the folder reads nothing.
    expect(taskBoard({ harness: 'pi', session: AGENT }, taskBoardsFolder(home))).toEqual([])
    expect(taskBoard({ harness: '..', session: AGENT }, taskBoardsFolder(home))).toEqual([])
    process.env.AGENT_BOARDS_DIR = join(home, 'boards')
    expect(taskBoardsFolder(home)).toBe(join(home, 'boards'))
  } finally {
    if (saved === undefined) delete process.env.AGENT_BOARDS_DIR
    else process.env.AGENT_BOARDS_DIR = saved
  }
})
