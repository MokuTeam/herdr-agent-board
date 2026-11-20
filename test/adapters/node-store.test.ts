// The masters a node answers to (adapters/node-store.ts): masters.json, a list, mode 0600, the
// token's SHA-256 only. Two stores on one folder stand for the board's process and a shell's
// `board node forget`: a master forgotten in either ends the other's watch.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeStore, masterName } from '../../src/adapters/node-store.ts'

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'node-store-'))
  return dir
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('masters.json', () => {
  test('a list: two masters with a token each, each token its own master; only the hashes are kept', () => {
    const dir = folder()
    try {
      let now = 1_795_000_000_000
      const store = createNodeStore({ dir, now: () => now })
      const a = store.add('laptop', 'hand')
      now += 1000
      const b = store.add('standby', 'hand')
      expect(a.token).toMatch(/^[\w-]{43}$/)
      expect(b.token).not.toBe(a.token)
      expect(store.verify(a.token)?.id).toBe(a.master.id)
      expect(store.verify(b.token)?.id).toBe(b.master.id)
      expect(store.verify(`${a.token.slice(0, -1)}${a.token.endsWith('A') ? 'B' : 'A'}`)).toBeNull()
      expect(store.verify('')).toBeNull()
      const text = readFileSync(join(dir, 'masters.json'), 'utf8')
      expect(text).not.toContain(a.token)
      expect(text).not.toContain(b.token)
      const list = JSON.parse(text) as unknown[]
      expect(list).toEqual([
        {
          id: a.master.id,
          name: 'laptop',
          tokenHash: sha(a.token),
          pairedAt: 1_795_000_000_000,
          seenAt: expect.any(Number),
          via: 'hand',
        },
        {
          id: b.master.id,
          name: 'standby',
          tokenHash: sha(b.token),
          pairedAt: 1_795_000_001_000,
          seenAt: expect.any(Number),
          via: 'hand',
        },
      ])
      if (process.platform !== 'win32') expect(statSync(join(dir, 'masters.json')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('when a master was last seen goes to the file at most once a minute', () => {
    const dir = folder()
    try {
      let now = 1_795_000_000_000
      const store = createNodeStore({ dir, now: () => now })
      const { master, token } = store.add('laptop', 'hand')
      expect(store.list()[0]?.seenAt).toBeNull()
      store.verify(token)
      expect(store.list()[0]?.seenAt).toBe(now)
      const first = now
      now += 30_000
      store.verify(token)
      expect(store.list()[0]?.seenAt).toBe(first)
      now += 31_000
      store.verify(token)
      expect(store.list().find(m => m.id === master.id)?.seenAt).toBe(now)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('forget: that token stops at once, the other keeps working; an unknown id is false', () => {
    const dir = folder()
    try {
      const store = createNodeStore({ dir })
      const a = store.add('laptop', 'hand')
      const b = store.add('standby', 'hand')
      expect(store.forget(a.master.id)).toBe(true)
      expect(store.verify(a.token)).toBeNull()
      expect(store.verify(b.token)?.id).toBe(b.master.id)
      expect(store.forget(a.master.id)).toBe(false)
      expect(store.list().map(m => m.id)).toEqual([b.master.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a file that does not parse is no revocation: reads throw, nothing writes over it', () => {
    const dir = folder()
    try {
      const store = createNodeStore({ dir })
      const { master, token } = store.add('laptop', 'hand')
      const path = join(dir, 'masters.json')
      for (const bad of [JSON.stringify({ tokenHash: sha(token) }), '[{"id":"x","tokenHash":"zz"}]', '{ half']) {
        writeFileSync(path, bad)
        expect(() => store.verify(token)).toThrow('masters.json is not a list of masters')
        expect(() => store.list()).toThrow('masters.json is not a list of masters')
        expect(() => store.add('other', 'hand')).toThrow('masters.json is not a list of masters')
        expect(() => store.forget(master.id)).toThrow('masters.json is not a list of masters')
        expect(readFileSync(path, 'utf8')).toBe(bad)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no file is no master; forgetting one that is not there writes nothing', () => {
    const dir = folder()
    try {
      const store = createNodeStore({ dir })
      expect(store.list()).toEqual([])
      expect(store.verify('A'.repeat(43))).toBeNull()
      expect(store.forget('abc')).toBe(false)
      expect(existsSync(join(dir, 'masters.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a master's name: trimmed, printable, at most 64", () => {
    expect(masterName(' laptop ')).toBe('laptop')
    expect(masterName('Ноутбук дома')).not.toBeNull()
    expect(masterName('')).toBeNull()
    expect(masterName('  ')).toBeNull()
    expect(masterName('a'.repeat(65))).toBeNull()
    expect(masterName('bad\u0007name')).toBeNull()
    expect(masterName(42)).toBeNull()
  })
})

describe('watch', () => {
  test("forgotten in this process: its watchers are told at once, the other master's are not", () => {
    const dir = folder()
    try {
      const store = createNodeStore({ dir })
      const a = store.add('laptop', 'hand')
      const b = store.add('standby', 'hand')
      const told: string[] = []
      const unwatchA = store.watch(a.master.id, () => told.push('a'))
      const unwatchB = store.watch(b.master.id, () => told.push('b'))
      store.forget(a.master.id)
      expect(told).toEqual(['a'])
      unwatchA()
      unwatchB()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('forgotten by another process (a shell): told within the paced poll, and the poll stops after', async () => {
    const dir = folder()
    try {
      const board = createNodeStore({ dir, pollMs: 20 })
      const shell = createNodeStore({ dir })
      const a = board.add('laptop', 'hand')
      const b = board.add('standby', 'hand')
      const told: string[] = []
      board.watch(a.master.id, () => told.push('a'))
      const unwatchB = board.watch(b.master.id, () => told.push('b'))
      shell.forget(a.master.id)
      const deadline = Date.now() + 2000
      while (!told.length && Date.now() < deadline) await Bun.sleep(10)
      expect(told).toEqual(['a'])
      await Bun.sleep(100)
      expect(told).toEqual(['a'])
      unwatchB()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a file that does not parse for a while ends no stream; the master forgotten after it does', async () => {
    const dir = folder()
    try {
      const board = createNodeStore({ dir, pollMs: 20 })
      const a = board.add('laptop', 'hand')
      const path = join(dir, 'masters.json')
      const good = readFileSync(path, 'utf8')
      const told: string[] = []
      const unwatch = board.watch(a.master.id, () => told.push('a'))
      writeFileSync(path, '{ half')
      await Bun.sleep(150)
      expect(told).toEqual([])
      writeFileSync(path, good)
      await Bun.sleep(100)
      expect(told).toEqual([])
      createNodeStore({ dir }).forget(a.master.id)
      const deadline = Date.now() + 2000
      while (!told.length && Date.now() < deadline) await Bun.sleep(10)
      expect(told).toEqual(['a'])
      unwatch()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
