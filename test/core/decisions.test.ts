// Decisions (#487, core/decisions.ts): the config, `board ask`'s flags and every refusal, the lines,
// the queue's order, and whose prompt answers a question.
import { expect, test } from 'bun:test'
import { brief, decisionsBrief } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import {
  askSpec,
  decisionsConfig,
  defaultLine,
  durationWords,
  orderQueue,
  ownerPrompt,
  parseAsk,
  parseDuration,
} from '../../src/core/decisions.ts'
import { nodePart } from '../../src/core/node-items.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import { BRIEF_MAX } from '../../src/core/work-threads.ts'
import { notification } from '../support/task-notification.ts'

const ON = { defaults: true }

test('decisions are on for true or an object; { defaults: false } keeps them on without defaults', () => {
  expect(decisionsConfig(undefined)).toBeNull()
  expect(decisionsConfig(false)).toBeNull()
  expect(decisionsConfig('yes')).toBeNull()
  expect(decisionsConfig([])).toBeNull()
  expect(decisionsConfig(true)).toEqual({ defaults: true })
  expect(decisionsConfig({})).toEqual({ defaults: true })
  expect(decisionsConfig({ defaults: false })).toEqual({ defaults: false })
})

test('board ask reads its flags before a --, the rest is the question', () => {
  expect(parseAsk(['Merge', 'now?', '--option', 'yes', '--option', 'no, wait', '--recommend', '1'], [], ON)).toEqual({
    question: 'Merge now?',
    options: ['yes', 'no, wait'],
    recommend: 1,
    defaultMs: null,
  })
  expect(
    parseAsk(['--option', 'a', '--option', 'b', '--recommend', '2', '--default-after', '1h30m', 'Which?'], [], ON),
  ).toEqual({
    question: 'Which?',
    options: ['a', 'b'],
    recommend: 2,
    defaultMs: 90 * 60_000,
  })
  // After a lone --, a flag is text.
  expect(parseAsk(['Which'], ['--option', 'x'], ON)).toEqual({
    question: 'Which --option x',
    options: [],
    recommend: null,
    defaultMs: null,
  })
  // A plain question is one with no options, kept whole as a plain board ask keeps it.
  expect(parseAsk(['ok', 'to', 'go?'], [], ON).options).toEqual([])
  expect(parseAsk(['x'.repeat(900)], [], ON).question).toHaveLength(900)
})

test('board ask refuses with one line: options, labels, --recommend, --default-after', () => {
  const refused = (words: string[], cfg = ON): string => {
    try {
      parseAsk(words, [], cfg)
    } catch (err) {
      return (err as Error).message
    }
    return 'taken'
  }
  expect(refused(['q', '--option', 'a'])).toBe('give 2 to 4 options, not 1')
  expect(refused(['q', ...['a', 'b', 'c', 'd', 'e'].flatMap(o => ['--option', o])])).toBe('give 2 to 4 options, not 5')
  expect(refused(['q', '--option', 'a', '--option', ' '])).toBe('an option needs a label')
  expect(refused(['q', '--option', 'a', '--option', 'x'.repeat(61)])).toBe(
    "an option's label has more than 60 characters",
  )
  expect(refused(['q', '--option', 'Yes', '--option', 'yes'])).toBe('two options have the same label')
  expect(refused(['q', '--recommend', '1'])).toBe('--recommend needs --option')
  expect(refused(['q', '--option', 'a', '--option', 'b', '--recommend', '3'])).toBe(
    "--recommend takes an option's number, 1 to 2",
  )
  expect(refused(['q', '--option', 'a', '--option', 'b', '--recommend', 'one'])).toBe(
    "--recommend takes an option's number, 1 to 2",
  )
  expect(refused(['q', '--option', 'a', '--option', 'b', '--default-after', '2h'])).toBe(
    '--default-after needs --recommend: the default is the recommended option',
  )
  const both = ['q', '--option', 'a', '--option', 'b', '--recommend', '1', '--default-after']
  expect(refused([...both, 'soon'])).toBe('--default-after takes a time like 30m, 2h or 1h30m, not "soon"')
  expect(refused([...both, '4m'])).toBe('--default-after takes 5 min to 72 h')
  expect(refused([...both, '73h'])).toBe('--default-after takes 5 min to 72 h')
  expect(refused([...both, '2h'], { defaults: false })).toBe(
    'defaults are off on this board: ask without --default-after',
  )
  expect(refused(['q', '--option'])).toBe('--option needs a value')
  expect(refused(['q', '--option', '/clear', '--option', 'b'])).toBe("an option's label may not start with / or !")
  expect(refused(['q', '--option', '!rm -rf x', '--option', 'b'])).toBe("an option's label may not start with / or !")
  expect(refused(['--option', 'a', '--option', 'b'])).toStartWith('usage: board ask <question>')
})

test('board thread ask takes the same refusals from parsed words', () => {
  expect(askSpec('Ship it?', ['yes', 'no'], '1', '30m', ON)).toEqual({
    question: 'Ship it?',
    options: ['yes', 'no'],
    recommend: 1,
    defaultMs: 30 * 60_000,
  })
  expect(() => askSpec('q', ['yes'], undefined, undefined, ON)).toThrow('give 2 to 4 options, not 1')
})

test('durations: what reads, and how the card says it', () => {
  expect(parseDuration('30m')).toBe(30 * 60_000)
  expect(parseDuration('2h')).toBe(2 * 3_600_000)
  expect(parseDuration('1h30m')).toBe(90 * 60_000)
  expect(parseDuration('45 min')).toBe(45 * 60_000)
  expect(parseDuration('')).toBeNull()
  expect(parseDuration('2d')).toBeNull()
  expect(durationWords(2 * 3_600_000)).toBe('2 h')
  expect(durationWords(72 * 60_000)).toBe('1 h 12 min')
  expect(durationWords(45 * 60_000)).toBe('45 min')
})

test('the default goes in as a board reminder from decisions', () => {
  const text = defaultLine(2 * 3_600_000, 'Merge')
  expect(text).toBe('no answer in 2 h: go with your recommendation "Merge"')
  const entry = { id: 'abc123', key: 's1', next: 0, text, from: { key: 'decisions', name: 'decisions' } }
  expect(promptOf(entry, 0)).toBe(`[board reminder from decisions] ${text}`)
})

test('the queue: a running default first, soonest first; then the rest oldest first', () => {
  const q = [
    { n: 'plain-old', defaultAt: null, held: false, askedAt: 1 },
    { n: 'held', defaultAt: null, held: true, askedAt: 5 },
    { n: 'late-default', defaultAt: 900, held: false, askedAt: 9 },
    { n: 'board', defaultAt: null, held: false, askedAt: null },
    { n: 'soon-default', defaultAt: 300, held: false, askedAt: 8 },
    { n: 'plain-new', defaultAt: null, held: false, askedAt: 7 },
  ]
  expect(orderQueue(q).map(d => d.n)).toEqual([
    'soon-default',
    'late-default',
    'plain-old',
    'held',
    'plain-new',
    'board',
  ])
})

test("whose prompt answers: the owner's own words, never another session's, a teammate's or a background result", () => {
  // The owner: typed, in Telegram, or the board's thread answer the owner gave.
  expect(ownerPrompt('go with the second one')).toBe(true)
  expect(ownerPrompt('<channel source="telegram" chat_id="1">yes</channel>')).toBe(true)
  expect(ownerPrompt('[board thread atlas-3] yes')).toBe(true)
  // Not the owner: another session's message, an agent's, a teammate's.
  expect(ownerPrompt('<cross-session-message from="x" from-name="ben">done</cross-session-message>')).toBe(false)
  expect(ownerPrompt('<agent-message from="cleo">hi</agent-message>')).toBe(false)
  expect(ownerPrompt('<teammate-message teammate_id="t">hi</teammate-message>')).toBe(false)
  // Code Mode's background result (#424, #445), with a nonce or without.
  expect(ownerPrompt('<event nonce="n1" kind="repl-eval" at="2026-11-20T10:00:00Z">ok</event>')).toBe(false)
  expect(ownerPrompt('<event kind="repl-eval" at="2026-11-20T10:00:00.123Z">ok</event>')).toBe(false)
  // A board reminder (a Team notice comes as one too), a task notification.
  expect(ownerPrompt('[board reminder] check CI')).toBe(false)
  expect(ownerPrompt('[board reminder from team] anna wrote')).toBe(false)
  expect(ownerPrompt(notification('Background command "x" completed (exit code 0)'))).toBe(false)
  // Lines the board types itself: a restart's note (a reminder), its /compact; any slash command.
  expect(ownerPrompt('[board reminder; restarted at 10:00] go on with the review')).toBe(false)
  expect(ownerPrompt('/compact keep the plan')).toBe(false)
  expect(ownerPrompt('  /clear')).toBe(false)
})

test('the brief: the block only while decisions are on, for Claude, and without defaults when they are off', () => {
  const cfg = normalizeConfig({ language: 'en' })
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p1' }
  const off = brief(cfg, null, '/x', env, 'Claude')
  expect(brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, false, null)).toBe(off)
  expect(off).not.toContain('--option')
  const on = brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, false, { defaults: true })
  const lines = on.split('\n')
  const at = lines.findIndex(l => l.startsWith('- board ask '))
  expect(lines[at + 1]).toStartWith(
    '  With options: board ask "<question>" --option "<label>" --option "<label>" [--recommend <n>] [--default-after 2h]',
  )
  expect(lines[at + 1]).toContain('never for something that cannot be undone or goes out to another person')
  // Everything else as it was.
  expect(lines.filter((_, i) => i !== at + 1).join('\n')).toBe(off)
  const noDefaults = brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, false, { defaults: false })
  expect(noDefaults).toContain('Defaults are off on this board: ask without --default-after.')
  expect(noDefaults).not.toContain('[--default-after 2h]')
  expect(brief(cfg, null, '/x', env, 'Codex', null, null, [], false, null, false, { defaults: true })).toBe(
    brief(cfg, null, '/x', env, 'Codex'),
  )
})

test('the brief with watches (#486) on too: both lines, each where it goes; with both off, as without either', () => {
  const cfg = normalizeConfig({ language: 'en' })
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p1' }
  const none = brief(cfg, null, '/x', env, 'Claude')
  expect(brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, false, null)).toBe(none)
  const watches = brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, true, null)
  const decisions = brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, false, { defaults: true })
  const both = brief(cfg, null, '/x', env, 'Claude', null, null, [], false, null, true, { defaults: true })
  const added = (text: string) => text.split('\n').filter(l => !none.split('\n').includes(l))
  // Each feature's own lines, and with both on exactly the two sets together.
  expect(added(watches).length).toBeGreaterThan(0)
  expect(added(decisions)).toHaveLength(1)
  expect(added(both).sort()).toEqual([...added(watches), ...added(decisions)].sort())
  const lines = both.split('\n')
  expect(lines[lines.findIndex(l => l.startsWith('- board ask ')) + 1]).toStartWith('  With options: board ask')
  // Its block within the limit a feature's block has (core/work-threads.ts BRIEF_MAX).
  for (const block of [
    decisionsBrief({ defaults: true }),
    decisionsBrief({ defaults: false }),
    decisionsBrief({ defaults: true }, true),
    decisionsBrief({ defaults: false }, true),
  ])
    expect(block.length).toBeLessThanOrEqual(BRIEF_MAX)
  expect(decisionsBrief({ defaults: true }, true)).toContain('`card` op `ask`')
})

test("a device's card on the master (#781): its decision is carried, so the master can show its own copy of it", () => {
  const sid = '1f0e3c1a-5b7d-4c2e-9a10-3c4b5d6e7f80'
  const part = nodePart(
    {
      items: [
        {
          key: sid,
          session: sid,
          pane: 'w1:p1',
          workspace: 'w1',
          cwd: '/home/owner/work/atlas',
          status: 'idle',
          name: 'atlas 12',
          column: 'me',
          attention: 'ask',
          question: 'Merge now?',
          decision: { id: 'd1', options: ['yes', 'no'], recommend: 1, defaultAt: 1 },
        },
      ],
    },
    'studio',
  )
  const item = part?.items[0]
  expect(item?.key).toBe(`@studio:${sid}`)
  expect(item?.question).toBe('Merge now?')
  expect(item?.decision).toEqual({ id: 'd1', options: ['yes', 'no'], recommend: 1, defaultAt: 1 })
  // One that does not read as a decision (no options, a label with a control character) is left out.
  for (const decision of [{ id: 'd2', options: [] }, { id: 'd3', options: ['a\u0007', 'b'] }, 'd4']) {
    const raw = { key: sid, session: sid, pane: 'w1:p1', workspace: 'w1', status: 'idle', name: 'atlas 12', decision }
    const bad = nodePart({ items: [raw] }, 'studio')?.items[0]
    expect(bad?.key).toBe(`@studio:${sid}`)
    expect(bad && 'decision' in bad).toBe(false)
  }
})
