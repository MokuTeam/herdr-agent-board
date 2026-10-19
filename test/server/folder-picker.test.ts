import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { sandbox, until } from '../support/sandbox.ts'

async function unusedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise(resolve => server.close(resolve))
  return port
}

type Listing = { entries?: string[]; dir?: boolean; exists?: boolean; roots?: unknown[] }

test('the folder picker lists folders only, and the drives to start from', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const port = await unusedPort()
  const proc = box.run('server', {
    port,
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  const url = `http://127.0.0.1:${port}`
  const dirs = async (path: string) =>
    (await (
      await fetch(`${url}/api/fs/dirs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ path }),
      })
    ).json()) as Listing
  for (const d of ['b-dir', 'A-dir', '.hidden']) mkdirSync(join(box.dir, 'pick', d), { recursive: true })
  writeFileSync(join(box.dir, 'pick', 'file.txt'), 'x')
  const r = await dirs(join(box.dir, 'pick'))
  assert.deepEqual(r.entries, ['.hidden', 'A-dir', 'b-dir'])
  assert.equal(r.dir, true)
  assert.equal((await dirs(join(box.dir, 'pick', 'file.txt'))).dir, false)
  assert.equal((await dirs(join(box.dir, 'nope'))).exists, false)
  const roots = await dirs('')
  assert.ok((roots.roots?.length ?? 0) >= 2)
  assert.equal((await fetch(`${url}/api/fs/dirs`, { method: 'POST', body: '{}' })).status, 403)
}, 20_000)
