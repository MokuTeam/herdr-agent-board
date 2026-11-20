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

// #164: herdr says blocked, the screen shows no dialog. Only the page's messages look (look, anyway).
const piItem = { pane: 'pane1', session: 'C:\\Team Work\\сессия 100%.jsonl', agent: 'pi', name: 'Test' }
const piAgent = (status = 'blocked') => ({
  result: { agent: { agent: 'pi', agent_status: status, agent_session: { value: piItem.session } } },
})
/** pi's input box holding `text`, no dialog in its place. */
const piTyped = (text: string): string => screen('pi-idle').replace(/(─+\n)\n(─+\nclaude)/, `$1 ${text}\n$2`)
const typing = (calls: string[][]) =>
  calls.filter(args => args[1] === 'prompt' || args[0] === 'pane' || args[1] === 'send-keys')

for (const [name, it, agentReply, text] of [
  ['pi', piItem, piAgent(), screen('pi-idle')],
  ['Claude', item, agent('blocked'), prompt()],
] as const) {
  test(`a page message to a ${name} session herdr calls blocked, with no dialog on screen, says so (#164)`, async () => {
    const box = await sandbox()
    box.state({ 'agent get': agentReply, 'agent read': { text }, 'agent prompt': { result: {} } })
    const out = await box.run('send', { item: it, cfg: { language: 'en' }, text: 'hello', opts: { look: true } }).exited
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      busy: true,
      dialog: true,
      code: 'stale',
      error: 'herdr says Test waits for a decision, but its screen shows no dialog',
    })
    expect(typing(box.calls())).toEqual([])
  })
}

for (const [name, it, agentReply, text] of [
  ['pi menu', piItem, piAgent(), screen('pi-select')],
  ['pi screen half drawn', piItem, piAgent(), screen('pi-select').split('\n').slice(0, 60).join('\n')],
  ['Claude permission', item, agent('blocked'), screen('permission-bash')],
  ['Claude unknown screen', item, agent('blocked'), 'Unrecognized interactive screen\nPress Enter to continue'],
  [
    'custom agent',
    { ...item, agent: 'custom' },
    { result: { agent: { agent: 'custom', agent_status: 'blocked', agent_session: { value: 'expected' } } } },
    prompt(),
  ],
] as const) {
  for (const anyway of [false, true]) {
    test(`a dialog the board sees or cannot read stays one, ${anyway ? 'sent anyway' : 'looked at'} (${name}, #164)`, async () => {
      const box = await sandbox()
      box.state({ 'agent get': agentReply, 'agent read': { text }, 'agent prompt': { result: {} } })
      const opts = { look: true, anyway }
      const out = await box.run('send', { item: it, cfg: { language: 'en' }, text: 'hello', opts }).exited
      expect(JSON.parse(out.stdout)).toEqual({
        ok: false,
        busy: true,
        dialog: true,
        error: 'Test waits for a decision in the terminal',
      })
      expect(typing(box.calls())).toEqual([])
    })
  }
}

test('the scheduler and every other caller keep the plain refusal, with no screen read (#164)', async () => {
  for (const [it, agentReply] of [
    [piItem, piAgent()],
    [item, agent('blocked')],
  ] as const) {
    const box = await sandbox()
    box.state({ 'agent get': agentReply, 'agent read': { text: screen('pi-idle') }, 'agent prompt': { result: {} } })
    const out = await box.run('send', { item: it, cfg: { language: 'en' }, text: 'hello' }).exited
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      busy: true,
      dialog: true,
      error: 'Test waits for a decision in the terminal',
    })
    expect(box.calls()).toEqual([['agent', 'get', 'pane1']])
  }
}, 30_000)

test('send anyway types into the input box and presses Enter once the box shows the text (#164)', async () => {
  const box = await sandbox()
  box.state({
    'agent get': piAgent(),
    'agent read': {
      seq: [{ text: screen('pi-idle') }, { text: screen('pi-idle') }, { text: piTyped('-hello  there') }],
    },
    'pane send-text': { result: {} },
    'agent send-keys': { result: {} },
    'agent prompt': { error: 'agent_blocked' },
  })
  const opts = { look: true, anyway: true }
  const out = await box.run('send', { item: piItem, cfg: { language: 'en' }, text: '-hello  there', opts }).exited
  expect(JSON.parse(out.stdout)).toEqual({ ok: true })
  expect(typing(box.calls())).toEqual([
    ['pane', 'send-text', 'pane1', ' -hello  there'],
    ['agent', 'send-keys', 'pane1', 'enter'],
  ])
  // Claude's input box the same way.
  const claude = await sandbox()
  claude.state({
    'agent get': agent('blocked'),
    'agent read': { seq: [{ text: prompt() }, { text: prompt() }, { text: prompt('hello') }] },
    'pane send-text': { result: {} },
    'agent send-keys': { result: {} },
  })
  const c = await claude.run('send', { item, cfg: { language: 'en' }, text: 'hello', opts }).exited
  expect(JSON.parse(c.stdout)).toEqual({ ok: true })
  expect(typing(claude.calls())).toEqual([
    ['pane', 'send-text', 'pane1', 'hello'],
    ['agent', 'send-keys', 'pane1', 'enter'],
  ])
}, 30_000)

test('send anyway: not over text in the box, and no Enter when the box never shows the text (#164)', async () => {
  // Text in the box: the user's own, or a frame the board does not know. A dialog all the same.
  for (const anyway of [false, true]) {
    const box = await sandbox()
    box.state({ 'agent get': piAgent(), 'agent read': { text: piTyped('half a thought') } })
    const opts = { look: true, anyway }
    const out = await box.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts }).exited
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      busy: true,
      dialog: true,
      error: 'Test waits for a decision in the terminal',
    })
    expect(typing(box.calls())).toEqual([])
  }
  // A dialog that comes up between the look and the typing gets nothing.
  const late = await sandbox()
  late.state({
    'agent get': piAgent(),
    'agent read': { seq: [{ text: screen('pi-idle') }, { text: screen('pi-select') }] },
    'pane send-text': { result: {} },
  })
  const opts = { look: true, anyway: true }
  const l1 = await late.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts }).exited
  expect(JSON.parse(l1.stdout)).toMatchObject({ ok: false, dialog: true })
  expect(typing(late.calls())).toEqual([])
  const lost = await sandbox()
  lost.state({
    'agent get': piAgent(),
    'agent read': { seq: [{ text: screen('pi-idle') }, { text: screen('pi-idle') }, { text: screen('pi-select') }] },
    'pane send-text': { result: {} },
    'agent send-keys': { result: {} },
  })
  const l = await lost.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts }).exited
  expect(JSON.parse(l.stdout)).toEqual({
    ok: false,
    error:
      'The message is typed into Test, but its screen did not show it in the input box, so it was not sent. Check it in herdr',
  })
  expect(typing(lost.calls())).toEqual([['pane', 'send-text', 'pane1', 'hello']])
}, 30_000)

test('a message of several lines (or with files) is told there is no dialog, but not offered Send anyway (#164)', async () => {
  for (const anyway of [false, true]) {
    const box = await sandbox()
    box.state({ 'agent get': piAgent(), 'agent read': { text: screen('pi-idle') }, 'pane send-text': { result: {} } })
    const opts = { look: true, anyway }
    const text = 'look at this\n\nFiles:\nC:\\Team Work\\shot 100%.png'
    const out = await box.run('send', { item: piItem, cfg: { language: 'en' }, text, opts }).exited
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      busy: true,
      dialog: true,
      error: 'herdr says Test waits for a decision, but its screen shows no dialog',
    })
    expect(typing(box.calls())).toEqual([])
  }
}, 30_000)

test('looking at the screen: a failed read is the plain refusal; herdr no longer blocked sends as usual (#164)', async () => {
  const failed = await sandbox()
  failed.state({ 'agent get': piAgent(), 'agent read': { error: 'capture unavailable' } })
  const f = await failed.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts: { look: true } })
    .exited
  expect(JSON.parse(f.stdout)).toEqual({
    ok: false,
    busy: true,
    dialog: true,
    error: 'Test waits for a decision in the terminal',
  })
  const freed = await sandbox()
  freed.state({
    'agent get': { seq: [piAgent(), piAgent('idle')] },
    'agent read': { text: screen('pi-idle') },
    'agent prompt': { result: {} },
    'pane send-text': { result: {} },
  })
  const opts = { look: true, anyway: true }
  const r = await freed.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts }).exited
  expect(JSON.parse(r.stdout)).toEqual({ ok: true })
  expect(typing(freed.calls())).toEqual([['agent', 'prompt', 'pane1', 'hello']])
  // Another session in the pane by then: nothing typed.
  const moved = await sandbox()
  moved.state({
    'agent get': {
      seq: [
        piAgent(),
        { result: { agent: { agent: 'pi', agent_status: 'blocked', agent_session: { value: 'other' } } } },
      ],
    },
    'agent read': { text: screen('pi-idle') },
    'pane send-text': { result: {} },
  })
  const m = await moved.run('send', { item: piItem, cfg: { language: 'en' }, text: 'hello', opts }).exited
  expect(JSON.parse(m.stdout)).toMatchObject({
    ok: false,
    error: 'Test: another session is in that pane now, refresh the board',
  })
  expect(typing(moved.calls())).toEqual([])
}, 30_000)
