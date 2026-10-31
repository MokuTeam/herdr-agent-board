// The secrets on disk (adapters/secret-store.ts): sealed with a key of their own, 0600 in a 0700
// folder, never a value in a file but the session's own in memory; nothing made until one is set.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../../src/adapters/paths.ts'
import {
  hasSecretStore,
  listSecrets,
  markUsed,
  removeSecret,
  secretKeyFile,
  secretRunDir,
  secretStoreFile,
  secretsDir,
  secretsFor,
  secretUsedFile,
  setSecret,
  writeSessionEnv,
  writeSessionFile,
} from '../../src/adapters/secret-store.ts'
import { isolatedHome } from '../support/env.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const VALUE = 's3cr3t-MARKER-ключ'
const POSIX = process.platform !== 'win32'
const mode = (p: string): number => statSync(p).mode & 0o777

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return ''
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => readFileSync(join(e.parentPath, e.name), 'utf8'))
    .join('\n')
}

test('nothing is made or read until a secret is set', () => {
  isolatedHome()
  expect(hasSecretStore()).toBe(false)
  expect(listSecrets()).toEqual([])
  expect(secretsFor({ profile: 'work', session: SID })).toEqual([])
  expect(removeSecret('global::A')).toBe(false)
  markUsed([], SID, 'env')
  expect(existsSync(secretsDir())).toBe(false)
})

test('set: sealed in store.json, key apart, both 0600 in a 0700 folder under the state folder; no value on disk', () => {
  const dir = isolatedHome()
  const meta = setSecret({ scope: 'global', target: null }, 'TOGGL_API_TOKEN', VALUE, { now: 1000 })
  expect(meta).toEqual({
    id: 'global::TOGGL_API_TOKEN',
    name: 'TOGGL_API_TOKEN',
    scope: 'global',
    target: null,
    setAt: 1000,
  })
  expect(secretsDir()).toBe(join(stateDir(), 'secrets'))
  expect(hasSecretStore()).toBe(true)
  if (POSIX) {
    expect(mode(secretsDir())).toBe(0o700)
    expect(mode(secretStoreFile())).toBe(0o600)
    expect(mode(secretKeyFile())).toBe(0o600)
  }
  expect(JSON.stringify(meta)).not.toContain(VALUE)
  // Not in the store, not under the board's folders at all, not as base64 either.
  for (const text of [allText(dir), Buffer.from(allText(dir)).toString()]) {
    expect(text).not.toContain(VALUE)
    expect(text).not.toContain(Buffer.from(VALUE).toString('base64'))
  }
  expect(secretsFor({ profile: null, session: null })).toEqual([{ id: meta.id, name: 'TOGGL_API_TOKEN', value: VALUE }])
})

test('scopes: each session gets its own, by the order of scopes; replace keeps one entry; remove takes it out', () => {
  isolatedHome()
  setSecret({ scope: 'global', target: null }, 'A', 'g')
  setSecret({ scope: 'profile', target: 'work' }, 'A', 'p')
  setSecret({ scope: 'session', target: SID }, 'A', 's', { targetName: 'Slack bot' })
  setSecret({ scope: 'profile', target: 'work' }, 'B', 'b1')
  setSecret({ scope: 'profile', target: 'work' }, 'B', 'b2')
  const values = (profile: string | null, session: string | null) =>
    secretsFor({ profile, session }).map(s => `${s.name}=${s.value}`)
  expect(values('work', SID)).toEqual(['A=s', 'B=b2'])
  expect(values('work', null)).toEqual(['A=p', 'B=b2'])
  expect(values('default', 'other')).toEqual(['A=g'])
  const list = listSecrets()
  expect(list.map(s => s.id)).toEqual(['global::A', 'profile:work:A', `session:${SID}:A`, 'profile:work:B'])
  expect(list[2]?.targetName).toBe('Slack bot')
  expect(JSON.stringify(list)).not.toMatch(/"(g|p|s|b1|b2)"/)
  expect(removeSecret(`session:${SID}:A`)).toBe(true)
  expect(removeSecret(`session:${SID}:A`)).toBe(false)
  expect(values('work', SID)).toEqual(['A=p', 'B=b2'])
  // The store stays, empty, once the last one goes.
  for (const s of listSecrets()) removeSecret(s.id)
  expect(hasSecretStore()).toBe(true)
  expect(listSecrets()).toEqual([])
})

test('a value moved to another entry, or sealed with another key, does not open: it is left out', () => {
  isolatedHome()
  setSecret({ scope: 'global', target: null }, 'A', 'one')
  setSecret({ scope: 'global', target: null }, 'B', 'two')
  const store = JSON.parse(readFileSync(secretStoreFile(), 'utf8'))
  // B's name on A's sealed value.
  store.entries[1] = { ...store.entries[0], name: 'B' }
  writeFileSync(secretStoreFile(), JSON.stringify(store))
  expect(secretsFor({ profile: null, session: null })).toEqual([{ id: 'global::A', name: 'A', value: 'one' }])
  writeFileSync(secretKeyFile(), `${Buffer.alloc(32, 7).toString('base64')}\n`)
  expect(secretsFor({ profile: null, session: null })).toEqual([])
})

test('last used: when, which session and how, without the value; a value set anew starts unused', () => {
  isolatedHome()
  setSecret({ scope: 'global', target: null }, 'A', VALUE, { now: 1 })
  markUsed(['global::A'], SID, 'get', 5000)
  expect(listSecrets()[0]).toMatchObject({ usedAt: 5000, usedBy: SID, usedHow: 'get' })
  if (POSIX) expect(mode(secretUsedFile())).toBe(0o600)
  expect(readFileSync(secretUsedFile(), 'utf8')).not.toContain(VALUE)
  setSecret({ scope: 'global', target: null }, 'A', 'new', { now: 6000 })
  expect(listSecrets()[0]?.usedAt).toBeUndefined()
})

test("a session's env.sh and files: in $XDG_RUNTIME_DIR, 0600 in 0700 folders; without it, this user's temp folder", async () => {
  const dir = isolatedHome()
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const env = { XDG_RUNTIME_DIR: run }
  const file = writeSessionEnv(SID, [{ id: 'global::A', name: 'A', value: "it's" }], env)
  expect(file).toBe(join(run, 'agent-board', 'secrets', SID, 'env.sh'))
  expect(readFileSync(file, 'utf8')).toBe(`export A='it'"'"'s'\n`)
  const one = writeSessionFile(SID, { id: 'global::A', name: 'A', value: VALUE }, env)
  expect(readFileSync(one, 'utf8')).toBe(VALUE)
  if (POSIX) {
    for (const f of [file, one]) expect(mode(f)).toBe(0o600)
    for (const d of [
      join(run, 'agent-board'),
      join(run, 'agent-board', 'secrets'),
      join(run, 'agent-board', 'secrets', SID),
    ])
      expect(mode(d)).toBe(0o700)
  }
  // Emptied when a session has none any more.
  writeSessionEnv(SID, [], env)
  expect(readFileSync(file, 'utf8')).toBe('')
  // A pi session's key (a file's path) is a hashed folder name.
  const pi = writeSessionEnv('/home/me/.pi/agent/sessions/a b.jsonl', [], env)
  expect(pi).toMatch(/[\\/]secrets[\\/][0-9a-f]{32}[\\/]env\.sh$/)
  expect(secretRunDir({})).toContain('agent-board-')
  if (POSIX) {
    // A link planted in the run folder's place is refused.
    const other = join(dir, 'run2')
    mkdirSync(join(dir, 'elsewhere'))
    mkdirSync(other, { mode: 0o700 })
    symlinkSync(join(dir, 'elsewhere'), join(other, 'agent-board'))
    expect(() => writeSessionEnv(SID, [], { XDG_RUNTIME_DIR: other })).toThrow()
  }
})
