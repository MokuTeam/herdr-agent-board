// A question form Claude Code holds back from the transcript (auto and plan mode, 2.1.303), as the
// board's PreToolUse hook reported it: core/held-question.ts.

import { describe, expect, test } from 'bun:test'
import { answeredIn, heldQuestionOf, waitingTool } from '../../src/core/held-question.ts'
import { parseTranscriptTail } from '../../src/core/transcript.ts'
import type { HeldQuestion, ToolCall } from '../../src/core/types.ts'

const INPUT = {
  questions: [
    {
      question: 'Archive the 13 finished sessions?',
      header: 'Cleanup',
      multiSelect: false,
      options: [
        { label: 'Archive the 13 (Recommended)', description: 'Their tabs close; the board can bring any back.' },
        { label: 'Let me pick', description: 'Tell me which ones to keep.' },
      ],
    },
  ],
}
const T0 = Date.parse('2026-10-21T08:53:38.887Z') // the denied Bash call's result: the transcript's last line
const AT = Date.parse('2026-10-21T08:53:44.700Z') // the hook's report, as the dialog opened
const held: HeldQuestion = {
  id: 'toolu_01Ks',
  detail: 'Archive the 13 finished sessions?',
  questions: [{ ...INPUT.questions[0], preview: false }] as HeldQuestion['questions'],
  at: AT,
}

const line = (o: Record<string, unknown>): string => JSON.stringify(o)
const bash = (id: string, at: string) =>
  line({
    type: 'assistant',
    timestamp: at,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'board ask "x"' } }] },
  })
const result = (id: string, at: string) =>
  line({
    type: 'user',
    timestamp: at,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'denied' }] },
  })
const ask = (id: string, at: string) =>
  line({
    type: 'assistant',
    timestamp: at,
    message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: INPUT }] },
  })
// What the transcript has while the dialog is open in auto mode: the call before it, nothing after.
const beforeAsk = [bash('toolu_bash', '2026-10-21T08:53:33.724Z'), result('toolu_bash', '2026-10-21T08:53:38.887Z')]

describe('the transcript', () => {
  test('lastAt: the time of the newest user or assistant line, sidechains and other lines aside', () => {
    expect(parseTranscriptTail(beforeAsk).lastAt).toBe(T0)
    const side = line({ type: 'user', isSidechain: true, timestamp: '2026-10-21T09:00:00.000Z', message: {} })
    const title = line({ type: 'ai-title', aiTitle: 'Cleanup' })
    expect(parseTranscriptTail([...beforeAsk, side, title]).lastAt).toBe(T0)
    expect(parseTranscriptTail([title]).lastAt).toBeUndefined()
  })
})

describe('the hook', () => {
  test("an AskUserQuestion call: its id, first question and form; any other tool's, nothing", () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: INPUT,
      tool_use_id: 'toolu_01Ks',
    }
    expect(heldQuestionOf(input, AT)).toEqual(held)
    expect(heldQuestionOf({ ...input, tool_name: 'Bash' }, AT)).toBeNull()
    expect(heldQuestionOf({ ...input, tool_use_id: undefined }, AT)).toBeNull()
    expect(heldQuestionOf(null, AT)).toBeNull()
    // One the board cannot answer: its question for the card, no form.
    const odd = heldQuestionOf({ ...input, tool_input: { questions: [{ question: 'Which?', options: [] }] } }, AT)
    expect(odd).toEqual({ id: 'toolu_01Ks', detail: 'Which?', questions: null, at: AT })
  })
})

describe('the call a session waits on', () => {
  const info = parseTranscriptTail(beforeAsk)

  test('blocked, the transcript a step behind: the reported question, as the transcript would have it', () => {
    const tool = waitingTool('blocked', info, held)
    const fromTranscript = parseTranscriptTail([...beforeAsk, ask('toolu_01Ks', '2026-10-21T08:53:44.667Z')]).tool
    expect(tool).toEqual({ ...(fromTranscript as ToolCall), reported: AT })
    expect(tool?.questions).toEqual(held.questions)
  })

  test('the transcript has the call (any mode but auto and plan): the transcript, as before', () => {
    const written = parseTranscriptTail([...beforeAsk, ask('toolu_01Ks', '2026-10-21T08:53:44.667Z')])
    expect(waitingTool('blocked', written, held)).toBe(written.tool as ToolCall)
    // Another question of its own pending: that one.
    const other = parseTranscriptTail([...beforeAsk, ask('toolu_02', '2026-10-21T08:55:00.000Z')])
    expect(waitingTool('blocked', other, { ...held, at: Date.parse('2026-10-21T08:56:00.000Z') })).toBe(
      other.tool as ToolCall,
    )
  })

  test('not blocked, an old report, or no report: the transcript, as before', () => {
    for (const status of ['working', 'idle', 'done', 'unknown', ''])
      expect(waitingTool(status, info, held)).toBe(info.tool as ToolCall)
    // Answered by now: what came after it is in the transcript, the call itself too.
    const answered = parseTranscriptTail([
      ...beforeAsk,
      ask('toolu_01Ks', '2026-10-21T08:53:44.667Z'),
      result('toolu_01Ks', '2026-10-21T08:57:53.973Z'),
    ])
    expect(waitingTool('blocked', answered, held)?.pending).toBe(false)
    // Left behind by a process that ended while it asked: the transcript went on without it.
    const later = parseTranscriptTail([...beforeAsk, bash('toolu_later', '2026-10-21T09:30:00.000Z')])
    expect(waitingTool('blocked', later, held)).toBe(later.tool as ToolCall)
    expect(waitingTool('blocked', info, { ...held, at: T0 })).toBe(info.tool as ToolCall)
    for (const card of [
      undefined,
      null,
      'text',
      {},
      { ...held, id: '' },
      { ...held, at: 'now' },
      { ...held, questions: 5 },
    ])
      expect(waitingTool('blocked', info, card)).toBe(info.tool as ToolCall)
    expect(waitingTool('blocked', null, undefined)).toBeNull()
  })

  test('no transcript to read: the reported question', () => {
    expect(waitingTool('blocked', null, held)?.id).toBe('toolu_01Ks')
    expect(waitingTool('blocked', {}, held)?.questions).toEqual(held.questions)
  })
})

describe('answered', () => {
  test("a call the transcript had: its result, or a later call, as the answer route's check did", () => {
    const written = parseTranscriptTail([...beforeAsk, ask('toolu_01Ks', '2026-10-21T08:53:44.667Z')])
    const tool = written.tool as ToolCall
    expect(answeredIn(written, tool)).toBe(false)
    expect(
      answeredIn(
        parseTranscriptTail([
          ...beforeAsk,
          ask('toolu_01Ks', '2026-10-21T08:53:44.667Z'),
          result('toolu_01Ks', '2026-10-21T08:57:53.973Z'),
        ]),
        tool,
      ),
    ).toBe(true)
    expect(answeredIn(parseTranscriptTail([bash('toolu_next', '2026-10-21T08:58:00.000Z')]), tool)).toBe(true)
    expect(answeredIn(null, tool)).toBe(false)
  })

  test('a held call: once Claude Code writes it with its answer, not while the transcript is a step behind', () => {
    const tool = waitingTool('blocked', parseTranscriptTail(beforeAsk), held) as ToolCall
    expect(answeredIn(parseTranscriptTail(beforeAsk), tool)).toBe(false)
    // Written without its answer (a hook can make Claude Code write it early): not yet.
    expect(answeredIn(parseTranscriptTail([...beforeAsk, ask('toolu_01Ks', '2026-10-21T08:53:44.667Z')]), tool)).toBe(
      false,
    )
    const done = [
      ...beforeAsk,
      ask('toolu_01Ks', '2026-10-21T08:53:44.667Z'),
      result('toolu_01Ks', '2026-10-21T08:57:53.973Z'),
    ]
    expect(answeredIn(parseTranscriptTail(done), tool)).toBe(true)
    expect(answeredIn(parseTranscriptTail([...done, bash('toolu_next', '2026-10-21T08:58:00.000Z')]), tool)).toBe(true)
  })
})
