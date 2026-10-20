import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { BRIEF_VERSION, brief, waitReminder } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { notification } from '../support/task-notification.ts'

setDefaultTimeout(15_000)

// The Claude Code hook against a sandbox's cards and config.
type Card = Record<string, unknown>
const cardOf = (box: Sandbox, key: string): Card | null =>
  existsSync(join(box.cards, `${key}.json`)) ? JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8')) : null
function putCard(box: Sandbox, card: Card & { key: string }): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${card.key}.json`), JSON.stringify(card))
}
const configFile = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
function englishConfig(box: Sandbox): void {
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  writeFileSync(configFile(box), JSON.stringify({ language: 'en' }))
}
/** A Claude profile folder in the sandbox's home: one with settings.json is found. */
function profileFolder(box: Sandbox, name: string): string {
  const dir = join(box.env.USERPROFILE as string, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{}')
  return dir
}
/** `C:\x` as `c:\x` and back: the same folder on Windows. */
const flipDriveCase = (p: string): string =>
  p.replace(/^[A-Za-z]/, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))

/** The hook as Claude Code runs it: the event on stdin, `env` on top of the sandbox's; what it printed. */
async function runHook(
  box: Sandbox,
  input: unknown,
  pane: string | null = 'p1',
  env: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'hook.ts')], {
    cwd: root,
    env: { ...box.env, ...(pane ? { HERDR_PANE_ID: pane } : {}), ...env },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, stderr)
  assert.equal(stderr, '')
  return stdout
}
const context = (event: string, text: string): string =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`
const sessionStart = (box: Sandbox, sid: string) => ({ hook_event_name: 'SessionStart', session_id: sid, cwd: box.dir })
/** The brief as the hook in pane p1 gives it: the sandbox's env, which is not herdr's (no HERDR_ENV). */
const briefIn = (box: Sandbox, card: Card | null): string =>
  brief(normalizeConfig({ language: 'en' }), card, box.dir, { ...box.env, HERDR_PANE_ID: 'p1' })

test('SessionStart in a herdr pane: the full brief, and the card remembers it was briefed', async () => {
  const box = await sandbox()
  englishConfig(box)
  putCard(box, { key: 's1', category: 'acme', doing: 'fix the CI' })
  const out = await runHook(box, { hook_event_name: 'SessionStart', session_id: 's1', cwd: box.dir })
  useLanguage('en')
  assert.equal(out, context('SessionStart', briefIn(box, cardOf(box, 's1'))))
  assert.equal(cardOf(box, 's1')?.briefV, BRIEF_VERSION)
  assert.equal(typeof cardOf(box, 's1')?.briefedAt, 'number')
})

test('SessionStart where herdr says it is the host: the brief tells the session its pane', async () => {
  const box = await sandbox()
  englishConfig(box)
  const herdr = { HERDR_ENV: '1', HERDR_TAB_ID: 'w1:t2', HERDR_WORKSPACE_ID: 'w1' }
  const out = await runHook(box, sessionStart(box, 's1'), 'w1:p3', herdr)
  useLanguage('en')
  const text = brief(normalizeConfig({ language: 'en' }), cardOf(box, 's1'), box.dir, {
    ...box.env,
    HERDR_PANE_ID: 'w1:p3',
    ...herdr,
  })
  assert.equal(out, context('SessionStart', text))
  assert.match(text, /runs in herdr, in pane w1:p3 \(tab w1:t2, workspace w1\)\..*herdr-agents skill/)
})

test('UserPromptSubmit: the brief once for a session briefed by an older version, then the wait reminder', async () => {
  const box = await sandbox()
  englishConfig(box)
  putCard(box, { key: 's1', wait: 'the client', briefedAt: 1 })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'go on' }
  const first = await runHook(box, prompt)
  assert.match(
    first,
    /^\{"hookSpecificOutput":\{"hookEventName":"UserPromptSubmit","additionalContext":"\[agent-board\] The user watches/,
  )
  assert.equal(cardOf(box, 's1')?.briefV, BRIEF_VERSION)
  assert.equal(await runHook(box, prompt), context('UserPromptSubmit', waitReminder({ wait: 'the client' })))
  putCard(box, { key: 's1', briefV: BRIEF_VERSION })
  assert.equal(await runHook(box, prompt), '')
})

test('outside a herdr pane, or without a session id: nothing said, no card written', async () => {
  const box = await sandbox()
  assert.equal(await runHook(box, { hook_event_name: 'SessionStart', session_id: 's1', cwd: box.dir }, null), '')
  assert.equal(await runHook(box, { hook_event_name: 'SessionStart', cwd: box.dir }), '')
  assert.equal(cardOf(box, 's1'), null)
})

test('a board reminder does not count as the user answering the session', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, pin: 'me', pinAt: 1, briefV: 99 })
  const hook = (prompt: string) =>
    runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  await hook('[board reminder from lead-session] check the CI run')
  assert.equal(cardOf(box, 's1')?.ask, 'Send it?')
  // The session works again: a column dragged to by hand goes, as with any work.
  assert.equal(cardOf(box, 's1')?.pin, undefined)
  await hook('yes, send it')
  assert.equal(cardOf(box, 's1')?.ask, undefined)
})

// A pi session runs Claude Code through its bridge: the hook hears of the bridge's Claude session,
// the board shows pi's (herdr's agent_session of the pane, the session's file), where `board ask` went.
const PI_KEY = '/home/me/.pi/agent/sessions/--home-me--/2026-10-20T05-10-02-695Z_01a1.jsonl'
const PI_FILE = PI_KEY.replace(/[^A-Za-z0-9_-]/g, '_')
const piPane = (box: Sandbox) =>
  box.state({
    'agent get': { result: { agent: { agent: 'pi', agent_status: 'idle', agent_session: { value: PI_KEY } } } },
  })

test("a pi session: the user's answer clears the ask on pi's card, the board's, not only the bridge's", async () => {
  const box = await sandbox()
  piPane(box)
  putCard(box, { key: PI_FILE, ask: 'Close the kit?', askSince: 1, pin: 'me', pinAt: 1 })
  putCard(box, { key: 'cc1', briefV: BRIEF_VERSION })
  const hook = (prompt: string) =>
    runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt }, 'w6:p1', {
      PI_CODING_AGENT: 'true',
    })
  await hook('[board reminder from lead-session] check the CI run')
  expect(cardOf(box, PI_FILE)).toMatchObject({ ask: 'Close the kit?', askSince: 1 })
  expect(cardOf(box, PI_FILE)?.pin).toBeUndefined()
  await hook('closed it, go on')
  expect(cardOf(box, PI_FILE)?.ask).toBeUndefined()
  expect(cardOf(box, PI_FILE)?.askSince).toBeUndefined()
  expect(box.calls()).toContainEqual(['agent', 'get', 'w6:p1'])
})

test("a pi session: the wait reminder comes from pi's card", async () => {
  const box = await sandbox()
  englishConfig(box)
  piPane(box)
  putCard(box, { key: PI_FILE, wait: 'the client' })
  putCard(box, { key: 'cc1', briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'go on' }
  useLanguage('en')
  expect(await runHook(box, prompt, 'w6:p1', { PI_CODING_AGENT: 'true' })).toBe(
    context('UserPromptSubmit', waitReminder({ wait: 'the client' })),
  )
})

test('PI_CODING_AGENT in the env of a pane that herdr says runs Claude: no other card is touched', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: 'other' } } } },
  })
  putCard(box, { key: 'other', ask: 'Ship it?', askSince: 1 })
  putCard(box, { key: 'cc1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'yes' }
  await runHook(box, prompt, 'w1:p1', { PI_CODING_AGENT: 'true' })
  expect(cardOf(box, 'other')).toMatchObject({ ask: 'Ship it?', askSince: 1 })
  expect(cardOf(box, 'cc1')?.ask).toBeUndefined()
})

test('herdr failing or slow to answer leaves the hook as it was', async () => {
  const box = await sandbox()
  box.state({ 'agent get': { error: 'server not running' } })
  putCard(box, { key: 'cc1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'yes' }
  expect(await runHook(box, prompt, 'w1:p1', { PI_CODING_AGENT: 'true' })).toBe('')
  expect(cardOf(box, 'cc1')?.ask).toBeUndefined()
})

test('a Claude session of its own asks herdr nothing', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'yes' })
  expect(cardOf(box, 's1')?.ask).toBeUndefined()
  expect(box.calls()).toEqual([])
})

test('a task reporting back does not count as the user answering the session (hook)', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, briefV: 99 })
  const prompt = notification('Agent "Review" finished')
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  assert.equal(cardOf(box, 's1')?.ask, 'Send it?')
})

test("a call's results do not count as the user answering the session (hook)", async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Deploy now?', askSince: 1, briefV: 99 })
  const report =
    '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: ship on Monday\n\nFull protocol: /tmp/meeting_1.summary.md'
  const prompt = promptOf({ id: 'c1', key: 's1', kind: 'call', text: report, next: Date.now() }, Date.now())
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  assert.equal(cardOf(box, 's1')?.ask, 'Deploy now?')
})

// The profile a session runs in: the hook runs in the session's own env, so its CLAUDE_CONFIG_DIR
// (unset: ~/.claude) is the session's folder, and the profile that has that folder its id.
test('every spelling of the default folder reports default, and the brief is as before', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  englishConfig(box)
  useLanguage('en')
  putCard(box, { key: 's1', category: 'acme', doing: 'fix the CI' })
  const variants = [
    undefined,
    join(home, '.claude'),
    `${join(home, '.claude')}${sep}`,
    `${home}/.claude/`,
    `${join(home, '.claude').replaceAll('\\', '/')}/`,
    '~/.claude',
    ...(process.platform === 'win32' ? [flipDriveCase(join(home, '.claude'))] : []),
  ]
  for (const v of variants) {
    const out = await runHook(box, sessionStart(box, 's1'), 'p1', v === undefined ? {} : { CLAUDE_CONFIG_DIR: v })
    expect(out).toBe(context('SessionStart', briefIn(box, cardOf(box, 's1'))))
    expect(cardOf(box, 's1')?.profile).toBe('default')
    expect(sameDir(String(cardOf(box, 's1')?.profileDir), join(home, '.claude'))).toBe(true)
  }
})

test('a work session reports work; a folder no profile has keeps the folder and no id', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const work = profileFolder(box, '.claude-work')
  await runHook(box, sessionStart(box, 's2'), 'p1', { CLAUDE_CONFIG_DIR: work })
  expect(cardOf(box, 's2')).toMatchObject({ profile: 'work', profileDir: work })
  // `~` is the home folder, never a folder named so.
  await runHook(box, sessionStart(box, 's4'), 'p1', { CLAUDE_CONFIG_DIR: '~/.claude-work' })
  expect(cardOf(box, 's4')?.profile).toBe('work')
  expect(sameDir(String(cardOf(box, 's4')?.profileDir), join(home, '.claude-work'))).toBe(true)
  // A profile the card named before goes: it is never kept for a folder that is not its own.
  putCard(box, { key: 's3', profile: 'default', profileDir: join(home, '.claude') })
  await runHook(box, sessionStart(box, 's3'), 'p1', { CLAUDE_CONFIG_DIR: join(box.dir, 'odd') })
  expect(cardOf(box, 's3')?.profile).toBeUndefined()
  expect(cardOf(box, 's3')?.profileDir).toBe(join(box.dir, 'odd'))
})

test('outside a herdr pane nothing is written; an unchanged profile is not written again', async () => {
  const box = await sandbox()
  const work = { CLAUDE_CONFIG_DIR: profileFolder(box, '.claude-work') }
  expect(await runHook(box, sessionStart(box, 's1'), null, work)).toBe('')
  expect(cardOf(box, 's1')).toBeNull()
  putCard(box, { key: 's1', briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'go on' }
  expect(await runHook(box, prompt, 'p1', work)).toBe('')
  const first = cardOf(box, 's1')
  expect(first).toMatchObject({ profile: 'work', profileDir: work.CLAUDE_CONFIG_DIR })
  expect(typeof first?.updatedAt).toBe('number')
  await Bun.sleep(5)
  expect(await runHook(box, prompt, 'p1', work)).toBe('')
  expect(cardOf(box, 's1')).toEqual(first)
  // The profiles are only read: config.json is written where it was before (a first brief), not here.
  expect(existsSync(configFile(box))).toBe(false)
})
