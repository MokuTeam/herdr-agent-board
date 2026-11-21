// Case files (#488): board wait, board done and board sleep --self say so when a case the session
// holds has a state behind its work; with case files off the line is what it was. The board command
// runs as a child against the sandbox's fake herdr.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function config(box: Sandbox, extra: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  // port 9 and a wake there answer nothing: the live board and wake are never reached.
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', port: 9, wakeUrl: 'http://127.0.0.1:9', ...extra }),
  )
}

async function board(box: Sandbox, args: string[], env: Record<string, string> = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

test('board wait and done: the nudge for a case with no state, gone once the state is written; off, the line as it was', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  config(box, { threads: { cases: true } })
  const made = await board(box, ['thread', 'new', '--lane', 'atlas', '--ref', 'ABC-12', '--to', SID, 'Import mapping'])
  assert.match(made.out, /^ok · atlas-1 · doing/)
  const me = { CLAUDE_CODE_SESSION_ID: SID }
  const waited = await board(box, ['wait', 'the client'], me)
  assert.equal(waited.code, 0, waited.out)
  assert.match(
    waited.out,
    / · atlas-1: no state yet: board thread post atlas-1 --state "<where it stands, what next, what it waits on>"$/,
  )
  await board(box, ['thread', 'post', 'atlas-1', '--state', 'Waits on the client.'], me)
  const done = await board(box, ['done', 'handed over'], me)
  assert.equal(done.code, 0, done.out)
  assert.doesNotMatch(done.out, /atlas-1/)
  // Off: the same commands print what they printed before case files.
  config(box, { threads: true })
  const plain = await board(box, ['wait', 'the client'], me)
  assert.equal(plain.code, 0, plain.out)
  assert.doesNotMatch(plain.out, /state|atlas-1/)
  assert.equal(plain.out, 'ok · category: not set · waiting: the client · done: handed over')
  assert.equal(waited.out.replace(/ · atlas-1: no state yet: .*$/, ''), 'ok · category: not set · waiting: the client')
})
