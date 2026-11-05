// Settings → Backup… through the board's server (#233, server/routes/backup.ts): the view, the
// passphrase and the folder, the board's header required; and a board with no database and no
// backup target sends nothing new in its payload and makes no database.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

const json = async (res: Response) => (await res.json()) as Record<string, unknown>

test('a board without a database or a backup target: no backup in its payload, and no database made', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  const board = await json(await fetch(`${url}/api/board`))
  assert.equal('backup' in board, false)
  const view = await json(await fetch(`${url}/api/backup`))
  assert.equal(view.needed, false)
  assert.deepEqual(view.problems, [])
  assert.equal(existsSync(join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'board.db')), false)
})

test('the passphrase and the folder are set through the panel; a bad folder is refused with its reason', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  const post = (body: Record<string, unknown>, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  // without the board's header a page of another site cannot change it
  assert.notEqual((await post({ op: 'folder', folder: box.dir }, {})).status, 200)

  const short = await post({ op: 'passphrase', passphrase: 'short', again: 'short' })
  assert.equal(short.status, 400)
  assert.match(String((await json(short)).error), /10 characters/)
  const differs = await post({ op: 'passphrase', passphrase: 'correct horse battery', again: 'correct horse batterY' })
  assert.match(String((await json(differs)).error), /differ/)
  const set = await json(
    await post({ op: 'passphrase', passphrase: 'correct horse battery', again: 'correct horse battery' }),
  )
  assert.equal(set.ok, true)
  assert.ok((set.view as { key: unknown }).key)

  const missing = await post({ op: 'folder', folder: join(box.dir, 'nowhere') })
  assert.equal(missing.status, 400)
  assert.match(String((await json(missing)).error), /There is no folder/)
  const folder = join(box.dir, 'OneDrive')
  mkdirSync(folder)
  const ok = await json(await post({ op: 'folder', folder }))
  assert.equal(ok.ok, true)
  assert.equal((ok.view as { config: { folder: string } }).config.folder, folder)
  // Back up now with no database: nothing written to the folder
  await post({ op: 'now' })
  assert.deepEqual(readdirSync(folder), [])
}, 20_000)

test('a board with a backup target carries the backup’s line in its payload; nothing to back up is no problem', async () => {
  const box = await sandbox()
  const folder = join(box.dir, 'OneDrive')
  mkdirSync(folder)
  const { url } = await serveBoard(box, { language: 'en', backup: { folder } })
  const board = await json(await fetch(`${url}/api/board`))
  assert.deepEqual(board.backup, { last: null, problem: null })
})

test('a server that takes snapshots keeps its address: a change or a removal says Undo first; its admin login may change', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  const post = (body: Record<string, unknown>) =>
    fetch(`${url}/api/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
  const configFile = join(box.dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  const server = { host: 'example.org', port: 22, admin: { user: 'me', key: '' }, set: '2026-10-29T03:00:00Z' }
  mkdirSync(join(configFile, '..'), { recursive: true })
  writeFileSync(configFile, JSON.stringify({ language: 'en', backup: { server } }))
  for (const body of [
    { op: 'server', host: 'other.example.org', port: 22, adminUser: 'me', adminKey: '' },
    { op: 'server', remove: true },
  ]) {
    const res = await post(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(String((await json(res)).error), /Undo first/)
  }
  // the same address with another admin login (a key moved) is taken: Look, Apply and Undo need it right
  assert.equal(
    (await post({ op: 'server', host: 'example.org', port: 22, adminUser: 'root', adminKey: 'C:/keys/new' })).status,
    200,
  )
})
