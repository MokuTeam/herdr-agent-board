// What a thread carries besides its messages comes whole too (#187): a message this session sent
// (SendMessage), a task's report, a MokuPilot call's results and the answers to a question form.
// The thread's budget (fitThread) counts them with the messages and cuts the longest of all of
// them to one length, and the turn it cut says so.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { boardNotice, CALL_NOTE } from '../../src/core/notices.ts'
import { type ConversationTurn, fitThread, parseConversation } from '../../src/core/transcript.ts'
import { notification } from '../support/task-notification.ts'

const line = (o: unknown) => JSON.stringify(o)
const QUESTION = 'Which file goes first?'
const SENT = `${'A long brief for the other session. '.repeat(300)}end` // 10,8xx characters
const ANSWER = `${'Start with the oldest file, then '.repeat(150)}stop` // 4,9xx characters
const REPORT = `## Verdict\n${'The change holds up under review. '.repeat(300)}Ship it.` // 9,9xx characters
const CALL = `# Call with anna\n${'A decision from the call. '.repeat(1000)}Done.` // 26,0xx characters

const lines = [
  line({ type: 'user', message: { content: 'go' } }),
  line({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'SendMessage',
          input: { to: 'atlas', summary: 'the brief', message: SENT },
        },
        {
          type: 'tool_use',
          id: 'q1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: QUESTION,
                header: 'Order',
                multiSelect: false,
                options: [
                  { label: 'Oldest', description: '' },
                  { label: 'Newest', description: '' },
                ],
              },
            ],
          },
        },
      ],
    },
  }),
  line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'sent' }] },
  }),
  line({
    type: 'user',
    toolUseResult: { answers: { [QUESTION]: ANSWER } },
    message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'answered' }] },
  }),
  line({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: { content: notification('Agent "Review the diff" finished', { tail: `<result>${REPORT}</result>` }) },
  }),
  line({ type: 'user', message: { content: `[mokupilot call report]\n${CALL}\n\n${CALL_NOTE}` } }),
]

const tool = (conv: ConversationTurn[], label: string) => conv.find(t => t.role === 'tool' && t.label === label)
const notices = (conv: ConversationTurn[]) => conv.filter(t => t.role === 'notice')
const detailOf = (t: ConversationTurn | undefined) => (t && 'detail' in t ? t.detail : '')

test('a sent message, an answer, a task report and a call report come whole', () => {
  const conv = parseConversation(lines)
  const send = tool(conv, 'SendMessage')
  assert.equal(send?.role === 'tool' && send.send?.text, SENT)
  const ask = tool(conv, 'AskUserQuestion')
  assert.deepEqual(ask?.role === 'tool' && ask.answers, [ANSWER])
  const [report, call] = notices(conv)
  assert.equal(detailOf(report), REPORT)
  assert.equal(detailOf(call), CALL)
  // Within the budget nothing is cut, and nothing says it was.
  const fitted = fitThread(conv)
  assert.equal(fitted, conv)
  assert.ok(!fitted.some(t => 'cut' in t))
})

test('the budget counts them with the messages and cuts the longest of all to one length', () => {
  const conv = parseConversation(lines)
  // The prompt, the answer, the report and the sent message each fit in their share of what is
  // left; the call's 26,0xx characters do not and get the rest.
  const fitted = fitThread(conv, 50_001)
  const [report, call] = notices(fitted)
  assert.equal(detailOf(report), REPORT)
  assert.ok(!('cut' in (report ?? {})))
  const cap = 50_001 - 'go'.length - SENT.length - ANSWER.length - REPORT.length
  assert.equal(detailOf(call).length, cap)
  assert.ok(detailOf(call).endsWith('…'))
  assert.equal(call && 'cut' in call && call.cut, true)
  const send = tool(fitted, 'SendMessage')
  assert.equal(send?.role === 'tool' && send.send?.text, SENT)
  assert.ok(!('cut' in (send ?? {})))
})

test('a sent message and an answer over their share are cut, and their turn says so', () => {
  const conv = parseConversation(lines)
  // 2 + four texts of 2,000 each.
  const fitted = fitThread(conv, 8002)
  const send = tool(fitted, 'SendMessage')
  const ask = tool(fitted, 'AskUserQuestion')
  assert.ok(send?.role === 'tool' && ask?.role === 'tool')
  assert.equal(send.send?.text.length, 2000)
  assert.equal(send.send?.to, 'atlas')
  assert.equal(send.cut, true)
  assert.equal(ask.answers?.[0]?.length, 2000)
  assert.equal(ask.cut, true)
  for (const n of notices(fitted)) {
    assert.equal(detailOf(n).length, 2000)
    assert.equal('cut' in n && n.cut, true)
  }
  // The user's short prompt stays whole; the conversation keeps its order and its other fields.
  assert.deepEqual(fitted[0], conv[0])
  assert.deepEqual(
    fitted.map(t => t.role),
    conv.map(t => t.role),
  )
})

test("codex and pi read a call's results through boardNotice: whole there too", () => {
  const n = boardNotice(`[mokupilot call report]\n${CALL}\n\n${CALL_NOTE}`)
  assert.equal(n && 'detail' in n ? n.detail : '', CALL)
})

test('a form of two questions: only the answer over the cap is cut, the short one stays whole', () => {
  const form: ConversationTurn = {
    role: 'tool',
    label: 'AskUserQuestion',
    detail: QUESTION,
    path: '',
    done: true,
    at: 0,
    ask: [
      { question: QUESTION, header: '', multiSelect: false },
      { question: 'And then?', header: '', multiSelect: false },
    ],
    answers: ['Oldest', ANSWER],
  }
  const [fitted] = fitThread([form], 1000)
  assert.ok(fitted?.role === 'tool')
  assert.equal(fitted.answers?.[0], 'Oldest')
  assert.equal(fitted.answers?.[1]?.length, 994)
  assert.ok(fitted.answers?.[1]?.endsWith('…'))
  assert.equal(fitted.cut, true)
  assert.deepEqual(fitted.ask, form.ask)
})

test('a form closed without an answer, a reminder and a compaction are left as they are', () => {
  const ask: ConversationTurn = {
    role: 'tool',
    label: 'AskUserQuestion',
    detail: QUESTION,
    path: '',
    done: true,
    at: 0,
    ask: [{ question: QUESTION, header: '', multiSelect: false }],
    answers: null,
  }
  const reminder: ConversationTurn = {
    role: 'notice',
    kind: 'reminder',
    status: 'event',
    name: 'r'.repeat(900),
    from: '',
    cron: '',
    note: '',
    at: 1,
  }
  const compact: ConversationTurn = {
    role: 'notice',
    kind: 'compact',
    status: 'event',
    name: '',
    note: '',
    detail: '',
    trigger: 'auto',
    pre: 1,
    post: 1,
    at: 2,
  }
  const long: ConversationTurn = { role: 'user', text: 'u'.repeat(500), at: 3 }
  const [a, r, c, u] = fitThread([ask, reminder, compact, long], 100)
  assert.equal(a, ask)
  assert.equal(r, reminder)
  assert.equal(c, compact)
  assert.ok(u && 'text' in u && u.text.length === 100 && 'cut' in u)
})
