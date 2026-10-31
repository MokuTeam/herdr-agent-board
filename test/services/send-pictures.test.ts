// A message with pictures (send's `pictures`, from the message route) to Claude on the board's own
// server: Claude Code drops the Enter that comes while it reads a pasted picture, so the board gives
// it once the paste is over, and answers once the message is out of the box (services/paste.ts). A
// board on a PC, a message without pictures and an agent other than Claude make the calls they made
// before, and nothing more.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sandbox } from '../support/sandbox.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')
const rule = '─'.repeat(40)
const EMPTY = [rule, '❯ ', rule, '  ? for shortcuts'].join('\n')
const PASTING = screen('claude-pasting')
const HELD = screen('claude-picture-in-box')
const agent = (session = 'expected', kind = 'claude') => ({
  result: { agent: { agent: kind, agent_status: 'idle', agent_session: { value: session } } },
})
const item = { pane: 'pane1', session: 'expected', agent: 'claude', name: 'Test' }
const SERVER = {
  language: 'en',
  serverMode: { domain: 'board.example.com', socket: '/var/lib/agent-board/board.sock' },
}
const PC = { language: 'en' }
const UPLOAD = '/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/054431-screenshot-074431.png'
const MESSAGE = `the browser icon looks broken on the tablet\n\nFiles:\n${UPLOAD}`

const get = ['agent', 'get', 'pane1']
const read = ['agent', 'read', 'pane1', '--source', 'visible', '--ansi']
const prompt = (text: string) => ['agent', 'prompt', 'pane1', text]
const enter = ['pane', 'send-keys', 'pane1', 'enter']

async function sendWith(
  cfg: Record<string, unknown>,
  screens: string[],
  { text = MESSAGE, pictures = true, it = item, kind = 'claude' } = {},
) {
  const box = await sandbox()
  box.state({
    'agent get': agent(it.session ?? 'expected', kind),
    'agent read': { seq: screens.map(text => ({ text })) },
    'agent prompt': { result: {} },
    'pane send-keys': { result: {} },
  })
  const out = await box.run('send', { item: it, cfg, text, options: { pictures } }).exited
  expect(out.code).toBe(0)
  return { result: JSON.parse(out.stdout) as Record<string, unknown>, calls: box.calls() }
}

test('on the board’s own server: the Enter once the picture is in the box, and only then the answer', async () => {
  const { result, calls } = await sendWith(SERVER, [EMPTY, PASTING, PASTING, HELD, EMPTY])
  expect(result).toEqual({ ok: true })
  expect(calls).toEqual([get, read, get, prompt(MESSAGE), read, read, read, enter, read, read])
})

test('on the board’s own server, the paste over before the first look: no Enter of the board’s', async () => {
  const { result, calls } = await sendWith(SERVER, [EMPTY])
  expect(result).toEqual({ ok: true })
  expect(calls).toEqual([get, read, get, prompt(MESSAGE), read, read])
})

test('on the board’s own server, sent again with the message still in the box: its Enter, not a second copy', async () => {
  for (const before of [HELD, PASTING]) {
    const { result, calls } = await sendWith(SERVER, [before, HELD, EMPTY])
    expect(result).toEqual({ ok: true })
    expect(calls.some(c => c[1] === 'prompt')).toBe(false)
    expect(calls.filter(c => c[1] === 'send-keys')).toEqual([enter])
  }
})

test('on the board’s own server, the user’s own text with a picture in the box: the message is typed after it', async () => {
  const own = [rule, '❯ [Image #2]my own words in the terminal', rule, '  ? for shortcuts'].join('\n')
  const { result, calls } = await sendWith(SERVER, [own, PASTING, HELD, EMPTY])
  expect(result).toEqual({ ok: true })
  expect(calls).toEqual([get, read, get, prompt(MESSAGE), read, read, enter, read, read])
})

// What a board on a PC sends: its uploads under %LOCALAPPDATA% (a user name with a space, other
// alphabets, %), a pasted screenshot's name, a picture picked from storage, files alone.
const PC_MESSAGES = [
  MESSAGE,
  'посмотри на снимок 100%\n\nФайл:\nC:\\Users\\Team Work\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-31\\074431-screenshot-074431.png',
  'Files:\nC:\\Users\\Team Work\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-31\\081500-IMG-0001.jpeg',
]

for (const text of PC_MESSAGES)
  test(`a board on a PC sends a message with pictures as before (${JSON.stringify(text.slice(0, 24))})`, async () => {
    for (const pictures of [true, false]) {
      // The screen after the prompt would show a paste being read: a PC board never looks.
      const { result, calls } = await sendWith(PC, [EMPTY, PASTING, HELD], { text, pictures })
      expect(result).toEqual({ ok: true })
      expect(calls).toEqual([get, read, get, prompt(text)])
    }
  })

test('on the board’s own server, a message without pictures goes as before', async () => {
  const text = 'Files:\n/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/notes.pdf'
  for (const message of ['hello', '-hello', text]) {
    const { result, calls } = await sendWith(SERVER, [EMPTY, PASTING, HELD], { text: message, pictures: false })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([get, read, get, prompt(message.startsWith('-') ? ` ${message}` : message)])
  }
})

for (const [kind, session] of [
  ['pi', 'C:\\Team Work\\сессия 100%.jsonl'],
  ['codex', 'session-2'],
] as const)
  test(`on the board’s own server, pictures to ${kind} go as before: no screen read, no Enter`, async () => {
    const { result, calls } = await sendWith(SERVER, [PASTING, HELD], {
      it: { ...item, agent: kind, session },
      kind,
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([get, prompt(MESSAGE)])
  })
