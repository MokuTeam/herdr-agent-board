// The Claude homes of several profile folders (adapters/profile-homes.ts): one per folder, and
// what is read across them.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A profile folder whose registry has these files (sessions/<file>). */
function homeWith(sessions: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'board-profile-homes-'))
  made.push(root)
  mkdirSync(join(root, 'sessions'))
  mkdirSync(join(root, 'projects'))
  for (const [file, s] of Object.entries(sessions)) writeFileSync(join(root, 'sessions', file), JSON.stringify(s))
  return root
}

test('running sessions of every profile, each with its home; one home per folder', () => {
  const A = homeWith({ '1.json': { sessionId: 'sa', kind: 'interactive', pid: process.pid, name: 'A one' } })
  const B = homeWith({ '2.json': { sessionId: 'sb', kind: 'interactive', pid: process.pid, name: 'B one' } })
  const homes = createProfileHomes()
  const live = homes.liveSessions([A, B])
  expect([live.get('sa')?.home.root, live.get('sb')?.home.root]).toEqual([A, B])
  expect([live.get('sa')?.session.name, live.get('sb')?.session.name]).toEqual(['A one', 'B one'])
  expect(homes.forDir(`${A}${sep}`)).toBe(homes.forDir(A.toUpperCase()))
  expect(live.get('sb')?.home).toBe(homes.forDir(B))
  expect(homes.liveSessions([]).size).toBe(0)
})

/** A project in `root`'s projects/ whose newest transcript ran in `cwd`, `age` seconds ago. */
function project(root: string, folder: string, cwd: string, age: number): void {
  const dir = join(root, 'projects', folder)
  mkdirSync(dir)
  const file = join(dir, 's.jsonl')
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', cwd })}
`,
  )
  const at = new Date(Date.now() - age * 1000)
  utimesSync(file, at, at)
  utimesSync(dir, at, at)
}

test('recent folders: the newest of all homes first, each folder once, no more than asked', async () => {
  // Real folders outside the temp folder (temp folders are skipped on purpose): this checkout's.
  const repo = join(import.meta.dir, '..', '..')
  const [src, tests] = [join(repo, 'src'), join(repo, 'test')]
  const A = homeWith()
  project(A, 'a', repo, 20)
  project(A, 'b', src, 10)
  const B = homeWith()
  project(B, 'c', tests, 30)
  project(B, 'd', `${src}${sep}`, 5) // A has it too, spelled otherwise: B's is newer
  const homes = createProfileHomes()
  expect(await homes.recentFolders([A, B])).toEqual([`${src}${sep}`, repo, tests])
  expect(await homes.recentFolders([A, B], 2)).toEqual([`${src}${sep}`, repo])
  expect(await homes.recentFolders([B, A])).toEqual([`${src}${sep}`, repo, tests])
  // One home: its own list, as before profiles.
  expect(await homes.recentFolders([A])).toEqual([src, repo])
})

test('recent folders: a newer work folder shows however many private ones there are', async () => {
  // Real folders outside the temp folder: this checkout's folders under src/ and test/.
  const repo = join(import.meta.dir, '..', '..')
  const folders = ['src', 'test']
    .flatMap(top =>
      readdirSync(join(repo, top), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => join(repo, top, d.name)),
    )
    .sort()
  expect(folders.length).toBeGreaterThanOrEqual(15)
  const [work = '', older = '', ...rest] = folders
  const own = rest.slice(0, 13)
  const priv = homeWith()
  // 13, the newest 100 s ago.
  for (const [i, cwd] of own.entries()) project(priv, `p${i}`, cwd, 100 + i)
  const workHome = homeWith()
  project(workHome, 'w', work, 50)
  project(workHome, 'x', older, 900)
  const homes = createProfileHomes()
  // The private profile first, as the board lists it: work's newer folder still comes first.
  const recent = await homes.recentFolders([priv, workHome])
  expect(recent).toEqual([work, ...own.slice(0, 11)])
  expect(recent).not.toContain(older)
})
