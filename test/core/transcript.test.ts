import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROMPT_FILTERS, telegramEnvelope } from '../../src/core/prompt-filters.ts'
import {
  type ConversationTurn,
  cleanPrompt,
  fitThread,
  parseConversation,
  parseTranscriptTail,
  saidIn,
  toolDetail,
  toolLabel,
  toolPath,
  trailingQuestion,
  userText,
} from '../../src/core/transcript.ts'
import { line as entry, jsonl, type Line, T0 } from '../support/helper-fixtures.ts'

test('prompts are cleaned for one line', () => {
  assert.equal(cleanPrompt('[telegram message_id=5 ts=1] hi\nhow is it going'), 'hi how is it going')
  assert.equal(cleanPrompt('❯ ready to test'), 'ready to test')
  assert.equal(cleanPrompt('<command-name>/x</command-name> go'), '/x go')
})

test('telegramEnvelope strips a leading envelope only', () => {
  assert.equal(telegramEnvelope('[Telegram message_id=5 ts=1] hi'), 'hi')
  assert.equal(telegramEnvelope('hi [telegram x] there'), 'hi [telegram x] there')
  assert.deepEqual(DEFAULT_PROMPT_FILTERS, [telegramEnvelope])
})

test('without filters the envelope stays; userText takes the same seam', () => {
  assert.equal(cleanPrompt('[telegram id=1] hi', []), '[telegram id=1] hi')
  assert.equal(userText('[telegram id=1] hi', []), '[telegram id=1] hi')
  assert.equal(userText('[telegram id=1] hi'), 'hi')
  assert.equal(userText([{ type: 'text', text: '<system-reminder>x</system-reminder>go' }]), 'go')
})

test('pasted text shows without the pasted_content tags around it', () => {
  assert.equal(
    userText(
      '[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond line\n</pasted_content id="7952">\n\nplain one',
    ),
    '[Image #1]\n\nFirst line\nSecond line\n\nplain one',
  )
  assert.equal(userText('<pasted_content id="3cf7">\nonly this\n</pasted_content id="3cf7">'), 'only this')
  // Only the tags Claude Code puts there: a message that names the tag keeps it.
  assert.equal(userText('write <pasted_content> as a tag'), 'write <pasted_content> as a tag')
})

test('tool labels and details read like a sentence', () => {
  assert.equal(toolLabel('mcp__plugin_slack_slack__slack_read_channel'), 'slack · read_channel')
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Gmail · search_threads')
  assert.equal(toolLabel('Bash'), 'Bash')
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests')
  assert.equal(toolDetail('Bash', { command: '\n  git status\nmore' }), 'git status')
  assert.equal(toolDetail('Edit', { file_path: 'C:/Work/x/y/notes.md' }), 'notes.md')
  assert.equal(toolDetail('SendMessage', { to: 'uds:.pipeLOCALcc-msg-1' }), '→ another session')
  assert.equal(toolDetail('mcp__x__y', { query: 'invoice 42' }), 'invoice 42')
  assert.equal(toolPath('Read', { file_path: 'C:/a/b.csv' }), 'C:/a/b.csv')
  assert.equal(toolPath('Bash', { command: 'x' }), '')
})

const line = (o: unknown) => JSON.stringify(o)

test('transcript tail: title, last prompt, last words, pending tool; sidechains ignored', () => {
  const lines = [
    line({ type: 'ai-title', aiTitle: 'Receipt import' }),
    line({ type: 'last-prompt', lastPrompt: '[telegram message_id=1] load the receipts' }),
    line({ type: 'user', message: { content: 'load the receipts' } }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Checking the file.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/checks.csv' } },
        ],
      },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    line({
      type: 'assistant',
      message: {
        model: 'claude-x',
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 150000,
          output_tokens: 90,
        },
        content: [
          { type: 'text', text: 'The file is fine, asking.' },
          {
            type: 'tool_use',
            id: 't2',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Import 10/23?' }] },
          },
        ],
      },
    }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    // Sent while it worked: absorbed into the turn, kept as a queued command.
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: 'also the 10/24 file',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: '2026-10-15T21:50:13.839Z',
      },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<cross-session-message from="x">hi</cross-session-message>',
        commandMode: 'prompt',
        origin: { kind: 'peer' },
      },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<task-notification>done</task-notification>',
        commandMode: 'task-notification',
      },
    }),
  ]
  const info = parseTranscriptTail(lines)
  assert.equal(info.title, 'Receipt import')
  assert.equal(info.prompt, 'load the receipts')
  assert.equal(info.lastText, 'The file is fine, asking.')
  assert.equal(info.context, 153012) // what the last request carried, cache included; output not
  // No options: a form the board cannot answer, so no questions for it.
  assert.deepEqual(info.tool, {
    id: 't2',
    name: 'AskUserQuestion',
    label: 'AskUserQuestion',
    detail: 'Import 10/23?',
    pending: true,
    questions: null,
  })

  const conv = parseConversation(lines)
  // Another session's message is its own line, with who sent it, not the user's bubble.
  assert.deepEqual(
    conv.map(c => c.role),
    ['user', 'assistant', 'tool', 'assistant', 'tool', 'user', 'peer'],
  )
  const [, , read, , ask, queued, peer] = conv
  assert.equal(read?.role === 'tool' && read.done, true)
  assert.equal(ask?.role === 'tool' && ask.done, false)
  assert.equal(queued?.role === 'user' && queued.text, 'also the 10/24 file')
  assert.equal(queued?.at, Date.parse('2026-10-15T21:50:13.839Z'))
  assert.equal(peer?.role === 'peer' && peer.text, 'hi')
  assert.ok(!conv.some(c => 'text' in c && c.text === 'subagent noise'))
  assert.equal(parseConversation(lines, 2).length, 2)
})

test('updates kept as thinking (thinkingDisplay "updates") are said like any message; other thinking is not', () => {
  const lines = [
    line({ type: 'user', message: { content: 'is the sandbox free? then merge' } }),
    // As Claude Code 2.1.296+ writes them: an empty thinking block, then the update in one of its own.
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] },
    }),
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'The sandbox is free again. Starting with the first merge.\n\n',
            signature: 'x',
          },
        ],
      },
    }),
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr merge 1' } }] },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    // Older versions: thinking the terminal keeps folded away.
    line({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'x' }] },
    }),
  ]
  const conv = parseConversation(lines)
  assert.deepEqual(
    conv.map(c => c.role),
    ['user', 'assistant', 'tool'],
  )
  const said = conv[1]
  assert.equal(said?.role === 'assistant' && said.text, 'The sandbox is free again. Starting with the first merge.')
  assert.equal(parseTranscriptTail(lines).lastText, 'The sandbox is free again. Starting with the first merge.')
  assert.equal(saidIn({ thinkingDisplay: 'updates' }, { type: 'text', text: ' hi ' }), 'hi')
  assert.equal(saidIn({}, { type: 'thinking', thinking: 'hidden' }), '')
})

test('a message ending in a question: its last sentence or two, markup ignored', () => {
  assert.equal(trailingQuestion('The draft is ready. Send it?'), 'The draft is ready. Send it?')
  assert.equal(trailingQuestion('Done.\n\n**OK or edit?**'), 'OK or edit?')
  assert.equal(trailingQuestion('Done. Nothing needed.'), '')
  assert.equal(trailingQuestion('Code:\n```js\nif (a?) b\n```\nThat is all.'), '')
  assert.equal(trailingQuestion('Options:\n1. A\n2. B\n\nWhich one?'), 'Which one?')
  assert.equal(trailingQuestion('Готово. Отправлять?'), 'Готово. Отправлять?') // any script
})

test('the session thread: a call that works with others is a line of its own', () => {
  const main = (o: Line, sc = false): Line => ({ ...o, isSidechain: sc })
  const peerFrom = { kind: 'peer', from: 'uds:\\\\.\\pipe\\x1', name: 'Billing-master', msg_id: 'm1', body: 'Thanks.' }
  const lines = [
    main(entry.user(0, 'Go.')),
    main(
      entry.call(1, 'ag', 'Agent', {
        description: 'Review the diff',
        subagent_type: 'code-reviewer',
        run_in_background: true,
      }),
    ),
    main(
      entry.result(
        2,
        'ag',
        'Async agent launched successfully.\nagentId: a7f3 (internal ID - do not mention to user.)',
        {
          toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a7f3' },
        },
      ),
    ),
    main(entry.call(3, 'fk', 'Agent', { description: 'Audit a', subagent_type: 'fork', name: 'audit-a' })),
    main(
      entry.call(4, 'wf', 'Workflow', {
        script: "export const meta = {\n  name: 'polish-audit',\n  description: 'x' }",
      }),
    ),
    main(entry.result(5, 'wf', 'Workflow launched in background.', { toolUseResult: { runId: 'wf_9', taskId: 'w9' } })),
    main(
      entry.call(6, 'sm', 'SendMessage', {
        to: 'Billing-master [3fa9c1]',
        summary: 'Hours for today',
        message: 'All in.',
      }),
    ),
    main(entry.call(7, 'sp', 'Bash', { command: "spawn-agent -Name 'case-42' -Cwd C:\\work\\x -Brief 'go'" })),
    main(entry.result(8, 'sp', 'pane=wP:p3D name=case-42 agent=case-42')),
    main(entry.call(9, 'sp2', 'PowerShell', { command: 'spawn-agent -Name broken -Cwd nowhere' })),
    main(
      entry.result(10, 'sp2', 'No such folder: nowhere', {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'sp2', content: 'No such folder', is_error: true }],
        },
      }),
    ),
    // Another session's message: a meta line with the sender in its origin; then a reply to its pipe.
    main(
      entry.user(
        11,
        'Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\x1" from-name="Billing-master">Thanks.</cross-session-message>',
        { isMeta: true, origin: peerFrom },
      ),
    ),
    main({
      type: 'attachment',
      timestamp: new Date(T0 + 12000).toISOString(),
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'dup', origin: peerFrom },
    }),
    main(
      entry.call(13, 'rp', 'SendMessage', { to: 'uds:\\\\.\\pipe\\x1', summary: 'Reply', message: 'You are welcome.' }),
    ),
    main(entry.user(14, '<teammate-message teammate_id="design-check" summary="Done">It is sound.</teammate-message>')),
    // The user asking about the tag is the user, not a teammate.
    main(entry.user(14.5, 'Why does <teammate-message teammate_id="x">hi</teammate-message> render as a bubble?')),
    main(entry.said(15, 'subagent noise'), true),
  ]
  const conv = parseConversation(jsonl(lines).split('\n'))
  const tool = (id: string) => {
    const m = conv.find(c => c.role === 'tool' && c.id === id)
    if (m?.role !== 'tool') throw new Error(`no call ${id}`)
    return m
  }
  assert.deepEqual(tool('ag').helper, { kind: 'agent', type: 'code-reviewer', name: '', background: true, id: 'a7f3' })
  assert.deepEqual(tool('fk').helper, { kind: 'fork', type: '', name: 'audit-a', background: false, id: '' })
  assert.deepEqual(tool('wf').workflow, { name: 'polish-audit', run: 'wf_9' })
  assert.deepEqual(tool('sm').send, { to: 'Billing-master', summary: 'Hours for today', text: 'All in.' })
  assert.deepEqual(tool('sp').spawn, { name: 'case-42', pane: 'wP:p3D' })
  assert.equal(tool('sp2').spawn?.failed, true)
  const peers = conv.filter(m => m.role === 'peer')
  assert.deepEqual(
    peers.map(p => [p.from, p.text]),
    [
      ['Billing-master', 'Thanks.'],
      ['design-check', 'It is sound.'],
    ],
  ) // once, not twice
  assert.equal(peers[0]?.pipe, 'uds:\\\\.\\pipe\\x1') // the server turns it into the session's key
  assert.equal(peers[1]?.team, true)
  assert.equal(tool('rp').send?.name, 'Billing-master') // a reply to a pipe: whoever wrote from it
  assert.ok(conv.some(m => m.role === 'user' && m.text.startsWith('Why does <teammate-message')))
  assert.ok(!conv.some(m => 'text' in m && m.text === 'subagent noise'))
})

test("a helper's own transcript: its lines are sidechain lines, a fork's work begins with its directive", () => {
  const lines = [
    entry.call(10, 'toolu_b', 'Agent', { subagent_type: 'fork', description: "the parent's call" }),
    entry.user(11, [
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Fork started' },
      { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Count.' },
    ]),
    entry.call(12, 'g1', 'Glob', { pattern: '*' }),
    entry.user(13, '[Workflow harness — user request] The harness relays...:\n  polish it'),
  ]
  const conv = parseConversation(jsonl(lines).split('\n'), 40, { sidechain: true })
  assert.deepEqual(
    conv.map(m => (m.role === 'user' ? m.text : m.role)),
    ['Count.', 'tool'],
  )
  assert.deepEqual(parseConversation(jsonl(lines).split('\n')), [])
})

test('images sent with a message: their paths back under it from the meta line that names them', () => {
  const upload = 'C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-20\\'
  const at = '2026-10-20T10:45:14.374Z'
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  // As Claude Code 2.1.303 keeps a message the board typed with two images under "Files:".
  const sent = {
    type: 'user',
    promptId: 'p1',
    imagePasteIds: [16, 17],
    timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text: '[Image #16] [Image #17]see these\nFiles:' }, png, png] },
  }
  const sources = {
    type: 'user',
    promptId: 'p1',
    isMeta: true,
    turnCompanion: true,
    timestamp: at,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: `[Image: source: ${upload}a.png]` },
        { type: 'text', text: `[Image: source: ${upload}b.png]` },
      ],
    },
  }
  const reminder = { type: 'attachment', attachment: { type: 'total_tokens_reminder', text: 'x' }, timestamp: at }
  const thread = (lines: object[]) => parseConversation(lines.map(l => JSON.stringify(l)))
  assert.deepEqual(thread([sent, reminder, sources]), [
    { role: 'user', text: `see these\nFiles:\n${upload}a.png\n${upload}b.png`, at: Date.parse(at) },
  ])
  // Without the meta line, or with one of another prompt, the message is as Claude Code keeps it.
  const kept = { role: 'user', text: '[Image #16] [Image #17]see these\nFiles:', at: Date.parse(at) }
  assert.deepEqual(thread([sent]), [kept])
  assert.deepEqual(thread([sent, { ...sources, promptId: 'p2' }]), [kept])
  // A pasted screenshot Claude Code names no file for keeps its mark.
  const clipboard = {
    ...sent,
    imagePasteIds: [3],
    message: { role: 'user', content: [{ type: 'text', text: '[Image #3] look' }, png] },
  }
  assert.deepEqual(thread([clipboard, { ...sources, message: { role: 'user', content: [] } }]), [
    { role: 'user', text: '[Image #3] look', at: Date.parse(at) },
  ])
})

test('a thread over its budget cuts only its longest messages, all to one length; one within it is left as it is', () => {
  const turn = (role: 'user' | 'assistant', n: number): ConversationTurn => ({ role, text: 'x'.repeat(n), at: n })
  const tool: ConversationTurn = { role: 'tool', label: 'Read', detail: 'a.ts', path: 'a.ts', done: true, at: 0 }
  const within = [turn('user', 60), tool, turn('assistant', 40)]
  assert.equal(fitThread(within, 100), within)
  const sizes = (turns: ConversationTurn[]) => turns.map(t => ('text' in t ? t.text.length : t.role))
  // One pasted log: the others stay whole, the log gets what is left.
  const log = fitThread([turn('user', 10), tool, turn('user', 5000), turn('assistant', 20)], 100)
  assert.deepEqual(sizes(log), [10, 'tool', 70, 20])
  assert.ok(log[2] && 'text' in log[2] && log[2].text.endsWith('…'))
  assert.equal(log[1], tool)
  // Two long ones share what is left alike.
  assert.deepEqual(sizes(fitThread([turn('user', 10), turn('assistant', 300), turn('user', 900)], 100)), [10, 45, 45])
})
