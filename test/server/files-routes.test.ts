import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

type StatItem = { exists: boolean; dir?: boolean; kind?: string; line: number | null }

test('file API: stat, preview, raw bytes behind the token with ranges, and refusals', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { error: 'offline' } })
  const files = join(box.dir, 'files')
  mkdirSync(files)
  writeFileSync(join(files, 'pic.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  writeFileSync(join(files, 'note.txt'), 'hello')
  const { url } = await serveBoard(box)
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const stat = (await (
    await post('/api/fs/stat', { cwd: files, paths: ['note.txt:3', 'pic.png', 'missing.md', files] })
  ).json()) as { items: StatItem[] }
  assert.deepEqual(
    stat.items.map(i => [i.exists, i.dir ?? null, i.kind ?? null, i.line]),
    [
      [true, false, 'text', 3],
      [true, false, 'image', null],
      [false, null, null, null],
      [true, true, 'dir', null],
    ],
  )
  assert.equal((await post('/api/fs/stat', { paths: [] }, {})).status, 403)

  const note = (await (await post('/api/fs/preview', { path: join(files, 'note.txt') })).json()) as { text: string }
  assert.equal(note.text, 'hello')

  const board = (await (await fetch(`${url}/api/board`)).json()) as { fsToken: string }
  assert.ok(board.fsToken)
  const raw = (token: string) =>
    fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${token}`)
  assert.equal((await raw('wrong')).status, 403)
  const ok = await raw(board.fsToken)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(Buffer.from(await ok.arrayBuffer()).length, 16)
  const part = await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${board.fsToken}`, {
    headers: { range: 'bytes=4-7' },
  })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 4-7/16')
  assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [0x0d, 0x0a, 0x1a, 0x0a])
  // Text files never come raw: no page of theirs runs on this origin.
  assert.equal(
    (await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'note.txt'))}&t=${board.fsToken}`)).status,
    404,
  )

  assert.equal((await post('/api/open-url', { url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post('/api/fs/open', { path: join(files, 'nope.txt') })).status, 404)
}, 20_000)
