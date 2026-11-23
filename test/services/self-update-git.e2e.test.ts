// The board's update of itself (#617) against real git: a clone behind its origin, fast-forwarded by
// the same commands the board runs (adapters/self-update.ts gitIn), package.json and bun.lock taken
// from upstream before the merge and the checkout clean after it; a clone with a change of its own,
// and one that went its own way, left exactly as they were.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitIn } from '../../src/adapters/self-update.ts'
import type { UpdateState } from '../../src/core/self-update.ts'
import { createSelfUpdate, type SelfUpdateDeps } from '../../src/services/self-update.ts'

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await gitIn(cwd, args)
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`)
  return r.out.trim()
}

async function identity(repo: string, name: string): Promise<void> {
  await sh(repo, 'config', 'user.email', `${name}@example.com`)
  await sh(repo, 'config', 'user.name', name)
  await sh(repo, 'config', 'commit.gpgsign', 'false')
}

async function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'board-self-update-'))
  const up = join(dir, 'up')
  const down = join(dir, 'down')
  await gitIn(dir, ['init', '-q', '-b', 'main', up])
  await identity(up, 'anna')
  writeFileSync(join(up, 'package.json'), '{"v":1}\n')
  writeFileSync(join(up, 'bun.lock'), 'lock 1\n')
  writeFileSync(join(up, 'README.md'), 'one\n')
  await sh(up, 'add', '-A')
  await sh(up, 'commit', '-qm', 'First')
  await gitIn(dir, ['clone', '-q', up, down])
  await identity(down, 'ben')
  const commitUp = async (file: string, text: string, msg: string) => {
    writeFileSync(join(up, file), text)
    await sh(up, 'add', '-A')
    await sh(up, 'commit', '-qm', msg)
  }
  return { up, down, commitUp }
}

function deps(root: string, events: string[]): SelfUpdateDeps {
  let state: UpdateState = {}
  return {
    git: (args, ms) => gitIn(root, args, ms),
    isCheckout: () => true,
    node: () => false,
    config: () => true,
    canRestart: true,
    busy: () => null,
    install: async () => {
      events.push(`install ${readFileSync(join(root, 'bun.lock'), 'utf8').trim()}`)
      return { ok: true, detail: '' }
    },
    installer: async () => ({ ok: true, detail: '' }),
    backupSettings: () => [],
    restart: () => events.push('restart'),
    wakeUp: async () => false,
    wakeBack: async () => true,
    load: () => structuredClone(state),
    save: s => {
      state = structuredClone(s)
    },
    log: () => {},
    now: Date.now,
  }
}

test('behind its origin with new dependencies: installed from upstream first, then fast-forwarded, clean', async () => {
  const { up, down, commitUp } = await repos()
  await commitUp('bun.lock', 'lock 2\n', 'Dependencies (#12)')
  await commitUp('README.md', 'two\n', 'Docs (#13)')
  const events: string[] = []
  const r = await createSelfUpdate(deps(down, events)).check()
  expect(r).toMatchObject({ outcome: 'updated', came: ['Docs (#13)', 'Dependencies (#12)'] })
  // bun install saw the new lockfile before the merge
  expect(events).toEqual(['install lock 2', 'restart'])
  expect(await sh(down, 'rev-parse', 'HEAD')).toBe(await sh(up, 'rev-parse', 'HEAD'))
  expect(await sh(down, 'status', '--porcelain')).toBe('')
})

test('a change of its own in a tracked file, or a commit of its own: left exactly as it was', async () => {
  const { down, commitUp } = await repos()
  await commitUp('README.md', 'two\n', 'Docs')
  const before = await sh(down, 'rev-parse', 'HEAD')
  writeFileSync(join(down, 'package.json'), '{"v":"mine"}\n')
  expect(await createSelfUpdate(deps(down, [])).check()).toMatchObject({ outcome: 'skipped', reason: 'dirty' })
  expect(readFileSync(join(down, 'package.json'), 'utf8')).toBe('{"v":"mine"}\n')
  await sh(down, 'commit', '-qam', 'Mine')
  const mine = await sh(down, 'rev-parse', 'HEAD')
  expect(await createSelfUpdate(deps(down, [])).check()).toMatchObject({ outcome: 'skipped', reason: 'diverged' })
  expect(await sh(down, 'rev-parse', 'HEAD')).toBe(mine)
  expect(mine).not.toBe(before)
})

test('a detached HEAD is skipped; up to date is current', async () => {
  const { down } = await repos()
  expect(await createSelfUpdate(deps(down, [])).check()).toMatchObject({ outcome: 'current' })
  await sh(down, 'checkout', '-q', '--detach')
  expect(await createSelfUpdate(deps(down, [])).check()).toMatchObject({ outcome: 'skipped', reason: 'detached' })
})
