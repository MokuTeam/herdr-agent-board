// The user's presence as sessions see it (#172): the hooks' line (Claude Code and Codex) and the
// board command's `presence` / `away`. Sessions only read it; nothing is ever typed into them.
// A setup that never turned presence on sees none of it.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

type Card = Record<string, unknown>
const cardFile = (box: Sandbox, key: string): string => join(box.cards, `${key}.json`)
const cardOf = (box: Sandbox, key: string): Card | null =>
  existsSync(cardFile(box, key)) ? JSON.parse(readFileSync(cardFile(box, key), 'utf8')) : null
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
const presenceFile = (box: Sandbox): string => join(stateDir(box), 'presence.json')
function setPresence(box: Sandbox, value: unknown): void {
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(presenceFile(box), JSON.stringify(value))
}
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

async function spawnOut(file: string, box: Sandbox, input: unknown, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints', file)], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p1', ...env },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  expect(err).toBe('')
  return out
}
const claude = (box: Sandbox, event: string, sid = 's1') =>
  spawnOut('hook.ts', box, { hook_event_name: event, session_id: sid, cwd: box.dir, prompt: 'go on' })
const contextOf = (out: string): string => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '')

const AWAY = /The user is away from the computer/
const HERE = /The user is at the computer/

test('never turned on: no line, nothing on the card, no file', async () => {
  const box = await sandbox()
  config(box)
  expect(contextOf(await claude(box, 'SessionStart'))).not.toMatch(/Presence|at the computer|away from the computer/)
  expect(cardOf(box, 's1')).not.toHaveProperty('presenceSeen')
  expect(await claude(box, 'UserPromptSubmit')).toBe('')
  expect(cardOf(box, 's1')).not.toHaveProperty('presenceSeen')
  expect(existsSync(presenceFile(box))).toBe(false)
})

test('turned on: the brief says it, a change is one line on the next prompt, once', async () => {
  const box = await sandbox()
  config(box, { presence: { mode: 'auto' } })
  setPresence(box, { state: 'away', since: 1000, by: 'user', from: 'phone' })
  const start = contextOf(await claude(box, 'SessionStart'))
  expect(start).toMatch(AWAY)
  expect(start).toMatch(/Telegram/)
  expect(cardOf(box, 's1')?.presenceSeen).toBe(1000)
  expect(await claude(box, 'UserPromptSubmit')).toBe('')
  setPresence(box, { state: 'here', since: 2000, by: 'auto', from: 'auto' })
  const news = contextOf(await claude(box, 'UserPromptSubmit'))
  expect(news).toMatch(HERE)
  expect(news).not.toMatch(/Presence:/)
  expect(cardOf(box, 's1')?.presenceSeen).toBe(2000)
  expect(await claude(box, 'UserPromptSubmit')).toBe('')
})

test('turned on under a running session (its card marked): told on its next prompt', async () => {
  const box = await sandbox()
  config(box, { presence: true })
  await claude(box, 'SessionStart')
  const card = cardOf(box, 's1') as Card
  writeFileSync(cardFile(box, 's1'), JSON.stringify({ ...card, presenceSeen: -1 }))
  expect(contextOf(await claude(box, 'UserPromptSubmit'))).toMatch(HERE)
  expect(cardOf(box, 's1')?.presenceSeen).toBe(0)
  expect(await claude(box, 'UserPromptSubmit')).toBe('')
})

test('turned off: a fresh brief drops the field', async () => {
  const box = await sandbox()
  config(box, { presence: true })
  await claude(box, 'SessionStart')
  expect(cardOf(box, 's1')?.presenceSeen).toBe(0)
  config(box)
  expect(contextOf(await claude(box, 'SessionStart'))).not.toMatch(HERE)
  expect(cardOf(box, 's1')).not.toHaveProperty('presenceSeen')
})

const CODEX = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
test('Codex hook: the same line in its brief and on the next prompt after a change', async () => {
  const box = await sandbox()
  config(box, { presence: { mode: 'suggest' } })
  box.state({ 'agent get p1': { result: { agent: { agent: 'codex', agent_session: { value: CODEX } } } } })
  setPresence(box, { state: 'away', since: 5, by: 'user', from: 'cli' })
  const codex = (event: string) =>
    spawnOut(
      'codex-hook.ts',
      box,
      { hook_event_name: event, session_id: CODEX, cwd: box.dir, prompt: 'hi' },
      { CODEX_THREAD_ID: CODEX },
    )
  expect(contextOf(await codex('SessionStart'))).toMatch(AWAY)
  expect(cardOf(box, CODEX)?.presenceSeen).toBe(5)
  expect(await codex('UserPromptSubmit')).toBe('')
  setPresence(box, { state: 'here', since: 9, by: 'user', from: 'web' })
  expect(contextOf(await codex('UserPromptSubmit'))).toMatch(HERE)
})

function cli(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], {
      cwd: root,
      env: { ...box.env, ...env },
    })
    let out = ''
    proc.stdout.on('data', c => {
      out += c
    })
    proc.stderr.on('data', c => {
      out += c
    })
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board presence / board away: refused while off, switch and read while on', async () => {
  const box = await sandbox()
  config(box)
  const off = await cli(box, ['presence'])
  expect(off.code).toBe(0)
  expect(off.out).toMatch(/presence is off/)
  const refused = await cli(box, ['away'])
  expect(refused.code).not.toBe(0)
  expect(refused.out).toMatch(/Presence is off/)
  expect(existsSync(presenceFile(box))).toBe(false)

  config(box, { presence: true })
  expect((await cli(box, ['presence'])).out).toMatch(HERE)
  const away = await cli(box, ['away'])
  expect(away).toEqual({ code: 0, out: 'ok · away' })
  expect(JSON.parse(readFileSync(presenceFile(box), 'utf8'))).toMatchObject({ state: 'away', by: 'user' })
  expect((await cli(box, ['away', 'on'])).out).toBe('ok · already away')
  expect((await cli(box, ['presence'])).out).toMatch(AWAY)
  expect((await cli(box, ['away', 'off'])).out).toBe('ok · here')
  expect((await cli(box, ['presence', 'away'], { HERDR_PANE_ID: 'p7' })).out).toBe('ok · away')
  expect(JSON.parse(readFileSync(presenceFile(box), 'utf8')).from).toBe('agent')
  const bad = await cli(box, ['away', 'maybe'])
  expect(bad.code).not.toBe(0)
  expect(bad.out).toMatch(/usage: board away \[on\|off\]/)
})

test('on a call (#276): board presence call sets it; the next prompt says the user is on a call, once', async () => {
  const box = await sandbox()
  config(box, { presence: true })
  expect(contextOf(await claude(box, 'SessionStart'))).toMatch(HERE)
  expect(await cli(box, ['presence', 'call'])).toEqual({ code: 0, out: 'ok · call' })
  expect(JSON.parse(readFileSync(presenceFile(box), 'utf8'))).toMatchObject({
    state: 'call',
    by: 'user',
    before: 'here',
  })
  expect((await cli(box, ['presence', 'call'])).out).toBe('ok · already call')
  const news = contextOf(await claude(box, 'UserPromptSubmit'))
  expect(news).toMatch(/The user is on a call \(since \d\d:\d\d\) and slow to answer/)
  expect(await claude(box, 'UserPromptSubmit')).toBe('')
  expect((await cli(box, ['presence'])).out).toMatch(/on a call/)
  expect((await cli(box, ['presence', 'here'])).out).toBe('ok · here')
  const bad = await cli(box, ['presence', 'busy'])
  expect(bad.code).not.toBe(0)
  expect(bad.out).toMatch(/usage: board presence \[here\|away\|call\]/)
})
