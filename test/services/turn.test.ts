// Stop and Send now (#330) against a fake pane (services/turn.ts): which keys are pressed, when
// nothing is, and what the user is told, a stop that did not take included.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { HerdrAgent } from '../../src/adapters/herdr.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { QueuedPrompt } from '../../src/core/queue.ts'
import { sendNow, stopTurn, type TurnIO } from '../../src/services/turn.ts'

beforeEach(() => useLanguage('en'))

const S = '07624983-b6d4-410f-9664-28b0bc29b012'
const item = { agent: 'claude', session: S, name: 'Acme', pane: 'w1:p2', sleeping: false }
const deps = { log: () => {} }
const LINE = '─'.repeat(60)
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
/** The session's screen with an empty input box, or `draft` in it. */
const prompt = (draft = '') =>
  ['✻ Working… (12s)', '', LINE, `❯ ${draft || `${DIM}Press up to edit queued messages${RESET}`}`, LINE].join('\n')
/** A dialog over the input box: no box on screen. */
const DIALOG = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'].join('\n')

const marker = (at: number) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    timestamp: new Date(at).toISOString(),
  })

interface Pane {
  agent: HerdrAgent | null
  screen: string
  /** What Esc does: writes the marker, ends the turn, both, or nothing (the turn goes on). */
  esc: { marker?: boolean; idle?: boolean }
  queued: QueuedPrompt[]
}

/** A fake pane on a fake clock: each sleep moves it on. */
function fakePane(pane: Partial<Pane> = {}) {
  const p: Pane = {
    agent: { session: S, status: 'working', kind: 'claude' } as HerdrAgent,
    screen: prompt(),
    esc: { marker: true },
    queued: [],
    ...pane,
  }
  const sent: string[] = []
  let now = Date.parse('2026-11-06T11:06:00.000Z')
  let transcript = `${marker(now - 60_000)}\n` // an older stop, before this one
  const io: TurnIO = {
    agent: async () => p.agent,
    screen: async () => p.screen,
    keys: async (...keys) => {
      sent.push(...keys)
      if (keys.includes('esc')) {
        if (p.esc.marker) transcript += `${marker(now + 200)}\n`
        if (p.esc.idle && p.agent) p.agent = { ...p.agent, status: 'idle' }
      }
      if (keys.includes('ctrl+enter')) p.queued = []
    },
    transcript: () => transcript,
    queued: () => p.queued,
  }
  const sleep = async (ms: number) => {
    now += ms
  }
  return { io, sent, sleep, now: () => now, pane: p }
}

describe('Stop', () => {
  test('Claude: Esc, and done once the transcript says the turn was interrupted', async () => {
    const f = fakePane()
    expect(await stopTurn(deps, item, f)).toEqual({ ok: true })
    expect(f.sent).toEqual(['esc'])
  })

  test('a queued message starts the next turn at once: still working, stopped all the same', async () => {
    const f = fakePane({ esc: { marker: true }, queued: [{ text: 'next', at: 1 }] })
    expect(await stopTurn(deps, item, f)).toEqual({ ok: true })
    expect(f.pane.agent?.status).toBe('working')
  })

  test('herdr saying the turn ended is enough too', async () => {
    const f = fakePane({ esc: { idle: true } })
    expect(await stopTurn(deps, item, f)).toEqual({ ok: true })
  })

  test('a stop that did not stop is reported, with how long it waited', async () => {
    const f = fakePane({ esc: {} })
    const r = await stopTurn(deps, item, { ...f, waitMs: 6000 })
    expect(r).toEqual({ ok: false, error: 'Acme did not stop: it is still working 6 s after Esc' })
    expect(f.sent).toEqual(['esc'])
  })

  test('text in the input box: Esc still stops the turn (Claude Code keeps the text)', async () => {
    const f = fakePane({ screen: prompt('half a thought') })
    expect(await stopTurn(deps, item, f)).toEqual({ ok: true })
    expect(f.sent).toEqual(['esc'])
  })

  test('nothing pressed: over a dialog, a dialog herdr knows, another session, a turn already over', async () => {
    const cases: [Partial<Pane>, object][] = [
      [{ screen: DIALOG }, { ok: false, busy: true, error: 'Something is open over Acme’s input box: the board presses nothing into it' }],
      [
        { agent: { session: S, status: 'blocked', kind: 'claude' } as HerdrAgent },
        { ok: false, busy: true, error: 'Acme waits for a decision in the terminal' },
      ],
      [{ agent: { session: 'other', status: 'working', kind: 'claude' } as HerdrAgent }, { ok: false }],
      [{ agent: null }, { ok: false }],
      [{ agent: { session: S, status: 'idle', kind: 'claude' } as HerdrAgent }, { ok: true, already: true }],
    ]
    for (const [pane, want] of cases) {
      const f = fakePane(pane)
      expect(await stopTurn(deps, item, f)).toMatchObject(want)
      expect(f.sent).toEqual([])
    }
  })

  test('no keys for pi, Codex or an unknown program, nor without a pane or asleep', async () => {
    const cases: [object, string][] = [
      [{ ...item, agent: 'pi', session: 'pi-session' }, 'The board does not know the key that stops Acme'],
      [{ ...item, agent: 'codex' }, 'The board does not know the key that stops Acme'],
      [{ ...item, agent: undefined }, 'The board does not know the key that stops Acme'],
      [{ ...item, pane: null }, 'The session has no pane'],
      [{ ...item, sleeping: true }, 'Acme is asleep: no turn runs'],
    ]
    for (const [it, error] of cases) {
      const f = fakePane()
      expect(await stopTurn(deps, it as typeof item, f)).toEqual({ ok: false, error })
      expect(f.sent).toEqual([])
    }
  })

  test('herdr failing says so', async () => {
    const f = fakePane()
    f.io.keys = async () => {
      throw new Error('socket closed')
    }
    expect(await stopTurn(deps, item, f)).toEqual({ ok: false, error: 'herdr did not press the key in Acme: socket closed' })
  })

  test('in Russian', async () => {
    useLanguage('ru')
    expect(await stopTurn(deps, item, { ...fakePane({ esc: {} }), waitMs: 4000 })).toEqual({
      ok: false,
      error: 'Acme: ход не остановился, через 4 с после Esc сессия всё ещё работает',
    })
    expect(await stopTurn(deps, { ...item, agent: 'pi' }, fakePane())).toEqual({
      ok: false,
      error: 'Acme: доска не знает клавишу, которая останавливает эту программу',
    })
  })
})

describe('Send now', () => {
  const queued = [
    { text: 'also check the logs', at: 1 },
    { text: 'and the tests', at: 2 },
  ]

  test('Claude: ctrl+enter over an empty input box, while the message waits', async () => {
    const f = fakePane({ queued })
    expect(await sendNow(deps, item, 'and the tests', f)).toEqual({ ok: true })
    expect(f.sent).toEqual(['ctrl+enter'])
  })

  test('only on a queued message: gone in already, or nothing queued, presses nothing', async () => {
    for (const [pane, text] of [
      [{ queued }, 'something else'],
      [{ queued: [] }, 'also check the logs'],
      [{ queued: [] }, undefined],
    ] as const) {
      const f = fakePane(pane)
      expect(await sendNow(deps, item, text, f)).toEqual({ ok: true, already: true })
      expect(f.sent).toEqual([])
    }
  })

  test('no turn running: the message starts the next one by itself', async () => {
    const f = fakePane({ queued, agent: { session: S, status: 'idle', kind: 'claude' } as HerdrAgent })
    expect(await sendNow(deps, item, 'and the tests', f)).toEqual({ ok: true, already: true })
    expect(f.sent).toEqual([])
  })

  test('text in the input box would go instead: refused, and so over a dialog', async () => {
    const draft = fakePane({ queued, screen: prompt('half a thought') })
    expect(await sendNow(deps, item, 'and the tests', draft)).toEqual({
      ok: false,
      busy: true,
      error: 'Acme has unsent text in its input box: Send now would send that instead',
    })
    const dialog = fakePane({ queued, screen: DIALOG })
    expect(await sendNow(deps, item, 'and the tests', dialog)).toMatchObject({ ok: false, busy: true })
    expect([...draft.sent, ...dialog.sent]).toEqual([])
  })

  test('no keys for pi or Codex, nor without a pane or asleep', async () => {
    for (const it of [
      { ...item, agent: 'pi' },
      { ...item, agent: 'codex' },
      { ...item, pane: null },
      { ...item, sleeping: true },
    ]) {
      const f = fakePane({ queued })
      expect((await sendNow(deps, it, 'and the tests', f)).ok).toBe(false)
      expect(f.sent).toEqual([])
    }
  })

  test('in Russian', async () => {
    useLanguage('ru')
    expect(await sendNow(deps, item, 'and the tests', fakePane({ queued, screen: prompt('x') }))).toEqual({
      ok: false,
      busy: true,
      error: 'Acme: в поле ввода недописанный текст, «Отправить сейчас» отправило бы его',
    })
  })
})
