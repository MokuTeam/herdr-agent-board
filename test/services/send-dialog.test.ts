import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sandbox } from '../support/sandbox.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')
const rule = '─'.repeat(40)
const prompt = (text = ''): string => [rule, `❯ ${text}`, rule, '  ? for shortcuts'].join('\n')
const agent = (status = 'done', session = 'expected') => ({
  result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: session } } },
})
const item = { pane: 'pane1', session: 'expected', agent: 'claude', name: 'Test' }

for (const status of ['done', 'idle', 'working']) {
  test(`manual send refuses Teach auto mode even when herdr says ${status}`, async () => {
    const box = await sandbox()
    box.state({
      'agent get': agent(status),
      'agent read': { text: screen('teach-auto-mode') },
      'agent prompt': { result: {} },
    })
    const out = await box.run('send', { item, cfg: { language: 'en' }, text: 'keep this message' }).exited
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, busy: true, dialog: true })
    expect(box.calls().some(args => args[1] === 'prompt' || args[0] === 'pane')).toBe(false)
  })
}

for (const [name, text] of [
  ['question form', screen('question-single')],
  ['permission', screen('permission-bash')],
  ['unknown screen', 'Unrecognized interactive screen\nPress Enter to continue'],
  ['empty capture', ''],
  ['truncated input', `${rule}\n❯ `],
  ['unknown menu with a prompt-like cursor', `${rule}\n❯ Continue\n  Cancel`],
  ['old prompt above Teach auto mode', `${prompt()}\n${screen('teach-auto-mode')}`],
  ['old prompt above a dialog without a cursor', `${prompt()}\nDialog\nEnter to continue · Esc to cancel`],
] as const) {
  test(`manual send fails closed on ${name}`, async () => {
    const box = await sandbox()
    box.state({ 'agent get': agent(), 'agent read': { text }, 'agent prompt': { result: {} } })
    const out = await box.run('send', { item, cfg: {}, text: 'must not be typed' }).exited
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, busy: true, dialog: true })
    expect(box.calls().some(args => args[1] === 'prompt' || args[0] === 'pane')).toBe(false)
  })
}

test('a failed screen read refuses without typing', async () => {
  const box = await sandbox()
  box.state({ 'agent get': agent(), 'agent read': { error: 'capture unavailable' }, 'agent prompt': { result: {} } })
  const out = await box.run('send', { item, cfg: { language: 'en' }, text: 'keep me' }).exited
  expect(JSON.parse(out.stdout)).toMatchObject({ ok: false })
  expect(JSON.parse(out.stdout).error).toContain('capture unavailable')
  expect(box.calls().some(args => args[1] === 'prompt')).toBe(false)
})

test('missing agent kind cannot bypass the screen guard for a known Claude card', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { result: { agent: { agent_status: 'done', agent_session: { value: 'expected' } } } },
    'agent read': { text: screen('teach-auto-mode') },
    'agent prompt': { result: {} },
  })
  const out = await box.run('send', { item, cfg: {}, text: 'keep me' }).exited
  expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, busy: true, dialog: true })
  expect(box.calls().some(args => args[1] === 'prompt')).toBe(false)
})

for (const text of ['', '\x1b[2mTry running the tests\x1b[0m', 'already typed']) {
  test(`an ordinary prompt accepts one manual send (input=${JSON.stringify(text)})`, async () => {
    const box = await sandbox()
    box.state({
      'agent get': agent('working'),
      'agent read': { text: prompt(text) },
      'agent prompt': { result: {} },
    })
    const out = await box.run('send', { item, cfg: {}, text: '-hello' }).exited
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ ok: true })
    expect(box.calls().filter(args => args[1] === 'read')).toEqual([
      ['agent', 'read', 'pane1', '--source', 'visible', '--ansi'],
    ])
    expect(box.calls().filter(args => args[1] === 'prompt')).toEqual([['agent', 'prompt', 'pane1', ' -hello']])
  })
}

for (const next of [
  agent('idle', 'replacement'),
  agent('blocked'),
  { result: { agent: { agent: 'pi', agent_status: 'idle', agent_session: { value: 'expected' } } } },
]) {
  test(`a change while reading the screen refuses before typing (${JSON.stringify(next)})`, async () => {
    const box = await sandbox()
    box.state({
      'agent get': { seq: [agent(), next] },
      'agent read': { text: prompt() },
      'agent prompt': { result: {} },
    })
    const out = await box.run('send', { item, cfg: {}, text: 'must stay here' }).exited
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false })
    expect(box.calls().some(args => args[1] === 'prompt')).toBe(false)
  })
}

for (const [kind, session] of [
  ['pi', 'C:\\Team Work\\сессия 100%.jsonl'],
  ['custom', 'session-2'],
] as const) {
  test(`a ${kind} session keeps the original send calls without a Claude screen check`, async () => {
    const box = await sandbox()
    box.state({
      'agent get': { result: { agent: { agent: kind, agent_status: 'idle', agent_session: { value: session } } } },
      'agent read': { error: 'This agent does not use a Claude input box' },
      'agent prompt': { result: {} },
    })
    const out = await box.run('send', { item: { ...item, agent: kind, session }, cfg: {}, text: '-hello' }).exited
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ ok: true })
    expect(box.calls()).toEqual([
      ['agent', 'get', 'pane1'],
      ['agent', 'prompt', 'pane1', ' -hello'],
    ])
  })
}
