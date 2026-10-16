import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRIEF_VERSION, brief, waitReminder } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

// The Claude Code hook against a sandbox's cards and config.
type Card = Record<string, unknown>
const cardOf = (box: Sandbox, key: string): Card | null =>
  existsSync(join(box.cards, `${key}.json`)) ? JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8')) : null
function putCard(box: Sandbox, card: Card & { key: string }): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${card.key}.json`), JSON.stringify(card))
}
function englishConfig(box: Sandbox): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en' }))
}

/** The hook as Claude Code runs it: the event on stdin; what it printed. */
async function runHook(box: Sandbox, input: unknown, pane: string | null = 'p1'): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'hook.ts')], {
    cwd: root,
    env: { ...box.env, ...(pane ? { HERDR_PANE_ID: pane } : {}) },
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

test('SessionStart in a herdr pane: the full brief, and the card remembers it was briefed', async () => {
  const box = await sandbox()
  englishConfig(box)
  putCard(box, { key: 's1', category: 'acme', doing: 'fix the CI' })
  const out = await runHook(box, { hook_event_name: 'SessionStart', session_id: 's1', cwd: box.dir })
  useLanguage('en')
  assert.equal(out, context('SessionStart', brief(normalizeConfig({ language: 'en' }), cardOf(box, 's1'), box.dir)))
  assert.equal(cardOf(box, 's1')?.briefV, BRIEF_VERSION)
  assert.equal(typeof cardOf(box, 's1')?.briefedAt, 'number')
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
