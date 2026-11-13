// Threads in the board's payload (#379): nothing while they are off (no `threads`, no database made
// for them); on, the threads revision and how many wait on the owner, moving when a `board thread`
// command writes while the board runs. The threads themselves never ride in the payload.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Party } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const board = async (url: string) => (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>

/** `board thread …` in this process with the sandbox's folders, as a session runs it. */
async function thread(box: Sandbox, args: string[]): Promise<void> {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  const actor: Party = { kind: 'session', key: 's1', name: 'atlas-mapper' }
  try {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads: true },
      actor,
      lane: 'atlas',
      findSession: async () => null,
      out: l => out.push(l),
      err: l => out.push(l),
    })
    assert.equal(code, 0, out.join('\n'))
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

test('threads off: no threads in the payload, no database made for them', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const { url } = await serveBoard(box, { language: 'en', wakeUrl: wake.url })
    const payload = await board(url)
    assert.equal('threads' in payload, false)
    assert.equal(existsSync(join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'board.db')), false)
  } finally {
    wake.down()
  }
})

test('threads on: the revision and the count that waits on the owner, read again as the store moves', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const { url, proc } = await serveBoard(box, { language: 'en', wakeUrl: wake.url, threads: true })
    assert.deepEqual((await board(url)).threads, { rev: 0, needsOwner: 0 })
    assert.equal(existsSync(join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'board.db')), false)
    await thread(box, ['new', 'Pick the price list'])
    await thread(box, ['ask', 'atlas-1', 'Which price list wins?'])
    // The board reads it again at its next refresh, as it does every few seconds. A refresh asked for
    // while the start's own one runs answers before it publishes: ask until the line has moved.
    await until(async () => {
      proc.send('refresh')
      await Bun.sleep(100)
      return ((await board(url)).threads as { needsOwner?: number } | undefined)?.needsOwner === 1
    })
    const line = (await board(url)).threads as { rev: number; needsOwner: number }
    assert.equal(line.needsOwner, 1)
    assert.ok(line.rev > 0)
    assert.equal(JSON.stringify(await board(url)).includes('Which price list wins'), false)
  } finally {
    wake.down()
  }
})
