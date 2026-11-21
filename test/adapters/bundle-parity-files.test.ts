// The walk's part of what a node needs of its profile (#602, #603): the acknowledgments out of
// .claude.json and nothing else of it, the data files a hook's script names beside it with whether
// each holds a secret (never its value), and .claude.json rewritten on the node with only the keys
// asked for, against a session that rewrites it meanwhile. On folders of the test's own.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editJson, readProfile } from '../../src/adapters/bundle-files.ts'
import { buildManifest } from '../../src/core/bundle.ts'

const CANARY = 'canary-walk-8c21'

/** A Linux owner's profile with the MemPalace hooks as the first real node had them. */
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'bundle-parity-'))
  const home = join(root, 'home')
  const dir = join(home, '.claude')
  const mem = join(dir, 'mempalace-memory')
  mkdirSync(mem, { recursive: true })
  const run = (name: string): string => `python "${join(mem, name)}"`
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: run('start.py') }] }],
        Stop: [{ hooks: [{ type: 'command', command: run('save.py') }] }],
      },
    }),
  )
  const script = (extra: string): string =>
    `import json, pathlib\nhere = pathlib.Path(__file__).parent\ncfg = json.loads((here / "config.json").read_text())\n${extra}\n`
  writeFileSync(join(mem, 'start.py'), script(''))
  writeFileSync(join(mem, 'save.py'), script("state = here / 'offsets.json'"))
  writeFileSync(
    join(mem, 'config.json'),
    JSON.stringify({ user_name: 'owner', url: 'https://m.example', token: CANARY }),
  )
  writeFileSync(join(mem, 'offsets.json'), JSON.stringify({ last: 1234 }))
  // Named nowhere: not a file of a script's.
  writeFileSync(join(mem, 'other.json'), JSON.stringify({ password: CANARY }))
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      codeModeCaveatsAcceptedV1: true,
      codeModeAutoModeCaveatAcceptedV1: true,
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: CANARY },
      mcpServers: {},
    }),
  )
  return { root, home, dir }
}

describe('the walk (#602, #603)', () => {
  test('acks out of .claude.json, the named files beside the scripts, no value anywhere', () => {
    const p = profile()
    const read = readProfile(p.dir, { to: 'linux', home: p.home, claudeJson: join(p.home, '.claude.json') })
    if (!read.ok) throw new Error(read.why)
    expect(read.parts.acks).toEqual(['codeModeAutoModeCaveatAcceptedV1', 'codeModeCaveatsAcceptedV1'])
    expect(read.parts.beside).toEqual([
      { path: 'mempalace-memory/config.json', script: 'mempalace-memory/save.py', secret: true },
      { path: 'mempalace-memory/offsets.json', script: 'mempalace-memory/save.py', secret: false },
    ])
    expect(JSON.stringify(read.parts)).not.toContain(CANARY)
    const m = buildManifest(
      read.parts,
      { config: {}, sinks: {} },
      {
        from: process.platform,
        to: 'linux',
        profileDir: p.dir,
        home: p.home,
        programs: ['python3', 'bash'],
      },
    )
    expect(m.files.map(f => f.path)).toEqual(['mempalace-memory/save.py', 'mempalace-memory/start.py'])
    expect(m.acks).toEqual(['codeModeAutoModeCaveatAcceptedV1', 'codeModeCaveatsAcceptedV1'])
    expect(JSON.stringify(m.hooks)).toContain('python3 \\"{{profile-dir}}/mempalace-memory/save.py\\"')
    expect(m.report.filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => [e.name, e.verdict])).toEqual([
      ['mempalace-memory/config.json', 'needs-secret'],
      ['mempalace-memory/offsets.json', 'not-sent'],
    ])
    expect(JSON.stringify(m)).not.toContain(CANARY)
  })

  test('a profile with neither: no acks, no beside, as before', () => {
    const p = profile()
    writeFileSync(join(p.dir, 'settings.json'), JSON.stringify({ model: 'opus' }))
    writeFileSync(join(p.home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    const read = readProfile(p.dir, { to: 'linux', home: p.home, claudeJson: join(p.home, '.claude.json') })
    if (!read.ok) throw new Error(read.why)
    expect('acks' in read.parts).toBe(false)
    expect('beside' in read.parts).toBe(false)
  })

  test('the programs the node has decide which scripts the walk takes', () => {
    const p = profile()
    const read = readProfile(p.dir, {
      to: 'linux',
      home: p.home,
      claudeJson: join(p.home, '.claude.json'),
      programs: ['bash'],
    })
    if (!read.ok) throw new Error(read.why)
    expect(read.parts.files.map(f => f.path)).toEqual([])
    expect('beside' in read.parts).toBe(false)
  })
})

describe('.claude.json on the node: editJson', () => {
  const scratch = (text?: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'edit-json-')), '.claude.json')
    if (text !== undefined) writeFileSync(file, text)
    return file
  }
  const addAck = (v: Record<string, unknown> | undefined) =>
    v && Object.hasOwn(v, 'codeModeCaveatsAcceptedV1') ? null : { ...(v ?? {}), codeModeCaveatsAcceptedV1: true }

  test('the key put in, every other key as it was', () => {
    const file = scratch(
      JSON.stringify({ numStartups: 9, projects: { '/w': { allowedTools: [] } }, oauthAccount: { a: 1 } }),
    )
    expect(editJson(file, addAck)).toBe('written')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      numStartups: 9,
      projects: { '/w': { allowedTools: [] } },
      oauthAccount: { a: 1 },
      codeModeCaveatsAcceptedV1: true,
    })
    expect(editJson(file, addAck)).toBe('same')
  })

  test('rewritten by a session between the read and the write: read again, and neither change is lost', () => {
    const file = scratch(JSON.stringify({ numStartups: 1 }))
    let calls = 0
    const r = editJson(file, v => {
      // A running session writes the file while this one is changing it, the first time only.
      if (++calls === 1) writeFileSync(file, JSON.stringify({ numStartups: 2, tipsHistory: { a: 1 } }))
      return addAck(v)
    })
    expect([r, calls]).toEqual(['written', 2])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      numStartups: 2,
      tipsHistory: { a: 1 },
      codeModeCaveatsAcceptedV1: true,
    })
  })

  test('rewritten every time: left as the session wrote it, and said', () => {
    const file = scratch(JSON.stringify({ numStartups: 1 }))
    let n = 0
    const r = editJson(file, v => {
      writeFileSync(file, JSON.stringify({ numStartups: ++n + 1 }))
      return addAck(v)
    })
    expect(r).toBe('busy')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ numStartups: 4 })
  })

  test('a file that is not a JSON object: not touched', () => {
    const file = scratch('{ not json')
    expect(editJson(file, addAck)).toBe('parse')
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    const list = scratch('[1]')
    expect(editJson(list, addAck)).toBe('parse')
  })

  test.skipIf(process.platform === 'win32')('a new file is 0600; an old one keeps its mode', () => {
    const file = scratch()
    expect(editJson(file, addAck)).toBe('written')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const old = scratch('{}')
    chmodSync(old, 0o640)
    expect(editJson(old, addAck)).toBe('written')
    expect(statSync(old).mode & 0o777).toBe(0o640)
  })
})
