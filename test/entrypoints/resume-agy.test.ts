// `board resume --agy <id>` (#631): what wake types into a sleeping Antigravity session's pane.
// Runs `agy` with the interactive flags kept from wake-agy.json (or `launch.agy` fallback),
// `--conversation <id>`, in the session's project folder (spaces, Cyrillic, %). Asks herdr nothing.

import { Database } from 'bun:sqlite'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const WINDOWS = process.platform === 'win32'
const PROJECT = 'Проект x 50%'

function fakeAgyOn(bin: string): void {
  mkdirSync(bin, { recursive: true })
  const script = join(bin, 'fake-agy.ts')
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'
const log = process.env.FAKE_AGY_LOG
if (log) writeFileSync(log, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
process.exit(Number(process.env.FAKE_AGY_EXIT ?? 0))
`,
  )
  if (WINDOWS) {
    writeFileSync(join(bin, 'agy.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    const file = join(bin, 'agy')
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(file, 0o755)
  }
}

interface Set {
  bin: string
  log: string
  agyRoot: string
  project: string
}

function setUp(box: Sandbox, o: { config?: Record<string, unknown>; dbOnly?: boolean } = {}): Set {
  const home = box.env.USERPROFILE as string
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...o.config }))
  const project = join(home, PROJECT)
  mkdirSync(project, { recursive: true })
  const agyRoot = join(box.dir, 'agy-root')
  if (o.dbOnly) {
    mkdirSync(join(agyRoot, 'conversations'), { recursive: true })
    writeFileSync(join(agyRoot, 'conversations', `${ID}.db`), '')
  } else {
    const logs = join(agyRoot, 'brain', ID, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript.jsonl'), '{"type":"USER_INPUT","content":"hi"}\n')
  }
  const db = new Database(join(agyRoot, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, status TEXT,
    agent_name TEXT, parent_conversation_id TEXT, killed INTEGER
  )`)
  db.query(
    `INSERT INTO conversation_summaries VALUES (?, 'Gemini Dev', 'hi', 1, '2026-11-23T15:00:00Z', ?, 'CASCADE_RUN_STATUS_IDLE', '', '', 0)`,
  ).run(ID, JSON.stringify([`file://${project.replace(/\\/g, '/')}`]))
  db.close()

  const bin = join(box.dir, 'bin')
  fakeAgyOn(bin)
  return { bin, log: join(box.dir, 'agy.json'), agyRoot, project }
}

function sleeper(box: Sandbox, s: Set, fields: Record<string, unknown>): void {
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  const entry = { session: ID, name: 'Gemini Dev', pane: 'w5:p9', cwd: s.project, argv: [], slept_at: 1, ...fields }
  writeFileSync(join(state, 'wake-agy.json'), JSON.stringify({ [ID]: entry }))
}

async function resumeAgy(
  box: Sandbox,
  args: string[],
  s: Set,
): Promise<{ code: number; out: string; agy: { args: string[]; cwd: string } | null }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', ...args], {
    cwd: box.dir,
    env: {
      ...box.env,
      PATH: `${s.bin}${delimiter}${box.env.PATH}`,
      ANTIGRAVITY_APP_DATA_DIR: s.agyRoot,
      FAKE_AGY_LOG: s.log,
      FAKE_AGY_EXIT: '7',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const agy = existsSync(s.log) ? JSON.parse(readFileSync(s.log, 'utf8')) : null
  return { code, out: `${stdout}${stderr}`.trim(), agy }
}

test('board resume --agy: keeps interactive flags from wake-agy.json, runs in sleeper cwd, exits with agy code, asks herdr nothing', async () => {
  const box = await sandbox()
  const s = setUp(box)
  sleeper(box, s, {
    argv: [
      'agy',
      '--dangerously-skip-permissions',
      '--mode',
      'auto',
      '--conversation',
      '00000000-0000-0000-0000-000000000000',
      'old prompt',
    ],
  })
  const r = await resumeAgy(box, ['--agy', ID], s)
  expect(r.code).toBe(7)
  expect(r.agy).toEqual({
    args: ['--dangerously-skip-permissions', '--mode', 'auto', '--conversation', ID],
    cwd: s.project,
  })
  expect(box.calls()).toEqual([])
})

test('board resume --agy: falls back to launch.agy and conversation_summaries.db cwd, and accepts DB-only conversations', async () => {
  const box = await sandbox()
  const s = setUp(box, {
    config: { launch: { agy: ['agy', '--dangerously-skip-permissions'] } },
    dbOnly: true,
  })
  const r = await resumeAgy(box, ['--agy', ID.toUpperCase()], s)
  expect(r.code).toBe(7)
  expect(r.agy).toEqual({
    args: ['--dangerously-skip-permissions', '--conversation', ID.toUpperCase()],
    cwd: s.project,
  })
})

test('board resume --agy: missing conversation or invalid id is refused without running agy', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const none = await resumeAgy(box, ['--agy', '00000000-0000-0000-0000-000000000000'], s)
  expect(none.code).toBe(1)
  expect(none.out).toMatch(/no Antigravity conversation/)
  expect(none.agy).toBeNull()

  const bad = await resumeAgy(box, ['--agy', 'a;b'], s)
  expect(bad.code).toBe(1)
  expect(bad.out).toMatch(/not an Antigravity conversation id/)
  expect(bad.agy).toBeNull()
})
