// A side question as Claude Code's /btw in the session's pane (services/aside.ts), against a fake
// pane: what is typed, what keys are pressed, what is read back, and when nothing is typed at all.
import { beforeEach, expect, test } from 'bun:test'
import type { HerdrAgent } from '../../src/adapters/herdr.ts'
import { stripAnsi } from '../../src/core/dialogs/input-box.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { askAside, type BtwIO } from '../../src/services/aside.ts'

beforeEach(() => useLanguage('en'))

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const item = { agent: 'claude', session: S, name: 'Acme', pane: 'w1:p2', sleeping: false }
const deps = { log: () => {} }
const RULE = '▔'.repeat(80)
const LINE = '─'.repeat(80)
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** The session's screen with an empty input box, or `draft` in it. */
const prompt = (draft = '') =>
  ['● ready', '', LINE, `❯ ${draft || `${DIM}Try "fix lint errors"${RESET}`}`, LINE, '  ⏵⏵ auto mode on'].join('\n')

interface Pane {
  agent: HerdrAgent | null
  /** The screen with the input box, as `--ansi` reads it. */
  box: string
  /** Screens the overlay goes through once the line is typed, one per read; the last stays. */
  overlay: string[]
  /** The answer's lines, of which `height` are in sight; Down moves three further. */
  answer?: string[]
  height?: number
  /** Esc closes the overlay (false: it stays, as a frozen terminal would). */
  escCloses?: boolean
}

function fakePane(pane: Partial<Pane> = {}) {
  const p: Pane = {
    agent: { session: S, status: 'idle', kind: 'claude' } as HerdrAgent,
    box: prompt(),
    overlay: [],
    escCloses: true,
    ...pane,
  }
  const sent: string[] = []
  let typed = ''
  let step = 0
  let top = 0
  let open = false
  const overlayScreen = (): string => {
    const q = typed
    const screen = p.overlay[Math.min(step, p.overlay.length - 1)] ?? ''
    if (screen !== 'ANSWER') return screen.replaceAll('{q}', q)
    const shown = (p.answer ?? []).slice(top, top + (p.height ?? 20))
    return [
      '● ready',
      RULE,
      '',
      `    ${q}`,
      '',
      ...shown.map(l => (l ? `      ${l}` : '')),
      '',
      '    ↑/↓ to scroll · c to copy · Esc to close',
    ].join('\n')
  }
  const io: BtwIO = {
    agent: async () => p.agent,
    screen: async () => (open ? overlayScreen() : p.box),
    read: async () => {
      if (!open) return stripAnsi(p.box)
      const s = overlayScreen()
      step++
      return s
    },
    keys: async (...keys) => {
      sent.push(...keys)
      for (const k of keys) {
        if (k === 'esc' && p.escCloses) open = false
        if (k === 'down') top = Math.max(0, Math.min(top + 3, (p.answer?.length ?? 0) - (p.height ?? 20)))
      }
    },
    prompt: async text => {
      sent.push(`prompt:${text}`)
      typed = text
      open = p.overlay.length > 0
    },
  }
  return { io, sent, isOpen: () => open }
}

const answering = ['● ready', RULE, '', '    {q}', '', '      ✽ Answering…', '', '    Esc to close'].join('\n')
const fast = { pollMs: 0, sleep: async () => {} }

test('types /btw and the question into the session, reads the answer, closes the overlay', async () => {
  const f = fakePane({ overlay: [answering, answering, 'ANSWER'], answer: ['PINEAPPLE'] })
  const r = await askAside(deps, item, '  What was\n the code word?  ', { io: f.io, ...fast })
  expect(r).toMatchObject({ ok: true, text: 'PINEAPPLE' })
  // One line typed, nothing else into the conversation; one look further down; Esc closes it.
  expect(f.sent).toEqual(['prompt:/btw What was the code word?', 'down', 'esc'])
  expect(f.isOpen()).toBe(false)
})

test('works while the session is busy: /btw answers beside a running turn', async () => {
  const f = fakePane({
    agent: { session: S, status: 'working', kind: 'claude' } as HerdrAgent,
    overlay: ['ANSWER'],
    answer: ['Four'],
  })
  expect(await askAside(deps, item, 'what is 2+2?', { io: f.io, ...fast })).toMatchObject({ ok: true, text: 'Four' })
})

test('an answer taller than the overlay is read down to its end, blank lines kept', async () => {
  const answer = [...Array.from({ length: 45 }, (_, i) => `${i + 1} ${(i + 1) ** 2}`), '', 'done']
  const f = fakePane({ overlay: ['ANSWER'], answer, height: 26 })
  const r = await askAside(deps, item, 'squares?', { io: f.io, ...fast })
  expect(r).toMatchObject({ ok: true, text: answer.join('\n') })
  expect(f.sent.filter(k => k === 'down').length).toBe(8)
  expect(f.sent.at(-1)).toBe('esc')
})

test('nothing typed where it would not land as /btw: a dialog or overlay, a draft, another session, asleep', async () => {
  const cases: [Partial<Pane>, string][] = [
    [
      { agent: { session: S, status: 'blocked', kind: 'claude' } as HerdrAgent },
      'Acme waits for a decision in the terminal',
    ],
    [
      { box: ['● ready', LINE, '❯ ', LINE, '  Select model', '  Esc to close'].join('\n') },
      '“Acme” has a dialog or an overlay open in the terminal: /btw would land in it',
    ],
    [{ box: prompt('half a message') }, 'Acme has unsent text in its input box'],
    [
      { agent: { session: 'another', status: 'idle', kind: 'claude' } as HerdrAgent },
      'Acme: another session is in that pane now, refresh the board',
    ],
    [{ agent: null }, 'Acme: another session is in that pane now, refresh the board'],
  ]
  for (const [pane, error] of cases) {
    const f = fakePane({ overlay: ['ANSWER'], answer: ['x'], ...pane })
    const r = await askAside(deps, item, 'q', { io: f.io, ...fast })
    expect(r).toMatchObject({ ok: false, error })
    expect(f.sent).toEqual([])
  }
  const f = fakePane({ overlay: ['ANSWER'], answer: ['x'] })
  expect(await askAside(deps, { ...item, sleeping: true }, 'q', { io: f.io, ...fast })).toEqual({
    ok: false,
    error: '“Acme” is asleep: /btw needs the running session. Wake it first',
  })
  expect(await askAside(deps, { ...item, pane: null }, 'q', { io: f.io, ...fast })).toEqual({
    ok: false,
    error: 'The session has no pane',
  })
  expect(f.sent).toEqual([])
})

test('refused before anything is read: no question, too long for one /btw line', async () => {
  const f = fakePane({ overlay: ['ANSWER'], answer: ['x'] })
  const o = { io: f.io, ...fast }
  expect(await askAside(deps, item, '  ', o)).toEqual({ ok: false, error: 'Type the question first' })
  expect(await askAside(deps, item, 'x'.repeat(791), o)).toEqual({
    ok: false,
    error: 'A side question is up to 790 characters',
  })
  expect(f.sent).toEqual([])
})

test('other agents (pi, Codex, unknown) and panes with no Claude session id: refused as before, with no herdr call', async () => {
  const calls: string[] = []
  const untouched = Object.fromEntries(
    ['agent', 'screen', 'read', 'keys', 'prompt'].map(k => [
      k,
      async () => {
        calls.push(k)
        return null
      },
    ]),
  ) as unknown as BtwIO
  const notClaude = 'Only a Claude session with an id can be asked aside, and “Acme” is not one'
  for (const other of [
    { ...item, agent: 'pi' },
    { ...item, agent: 'codex' },
    { ...item, agent: 'unknown' },
    { ...item, session: 'pane-w1:p1' },
    { ...item, session: null },
  ])
    expect(await askAside(deps, other, 'q', { io: untouched, ...fast })).toEqual({ ok: false, error: notClaude })
  expect(calls).toEqual([])
})

test('no overlay after typing (an older Claude Code, the line went elsewhere): says so and presses no key', async () => {
  const f = fakePane({ overlay: [] })
  const r = await askAside(deps, item, 'q', { io: f.io, pollMs: 0, showMs: 20, sleep: () => Bun.sleep(5) })
  expect(r).toMatchObject({ ok: false })
  expect((r as { error: string }).error).toContain('did not open /btw')
  expect(f.sent).toEqual(['prompt:/btw q'])
})

test('too slow, or cancelled: our overlay is closed with Esc, and only ours', async () => {
  const slow = fakePane({ overlay: [answering] })
  const r = await askAside(deps, item, 'q', { io: slow.io, ...fast, timeoutMs: -1 })
  expect(r).toEqual({ ok: false, error: 'No answer in 0 s' })
  expect(slow.sent).toEqual(['prompt:/btw q', 'esc'])
  expect(slow.isOpen()).toBe(false)

  const control = new AbortController()
  const cancelled = fakePane({ overlay: [answering] })
  const pending = askAside(deps, item, 'q', {
    io: cancelled.io,
    pollMs: 0,
    signal: control.signal,
    sleep: async () => control.abort(),
  })
  expect(await pending).toEqual({ ok: false, error: 'Cancelled' })
  expect(cancelled.sent).toEqual(['prompt:/btw q', 'esc'])

  // An overlay with someone else's question: not ours to close.
  const other = fakePane({
    overlay: [
      ['● ready', RULE, '', '    /btw which file?', '', '      a.ts', '', '    c to copy · Esc to close'].join('\n'),
    ],
  })
  const r2 = await askAside(deps, item, 'q', { io: other.io, pollMs: 0, showMs: -1, sleep: async () => {} })
  expect(r2.ok).toBe(false)
  expect(other.sent).toEqual(['prompt:/btw q'])
})

test('one side question per pane at a time', async () => {
  let release = () => {}
  const f = fakePane({ overlay: ['ANSWER'], answer: ['x'] })
  const first = askAside(deps, item, 'q', {
    io: f.io,
    pollMs: 0,
    sleep: () => new Promise<void>(resolve => (release = resolve)),
  })
  const second = await askAside(deps, item, 'q2', { io: f.io, ...fast })
  expect(second).toEqual({ ok: false, busy: true, error: '“Acme” is already answering a side question' })
  for (let i = 0; i < 10; i++) {
    release()
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
  }
  expect((await first).ok).toBe(true)
})

test('herdr failing says so', async () => {
  const f = fakePane()
  f.io.prompt = async () => {
    throw new Error('herdr: pane not found')
  }
  expect(await askAside(deps, item, 'q', { io: f.io, ...fast })).toEqual({
    ok: false,
    error: 'Could not ask “Acme” through herdr: herdr: pane not found',
  })
})
