// A message with a picture sent from the board while the session works (server/routes/session.ts):
// the message route keeps what it sent, and the session's detail gives the picture's path back to
// the thread, in its queue and once Claude took it into the running turn; the rest of the thread
// is as it was. The transcript is the owner's (Claude Code 2.1.308), moved to the test's time.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSessionDetail, type SessionDetail } from '../../web/src/api/client.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

const FIXTURE = readFileSync(new URL('../fixtures/queued-picture.jsonl', import.meta.url), 'utf8')
const rule = '─'.repeat(40)
const WORDS = 'кнопки «открыть его браузер» я не вижу'
const KEPT = `[Image #9]${WORDS}\nФайл:`

/** The board over session s1 working in pane p0; resolves once the board has it. */
async function board(box: Sandbox) {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'p0',
              agent: 'claude',
              agent_session: { value: 's1' },
              agent_status: 'working',
              cwd: 'C:\\w\\case',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent get': { result: { agent: { agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working' } } },
    'agent read': { text: [rule, '❯ ', rule, '  esc to interrupt'].join('\n') },
    'agent prompt': { result: {} },
  })
  const { url } = await serveBoard(box, { language: 'ru' })
  for (const deadline = Date.now() + 8000; ; ) {
    const b = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: unknown[] }
    if (!b.stale && b.items.length) break
    if (Date.now() > deadline) throw new Error('No board with the session')
    await Bun.sleep(20)
  }
  return url
}

/** s1's transcript: `lines`, every time of the picture's message moved to `at`. */
function transcript(box: Sandbox, lines: string, at: number): void {
  const claude = join(box.env.HOME ?? '', '.claude')
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(
    join(project, 's1.jsonl'),
    lines.replace(/2026-10-31T06:0[46]:\d\d\.\d{3}Z/g, new Date(at).toISOString()),
  )
  // A registry file that names this test's own process, which is alive, and says it is busy.
  writeFileSync(
    join(claude, 'sessions', 's1.json'),
    JSON.stringify({
      pid: process.pid,
      sessionId: 's1',
      kind: 'interactive',
      startedAt: at - 3_600_000,
      status: 'busy',
    }),
  )
}

async function detail(url: string): Promise<SessionDetail> {
  const d: unknown = await (await fetch(`${url}/api/session/s1`, { signal: AbortSignal.timeout(5000) })).json()
  if (!isSessionDetail(d)) throw new Error(`not a session's detail: ${JSON.stringify(d)}`)
  return d
}

async function post(url: string, files: string[]): Promise<unknown> {
  const res = await fetch(`${url}/api/session/s1/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ text: WORDS, files, session: 's1', requestId: 'r1' }),
  })
  return res.json()
}

const users = (d: SessionDetail) => d.conversation.flatMap(m => (m.role === 'user' ? [m.text] : []))

test('a picture sent while the session works: its path in the queue and in the thread, the other turns as they were', async () => {
  const box = await sandbox()
  // The board finds the session's transcript when it reads herdr: there before it, rewritten later.
  transcript(box, '', Date.now())
  const url = await board(box)
  const upload = join(box.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', 'agent-board', 'uploads', '2026-10-31')
  const picture = join(upload, '070429-screenshot-090429.png')
  expect(await post(url, [picture])).toEqual({ ok: true })
  const at = Date.now() + 1000
  const lines = FIXTURE.trim().split('\n')
  // Still in the queue: only its enqueue so far.
  transcript(box, `${lines.slice(0, 6).join('\n')}\n`, at)
  const waiting = await detail(url)
  expect(waiting.queued).toEqual([{ text: `${WORDS}\nФайл:\n${picture}`, at }])
  // Taken into the running turn: a queued command.
  transcript(box, `${lines.join('\n')}\n`, at)
  const taken = await detail(url)
  const thread = users(taken)
  expect(thread.at(-1)).toBe(`${WORDS}\nФайл:\n${picture}`)
  // The message sent while idle (its meta line named its file), the task's notice and the
  // text-only message sent while it worked.
  expect(thread.slice(0, -1)).toEqual([
    'нашел еще одну ошибку, когда открываешь браузер поле ввода улетает за экран и ничего не возможно печатать\nФайл:\n/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/055345-screenshot-075345.png',
    'спасибо',
  ])
  expect(taken.conversation.map(m => m.role)).toEqual(['user', 'notice', 'user', 'user'])
}, 20_000)

test('without a picture among the files nothing is kept, and the thread is as Claude Code keeps it', async () => {
  const box = await sandbox()
  transcript(box, '', Date.now())
  const url = await board(box)
  const upload = join(box.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', 'agent-board', 'uploads', '2026-10-31')
  expect(await post(url, [join(upload, 'notes.pdf')])).toEqual({ ok: true })
  transcript(box, FIXTURE, Date.now() + 1000)
  expect(users(await detail(url)).at(-1)).toBe(KEPT)
  expect(() =>
    readFileSync(join(box.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', 'agent-board', 'sent-pictures.json')),
  ).toThrow()
}, 20_000)
