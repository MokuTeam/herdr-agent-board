// Walking a profile folder for its bundle (design: docs/design/nodes, 9.1 and 14, T10): a fixture
// on disk in a temp folder, with links, an oversized file and the parts that never travel.
import { afterEach, describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_FILE_BYTES, modeOf, type ReadOptions, readProfile } from '../../src/adapters/bundle-files.ts'
import { buildManifest, bundleHash } from '../../src/core/bundle.ts'

const CANARY = 'canary-51d0e2'
const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-files-'))
  cleanups.push(dir)
  return dir
}
const put = (file: string, text: string | Uint8Array): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
// A folder link: a junction on Windows, which needs no rights there; a symlink elsewhere.
const linkFolder = (target: string, path: string): void => symlinkSync(target, path, 'junction')
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A profile folder as Claude leaves it: the parts that travel and the ones that never do. */
function profile(): { root: string; dir: string; outside: string } {
  const root = temp()
  const dir = join(root, '.claude')
  put(join(dir, 'skills/review/SKILL.md'), '# Review\n')
  put(join(dir, 'skills/review/check.sh'), '#!/bin/sh\necho ok\n')
  put(join(dir, 'skills/review/node_modules/x/index.js'), 'x')
  put(join(dir, 'skills/review/.git/HEAD'), 'ref')
  put(join(dir, 'skills/py/.venv/bin/python'), 'x')
  put(join(dir, 'skills/py/__pycache__/a.pyc'), 'x')
  put(join(dir, 'skills/big/model.bin'), new Uint8Array(MAX_FILE_BYTES + 1))
  put(join(dir, 'agents/fixer.md'), 'fixer')
  put(join(dir, 'commands/ship.md'), 'ship')
  put(join(dir, 'CLAUDE.md'), 'be brief')
  put(join(dir, 'settings.json'), JSON.stringify({ model: 'opus', env: { API_TOKEN: CANARY, MODE: 'x' } }))
  put(
    join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: CANARY },
      projects: { 'C:/work': { history: [CANARY] } },
      mcpServers: {
        remote: { type: 'http', url: 'https://m.example.com/mcp', headers: { Authorization: `Bearer ${CANARY}` } },
      },
    }),
  )
  // Never sent: credentials, transcripts, memory, history, the rest of the folder.
  put(join(dir, '.credentials.json'), CANARY)
  put(join(dir, 'projects/C--work/abc.jsonl'), CANARY)
  put(join(dir, 'projects/C--work/memory/MEMORY.md'), CANARY)
  put(join(dir, 'history.jsonl'), CANARY)
  put(join(dir, 'todos/a.json'), CANARY)
  put(join(dir, 'plugins/x/plugin.json'), CANARY)
  const outside = join(root, 'shared-skills')
  put(join(outside, 'deploy/SKILL.md'), '# Deploy\n')
  return { root, dir, outside }
}

const walk = (dir: string, opts: Partial<ReadOptions> = {}) => {
  const read = readProfile(dir, { claudeJson: join(dir, '.claude.json'), to: 'linux', ...opts })
  assert.equal(read.ok, true)
  if (!read.ok) throw new Error('not read')
  return read.parts
}

describe('readProfile', () => {
  test('skills, agents, commands and CLAUDE.md, hashed by content, by path in the profile folder', () => {
    const { dir } = profile()
    const parts = walk(dir)
    assert.deepEqual(parts.files.map(f => f.path).sort(), [
      'CLAUDE.md',
      'agents/fixer.md',
      'commands/ship.md',
      'skills/review/SKILL.md',
      'skills/review/check.sh',
    ])
    const skill = parts.files.find(f => f.path === 'skills/review/SKILL.md')
    assert.equal(skill?.sha256, sha('# Review\n'))
    assert.equal(skill?.size, 9)
    assert.equal(skill?.source, join(dir, 'skills/review/SKILL.md'))
  })

  test('a file over 5 MB and node_modules, .git, .venv, __pycache__ are left out, each reported', () => {
    const { dir } = profile()
    assert.deepEqual(
      [...walk(dir).skipped].sort((a, b) => (a.path < b.path ? -1 : 1)),
      [
        { path: 'skills/big/model.bin', why: 'too-big' },
        { path: 'skills/py/.venv', why: 'skipped-folder' },
        { path: 'skills/py/__pycache__', why: 'skipped-folder' },
        { path: 'skills/review/.git', why: 'skipped-folder' },
        { path: 'skills/review/node_modules', why: 'skipped-folder' },
      ],
    )
  })

  test('settings.json as it is, and only mcpServers of .claude.json', () => {
    const { dir } = profile()
    const parts = walk(dir)
    assert.deepEqual(parts.settings, { model: 'opus', env: { API_TOKEN: CANARY, MODE: 'x' } })
    assert.deepEqual(Object.keys(parts.mcpServers as object), ['remote'])
  })

  test('credentials, transcripts, memory, history and .claude.json beyond mcpServers are never read into it', () => {
    const { dir } = profile()
    const parts = walk(dir)
    const read = JSON.stringify({ ...parts, settings: null, mcpServers: null })
    expect(read).not.toContain(CANARY)
    expect(read).not.toContain('credentials')
    expect(read).not.toContain('projects/')
  })

  test('a secret is never in the built manifest: canaries in settings env and an MCP header', () => {
    const { dir } = profile()
    const ctx = { from: process.platform, to: 'linux', profileDir: dir }
    const m = buildManifest(walk(dir), { config: {}, sinks: {} }, ctx)
    expect(JSON.stringify(m)).not.toContain(CANARY)
    assert.deepEqual(m.settings.env, { MODE: 'x' })
  })

  test("a link to a folder elsewhere is followed and its target's content travels", () => {
    const { dir, outside } = profile()
    linkFolder(join(outside, 'deploy'), join(dir, 'skills/deploy'))
    const parts = walk(dir)
    const deploy = parts.files.find(f => f.path === 'skills/deploy/SKILL.md')
    assert.equal(deploy?.sha256, sha('# Deploy\n'))
    assert.deepEqual(parts.followed, ['skills/deploy'])
  })

  test('a whole skills folder that is a link is walked as skills/', () => {
    const { root } = profile()
    const dir = join(root, 'other-profile')
    mkdirSync(dir)
    linkFolder(join(root, 'shared-skills'), join(dir, 'skills'))
    const parts = walk(dir)
    assert.deepEqual(
      parts.files.map(f => f.path),
      ['skills/deploy/SKILL.md'],
    )
    assert.deepEqual(parts.followed, ['skills'])
  })

  test('a link into a part of the profile folder that never travels is not followed', () => {
    const { dir } = profile()
    linkFolder(join(dir, 'projects'), join(dir, 'skills/leak'))
    linkFolder(dir, join(dir, 'agents/self'))
    const parts = walk(dir)
    expect(JSON.stringify(parts.files)).not.toContain('leak')
    expect(JSON.stringify(parts.files)).not.toContain('self')
    assert.deepEqual(
      parts.skipped.filter(s => s.why === 'link-into-profile').sort((a, b) => (a.path < b.path ? -1 : 1)),
      [
        { path: 'agents/self', why: 'link-into-profile' },
        { path: 'skills/leak', why: 'link-into-profile' },
      ],
    )
  })

  test('a link back to a folder the walk is in is a loop, and a broken link is reported', () => {
    const { dir, outside } = profile()
    linkFolder(join(dir, 'skills/review'), join(dir, 'skills/review/again'))
    const gone = join(outside, 'gone')
    mkdirSync(gone)
    linkFolder(gone, join(dir, 'commands/gone'))
    rmSync(gone, { recursive: true })
    const skipped = walk(dir).skipped
    assert.deepEqual(
      skipped.find(s => s.path === 'skills/review/again'),
      { path: 'skills/review/again', why: 'link-loop' },
    )
    assert.deepEqual(
      skipped.find(s => s.path === 'commands/gone'),
      { path: 'commands/gone', why: 'link-broken' },
    )
  })

  test('the hash is the same whatever order the files were walked in', () => {
    const { dir } = profile()
    const ctx = { from: process.platform, to: 'linux', profileDir: dir }
    const parts = walk(dir)
    const a = buildManifest(parts, { config: {}, sinks: {} }, ctx)
    const b = buildManifest({ ...parts, files: [...parts.files].reverse() }, { config: {}, sinks: {} }, ctx)
    assert.equal(bundleHash(a), bundleHash(b))
  })

  test('a profile without the parts gives an empty bundle; the default profile reads ~/.claude.json from where it is told', () => {
    const root = temp()
    const dir = join(root, '.claude')
    mkdirSync(dir)
    put(join(root, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'npx' } }, userID: CANARY }))
    const parts = walk(dir, { claudeJson: join(root, '.claude.json') })
    assert.deepEqual(parts.files, [])
    assert.equal(parts.settings, undefined)
    assert.deepEqual(parts.mcpServers, { a: { command: 'npx' } })
  })

  test('settings.json or .claude.json that does not parse: nothing is built', () => {
    const { dir } = profile()
    put(join(dir, 'settings.json'), '{ not json')
    const opts = { claudeJson: join(dir, '.claude.json'), to: 'linux' }
    assert.deepEqual(readProfile(dir, opts), { ok: false, why: 'settings', file: join(dir, 'settings.json') })
    put(join(dir, 'settings.json'), '{}')
    put(join(dir, '.claude.json'), '{ not json')
    assert.deepEqual(readProfile(dir, opts), { ok: false, why: 'claude-json', file: join(dir, '.claude.json') })
  })
})

describe('modeOf', () => {
  const sh = new TextEncoder().encode('#!/bin/sh\n')
  const md = new TextEncoder().encode('# Title\n')
  test('Windows keeps no executable bit: a script with #! is 0755, anything else 0644', () => {
    assert.equal(modeOf({ mode: 0o100666 }, sh, 'win32'), 0o755)
    assert.equal(modeOf({ mode: 0o100666 }, md, 'win32'), 0o644)
  })
  test('elsewhere the file system says', () => {
    assert.equal(modeOf({ mode: 0o100750 }, md, 'linux'), 0o750)
    assert.equal(modeOf({ mode: 0o100644 }, sh, 'darwin'), 0o644)
  })
})

describe('readProfile: hook scripts and the fence', () => {
  const hooked = (dir: string, ...commands: string[]): void =>
    put(
      join(dir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: commands.map(command => ({ type: 'command', command })) }] } }),
    )

  test("the script a portable hook names travels, exactly that file: not hooks/ as a folder, not herdr's", () => {
    const { root, dir } = profile()
    put(join(dir, 'hooks/lint.sh'), '#!/bin/sh\nexit 0\n')
    put(join(dir, 'hooks/other.sh'), 'unnamed')
    put(join(dir, 'hooks/herdr-agent-state.sh'), 'herdr')
    hooked(dir, `bash "${join(dir, 'hooks/lint.sh')}"`, 'bash ~/.claude/hooks/herdr-agent-state.sh')
    const parts = walk(dir, { home: root })
    const paths = parts.files.map(f => f.path)
    assert.ok(paths.includes('hooks/lint.sh'))
    assert.ok(!paths.includes('hooks/other.sh'))
    assert.ok(!paths.includes('hooks/herdr-agent-state.sh'))
    const m = buildManifest(
      parts,
      { config: {}, sinks: {} },
      { from: process.platform, to: 'linux', profileDir: dir, home: root },
    )
    assert.equal(m.report.find(e => e.kind === 'hook' && e.name === 'lint')?.why, 'script-sent')
    // Windows keeps no executable bit: the script's #! makes it 0755.
    if (process.platform === 'win32') assert.equal(m.files.find(f => f.path === 'hooks/lint.sh')?.mode, 0o755)
  })

  test('a script that is not there: reported missing, and its hook is not sent', () => {
    const { dir } = profile()
    hooked(dir, `bash "${join(dir, 'hooks/gone.sh')}"`)
    const parts = walk(dir)
    assert.deepEqual(
      parts.skipped.find(s => s.path === 'hooks/gone.sh'),
      { path: 'hooks/gone.sh', why: 'missing' },
    )
    const m = buildManifest(parts, { config: {}, sinks: {} }, { from: process.platform, to: 'linux', profileDir: dir })
    assert.deepEqual(m.hooks, {})
    assert.equal(m.report.find(e => e.kind === 'hook' && e.name === 'gone')?.why, 'script-missing')
  })

  test('a link to the folder above the profile, or to .claude.json beside it, is never followed', () => {
    const { root, dir } = profile()
    put(join(root, '.claude.json'), JSON.stringify({ userID: CANARY }))
    put(join(root, '.ssh/id_ed25519'), CANARY)
    linkFolder(root, join(dir, 'skills/home'))
    linkFolder(join(root, '.ssh'), join(dir, 'commands/keys'))
    let fileLink = true
    try {
      symlinkSync(join(root, '.claude.json'), join(dir, 'commands/state.json'), 'file')
    } catch {
      fileLink = false // Windows without the right to make file links
    }
    const parts = walk(dir)
    expect(JSON.stringify(parts.files)).not.toContain('home/')
    expect(JSON.stringify(parts.files)).not.toContain('keys')
    expect(JSON.stringify(parts.files)).not.toContain('state.json')
    assert.deepEqual(
      parts.skipped.find(s => s.path === 'skills/home'),
      { path: 'skills/home', why: 'link-into-profile' },
    )
    assert.deepEqual(
      parts.skipped.find(s => s.path === 'commands/keys'),
      { path: 'commands/keys', why: 'denied' },
    )
    if (fileLink)
      assert.deepEqual(
        parts.skipped.find(s => s.path === 'commands/state.json'),
        { path: 'commands/state.json', why: 'denied' },
      )
  })

  test('a profile folder that is not there: nothing is built', () => {
    const missing = join(temp(), 'nope')
    assert.deepEqual(readProfile(missing, { claudeJson: join(missing, '.claude.json'), to: 'linux' }), {
      ok: false,
      why: 'no-folder',
      file: missing,
    })
  })
})
