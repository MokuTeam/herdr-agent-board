// The portability rule (design: docs/design/nodes, 8.4, and 14, T7): what may leave this computer,
// over facts handed in, and finding paths in a brief by their shape.
import { afterEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laneLeaves, MAX_PATHS, type PortableFacts, pathsIn, portable, repoAddress } from '../../src/core/portable.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const facts = (o: Partial<PortableFacts> = {}): PortableFacts => ({
  lane: 'atlas',
  lanes: 'all',
  checkout: { remote: 'https://github.com/MokuTeam/herdr-agent-board.git', clean: true, headPushed: true },
  worktree: null,
  brief: 'Fix the flaky test in test/core/when.test.ts and push the branch.',
  exists: () => false,
  ...o,
})

describe('portable', () => {
  test('a clean checkout with a remote and HEAD pushed, a brief with no local path: it may go', () => {
    assert.deepEqual(portable(facts()), { ok: true })
  })

  test('the lane: ticked or "all" may leave; unticked, absent or empty stays home, before any other fact', () => {
    assert.equal(laneLeaves('atlas', ['atlas']), true)
    assert.equal(laneLeaves('atlas', 'all'), true)
    for (const lanes of [['tools'], [], null, undefined] as const) {
      assert.equal(laneLeaves('atlas', lanes), false)
      assert.deepEqual(portable(facts({ lanes, checkout: null })), { ok: false, why: { kind: 'lane' } })
    }
  })

  test('no checkout, or no remote', () => {
    assert.deepEqual(portable(facts({ checkout: null })), { ok: false, why: { kind: 'no-remote' } })
    assert.deepEqual(portable(facts({ checkout: { remote: null, clean: true, headPushed: true } })), {
      ok: false,
      why: { kind: 'no-remote' },
    })
    // A remote that is a path on this computer still counts as one: the node decides whether it reaches it.
    assert.deepEqual(portable(facts({ checkout: { remote: 'C:/repos/bare.git', clean: true, headPushed: true } })), {
      ok: true,
    })
  })

  test('changes in the tree, and commits not pushed', () => {
    const remote = 'git@github.com:a/b.git'
    assert.deepEqual(portable(facts({ checkout: { remote, clean: false, headPushed: true } })), {
      ok: false,
      why: { kind: 'changes' },
    })
    assert.deepEqual(portable(facts({ checkout: { remote, clean: true, headPushed: false } })), {
      ok: false,
      why: { kind: 'unpushed' },
    })
  })

  test('a new worktree: from a pushed branch it goes, whatever the tree; from an unpushed one it stays', () => {
    const checkout = { remote: 'https://github.com/a/b', clean: false, headPushed: false }
    assert.deepEqual(portable(facts({ checkout, worktree: { branch: 'main', pushed: true } })), { ok: true })
    assert.deepEqual(portable(facts({ checkout, worktree: { branch: 'nodes/t7', pushed: false } })), {
      ok: false,
      why: { kind: 'base-unpushed', branch: 'nodes/t7' },
    })
  })

  test('a brief naming a scratchpad file of this computer, Windows and POSIX form, stays home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-portable-'))
    cleanups.push(dir)
    const brief = join(dir, 'brief.md')
    writeFileSync(brief, 'the task')
    const native = portable(facts({ brief: `Read ${brief} first.`, exists: existsSync }))
    assert.deepEqual(native, { ok: false, why: { kind: 'local-path', path: brief } })
    // The paths a sandbox would name on either platform, against a disk that has them.
    const win = String.raw`C:\Users\me\AppData\Local\Temp\claude\x\scratchpad\brief.md`
    const posix = '/tmp/claude-1000/x/scratchpad/brief.md'
    const disk = new Set([win, posix, 'C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/brief.md'])
    const has = (p: string) => disk.has(p)
    for (const path of [win, posix, 'C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/brief.md'])
      assert.deepEqual(portable(facts({ brief: `The brief is in ${path}.`, exists: has })), {
        ok: false,
        why: { kind: 'local-path', path },
      })
  })

  test('a brief naming a path that does not exist here is allowed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-portable-'))
    cleanups.push(dir)
    const missing = join(dir, 'nothing-here', 'brief.md')
    assert.deepEqual(portable(facts({ brief: `See ${missing} and /srv/data/x.csv`, exists: existsSync })), { ok: true })
  })

  test('exists is asked only for paths in the brief, at most 20, and not when an earlier rule decided', () => {
    const asked: string[] = []
    const exists = (p: string) => {
      asked.push(p)
      return false
    }
    const many = Array.from({ length: 30 }, (_, i) => `/data/f${i}.txt`).join(' ')
    portable(facts({ brief: many, exists }))
    assert.equal(asked.length, MAX_PATHS)
    asked.length = 0
    portable(facts({ brief: many, exists, checkout: null }))
    assert.deepEqual(asked, [])
  })
})

describe('pathsIn', () => {
  test('Windows paths with either slash, UNC and POSIX, in order, trailing punctuation off', () => {
    const text = String.raw`Open C:\Work\a.txt, then d:/notes/b.md; also \\nas\share\c.log and /home/me/d.txt.`
    assert.deepEqual(pathsIn(text), [
      String.raw`C:\Work\a.txt`,
      'd:/notes/b.md',
      String.raw`\\nas\share\c.log`,
      '/home/me/d.txt',
    ])
  })

  test('a quoted path keeps its spaces', () => {
    assert.deepEqual(pathsIn(String.raw`Read "C:\Program Files\App\x y.txt" and '/mnt/my files/z'`), [
      String.raw`C:\Program Files\App\x y.txt`,
      '/mnt/my files/z',
    ])
    assert.deepEqual(pathsIn('In `/opt/a b/c` there'), ['/opt/a b/c'])
  })

  test('URLs, relative paths, fractions and a bare drive are not paths', () => {
    assert.deepEqual(
      pathsIn(String.raw`See https://github.com/a/b/pull/3, ./src/x.ts, src/core, ~/x, 1/2, and/or, D:\ and e:/ alone`),
      [],
    )
  })

  test('each once, at most 20, without touching the disk', () => {
    assert.deepEqual(pathsIn('/a/x /a/x /a/y'), ['/a/x', '/a/y'])
    const many = Array.from({ length: 25 }, (_, i) => `C:\\d\\${i}`).join(' ')
    const found = pathsIn(many)
    assert.equal(found.length, 20)
    assert.equal(found[0], 'C:\\d\\0')
  })
})

describe('repoAddress', () => {
  test('https, scp-like ssh and ssh:// URLs are host/path, without user, port and .git', () => {
    for (const url of [
      'https://github.com/MokuTeam/herdr-agent-board.git',
      'https://user@GitHub.com/MokuTeam/herdr-agent-board/',
      'git@github.com:MokuTeam/herdr-agent-board.git',
      'ssh://git@github.com:22/MokuTeam/herdr-agent-board.git',
    ])
      assert.equal(repoAddress(url), 'github.com/MokuTeam/herdr-agent-board', url)
  })

  test('a path on this computer has no host', () => {
    for (const url of [
      'C:/repos/bare.git',
      String.raw`C:\repos\bare.git`,
      '/srv/git/r.git',
      'file:///srv/git/r.git',
      '../r',
    ])
      assert.equal(repoAddress(url), null, url)
  })
})
