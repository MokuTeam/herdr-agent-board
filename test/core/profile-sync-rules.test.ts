// The profile sync's path rules (core/profile-sync/rules.ts): a project under a rule's folder on
// one side at the same place below its folder on the other, both ways, the longest folder first;
// a pair by git remote over a rule, the owner's own path over both; the rule suggested for the
// projects without a pair; the preview's projects grouped by how they land.
import { describe, expect, test } from 'bun:test'
import { type ProjectFact, pairProjects, type Unpaired } from '../../src/core/profile-sync/paths.ts'
import { buildPreview, type Manifest } from '../../src/core/profile-sync/plan.ts'
import { syncScript } from '../../src/core/profile-sync/remote.ts'
import {
  cleanRules,
  type PathRule,
  placeGroups,
  ruleMoves,
  rulesIn,
  suggestMoves,
  suggestRules,
} from '../../src/core/profile-sync/rules.ts'

const project = (p: Partial<ProjectFact> & { folder: string }): ProjectFact => ({
  profile: 'default',
  path: null,
  state: 'plain',
  remote: null,
  top: null,
  worktree: false,
  files: 1,
  bytes: 10,
  ...p,
})
const PC = { platform: 'win32', home: 'C:\\Users\\migo' }
const SERVER = { platform: 'linux', home: '/home/agent' }
const MIGO: PathRule = { pc: 'C:\\migo', server: '/home/agent/migo' }
const server = (more: Partial<Parameters<typeof pairProjects>[0]['target']> = {}) => ({
  platform: 'linux',
  projects: [],
  clones: [],
  folders: {},
  ...more,
})
const pairsOf = (r: ReturnType<typeof pairProjects>) => r.pairs.map(p => [p.folder, p.to, p.how, p.rule])

describe('a rule moves a project both ways', () => {
  const dev = project({ folder: 'C--migo-development', path: 'C:\\migo\\development' })
  const deep = project({ folder: 'C--Migo-Dev-x-y', path: 'c:\\Migo\\Dev\\x y\\Проект' })

  test('PC to server: the same place below the server folder, the case of the PC path kept, / between', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [dev, deep] },
      target: server(),
      given: {},
      rules: ruleMoves([MIGO], 'up', 'win32'),
    })
    expect(pairsOf(r)).toEqual([
      ['C--Migo-Dev-x-y', '/home/agent/migo/Dev/x y/Проект', 'rule', 0],
      ['C--migo-development', '/home/agent/migo/development', 'rule', 0],
    ])
    expect(r.pairs.find(p => p.folder === 'C--migo-development')?.toFolder).toBe('-home-agent-migo-development')
    expect(r.unpaired).toEqual([])
  })

  test('server to PC: a project the sync placed there whose folder is not made yet comes back by the rule', () => {
    // its memory and sessions went up to /home/agent/migo/dev; the folder itself is not there
    const waiting = project({ folder: '-home-agent-migo-dev', path: '/home/agent/migo/dev', state: 'gone' })
    const r = pairProjects({
      source: { platform: 'linux', projects: [waiting] },
      target: { platform: 'win32', projects: [], clones: [], folders: {} },
      given: {},
      rules: ruleMoves([MIGO], 'down', 'linux'),
    })
    expect(pairsOf(r)).toEqual([['-home-agent-migo-dev', 'C:\\migo\\dev', 'rule', 0]])
  })

  test('server to PC: the inverse, \\ between; a path outside every rule stays without a pair', () => {
    const there = project({ folder: '-home-agent-migo-a-b', path: '/home/agent/migo/a/b' })
    const elsewhere = project({ folder: '-srv-x', path: '/srv/x' })
    const prefix = project({ folder: '-home-agent-migox', path: '/home/agent/migox' })
    const r = pairProjects({
      source: { platform: 'linux', projects: [there, elsewhere, prefix] },
      target: { platform: 'win32', projects: [], clones: [], folders: {} },
      given: {},
      rules: ruleMoves([MIGO], 'down', 'linux'),
    })
    expect(pairsOf(r)).toEqual([['-home-agent-migo-a-b', 'C:\\migo\\a\\b', 'rule', 0]])
    expect(r.pairs[0]?.toFolder).toBe('C--migo-a-b')
    expect(r.unpaired.map(u => [u.folder, u.why])).toEqual([
      ['-home-agent-migox', 'noRemote'],
      ['-srv-x', 'noRemote'],
    ])
  })

  test('the longest folder wins, whatever the order the rules come in; a folder that is the rule’s own maps to it', () => {
    const rules: PathRule[] = [MIGO, { pc: 'C:\\migo\\development\\', server: '/srv/dev' }]
    const r = pairProjects({
      source: {
        platform: 'win32',
        projects: [dev, project({ folder: 'C--migo-development-a', path: 'C:\\MIGO\\DEVELOPMENT\\a' })],
      },
      target: server(),
      given: {},
      rules: ruleMoves(rules, 'up', 'win32'),
    })
    expect(pairsOf(r)).toEqual([
      ['C--migo-development', '/srv/dev', 'rule', 1],
      ['C--migo-development-a', '/srv/dev/a', 'rule', 1],
    ])
    // Linux paths tell case apart: /home/agent/Migo is no rule's
    const back = pairProjects({
      source: { platform: 'linux', projects: [project({ folder: '-home-agent-Migo-x', path: '/home/agent/Migo/x' })] },
      target: { platform: 'win32', projects: [], clones: [], folders: {} },
      given: {},
      rules: ruleMoves(rules, 'down', 'linux'),
    })
    expect(back.pairs).toEqual([])
  })

  test('a drive root as a rule’s PC folder', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [dev] },
      target: server(),
      given: {},
      rules: ruleMoves([{ pc: 'C:', server: '/home/agent/c' }], 'up', 'win32'),
    })
    expect(pairsOf(r)).toEqual([['C--migo-development', '/home/agent/c/migo/development', 'rule', 0]])
  })
})

describe('which wins: the owner’s path, then git remote, then a rule', () => {
  const remote = 'git@github.com:MokuTeam/board.git'
  const board = project({
    folder: 'C--migo-board',
    path: 'C:\\migo\\board',
    state: 'git',
    remote,
    top: 'C:\\migo\\board',
  })
  const notes = project({ folder: 'C--migo-notes', path: 'C:\\migo\\notes' })
  const tree = project({
    folder: 'C--migo-board--claude-worktrees-x',
    path: 'C:\\migo\\board\\.claude\\worktrees\\x',
    state: 'git',
    remote,
    top: 'C:\\migo\\board\\.claude\\worktrees\\x',
    worktree: true,
  })
  const gone = project({ folder: 'C--migo-old', path: 'C:\\migo\\old', state: 'gone' })
  const clones = [{ path: '/home/agent/work/board', remote: 'https://github.com/MokuTeam/board' }]

  test('a clone there over the rule; a worktree by the rule, not onto its clone; a folder not there by the rule too', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [board, notes, tree, gone] },
      target: server({ clones }),
      given: {},
      rules: ruleMoves([MIGO], 'up', 'win32'),
    })
    expect(pairsOf(r)).toEqual([
      ['C--migo-board', '/home/agent/work/board', 'remote', undefined],
      ['C--migo-notes', '/home/agent/migo/notes', 'rule', 0],
      ['C--migo-old', '/home/agent/migo/old', 'rule', 0],
      ['C--migo-board--claude-worktrees-x', '/home/agent/migo/board/.claude/worktrees/x', 'rule', 0],
    ])
    expect(r.unpaired).toEqual([])
    // without a rule, a folder not there has no pair, as before
    const lone = pairProjects({ source: { platform: 'win32', projects: [gone] }, target: server(), given: {} })
    expect(lone.unpaired.map(u => u.why)).toEqual(['gone'])
    // without the rule, the worktree is as it was: left without a pair
    const none = pairProjects({
      source: { platform: 'win32', projects: [tree] },
      target: server({ clones }),
      given: {},
    })
    expect(none.unpaired.map(u => u.why)).toEqual(['worktree'])
  })

  test('the owner’s path over a clone and over a rule; leave out over both', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [board, notes] },
      target: server({ clones }),
      given: { 'default/C--migo-board': '/home/agent/mine', 'default/C--migo-notes': null },
      rules: ruleMoves([MIGO], 'up', 'win32'),
    })
    expect(pairsOf(r)).toEqual([['C--migo-board', '/home/agent/mine', 'owner', undefined]])
    expect(r.unpaired.map(u => [u.folder, u.why])).toEqual([['C--migo-notes', 'left']])
  })

  test('the same path between two Linux machines over a rule', () => {
    const same = project({ folder: '-srv-notes', path: '/srv/notes' })
    const r = pairProjects({
      source: { platform: 'linux', projects: [same] },
      target: server({ projects: [same] }),
      given: {},
      rules: ruleMoves([{ pc: '/srv', server: '/home/agent/srv' }], 'up', 'linux'),
    })
    expect(pairsOf(r)).toEqual([['-srv-notes', '/srv/notes', 'same', undefined]])
  })
})

describe('the rule suggested', () => {
  test('the deepest common folder to its name in the target’s home, its case as the first path spells it', () => {
    expect(
      suggestMoves(['C:\\migo\\development', 'c:\\MIGO\\x\\y', 'C:\\migo\\development\\projects\\a'], PC, SERVER),
    ).toEqual([{ from: 'C:\\migo', to: '/home/agent/migo', projects: 3 }])
    expect(suggestMoves(['C:\\migo\\dev\\a', 'C:\\migo\\dev\\b'], PC, SERVER)).toEqual([
      { from: 'C:\\migo\\dev', to: '/home/agent/dev', projects: 2 },
    ])
    // one project: its own folder
    expect(suggestMoves(['D:\\work\\site'], PC, SERVER)).toEqual([
      { from: 'D:\\work\\site', to: '/home/agent/site', projects: 1 },
    ])
  })

  test('never a drive alone: one per top folder; the home’s projects to the target’s home, as placed there', () => {
    expect(
      suggestMoves(
        ['C:\\migo\\a', 'C:\\migo\\b\\c', 'D:\\work\\x', 'C:\\Users\\migo\\code\\p', 'C:\\Users\\migo\\q', 'C:\\'],
        PC,
        SERVER,
      ),
    ).toEqual([
      { from: 'C:\\migo', to: '/home/agent/migo', projects: 2 },
      { from: 'C:\\Users\\migo', to: '/home/agent', projects: 2 },
      { from: 'D:\\work\\x', to: '/home/agent/x', projects: 1 },
    ])
    expect(suggestMoves(['C:\\Users\\migo\\code\\a', 'C:\\Users\\migo\\code\\b'], PC, SERVER)).toEqual([
      { from: 'C:\\Users\\migo\\code', to: '/home/agent/code', projects: 2 },
    ])
    // never a folder above the home: C:\Users of two users is one per top folder… of the home's own
    expect(suggestMoves(['C:\\Users\\other\\x'], PC, SERVER)).toEqual([
      { from: 'C:\\Users\\other\\x', to: '/home/agent/x', projects: 1 },
    ])
    expect(suggestMoves(['C:\\'], PC, SERVER)).toEqual([])
    expect(suggestMoves([], PC, SERVER)).toEqual([])
  })

  test('the server to a PC: its folders to the PC’s home, \\ between', () => {
    expect(suggestMoves(['/home/agent/migo/a', '/home/agent/migo/b'], SERVER, PC)).toEqual([
      { from: '/home/agent/migo', to: 'C:\\Users\\migo\\migo', projects: 2 },
    ])
    expect(suggestMoves(['/srv/a', '/opt/b/c'], SERVER, PC)).toEqual([
      { from: '/opt/b/c', to: 'C:\\Users\\migo\\c', projects: 1 },
      { from: '/srv/a', to: 'C:\\Users\\migo\\a', projects: 1 },
    ])
  })

  test('from the projects a rule could place, as PC ↔ server folders either way', () => {
    const unpaired = [
      { profile: 'default', folder: 'a', path: 'C:\\migo\\a', why: 'noRemote' as const, files: 1, bytes: 1 },
      { profile: 'default', folder: 'b', path: 'C:\\migo\\b', why: 'noClone' as const, files: 1, bytes: 1 },
      { profile: 'default', folder: 'g', path: 'D:\\gone', why: 'gone' as const, files: 1, bytes: 1 },
      { profile: 'default', folder: 'l', path: 'E:\\left', why: 'left' as const, files: 1, bytes: 1 },
      { profile: 'default', folder: 'u', path: null, why: 'unknown' as const, files: 1, bytes: 1 },
    ]
    expect(suggestRules(unpaired, 'up', PC, SERVER)).toEqual([
      { rule: MIGO, projects: 2 },
      { rule: { pc: 'D:\\gone', server: '/home/agent/gone' }, projects: 1 },
    ])
    const down = [
      { ...(unpaired[0] as Unpaired), path: '/home/agent/migo/a' },
      { ...(unpaired[1] as Unpaired), path: '/home/agent/migo/b' },
    ]
    expect(suggestRules(down, 'down', SERVER, PC)).toEqual([
      { rule: { pc: 'C:\\Users\\migo\\migo', server: '/home/agent/migo' }, projects: 2 },
    ])
  })
})

describe('the rules as kept', () => {
  test('each folder absolute on its side, written as it writes them; a PC folder once', () => {
    expect(
      cleanRules(
        [
          { pc: 'C:/migo/', server: '/home/agent/migo/' },
          { pc: 'c:\\MIGO', server: '/elsewhere' },
          { pc: '/c/work', server: '/home/agent/work' },
        ],
        'win32',
        'linux',
      ),
    ).toEqual([MIGO, { pc: 'C:\\work', server: '/home/agent/work' }])
    expect(cleanRules([], 'win32', 'linux')).toEqual([])
    for (const bad of [
      [{ pc: 'migo', server: '/home/agent/migo' }],
      [{ pc: 'C:\\migo', server: 'C:\\x' }],
      [{ pc: 'C:\\migo' }],
      ['C:\\migo'],
      'C:\\migo',
      Array.from({ length: 101 }, (_, i) => ({ pc: `C:\\${i}`, server: `/x/${i}` })),
    ])
      expect(cleanRules(bad, 'win32', 'linux')).toBeNull()
  })

  test('read from config.json per server; another server’s are not this one’s', () => {
    const tunnel = { host: 'a', syncPaths: { a: [MIGO, { pc: 1 }], b: [{ pc: 'D:\\x', server: '/x' }] } }
    expect(rulesIn(tunnel, 'a')).toEqual([MIGO])
    expect(rulesIn(tunnel, 'c')).toEqual([])
    expect(rulesIn(undefined, 'a')).toEqual([])
  })
})

const manifest = (m: Partial<Manifest> & Pick<Manifest, 'platform' | 'home'>): Manifest => ({
  v: 1,
  profiles: [],
  projects: [],
  clones: [],
  findings: [],
  held: [],
  cantGo: [],
  ...m,
})

describe('the preview, its projects grouped by how they land', () => {
  const remote = 'https://github.com/MokuTeam/board'
  const pc = manifest({
    ...PC,
    projects: [
      project({ folder: 'C--migo-a', path: 'C:\\migo\\a' }),
      project({ folder: 'C--migo-b', path: 'C:\\migo\\b' }),
      project({ folder: 'C--migo-board', path: 'C:\\migo\\board', state: 'git', remote, top: 'C:\\migo\\board' }),
      project({ folder: 'C--mine', path: 'C:\\mine' }),
      project({ folder: 'C--out', path: 'C:\\out' }),
      project({ folder: 'D--x', path: 'D:\\x' }),
      project({ folder: 'D--y', path: 'D:\\y' }),
    ],
  })
  const srv = manifest({ ...SERVER, clones: [{ path: '/home/agent/work/board', remote }] })
  const given = { 'default/C--mine': '/home/agent/mine', 'default/C--out': null }

  test('without a rule: the suggestion from the projects without a pair', () => {
    const p = buildPreview({ id: 'p', at: 1, direction: 'up', source: pc, target: srv, given })
    expect(p.rules).toEqual([])
    expect(p.suggested).toEqual([
      { rule: MIGO, projects: 2 },
      { rule: { pc: 'D:\\x', server: '/home/agent/x' }, projects: 1 },
      { rule: { pc: 'D:\\y', server: '/home/agent/y' }, projects: 1 },
    ])
  })

  test('with the rule: by the rule, by git remote, chosen, left out, without a pair; what is known of the folders there', () => {
    const p = buildPreview({
      id: 'p',
      at: 1,
      direction: 'up',
      source: pc,
      target: srv,
      given,
      rules: [MIGO, { pc: 'E:\\none', server: '/home/agent/none' }],
      there: { '/home/agent/migo/a': true, '/home/agent/migo/b': false, '/home/agent/elsewhere': true },
    })
    expect(p.there).toEqual({ '/home/agent/migo/a': true, '/home/agent/migo/b': false })
    expect(p.suggested).toEqual([
      { rule: { pc: 'D:\\x', server: '/home/agent/x' }, projects: 1 },
      { rule: { pc: 'D:\\y', server: '/home/agent/y' }, projects: 1 },
    ])
    expect(p.moves.map(m => m.from)).toContain('C:\\migo\\a')
    const g = placeGroups(p)
    expect(g.map(x => [x.kind, x.index, x.list.map(y => [y.from, y.to, y.there])])).toEqual([
      [
        'rule',
        0,
        [
          ['C:\\migo\\a', '/home/agent/migo/a', true],
          ['C:\\migo\\b', '/home/agent/migo/b', false],
        ],
      ],
      ['rule', 1, []],
      ['remote', undefined, [['C:\\migo\\board', '/home/agent/work/board', null]]],
      ['chosen', undefined, [['C:\\mine', '/home/agent/mine', null]]],
      ['left', undefined, [['C:\\out', null, null]]],
      [
        'none',
        undefined,
        [
          ['D:\\x', null, null],
          ['D:\\y', null, null],
        ],
      ],
    ])
    expect(g[0]?.rule).toEqual(MIGO)
  })

  test('the server to the PC: the same rule backwards', () => {
    const there = manifest({
      ...SERVER,
      projects: [project({ folder: '-home-agent-migo-a', path: '/home/agent/migo/a' })],
    })
    const p = buildPreview({
      id: 'p',
      at: 1,
      direction: 'down',
      source: there,
      target: manifest(PC),
      given: {},
      rules: [MIGO],
    })
    expect(p.pairs.map(x => [x.to, x.toFolder, x.how])).toEqual([['C:\\migo\\a', 'C--migo-a', 'rule']])
    expect(p.moves).toEqual([{ from: '/home/agent/migo/a', to: 'C:\\migo\\a' }])
  })
})

describe('the picker’s ops on the server', () => {
  test('run as the board’s user by its sync program, as every op of the sync', () => {
    for (const op of ['dirs', 'mkdir', 'exists'] as const) {
      const script = syncScript(op)
      expect(script).toContain('exec setsid -w runuser -u "$u" -- env -i HOME="$h"')
      expect(script.trim().endsWith(`"$b" ${op}`)).toBe(true)
    }
  })
})
