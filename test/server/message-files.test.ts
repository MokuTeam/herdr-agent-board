// The files a message to a session carries (#401): only files the board took in its uploads, by
// real paths. A sibling folder whose name starts the same, a path that climbs out with `..`, or a
// link out of the uploads refuses the message with a 400 and types nothing; an upload goes as before.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

type Board = { items: { key?: string }[] }

describe('a message with files', () => {
  let box: Sandbox
  let base = ''
  let state = ''
  let uploads = ''
  let upload = ''
  const cleanups: (() => void | Promise<void>)[] = []

  beforeAll(async () => {
    box = await sandbox({ after: fn => void cleanups.push(fn) })
    box.state({
      'api snapshot': {
        result: {
          snapshot: { panes: [{ pane_id: 'p', agent: 'codex', agent_status: 'idle' }], tabs: [], workspaces: [] },
        },
      },
      'agent get': { result: { agent: { agent_status: 'idle' } } },
      'agent prompt': { result: {} },
    })
    state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
    uploads = join(state, 'uploads')
    mkdirSync(join(uploads, '2026-11-20'), { recursive: true })
    upload = join(uploads, '2026-11-20', 'notes.txt')
    writeFileSync(upload, 'anna')
    base = (await serveBoard(box)).url
    for (let i = 0; i < 250; i++) {
      const board = (await (await fetch(`${base}/api/board`)).json()) as Board
      if (board.items[0]?.key === 'pane-p') return
      await new Promise(r => setTimeout(r, 20))
    }
    throw Error('No fixture board')
  })
  afterAll(async () => {
    for (const fn of cleanups) await fn()
  })

  const prompts = () => box.calls().filter(a => a[1] === 'prompt')
  async function send(files: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(`${base}/api/session/pane-p/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ text: 'hi', session: null, files }),
    })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }
  async function refused(files: string[]): Promise<void> {
    const before = prompts().length
    const r = await send(files)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'file' })
    expect(prompts().length).toBe(before)
  }
  async function typed(files: string[]): Promise<void> {
    const before = prompts().length
    const r = await send(files)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(prompts().slice(before)).toEqual([
      ['agent', 'prompt', 'p', `hi\n\n${files.length === 1 ? 'File' : 'Files'}:\n${files.join('\n')}`],
    ])
  }

  test('an upload goes as its path, as before, a name with spaces, another alphabet and % too', async () => {
    await typed([upload])
    const odd = join(uploads, '2026-11-20', 'заметки 100% ben.png')
    writeFileSync(odd, 'ben')
    await typed([upload, odd])
  })

  test('a sibling folder whose name starts like the uploads is refused, and so is the whole message', async () => {
    const other = join(`${uploads}-other`, 'x.txt')
    mkdirSync(join(`${uploads}-other`), { recursive: true })
    writeFileSync(other, 'ben')
    await refused([other])
    await refused([upload, other])
  })

  test('a path that climbs out of the uploads with .. is refused', async () => {
    writeFileSync(join(state, 'secret.txt'), 'cleo')
    await refused([join(uploads, '..', 'secret.txt')])
    await refused([`${uploads}/../secret.txt`])
  })

  test('a junction or link inside the uploads that points out of them is refused', async () => {
    const outside = join(box.dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'atlas.txt'), 'atlas')
    symlinkSync(outside, join(uploads, 'out'), 'junction')
    await refused([join(uploads, 'out', 'atlas.txt')])
  })

  test('the uploads folder itself, a file not there, or a relative path is refused', async () => {
    await refused([uploads])
    await refused([join(uploads, '2026-11-20', 'missing.txt')])
    await refused(['relative/notes.txt'])
  })

  test.if(process.platform === 'win32')(
    'on Windows: another case and forward slashes still name the upload',
    async () => {
      await typed([upload.toUpperCase()])
      await typed([upload.replaceAll('\\', '/')])
    },
  )

  test.if(process.platform === 'win32')('on Windows: a UNC path is refused', async () => {
    await refused([`\\\\localhost\\${upload.replace(':', '$')}`])
  })
})
