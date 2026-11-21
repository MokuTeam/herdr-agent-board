// The master's per-device records (adapters/node-store.ts createDeviceStore, #499): the token a
// node gave it, whole or not at all, mode 0600 on POSIX, never in an error; ids that are not one
// leave no path outside the folder.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceStore } from '../../src/adapters/node-store.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'

test('a token stored and read back; a bad one refused without its value; none is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-nodes-'))
  const store = createDeviceStore({ dir })
  expect(store.token('server-1')).toBeNull()
  store.setToken('server-1', TOKEN)
  expect(store.token('server-1')).toBe(TOKEN)
  const file = join(dir, 'server-1', 'token')
  expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  for (const bad of ['', 'short', `${TOKEN} ${TOKEN}`, 'ünïcödé'.repeat(8)]) {
    let said = ''
    try {
      store.setToken('server-1', bad)
    } catch (err) {
      said = (err as Error).message
    }
    expect(said).toContain('not a token')
    if (bad) expect(said).not.toContain(bad)
  }
  expect(store.token('server-1')).toBe(TOKEN)
  writeFileSync(file, 'garbage here\n')
  expect(store.token('server-1')).toBeNull()
})

test('only device ids make paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-nodes-'))
  const store = createDeviceStore({ dir })
  for (const id of ['..', '../x', 'Server', 'a/b', 'a\\b', ''])
    expect(() => store.setToken(id, TOKEN)).toThrow('not a device id')
  expect(store.token('..')).toBeNull()
  expect(existsSync(join(dir, '..', 'token'))).toBe(false)
  expect(store.keyPath('server-1')).toBe(join(dir, 'server-1', 'link-key'))
  expect(store.pidFile('server-1')).toBe(join(dir, 'server-1', 'ssh-pid.json'))
})
