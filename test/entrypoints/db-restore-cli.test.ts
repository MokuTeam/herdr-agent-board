// `board db restore` as the owner runs it (#233, entrypoints/cli.ts dbCmd): the newest snapshot
// that opens is restored, and each newer one passed over is named with why, so the hours it held
// are known to be missing from what came back.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOLDER_NAME, writeKey } from '../../src/adapters/backup-store.ts'
import { openDb } from '../../src/adapters/db.ts'
import { snapshotName } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { backupNow } from '../../src/services/backup.ts'
import { isolatedHome } from '../support/env.ts'
import { root } from '../support/sandbox.ts'

function cli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], {
      cwd: root,
      env: { ...process.env, HERDR_PANE_ID: '', CLAUDE_CODE_SESSION_ID: '' },
    })
    let out = ''
    proc.stdout.on('data', c => {
      out += c
    })
    proc.stderr.on('data', c => {
      out += c
    })
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board db restore names each newer snapshot it passed over, and why', async () => {
  const dir = isolatedHome()
  const db = openDb()
  assert.ok(db)
  db.write('user', tx => tx.journal({ store: 'test', op: 'add', ref: 'kept' }))
  db.close()
  assert.ok((await writeKey(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 }))).ok)
  const folder = join(dir, 'Sync')
  mkdirSync(folder)
  const configDir = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(configDir, { recursive: true })
  // port 9 answers nothing: the command never reaches a live board
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, backup: { folder } }))
  const good = (await backupNow({ cfg: { backup: { folder } } })).sent[0]?.name as string
  const damaged = readFileSync(join(folder, FOLDER_NAME, good))
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 1
  const newer = snapshotName(Date.now() + 60_000, 'aaaaaaaa')
  writeFileSync(join(folder, FOLDER_NAME, newer), damaged)
  const r = await cli(['db', 'restore', '--target', 'folder'])
  assert.equal(r.code, 0, r.out)
  const lines = r.out.split(/\r?\n/)
  assert.deepEqual(lines.slice(0, 1), [
    `passed over ${newer}: The snapshot is damaged: it does not open with the board’s own key.`,
  ])
  assert.match(lines.at(-1) ?? '', new RegExp(`^ok · restored folder/${good}; `))
}, 30_000)

test('a restore that takes nothing still names what it passed over, then why it stopped', async () => {
  const dir = isolatedHome()
  const db = openDb()
  assert.ok(db)
  db.write('user', tx => tx.journal({ store: 'test', op: 'add', ref: 'kept' }))
  db.close()
  assert.ok((await writeKey(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 }))).ok)
  const folder = join(dir, 'Sync')
  mkdirSync(folder)
  const configDir = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, backup: { folder } }))
  const good = (await backupNow({ cfg: { backup: { folder } } })).sent[0]?.name as string
  const damaged = readFileSync(join(folder, FOLDER_NAME, good))
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 1
  writeFileSync(join(folder, FOLDER_NAME, good), damaged)
  const r = await cli(['db', 'restore', '--target', 'folder'])
  assert.equal(r.code, 1)
  const lines = r.out.split(/\r?\n/)
  assert.equal(lines[0], `passed over ${good}: The snapshot is damaged: it does not open with the board’s own key.`)
  assert.match(lines.at(-1) ?? '', /^board: The snapshot is damaged/)
}, 30_000)
