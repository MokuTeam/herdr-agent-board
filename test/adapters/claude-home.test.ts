import { afterEach, describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeHome, defaultClaudeHome, readUsageCache } from '../../src/adapters/claude-home.ts'
import { canSymlink, SYMLINK_SKIP_REASON } from '../support/fs.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'board-claude-home-'))
  made.push(root)
  mkdirSync(join(root, 'projects'))
  return root
}

const row = (cwd: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    cwd,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'text', text }] },
    ...extra,
  })

describe('the home and its registry', () => {
  test('root is what it was built from; the default one is ~/.claude', () => {
    const root = newRoot()
    assert.equal(createClaudeHome(root).root, root)
    assert.equal(defaultClaudeHome(), defaultClaudeHome())
    assert.match(defaultClaudeHome().root, /[\\/]\.claude$/)
  })

  test('liveSessions: interactive sessions whose process is alive, by session id', () => {
    const root = newRoot()
    const dir = join(root, 'sessions')
    mkdirSync(dir)
    const put = (file: string, s: unknown) =>
      writeFileSync(join(dir, file), typeof s === 'string' ? s : JSON.stringify(s))
    put('1.json', { sessionId: 'live', kind: 'interactive', pid: process.pid, name: 'mine' })
    put('2.json', { sessionId: 'headless', kind: 'sdk', pid: process.pid })
    put('3.json', { sessionId: 'dead', kind: 'interactive', pid: 2 ** 22 + 12345 })
    put('4.json', 'not json')
    put('5.txt', { sessionId: 'ignored', kind: 'interactive', pid: process.pid })
    const live = createClaudeHome(root).liveSessions()
    assert.deepEqual([...live.keys()], ['live'])
    assert.equal(live.get('live')?.name, 'mine')
  })

  test('liveSessions: no sessions folder is an empty map', () => {
    assert.equal(createClaudeHome(newRoot()).liveSessions().size, 0)
  })
})

describe('transcriptPath', () => {
  test('guesses projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl for either separator', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    const put = (folder: string, id: string) => {
      mkdirSync(join(root, 'projects', folder), { recursive: true })
      const file = join(root, 'projects', folder, `${id}.jsonl`)
      writeFileSync(file, '{}\n')
      return file
    }
    const win = put('C--Work-my-app', 'win')
    const unix = put('-home-me-my-app', 'unix')
    assert.equal(home.transcriptPath('win', 'C:\\Work\\my.app\\'), win)
    assert.equal(home.transcriptPath('unix', '/home/me/my.app/'), unix)
  })

  test('falls back to scanning project folders, and caches a miss for a minute', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    mkdirSync(join(root, 'projects', 'elsewhere'))
    const file = join(root, 'projects', 'elsewhere', 'found.jsonl')
    writeFileSync(file, '{}\n')
    assert.equal(home.transcriptPath('found', '/no/such'), file)
    assert.equal(home.transcriptPath('missing', '/no/such'), null)
    writeFileSync(join(root, 'projects', 'elsewhere', 'missing.jsonl'), '{}\n')
    assert.equal(home.transcriptPath('missing', ''), null) // the scan is not repeated within a minute
    assert.equal(home.transcriptPath('missing', '/no/such'), null)
  })
})

describe('transcriptInfo', () => {
  const ai = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title })
  const userRow = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
  const asstRow = (text: string) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

  test('null for no path or a missing file; activity is the file mtime', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    assert.equal(home.transcriptInfo(null), null)
    assert.equal(home.transcriptInfo(join(root, 'nope.jsonl')), null)
    const path = join(root, 's.jsonl')
    writeFileSync(path, `${ai('Title')}\n${userRow('hi')}\n${asstRow('done')}\n`)
    const at = new Date('2026-03-04T05:06:07Z')
    utimesSync(path, at, at)
    const info = home.transcriptInfo(path)
    assert.equal(info?.title, 'Title')
    assert.equal(info?.lastText, 'done')
    assert.equal(info?.activity, at.getTime())
  })

  test('cached until the file changes (mtime or size), then read again', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    const path = join(root, 's.jsonl')
    writeFileSync(path, `${asstRow('first')}\n`)
    const t1 = new Date('2026-03-04T00:00:00Z')
    utimesSync(path, t1, t1)
    const first = home.transcriptInfo(path)
    assert.equal(first?.lastText, 'first')
    assert.equal(home.transcriptInfo(path), first) // same object: served from the cache
    writeFileSync(path, `${asstRow('other')}\n`) // same size, new mtime
    const t2 = new Date('2026-03-04T00:00:05Z')
    utimesSync(path, t2, t2)
    const second = home.transcriptInfo(path)
    assert.notEqual(second, first)
    assert.equal(second?.lastText, 'other')
    assert.equal(second?.activity, t2.getTime())
  })

  test('widens the window when the first 256 KB holds no usable lines', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    const path = join(root, 'big.jsonl')
    const filler = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1000) })
    const pad = Array.from({ length: 400 }, () => filler).join('\n') // ~400 KB after the title
    writeFileSync(path, `${ai('Far back')}\n${pad}\n`)
    assert.equal(home.transcriptInfo(path)?.title, 'Far back')
  })
})

describe('conversation', () => {
  const turn = (i: number) =>
    JSON.stringify({
      type: i % 2 ? 'assistant' : 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message:
        i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `m${i}` }] } : { role: 'user', content: `m${i}` },
    })

  test('[] for a missing file; the last `limit` turns otherwise', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    assert.deepEqual(home.conversation(join(root, 'nope.jsonl')), [])
    const path = join(root, 's.jsonl')
    writeFileSync(path, `${Array.from({ length: 10 }, (_, i) => turn(i)).join('\n')}\n`)
    const last3 = home.conversation(path, 3)
    assert.equal(last3.length, 3)
    assert.deepEqual(
      last3.map(t => ('text' in t ? t.text : '')),
      ['m7', 'm8', 'm9'],
    )
    assert.equal(home.conversation(path).length, 10)
  })

  test('reads past 2 MB when the first window held too few turns', () => {
    const root = newRoot()
    const home = createClaudeHome(root)
    const path = join(root, 'big.jsonl')
    const filler = JSON.stringify({ type: 'progress', pad: 'x'.repeat(100_000) })
    const early = Array.from({ length: 6 }, (_, i) => turn(i)).join('\n')
    const pad = Array.from({ length: 30 }, () => filler).join('\n') // ~3 MB of non-turns after them
    writeFileSync(path, `${early}\n${pad}\n`)
    expect(home.conversation(path, 40).length).toBe(6)
  })
})

describe('searchHistory', () => {
  function fixture() {
    const root = newRoot()
    const cwd = '/project-one'
    const dir = join(root, 'projects', '-project-one')
    mkdirSync(dir)
    return { root, base: join(root, 'projects'), cwd, dir, home: createClaudeHome(root) }
  }

  test('stays in the selected project, verifies colliding cwd, skips sidechains, gives provenance', async () => {
    const { base, cwd, dir, home } = fixture()
    writeFileSync(
      join(dir, 'session-a.jsonl'),
      [
        'broken',
        row(cwd, 'Needle: project note'),
        row('/project/one', 'needle: colliding path'),
        row(cwd, 'needle: sidechain', { isSidechain: true }),
      ].join('\n'),
    )
    writeFileSync(join(dir, 'session-b.jsonl'), row(cwd, 'needle: unknown date', { timestamp: 'bad' }))
    mkdirSync(join(base, '-other'))
    writeFileSync(join(base, '-other', 'secret.jsonl'), row('/other', 'needle: other project'))
    const out = await home.searchHistory(cwd, 'NEEDLE')
    assert.equal(out.results?.length, 2)
    assert.equal(out.scanned, 2)
    const first = out.results?.find(r => r.session === 'session-a')
    const second = out.results?.find(r => r.session === 'session-b')
    assert.match(first?.excerpt ?? '', /project note/)
    assert.equal(second?.date, null)
    assert.equal(first?.role, 'assistant')
    assert.equal(first?.text, 'Needle: project note')
    assert.equal(typeof first?.title, 'string')
    assert.match(first?.source ?? '', /-project-one\/session-a.jsonl/)
    assert.ok((first?.byteOffset ?? 0) > 0)
    assert.equal((await home.searchHistory(cwd, 'absent')).results?.length, 0)
    assert.equal((await home.searchHistory(cwd, 'project note', 'session-a')).results?.length, 0)
  })

  test('finds the updates kept as thinking (thinkingDisplay "updates"), not other thinking', async () => {
    const { cwd, dir, home } = fixture()
    const thinking = (text: string) => ({
      message: { content: [{ type: 'thinking', thinking: text, signature: 'x' }] },
    })
    writeFileSync(
      join(dir, 's.jsonl'),
      [
        row(cwd, '', { thinkingDisplay: 'updates', ...thinking('needle: the sandbox is free') }),
        row(cwd, '', thinking('needle: private reasoning')),
      ].join('\n'),
    )
    const out = await home.searchHistory(cwd, 'needle')
    assert.deepEqual(
      out.results?.map(r => r.text),
      ['needle: the sandbox is free'],
    )
  })

  test('a Windows cwd finds its folder and matches rows written with either slash or case', async () => {
    const { base, home } = fixture()
    mkdirSync(join(base, 'C--Work-app'))
    writeFileSync(join(base, 'C--Work-app', 's.jsonl'), row('c:/work/app', 'needle: from windows'))
    const out = await home.searchHistory('C:\\Work\\app\\', 'needle')
    assert.equal(out.results?.length, 1)
  })

  test('limits results and bytes, and rejects invalid queries', async () => {
    const { cwd, dir, home } = fixture()
    writeFileSync(join(dir, 'many.jsonl'), Array.from({ length: 50 }, () => row(cwd, 'needle')).join('\n'))
    const out = await home.searchHistory(cwd, 'needle')
    assert.equal(out.results?.length, 30)
    assert.equal(out.truncated, true)
    assert.equal((await home.searchHistory(cwd, 'x')).invalid, true)
    assert.equal((await home.searchHistory(cwd, null)).invalid, true)
    writeFileSync(join(dir, 'tail.jsonl'), `${'x'.repeat(2 << 20)}\n${row(cwd, 'tail needle')}`)
    const tail = await home.searchHistory(cwd, 'tail needle')
    assert.equal(tail.results?.length, 1)
    assert.ok((tail.bytesRead ?? 0) <= 8 << 20)
  })
})

describe('searchHistory symlinks', () => {
  test.skipIf(!canSymlink)(
    `a symlinked project folder cannot escape the projects folder (${SYMLINK_SKIP_REASON})`,
    async () => {
      const root = newRoot()
      symlinkSync(tmpdir(), join(root, 'projects', '-escape'))
      assert.equal((await createClaudeHome(root).searchHistory('/escape', 'needle')).unavailable, true)
    },
  )
})

describe('localUsage', () => {
  const cacheDir = (root: string) => join(root, 'herdr-usagebar')
  function cache() {
    const root = newRoot()
    mkdirSync(cacheDir(root))
    return { root, file: join(cacheDir(root), 'claude-limits-latest.json') }
  }

  test('only known numeric cache fields leave the reader; zero is valid, context/account stay unknown', () => {
    const { root, file } = cache()
    const now = 1000000
    writeFileSync(
      file,
      JSON.stringify({
        fetchedAtMs: now - 1000,
        fiveHour: { usedPercentage: 0, resetsAt: 2000 },
        sevenDay: { usedPercentage: 50 },
        secret: 'must not leave reader',
      }),
    )
    const out = createClaudeHome(root).localUsage(now)
    assert.equal(out.limits.available, true)
    assert.equal(out.limits.windows?.[0]?.usedPercentage, 0)
    assert.equal(out.limits.ageMs, 1000)
    assert.equal(out.limits.stale, false)
    assert.equal(out.context.available, false)
    assert.equal(out.limits.sessionAccountVerified, false)
    assert.doesNotMatch(JSON.stringify(out), /must not leave/)
  })

  test('a missing or bad cache never becomes invented fresh usage', () => {
    const { root, file } = cache()
    const home = createClaudeHome(root)
    const now = 1000000
    assert.equal(home.localUsage(now).limits.available, false)
    writeFileSync(file, 'bad')
    assert.equal(home.localUsage(now).limits.available, false)
  })

  test.skipIf(!canSymlink)(`a symlinked cache is refused (${SYMLINK_SKIP_REASON})`, () => {
    const { root, file } = cache()
    const other = join(cacheDir(root), 'other.json')
    writeFileSync(other, JSON.stringify({ fetchedAtMs: 999000, fiveHour: { usedPercentage: 10 } }))
    symlinkSync(other, file)
    assert.equal(createClaudeHome(root).localUsage(1000000).limits.available, false)
  })

  test('readUsageCache reads any folder (the board own status line cache)', () => {
    const dir = newRoot()
    writeFileSync(
      join(dir, 'claude-limits-latest.json'),
      JSON.stringify({ fetchedAtMs: 5000, fiveHour: { usedPercentage: 10 } }),
    )
    assert.equal(readUsageCache(dir, 6000).limits.available, true)
  })
})

describe('recentFolders', () => {
  test('the cwd in the newest transcript of each project, newest first, once each, existing folders only', async () => {
    const root = newRoot()
    // Real folders outside the temp folder (temp folders are skipped on purpose): this checkout's,
    // wherever the tests run from.
    const older = join(import.meta.dir, '..', '..')
    const newer = join(older, 'src')
    const missing = join(older, `no-such-folder-${process.pid}`)
    const mk = (folder: string, cwd: string, age: number) => {
      const dir = join(root, 'projects', folder)
      mkdirSync(dir)
      const file = join(dir, 's.jsonl')
      writeFileSync(file, `${JSON.stringify({ type: 'user', cwd })}\n`)
      const at = new Date(Date.now() - age * 1000)
      utimesSync(file, at, at)
      utimesSync(dir, at, at)
    }
    mk('a', older, 20)
    mk('b', missing, 10)
    mk('c', newer, 5)
    mk('d', newer, 30) // same folder again, older
    assert.deepEqual(await createClaudeHome(root).recentFolders(), [newer, older])
  })
})
