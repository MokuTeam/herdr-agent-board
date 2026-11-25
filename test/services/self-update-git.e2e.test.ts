// The board's update of itself (#617) against real git: a clone behind its origin, fast-forwarded by
// the same commands the board runs (adapters/self-update.ts gitIn), package.json and bun.lock taken
// from upstream before the merge and the checkout clean after it; a clone with a change of its own,
// and one that went its own way, left exactly as they were.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveCommit, archiveStamp } from '../../src/adapters/git.ts'
import { writeTree } from '../../src/adapters/plugin-update.ts'
import { adoptArchive, gitIn } from '../../src/adapters/self-update.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { ARCHIVE_COMMIT_FILE } from '../../src/core/node-texts.ts'
import { standing, standingText, type UpdateState } from '../../src/core/self-update.ts'
import { readTar } from '../../src/core/tar.ts'
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

function deps(root: string, events: string[], over: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  let state: UpdateState = {}
  return {
    git: (args, ms) => gitIn(root, args, ms),
    isCheckout: () => existsSync(join(root, '.git')),
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
    ...over,
  }
}

async function archiveInstall(up: string, dir: string, commit: string): Promise<void> {
  const tar = await archiveCommit(up, commit)
  if (!tar) throw new Error(`archiveCommit failed for ${commit}`)
  const parsed = readTar(tar)
  if ('error' in parsed) throw new Error(parsed.error)
  writeTree(dir, parsed.entries)
  writeFileSync(join(dir, ARCHIVE_COMMIT_FILE), `${commit}\n`)
  writeFileSync(join(dir, '.archive-sha256'), `${'0'.repeat(64)}\n`)
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export const x = 1\n')
}

function archiveDeps(root: string, up: string, events: string[], over: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return deps(root, events, {
    archiveCommit: () => archiveStamp(root),
    adoptArchive: commit => adoptArchive(root, commit, up),
    ...over,
  })
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

test('archive install master adopts at .archive-commit, updates to origin/main, and stays clean', async () => {
  const { up, commitUp } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-master-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    const root = join(base, 'plugin')
    await archiveInstall(up, root, commitA)
    await commitUp('bun.lock', 'lock 2\n', 'Dependencies (#12)')
    await commitUp('README.md', 'two\n', 'Docs (#13)')
    const commitB = await sh(up, 'rev-parse', 'HEAD')

    const events: string[] = []
    const updater = createSelfUpdate(archiveDeps(root, up, events))
    const r = await updater.check({ byHand: true })
    expect(r).toMatchObject({
      outcome: 'updated',
      from: commitA,
      to: commitB,
      came: ['Docs (#13)', 'Dependencies (#12)'],
    })
    expect(events).toEqual(['install lock 2', 'restart'])
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(existsSync(join(root, ARCHIVE_COMMIT_FILE))).toBe(false)
    expect(existsSync(join(root, '.archive-sha256'))).toBe(false)
    expect(await sh(root, 'rev-parse', 'HEAD')).toBe(commitB)
    expect(await sh(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')).toBe('main')
    expect(await sh(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/main')
    expect(await sh(root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(await updater.resume()).toMatchObject({ outcome: 'updated', from: commitA, to: commitB, commit: commitB })
    expect(await updater.check()).toMatchObject({ outcome: 'current', commit: commitB })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('archive install already at latest commit adopts cleanly and reports current', async () => {
  const { up } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-current-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    const root = join(base, 'plugin')
    await archiveInstall(up, root, commitA)
    const r = await createSelfUpdate(archiveDeps(root, up, [])).check()
    expect(r).toMatchObject({ outcome: 'current', branch: 'main', commit: commitA })
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(existsSync(join(root, ARCHIVE_COMMIT_FILE))).toBe(false)
    expect(await sh(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/main')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('archive install whose tree differs from .archive-commit is refused with a plain sentence and leaves no .git', async () => {
  const { up, commitUp } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-dirty-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    await commitUp('README.md', 'two\n', 'Docs (#14)')
    const en = translator('en')
    const ru = translator('ru')

    // Modified tracked file
    const modRoot = join(base, 'mod')
    await archiveInstall(up, modRoot, commitA)
    writeFileSync(join(modRoot, 'README.md'), 'edited locally\n')
    const r1 = await createSelfUpdate(archiveDeps(modRoot, up, [])).check()
    expect(r1).toMatchObject({ outcome: 'skipped', reason: 'archive-dirty', commit: commitA })
    expect(r1.detail).toContain('README.md')
    const st1 = standing({ on: true, every: 'hour', at: '04:00' }, { last: r1 }, Date.now())
    expect(st1 && standingText(st1, en)).toContain('differ from .archive-commit')
    expect(st1 && standingText(st1, en)).toContain('README.md')
    expect(st1 && standingText(st1, ru)).toContain('отличаются от .archive-commit')
    expect(existsSync(join(modRoot, '.git'))).toBe(false)
    expect(readdirSync(modRoot).some(n => n.startsWith('.git-adopt-'))).toBe(false)
    expect(readFileSync(join(modRoot, ARCHIVE_COMMIT_FILE), 'utf8')).toBe(`${commitA}\n`)
    expect(readFileSync(join(modRoot, 'README.md'), 'utf8')).toBe('edited locally\n')

    // Deleted tracked file
    const delRoot = join(base, 'del')
    await archiveInstall(up, delRoot, commitA)
    rmSync(join(delRoot, 'bun.lock'))
    const r2 = await createSelfUpdate(archiveDeps(delRoot, up, [])).check()
    expect(r2).toMatchObject({ outcome: 'skipped', reason: 'archive-dirty', commit: commitA })
    expect(r2.detail).toContain('bun.lock')
    expect(existsSync(join(delRoot, '.git'))).toBe(false)
    expect(readdirSync(delRoot).some(n => n.startsWith('.git-adopt-'))).toBe(false)
    expect(readFileSync(join(delRoot, ARCHIVE_COMMIT_FILE), 'utf8')).toBe(`${commitA}\n`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('archive install with unknown commit or unreachable remote refuses cleanly with no .git left', async () => {
  const { up } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-fail-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    const missingRoot = join(base, 'missing-commit')
    await archiveInstall(up, missingRoot, commitA)
    const bogus = 'f'.repeat(40)
    writeFileSync(join(missingRoot, ARCHIVE_COMMIT_FILE), `${bogus}\n`)
    const r1 = await createSelfUpdate(archiveDeps(missingRoot, up, [])).check()
    expect(r1).toMatchObject({ outcome: 'skipped', reason: 'archive', commit: bogus })
    expect(existsSync(join(missingRoot, '.git'))).toBe(false)
    expect(readdirSync(missingRoot).some(n => n.startsWith('.git-adopt-'))).toBe(false)
    expect(readFileSync(join(missingRoot, ARCHIVE_COMMIT_FILE), 'utf8')).toBe(`${bogus}\n`)

    const badRemoteRoot = join(base, 'bad-remote')
    await archiveInstall(up, badRemoteRoot, commitA)
    const r2 = await createSelfUpdate(archiveDeps(badRemoteRoot, join(base, 'does-not-exist'), [])).check()
    expect(r2).toMatchObject({ outcome: 'skipped', reason: 'fetch', commit: commitA })
    expect(existsSync(join(badRemoteRoot, '.git'))).toBe(false)
    expect(readdirSync(badRemoteRoot).some(n => n.startsWith('.git-adopt-'))).toBe(false)
    expect(readFileSync(join(badRemoteRoot, ARCHIVE_COMMIT_FILE), 'utf8')).toBe(`${commitA}\n`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('node with an archive install skips as node and leaves .archive-commit and no .git', async () => {
  const { up, commitUp } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-node-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    await commitUp('README.md', 'two\n', 'Docs (#15)')
    const root = join(base, 'node')
    await archiveInstall(up, root, commitA)
    const r = await createSelfUpdate(archiveDeps(root, up, [], { node: () => true })).check()
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'node' })
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(readFileSync(join(root, ARCHIVE_COMMIT_FILE), 'utf8')).toBe(`${commitA}\n`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('archive install in a path with spaces, non-ASCII characters, and % adopts and updates cleanly', async () => {
  const { up, commitUp } = await repos()
  const base = mkdtempSync(join(tmpdir(), 'board-archive-path-'))
  try {
    const commitA = await sh(up, 'rev-parse', 'HEAD')
    const root = join(base, 'archive master тест %20')
    await archiveInstall(up, root, commitA)
    await commitUp('README.md', 'two\n', 'Docs (#16)')
    const commitB = await sh(up, 'rev-parse', 'HEAD')
    const r = await createSelfUpdate(archiveDeps(root, up, [])).check()
    expect(r).toMatchObject({ outcome: 'updated', from: commitA, to: commitB })
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await sh(root, 'rev-parse', 'HEAD')).toBe(commitB)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
