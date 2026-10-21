import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// `bun src/entrypoints/server.ts`: the web board alone, against the sandbox's fake herdr. Wake off:
// with it on (the default) the board would start wake's start and ask 127.0.0.1:12421.
function config(box: Sandbox, port: number): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', port, wakeUrl: null, refreshSec: 3600, wake: false }),
  )
}

function startServer(box: Sandbox) {
  return Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'server.ts')], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** Reads the stream until `text` shows up (or it ends); everything read so far. */
async function readUntil(stream: ReadableStream<Uint8Array>, text: string, timeout = 10_000): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeout
  let out = ''
  try {
    while (!out.includes(text) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

test('the web board alone: says where it listens, answers, and refuses a second one on the same port', async () => {
  const box = await sandbox()
  const port = await unusedPort()
  config(box, port)
  const first = startServer(box)
  try {
    const url = `http://127.0.0.1:${port}/`
    assert.equal((await readUntil(first.stdout, '\n')).trim(), `agent board: ${url}`)
    const res = await fetch(`${url}api/board`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(((await res.json()) as { items?: unknown }).items))

    const second = startServer(box)
    const [stdout, stderr] = await Promise.all([new Response(second.stdout).text(), new Response(second.stderr).text()])
    assert.equal(await second.exited, 1)
    assert.equal(stdout, '')
    assert.equal(stderr.trim(), 'agent board: the port is taken, another board already serves it')
  } finally {
    first.kill()
    await first.exited
  }
}, 20_000)
