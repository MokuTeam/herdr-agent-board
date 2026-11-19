// The owner's messages through a channel plugin (Telegram), as Claude Code writes them: a meta user
// line with origin { kind: 'channel' } and a <channel …> envelope. Shapes copied from a real
// transcript, every value made up.
import { expect, test } from 'bun:test'
import { attachedText, channelMessage } from '../../src/core/channel-message.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { channelEnvelope } from '../../src/core/prompt-filters.ts'
import { cleanPrompt, parseConversation, parseTranscriptTail, userText } from '../../src/core/transcript.ts'

const SERVER = 'plugin:tg:telegram'
const TS = '2026-11-19T07:58:01.174Z'
const AT = Date.parse(TS)

const envelope = (body: string, attrs = '') =>
  `<channel source="${SERVER}" message_id="744" user="owner" ts="2026-11-19T07:57:51.000Z"${attrs}>\n${body}\n</channel>`

const meta = (content: unknown, more: Record<string, unknown> = {}) =>
  JSON.stringify({
    parentUuid: 'p1',
    isSidechain: false,
    promptId: 'x1',
    type: 'user',
    isMeta: true,
    timestamp: TS,
    permissionMode: 'auto',
    origin: { kind: 'channel', server: SERVER },
    promptSource: 'system',
    queueSkipSlashCommands: true,
    turnOrigin: 'peer',
    turnPosition: { promptIndex: 12, turnIndex: 30 },
    queueSkipAttachments: true,
    uuid: 'u1',
    message: { role: 'user', content },
    ...more,
  })
const enqueue = (content: string) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: TS, content })
const typed = (text: string, ts = TS) =>
  JSON.stringify({ type: 'user', isSidechain: false, timestamp: ts, message: { role: 'user', content: text } })
const said = (text: string, ts = TS) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: ts,
    message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text }] },
  })
const queued = (prompt: string, origin: unknown) =>
  JSON.stringify({
    type: 'attachment',
    isSidechain: false,
    timestamp: TS,
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt, origin, timestamp: TS },
  })

const TEXT = envelope('Hello, please check the estimate.')
const VOICE = envelope(
  '🎤 Hello, please check the estimate.',
  ' file_id="AwACAgFAKE" file_kind="voice" transcribed="true"',
)
const PHOTO = envelope('', ' file_id="AgACFAKE" file_kind="photo"')

test('the envelope gives the text, the channel and what came with it', () => {
  expect(channelMessage(TEXT)).toEqual({ via: 'telegram', text: 'Hello, please check the estimate.', id: '744' })
  expect(channelMessage(VOICE)).toEqual({
    via: 'telegram',
    text: '🎤 Hello, please check the estimate.',
    id: '744',
    attached: 'voice',
    transcribed: true,
  })
  expect(channelMessage(PHOTO)).toEqual({ via: 'telegram', text: '', id: '744', attached: 'photo' })
  // Attributes in any order, escaped values, a file's name; the server names the channel without a source.
  expect(
    channelMessage('<channel file_name="a &amp; b.pdf" file_kind="document" in_reply_to="7">x</channel>', SERVER),
  ).toEqual({ via: 'telegram', text: 'x', id: '', attached: 'document', fileName: 'a & b.pdf' })
  expect(channelMessage('no envelope here')).toBeNull()
})

test('a file without text reads as attached, in the board language', () => {
  expect(attachedText({ attached: 'photo' }, translator('en'))).toBe('(photo attached)')
  expect(attachedText({ attached: 'photo' }, translator('ru'))).toBe('(фото во вложении)')
  expect(attachedText({ attached: 'gif', fileName: 'cat.gif' }, translator('en'))).toBe('(cat.gif attached)')
  expect(attachedText({}, translator('en'))).toBe('(file attached)')
})

test('the card line and the user text drop the envelope cleanly', () => {
  expect(cleanPrompt(TEXT)).toBe('Hello, please check the estimate.')
  expect(userText(VOICE)).toBe('🎤 Hello, please check the estimate.')
  expect(channelEnvelope('see <channel source="x">hi</channel> ok')).toBe('see hi ok')
  expect(channelEnvelope('plain text')).toBe('plain text')
})

test('a channel message is the owner’s turn in the conversation, the enqueue line not read', () => {
  const turns = parseConversation([enqueue(TEXT), meta(TEXT), said('Checking.')])
  expect(turns).toEqual([
    { role: 'user', text: 'Hello, please check the estimate.', at: AT, via: 'telegram' },
    { role: 'assistant', text: 'Checking.', at: AT },
  ])
  expect(parseConversation([meta(VOICE)])).toEqual([
    {
      role: 'user',
      text: '🎤 Hello, please check the estimate.',
      at: AT,
      via: 'telegram',
      attached: 'voice',
      transcribed: true,
    },
  ])
  // A photo without text is still a turn: the page says what came.
  expect(parseConversation([meta(PHOTO)])).toEqual([
    { role: 'user', text: '', at: AT, via: 'telegram', attached: 'photo' },
  ])
  // Content as text blocks reads the same.
  expect(parseConversation([meta([{ type: 'text', text: TEXT }])])[0]).toMatchObject({ role: 'user', via: 'telegram' })
})

test('queued into a running turn and sent again, a channel message shows once', () => {
  const origin = { kind: 'channel', server: SERVER }
  expect(parseConversation([queued(TEXT, origin), meta(TEXT)])).toHaveLength(1)
  // Without an id: once when the copy comes right after it.
  const bare = '<channel source="plugin:tg:telegram">same words</channel>'
  expect(parseConversation([queued(bare, origin), meta(bare)])).toHaveLength(1)
  // Two messages with their own ids are two.
  const other = TEXT.replace('message_id="744"', 'message_id="745"')
  expect(parseConversation([meta(TEXT), meta(other)])).toHaveLength(2)
})

test('every other meta line stays hidden, as before', () => {
  const hidden = [
    // An image's path for a prompt (turnCompanion) with no prompt to go to.
    meta('[Image: source: /tmp/x.png]', { origin: undefined, turnCompanion: true }),
    meta('[Image: source: /tmp/x.png]', { turnCompanion: true }),
    // No origin at all, a caveat, an envelope in a line of another kind.
    meta('<local-command-caveat>…</local-command-caveat>', { origin: undefined }),
    meta(TEXT, { origin: undefined }),
    meta(TEXT, { origin: { kind: 'hook', server: SERVER } }),
    meta(TEXT, { origin: { kind: 'system' } }),
    meta('Skill instructions', { origin: { kind: 'skill' } }),
    // Of kind channel, but no envelope in it: nothing to show.
    meta('just a note'),
  ]
  for (const l of hidden) {
    expect(parseConversation([l])).toEqual([])
    expect(parseTranscriptTail([l]).prompt).toBe('')
    expect(parseTranscriptTail([said('Done?'), l]).replied).toBe(false)
  }
  // A queued command of another kind reads as it did.
  expect(parseConversation([queued('typed while busy', { kind: 'human' })])).toEqual([
    { role: 'user', text: 'typed while busy', at: AT },
  ])
})

test('the card counts a channel message as the last prompt and as the answer', () => {
  const info = parseTranscriptTail([typed('older typed prompt'), said('Shall I go on?'), meta(VOICE)])
  expect(info.prompt).toBe('🎤 Hello, please check the estimate.')
  expect(info.replied).toBe(true)
  expect(parseTranscriptTail([meta(PHOTO)]).prompt).not.toBe('')
  // A prompt typed after it is the last one.
  expect(parseTranscriptTail([meta(TEXT), typed('typed later')]).prompt).toBe('')
  const withLast = [
    meta(TEXT),
    typed('typed later'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'typed later' }),
  ]
  expect(parseTranscriptTail(withLast).prompt).toBe('typed later')
  // A compaction's summary or a task reporting back after it is not a prompt typed after it.
  const summary = JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    timestamp: TS,
    message: { role: 'user', content: 'This session is being continued…' },
  })
  const task = JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    timestamp: TS,
    message: { role: 'user', content: 'Background task done' },
  })
  expect(parseTranscriptTail([meta(TEXT), summary, task]).prompt).toBe('Hello, please check the estimate.')
  // A session without channels: as before.
  expect(parseTranscriptTail([typed('hi'), said('Done?')]).replied).toBe(false)
})
