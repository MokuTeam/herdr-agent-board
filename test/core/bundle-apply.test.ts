// Applying a bundle, the pure part (core/bundle.ts, #506, docs/design/nodes 9.3): where a file may
// go, the manifest a node takes, and the node's settings.json, mcpServers and config.json after it,
// touching only what the bundle owns.
import { describe, expect, test } from 'bun:test'
import {
  appliedMcp,
  appliedSettings,
  appliedSlice,
  BUNDLE_FORMAT,
  type BundleManifest,
  buildManifest,
  bundlePath,
  manifestOf,
  nodeMode,
  PROFILE_DIR,
  withProfileDirFilled,
} from '../../src/core/bundle.ts'
import { nodeStatusOf } from '../../src/core/nodes.ts'

const m = (over: Partial<BundleManifest> = {}): BundleManifest => ({
  format: BUNDLE_FORMAT,
  files: [],
  settings: {},
  hooks: {},
  mcp: {},
  board: { sinks: {} },
  report: [],
  ...over,
})
const H = 'a'.repeat(64)

describe('bundlePath', () => {
  test.each([
    ['skills/a/SKILL.md', 'skills/a/SKILL.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['hooks/notify.sh', 'hooks/notify.sh'],
    ['skills/a:b/x.md', 'skills/a:b/x.md'],
    ['../x', null],
    ['skills/../../x', null],
    ['./x', null],
    ['skills//x', null],
    ['/etc/passwd', null],
    ['C:/Windows/x', null],
    ['skills\\x', null],
    ['skills/x\u0000', null],
    ['.credentials.json', null],
    ['.claude.json', null],
    ['a/.ssh/id_ed25519', null],
    ['skills/x/node_modules/y', null],
    ['settings.json', null],
    ['Settings.JSON', null],
    ['skills/settings.json', 'skills/settings.json'],
    ['', null],
    ['skills/x/nul', null],
    ['skills/CON.txt', null],
    ['skills/x./a.md', null],
    ['skills/x /a.md', null],
    ['skills/herdr-agents/SKILL.md', null],
    ['skills/agent-board-threads/SKILL.md', null],
    ['skills/herdr-agents-mine/SKILL.md', 'skills/herdr-agents-mine/SKILL.md'],
  ])('%j: %j', (raw, want) => {
    expect(bundlePath(raw)).toBe(want)
  })
})

test("buildManifest: the board's own skills and a name a node does not write stay on the master, said", () => {
  const f = (path: string) => ({ path, sha256: H, mode: 0o644 })
  const built = buildManifest(
    {
      files: [f('skills/a/SKILL.md'), f('skills/herdr-agents/SKILL.md'), f('skills/b/nul')],
      skipped: [],
      followed: [],
      settings: undefined,
      mcpServers: undefined,
    },
    { config: {}, sinks: {} },
    { from: 'win32', to: 'linux', profileDir: 'C:/Users/o/.claude' },
  )
  expect(built.files.map(x => x.path)).toEqual(['skills/a/SKILL.md'])
  expect(built.report.filter(e => e.verdict === 'not-sent')).toEqual([
    { kind: 'skill', name: 'skills/herdr-agents/SKILL.md', verdict: 'not-sent', why: 'board-own' },
    { kind: 'skill', name: 'skills/b/nul', verdict: 'not-sent', why: 'unsafe-name' },
  ])
})

/** `${NAME}` as a server's settings write it. */
const ref = (name: string): string => ['$', '{', name, '}'].join('')

test("a server's references: herdr's own variables are not counted, any other is said as what it is", () => {
  const built = buildManifest(
    {
      files: [],
      skipped: [],
      followed: [],
      settings: undefined,
      mcpServers: {
        local: {
          type: 'http',
          url: `https://x.example.com/mcp?pane=${ref('HERDR_PANE_ID')}&host=${ref('COMPUTERNAME')}`,
          headers: { 'X-Ws': ref('HERDR_WORKSPACE_ID') },
        },
      },
    },
    { config: {}, sinks: {} },
    { from: 'win32', to: 'linux', profileDir: 'C:/Users/o/.claude' },
  )
  expect(built.report.filter(e => e.why === 'reference')).toEqual([
    { kind: 'mcp', name: 'COMPUTERNAME', verdict: 'needs-secret', why: 'reference', detail: 'local' },
  ])
})

describe('manifestOf', () => {
  test('a manifest of format 1, its report left out; anything else null', () => {
    const raw = { ...m({ files: [{ path: 'CLAUDE.md', sha256: H, mode: 0o644 }] }), report: [{ kind: 'env' }] }
    expect(manifestOf(raw)).toEqual(m({ files: [{ path: 'CLAUDE.md', sha256: H, mode: 0o644 }] }))
    expect(manifestOf({ ...raw, format: 2 })).toBeNull()
    expect(manifestOf({ ...raw, files: [{ path: 'x', sha256: 'nope' }] })).toBeNull()
    expect(manifestOf({ ...raw, hooks: { Stop: 'x' } })).toBeNull()
    expect(manifestOf(null)).toBeNull()
  })
})

describe('appliedSettings', () => {
  test("the bundle's keys and env variables in, the ones it owned and dropped out, the owner's stay", () => {
    const before = m({ settings: { model: 'opus', effortLevel: 'high', env: { A: '1', B: '2' } } })
    const after = m({ settings: { model: 'sonnet', env: { A: '1' } } })
    const node = { model: 'opus', effortLevel: 'high', theme: 'dark', env: { A: '1', B: '2', MINE: 'x' } }
    expect(appliedSettings(node, before, after)).toEqual({ model: 'sonnet', theme: 'dark', env: { A: '1', MINE: 'x' } })
    expect(node.env.B).toBe('2')
  })

  test("a hook is matched in the node's form: filled in, it is found and removed; the owner's stays", () => {
    const hook = { type: 'command', command: `bash ${PROFILE_DIR}/hooks/g.sh` }
    const before = withProfileDirFilled(m({ hooks: { Stop: [{ matcher: '', hooks: [hook] }] } }), '/home/o/.claude')
    const node = {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'bash /home/o/.claude/hooks/g.sh' },
              { type: 'command', command: 'mine' },
            ],
          },
        ],
      },
    }
    expect(appliedSettings(node, before, m())).toEqual({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'mine' }] }] },
    })
    // Added once: a hook already there is not added again.
    expect(appliedSettings(node, null, before)).toEqual(node)
    expect(appliedSettings({}, null, before)).toEqual({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /home/o/.claude/hooks/g.sh' }] }] },
    })
  })

  test('nothing owned, nothing sent: the settings as they were', () => {
    expect(appliedSettings({ theme: 'dark', hooks: {} }, null, m())).toEqual({ theme: 'dark', hooks: {} })
  })
})

test("appliedMcp: the bundle's servers by name, the owner's stay", () => {
  const before = m({ mcp: { a: { url: 'x' }, b: { url: 'y' } } })
  const after = m({ mcp: { a: { url: 'z' } } })
  expect(appliedMcp({ a: {}, b: {}, mine: { command: 'm' } }, before, after)).toEqual({
    a: { url: 'z' },
    mine: { command: 'm' },
  })
})

test("appliedSlice: the master's keys, one it dropped removed, one it never sent kept, no secrets made from nothing", () => {
  const cfg = { language: 'en', models: ['m'], node: { id: 'n' } }
  expect(appliedSlice(cfg, null, { sinks: {} })).toEqual(cfg)
  const first = { sinks: { s: {} }, language: 'ru', launch: { claude: 'claude --verbose' } }
  const one = appliedSlice(cfg, null, first)
  expect(one).toEqual({
    language: 'ru',
    models: ['m'],
    node: { id: 'n' },
    secrets: { sinks: { s: {} } },
    launch: { claude: 'claude --verbose' },
  })
  expect(appliedSlice(one, first, { sinks: {} })).toEqual({
    models: ['m'],
    node: { id: 'n' },
    secrets: { sinks: {} },
    launch: {},
  })
})

test('nodeMode: a script the bundle sends is 0755, anything else 0644, whatever the master said', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  expect(nodeMode('hooks/a.sh', enc('echo'))).toBe(0o755)
  expect(nodeMode('hooks/a', enc('#!/usr/bin/env node'))).toBe(0o755)
  expect(nodeMode('skills/a/SKILL.md', enc('# A'))).toBe(0o644)
})

test("nodeStatusOf: a profile's bundle { seq, hash } kept, anything else null", () => {
  const status = {
    api: 1,
    id: 'n',
    version: '1',
    commit: 'c',
    platform: 'linux',
    arch: 'x64',
    cpus: 1,
    memTotalMb: 1,
    memAvailableMb: 1,
    load: null,
    sessions: { awake: 0, working: 0, asleep: 0 },
    launches: 0,
    workRootFreeMb: null,
    agents: [],
    at: 1,
    profiles: [
      { id: 'a', loggedIn: true, bundle: { seq: 3, hash: H } },
      { id: 'b', loggedIn: true, bundle: { seq: -1, hash: H } },
      { id: 'c', loggedIn: true, bundle: null },
    ],
  }
  expect(nodeStatusOf(status)?.profiles.map(p => p.bundle)).toEqual([{ seq: 3, hash: H }, null, null])
})
