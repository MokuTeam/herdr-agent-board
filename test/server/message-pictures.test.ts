// The message route with files (server/routes/session.ts): a picture among them (Claude Code's own
// extensions) makes it a message with pictures. On the board's own server Claude then gets the
// board's Enter once the paste is over (services/paste.ts); on a PC, and for files that are not
// pictures, the calls are the ones they were.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { startOwnServer } from '../support/own-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')
const rule = '─'.repeat(40)
const EMPTY = [rule, '❯ ', rule, '  ? for shortcuts'].join('\n')
const PASTING = screen('claude-pasting')
const HELD = screen('claude-picture-in-box')

type Board = { stale: boolean; items: { session?: string | null }[] }

function claudeIn(box: Sandbox, screens: string[]): void {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'p', agent: 'claude', agent_session: { value: 'a' }, agent_status: 'idle' }],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent get': { result: { agent: { agent: 'claude', agent_session: { value: 'a' }, agent_status: 'idle' } } },
    'agent read': { seq: screens.map(text => ({ text })) },
    'agent prompt': { result: {} },
    'pane send-keys': { result: {} },
  })
}

/** POST a message to session `a` with `files` (names in today's uploads folder): its answer and herdr's calls for it. */
async function message(box: Sandbox, url: string, headers: Record<string, string>, files: string[], id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const board = (await (await fetch(`${url}/api/board`, { headers })).json()) as Board
    if (!board.stale && board.items[0]?.session === 'a') break
    await new Promise(r => setTimeout(r, 20))
  }
  const before = box.calls().length
  const uploads = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'uploads', '2026-10-31')
  const res = await fetch(`${url}/api/session/a/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
    body: JSON.stringify({ text: 'look', files: files.map(f => join(uploads, f)), session: 'a', requestId: id }),
  })
  const calls = box.calls().slice(before)
  return {
    result: (await res.json()) as Record<string, unknown>,
    prompts: calls.filter(c => c[1] === 'prompt').length,
    reads: calls.filter(c => c[1] === 'read').length,
    enters: calls.filter(c => c[1] === 'send-keys').length,
  }
}

test('on the board’s own server a picture among the files gets the board’s Enter; a PDF goes as before', async () => {
  const box = await sandbox()
  claudeIn(box, [EMPTY, PASTING, HELD, EMPTY])
  const { url } = await startOwnServer(box)
  const key = { 'x-board-key': readFileSync(join(stateFolder(box), 'local-key'), 'utf8').trim() }
  expect(await message(box, url, key, ['054431-screenshot-074431.png', 'notes.pdf'], 'r1')).toEqual({
    result: { ok: true },
    prompts: 1,
    reads: 5,
    enters: 1,
  })
  claudeIn(box, [EMPTY])
  expect(await message(box, url, key, ['notes.pdf'], 'r2')).toEqual({
    result: { ok: true },
    prompts: 1,
    reads: 1,
    enters: 0,
  })
}, 30_000)

test('a board on a PC sends a picture as before: one screen read, the prompt, no Enter of its own', async () => {
  const box = await sandbox()
  claudeIn(box, [EMPTY, PASTING, HELD])
  const { url } = await serveBoard(box, { language: 'en' })
  expect(await message(box, url, {}, ['054431-screenshot-074431.png'], 'r1')).toEqual({
    result: { ok: true },
    prompts: 1,
    reads: 1,
    enters: 0,
  })
}, 15_000)
