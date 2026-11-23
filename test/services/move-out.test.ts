// The source's half of a move to another device (#616, services/move-out.ts): which folder it packs
// a session from. A session moved to this board before has the source device's folder in its
// transcript's first lines (#621); the folder it runs in here, whose project folder holds the
// transcript, is the one that travels.
import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Item } from '../../src/core/types.ts'
import type { Deps } from '../../src/services/deps.ts'
import { createMoveOut } from '../../src/services/move-out.ts'
import { isolatedHome } from '../support/env.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
let home = ''
beforeEach(() => {
  home = isolatedHome()
})

test("a session moved here before packs the folder it runs in here, not the one its transcript's first lines name", async () => {
  const dir = join(home, '.claude')
  const here = join(home, 'work', 'example.com', 'anna', 'atlas-feature-x')
  const there = join(home, 'laptop', 'atlas')
  for (const d of [here, there]) mkdirSync(d, { recursive: true })
  const project = join(dir, 'projects', projectFolderName(here))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${S}.jsonl`), `${JSON.stringify({ type: 'user', cwd: there, sessionId: S })}\n`)
  const asked: string[] = []
  const out = createMoveOut({
    deps: {
      profiles: () => ({ list: [{ id: 'default', dir, title: 'Default', hidden: false }] }),
    } as unknown as Deps,
    items: () =>
      [
        {
          key: S,
          session: S,
          name: 'Atlas',
          agent: 'claude',
          cwd: here,
          sleeping: true,
          profile: 'default',
          category: 'atlas',
        },
      ] as unknown as Item[],
    log: () => {},
    git: {
      checkout: async cwd => {
        asked.push(cwd)
        return {
          root: cwd,
          remote: { name: 'origin', url: 'git@github.com:anna/atlas.git', address: 'github.com/anna/atlas' },
          clean: true,
          headPushed: true,
        }
      },
      info: async cwd => ({ root: cwd, branch: 'feature-x' }),
      identity: async () => null,
      changes: async () => ({ head: 'c'.repeat(40), changes: { files: [], deleted: [], odd: [] } }),
    },
  })
  const r = await out.pack(S, 'server-1')
  if (!r.ok) throw new Error(r.why)
  expect(r.pack.cwd).toBe(here)
  expect(asked).toEqual([here])
  // A session that never moved: its transcript's folder is the one it runs in, as before.
  const fresh = join(home, 'fresh')
  mkdirSync(fresh, { recursive: true })
  const project2 = join(dir, 'projects', projectFolderName(fresh))
  mkdirSync(project2, { recursive: true })
  const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  writeFileSync(join(project2, `${S2}.jsonl`), `${JSON.stringify({ type: 'user', cwd: fresh, sessionId: S2 })}\n`)
  const out2 = createMoveOut({
    deps: { profiles: () => ({ list: [{ id: 'default', dir, title: 'Default', hidden: false }] }) } as unknown as Deps,
    items: () =>
      [
        {
          key: S2,
          session: S2,
          name: 'Ben',
          agent: 'claude',
          cwd: '',
          sleeping: true,
          profile: 'default',
          category: 'atlas',
        },
      ] as unknown as Item[],
    log: () => {},
    git: {
      checkout: async cwd => ({
        root: cwd,
        remote: { name: 'origin', url: 'git@github.com:anna/atlas.git', address: 'github.com/anna/atlas' },
        clean: true,
        headPushed: true,
      }),
      info: async cwd => ({ root: cwd, branch: 'main' }),
      identity: async () => null,
      changes: async () => ({ head: 'c'.repeat(40), changes: { files: [], deleted: [], odd: [] } }),
    },
  })
  const r2 = await out2.pack(S2, 'laptop')
  expect(r2.ok && r2.pack.cwd).toBe(fresh)
})
