import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { scheduleDir } from '../../src/adapters/paths.ts'
import { addEntry, getEntry } from '../../src/adapters/schedule-store.ts'
import { createThread, getThread } from '../../src/adapters/work-thread-store.ts'
import { isolatedHome } from '../support/env.ts'
import { root } from '../support/sandbox.ts'

const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const S2 = '11111111-2222-3333-4444-555555555555'

async function cli(args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: root,
    env: { ...process.env, HERDR_PANE_ID: '', CLAUDE_CODE_SESSION_ID: '' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 20_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, out: `${out}${err}`.trim() }
}

test('board db rekey --dry-run, real run, idempotent repeat, reverse round-trip, and invalid arguments', async () => {
  const dir = isolatedHome()
  const configDir = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(configDir, { recursive: true })
  // Port 9 answers nothing: CLI never talks to a running board.
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ language: 'en', port: 9 }))

  const db = openDb({ create: true })
  if (!db) throw new Error('no db')
  const tid = db.write(
    'test',
    tx =>
      createThread(tx, {
        lane: 'atlas',
        title: 'CLI rekey',
        status: 'next',
        author: { kind: 'session', key: S1, name: 'Anna' },
        assignee: { kind: 'session', key: `@server-1:${S2}`, name: 'Ben' },
        at: 100,
      }).head.id,
  )
  db.close()

  const e = addEntry({ key: S1, name: 'Anna', text: 'check', at: 5000, next: 5000 })
  expect(existsSync(join(scheduleDir(), `${e.id}.json`))).toBe(true)

  // Invalid flags fail cleanly.
  expect((await cli(['db', 'rekey', '--from', 'local', '--to', 'server-1'])).code).toBe(1)
  expect((await cli(['db', 'rekey', '--from', 'laptop', '--to', 'laptop'])).code).toBe(1)
  expect((await cli(['db', 'rekey', '--from', 'laptop'])).code).toBe(1)
  expect((await cli(['db', 'rekey', '--from', 'laptop', '--to', 'server-1', '--bogus'])).code).toBe(1)

  // Dry run with --json changes nothing.
  const dry = await cli(['db', 'rekey', '--from', 'laptop', '--to', 'server-1', '--dry-run', '--json'])
  expect(dry.code, dry.out).toBe(0)
  const dryJson = JSON.parse(dry.out)
  expect(dryJson.dryRun).toBe(true)
  expect(dryJson.backup).toBeNull()
  expect(dryJson.db.total).toBe(4)
  expect(getEntry(e.id)?.key).toBe(S1)

  // Real run takes backup and rekeys both DB and schedule.
  const real = await cli(['db', 'rekey', '--from', 'laptop', '--to', 'server-1'])
  expect(real.code, real.out).toBe(0)
  expect(real.out).toContain('ok · rekeyed laptop -> server-1')
  expect(real.out).toContain('backup · ')
  expect(getEntry(e.id)?.key).toBe(`@laptop:${S1}`)

  const dbAfter = openDb({ create: false })
  expect(dbAfter && getThread(dbAfter, tid)?.createdBy).toEqual({ kind: 'session', key: `@laptop:${S1}`, name: 'Anna' })
  expect(dbAfter && getThread(dbAfter, tid)?.assignee).toEqual({ kind: 'session', key: S2, name: 'Ben' })
  dbAfter?.close()

  // Idempotent second run.
  const again = await cli(['db', 'rekey', '--from', 'laptop', '--to', 'server-1'])
  expect(again.code, again.out).toBe(0)
  expect(again.out).toBe('ok · already rekeyed from laptop to server-1 (0 changes)')

  // Reverse round-trip.
  const rev = await cli(['db', 'rekey', '--from', 'server-1', '--to', 'laptop', '--json'])
  expect(rev.code, rev.out).toBe(0)
  expect(JSON.parse(rev.out).already).toBe(false)
  expect(getEntry(e.id)?.key).toBe(S1)
}, 30_000)
