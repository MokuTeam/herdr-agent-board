import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// Watches (#486) and the web board: the payload carries them only while config.json turns them on,
// the page can cancel one and change none, and nothing a phone, the tunnel or Team reaches makes one.
const HOUR = 3600e3
const watchesOf = (box: Sandbox) => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule/watches')

function putWatch(box: Sandbox, id: string): void {
  mkdirSync(watchesOf(box), { recursive: true })
  writeFileSync(
    join(watchesOf(box), `${id}.json`),
    JSON.stringify({
      id,
      key: 's1',
      name: 'anna',
      kind: 'watch',
      text: 'CI on PR 12',
      next: Date.now() + HOUR,
      created: Date.now(),
      probe: { cmd: 'gh pr checks 12', everyMs: 600_000, timeoutMs: 20_000 },
      claim: { pid: 1, at: 1 },
    }),
  )
}
const readWatch = (box: Sandbox, id: string) =>
  existsSync(join(watchesOf(box), `${id}.json`))
    ? JSON.parse(readFileSync(join(watchesOf(box), `${id}.json`), 'utf8'))
    : null

async function schedulesOf(url: string): Promise<Record<string, unknown>[]> {
  return ((await (await fetch(`${url}/api/board`)).json()) as { schedules: Record<string, unknown>[] }).schedules
}

test('the payload: no watch while watches are off, the watch without its claim while on', async () => {
  const off = await sandbox()
  putWatch(off, 'aaaaa1')
  assert.deepEqual(await schedulesOf((await serveBoard(off)).url), [])

  const on = await sandbox()
  putWatch(on, 'aaaaa1')
  const list = await schedulesOf((await serveBoard(on, { watches: true })).url)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.kind, 'watch')
  assert.deepEqual(list[0]?.probe, { cmd: 'gh pr checks 12', everyMs: 600_000, timeoutMs: 20_000 })
  assert.equal('claim' in (list[0] ?? {}), false)
})

test('the page cancels a watch and changes none: mode finds no entry under its id', async () => {
  const box = await sandbox()
  putWatch(box, 'bbbbb1')
  const before = readWatch(box, 'bbbbb1')
  const { url } = await serveBoard(box, { watches: true })
  const post = (body: unknown) =>
    fetch(`${url}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
  assert.equal((await post({ op: 'mode', id: 'bbbbb1', idle: true })).status, 404)
  assert.deepEqual(readWatch(box, 'bbbbb1'), before)
  assert.equal((await post({ op: 'cancel', id: 'bbbbb1' })).status, 200)
  assert.equal(readWatch(box, 'bbbbb1'), null)
})

/** Every .ts file under a folder of the repository. */
function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) out.push(relative(root, p).replace(/\\/g, '/'))
    }
  }
  walk(join(root, dir))
  return out
}

test('nothing a route, the phone, the tunnel or Team reaches makes or edits a watch: only the board command', () => {
  const files = [...sources('src'), ...sources('hub'), ...sources('web/src')]
  const using = (name: string) =>
    files.filter(f => new RegExp(`\\b${name}\\b`).test(readFileSync(join(root, f), 'utf8'))).sort()
  // addWatch: defined in the store, called by `board wait --probe` alone.
  assert.deepEqual(using('addWatch'), ['src/adapters/schedule-store.ts', 'src/entrypoints/watch-cli.ts'])
  // updateWatch: the store and the scheduler's probe pass (its bookkeeping, never the command).
  assert.deepEqual(using('updateWatch'), ['src/adapters/schedule-store.ts', 'src/services/watches.ts'])
})
