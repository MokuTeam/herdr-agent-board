// "Where the projects go" in the sync's preview (components/access/SyncPlaces.tsx) and its folder
// picker (FolderChooser.tsx, models/folder-chooser.ts): breadcrumbs on either side, folders in
// order, the listings of both sides read; the picker drawn on the server (New folder) and on this
// computer (its top); the projects grouped by the rule that places them, by git remote, chosen,
// left out and without a place, a folder not there yet said with what it means.
import { describe, expect, test } from 'bun:test'
import type { ProjectFact } from '../../src/core/profile-sync/paths.ts'
import { buildPreview, type Manifest, type ProfileFacts } from '../../src/core/profile-sync/plan.ts'
import { FolderChooser } from '../../web/src/components/access/FolderChooser.tsx'
import { SyncPlaces } from '../../web/src/components/access/SyncPlaces.tsx'
import {
  crumbs,
  inside,
  type Listing,
  pcListing,
  serverListing,
  sortFolders,
} from '../../web/src/models/folder-chooser.ts'
import { profileFolds } from '../../web/src/models/sync-profiles.ts'
import { board, renderInBoard } from './support/board.tsx'
import { find, findAll, hasClass, type Node } from './support/markup.ts'

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const buttons = (nodes: Node[]): string[] => findAll(nodes, el => el.tag === 'button').map(textOf)

describe('the picker’s model', () => {
  test('breadcrumbs on this computer and on the server; a folder inside another', () => {
    expect(crumbs('C:\\migo\\dev', '\\')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'migo', path: 'C:\\migo' },
      { name: 'dev', path: 'C:\\migo\\dev' },
    ])
    expect(crumbs('C:\\', '\\')).toEqual([{ name: 'C:', path: 'C:\\' }])
    expect(crumbs('/home/agent', '/')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'agent', path: '/home/agent' },
    ])
    expect(crumbs('/', '/')).toEqual([{ name: '/', path: '/' }])
    expect(crumbs('', '\\')).toEqual([])
    expect(inside('C:\\', 'migo', '\\')).toBe('C:\\migo')
    expect(inside('C:\\migo', 'x y', '\\')).toBe('C:\\migo\\x y')
    expect(inside('/', 'home', '/')).toBe('/home')
    expect(inside('/home/agent', 'проект', '/')).toBe('/home/agent/проект')
  })

  test('folders in order: hidden ones last, numbers as numbers', () => {
    expect(sortFolders(['.cache', 'b', 'a10', 'A2', '.bun'])).toEqual(['A2', 'a10', 'b', '.bun', '.cache'])
  })

  test('this computer’s listing (its top: home and drives) and the server’s; a refusal is none', () => {
    expect(
      pcListing({ path: '', exists: true, dir: true, roots: [{ name: '~', path: 'C:\\Users\\me' }], entries: [] }),
    ).toEqual({
      path: '',
      parent: '',
      entries: [],
      sep: '\\',
      roots: [{ name: '~', path: 'C:\\Users\\me' }],
      error: null,
    })
    expect(
      pcListing({ path: 'C:\\migo', exists: true, dir: true, entries: ['b', '.git', 'a'], parent: 'C:\\', sep: '\\' }),
    ).toEqual({ path: 'C:\\migo', parent: 'C:\\', entries: ['a', 'b', '.git'], sep: '\\', roots: [], error: null })
    expect(pcListing({ path: 'C:\\gone', exists: false })?.error).toBe('missing')
    // a folder not there yet: its parent, so the picker opens there
    expect(pcListing({ path: 'C:\\migo\\gone', exists: false })?.parent).toBe('C:\\migo')
    expect(pcListing({ path: 'C:\\gone', exists: false })?.parent).toBe('C:\\')
    expect(pcListing({ path: '/home/me/gone', exists: false })?.parent).toBe('/home/me')
    expect(pcListing({ path: '/gone', exists: false })?.parent).toBe('/')
    expect(pcListing({ path: 'X:\\', exists: false, slow: true })?.error).toBe('slow')
    expect(pcListing(null)).toBeNull()
    expect(
      serverListing({
        ok: true,
        path: '/home/agent',
        parent: '/home',
        home: '/home/agent',
        entries: ['.claude', 'migo'],
      }),
    ).toEqual({ path: '/home/agent', parent: '/home', entries: ['migo', '.claude'], sep: '/', roots: [], error: null })
    expect(serverListing({ ok: false, error: 'wrong password' })).toBeNull()
    expect(serverListing(null)).toBeNull()
  })
})

const nothing = async (): Promise<string> => ''

describe('the picker', () => {
  const at: Listing = {
    path: '/home/agent',
    parent: '/home',
    entries: ['migo', 'work', '.claude'],
    sep: '/',
    roots: [],
    error: null,
  }

  test('on the server: its breadcrumbs, its folders to open, Choose this folder, New folder', () => {
    const nodes = renderInBoard(
      <FolderChooser
        side="server"
        start=""
        list={nothing}
        make={nothing}
        onChoose={() => {}}
        onCancel={() => {}}
        initial={at}
      />,
      board({}),
      'en',
    )
    expect(nodes.map(textOf).join(' ')).toContain('A folder on the server')
    expect(buttons(nodes)).toEqual([
      '/',
      'home',
      'agent',
      'Up',
      'Choose this folder',
      'New folder',
      'Cancel',
      ' migo',
      ' work',
      ' .claude',
    ])
  })

  test('on this computer: its top (home and drives), no New folder; a folder that cannot be read says so', () => {
    const top: Listing = {
      path: '',
      parent: '',
      entries: [],
      sep: '\\',
      roots: [
        { name: '~', path: 'C:\\Users\\me' },
        { name: 'C:', path: 'C:\\' },
      ],
      error: null,
    }
    const nodes = renderInBoard(
      <FolderChooser side="pc" start="" list={nothing} onChoose={() => {}} onCancel={() => {}} initial={top} />,
      board({}),
      'en',
    )
    expect(buttons(nodes)).toEqual(['Top', 'Up', 'Choose this folder', 'Cancel', ' ~', ' C:'])
    const denied = renderInBoard(
      <FolderChooser
        side="pc"
        start=""
        list={nothing}
        onChoose={() => {}}
        onCancel={() => {}}
        initial={{ ...top, path: 'C:\\secret', roots: [], error: 'denied' }}
      />,
      board({}),
      'ru',
    )
    expect(denied.map(textOf).join(' ')).toContain('Эту папку нельзя прочитать.')
  })
})

const project = (p: Partial<ProjectFact> & { folder: string; path: string }): ProjectFact => ({
  profile: 'default',
  state: 'plain',
  remote: null,
  top: null,
  worktree: false,
  files: 1,
  bytes: 1,
  ...p,
})
const manifest = (m: Pick<Manifest, 'platform' | 'home'> & Partial<Manifest>): Manifest => ({
  v: 1,
  profiles: [],
  projects: [],
  clones: [],
  findings: [],
  held: [],
  cantGo: [],
  ...m,
})

describe('where the projects go', () => {
  const remote = 'https://github.com/MokuTeam/board'
  const p = buildPreview({
    id: 'p',
    at: 1,
    direction: 'up',
    source: manifest({
      platform: 'win32',
      home: 'C:\\Users\\migo',
      projects: [
        project({ folder: 'C--migo-a', path: 'C:\\migo\\a' }),
        project({ folder: 'C--migo-b', path: 'C:\\migo\\b' }),
        project({ folder: 'C--migo-board', path: 'C:\\migo\\board', state: 'git', remote, top: 'C:\\migo\\board' }),
        project({ folder: 'D--mine', path: 'D:\\mine' }),
        project({ folder: 'D--out', path: 'D:\\out' }),
        project({ folder: 'E--x', path: 'E:\\x' }),
      ],
    }),
    target: manifest({
      platform: 'linux',
      home: '/home/agent',
      clones: [{ path: '/home/agent/work/board', remote }],
    }),
    given: { 'default/D--mine': '/home/agent/mine', 'default/D--out': null },
    rules: [{ pc: 'C:\\migo', server: '/home/agent/migo' }],
    there: { '/home/agent/migo/a': true, '/home/agent/migo/b': false },
  })
  const draw = (lang = 'en') =>
    renderInBoard(
      <SyncPlaces p={p} send={async () => null} passwords={{}} enabled onSaid={() => {}} />,
      board({}),
      lang,
    )

  test('each project where it lands, grouped by how; a folder not there yet said; a choice for each', () => {
    const nodes = draw()
    const text = nodes.map(textOf).join(' ')
    for (const line of [
      'Suggested: E:\\x ↔ /home/agent/x (1 project)',
      'Rule: C:\\migo ↔ /home/agent/migo · 2',
      'default: C:\\migo\\a → /home/agent/migo/a',
      'default: C:\\migo\\b → /home/agent/migo/b · not there yet',
      'By git remote (a clone there) · 1',
      'default: C:\\migo\\board → /home/agent/work/board',
      'Chosen for the project · 1',
      'default: D:\\mine → /home/agent/mine',
      'Left out · 1',
      'default: D:\\out',
      'Without a place · 1',
      'default: E:\\x (no git remote)',
      'will be there once you put the project there; its memory and sessions wait for it',
    ])
      expect(text).toContain(line)
    expect(text).not.toContain('C:\\migo\\a → /home/agent/migo/a · not there yet')
    expect(buttons(nodes)).toEqual([
      // the suggestion
      'Use this rule',
      'This computer…',
      'The server…',
      // the rule, then its two projects
      'This computer…',
      'The server…',
      'Remove',
      'Choose…',
      'Leave out',
      'Choose…',
      'Leave out',
      // by git remote
      'Choose…',
      'Leave out',
      // chosen
      'Choose…',
      'As the rules say',
      'Leave out',
      // left out
      'Choose…',
      'Put back',
      // without a place
      'Choose…',
      'Leave out',
      'Add a rule',
    ])
    const ru = draw('ru').map(textOf).join(' ')
    expect(ru).toContain('Куда идут проекты')
    expect(ru).toContain('Правило: C:\\migo ↔ /home/agent/migo')
    expect(ru).toContain('папки ещё нет')
    expect(ru).not.toContain('sync.p')
  })

  test('no project on either side: nothing to place, nothing drawn', () => {
    const empty = { ...p, pairs: [], unpaired: [], rules: [], suggested: [] }
    expect(
      renderInBoard(
        <SyncPlaces p={empty} send={async () => null} passwords={{}} enabled onSaid={() => {}} />,
        board({}),
        'en',
      ),
    ).toEqual([])
  })
})

describe('the profiles', () => {
  const facts = (name: string, dir: string): ProfileFacts => ({ name, dir, files: {}, synced: {}, secretFiles: [] })
  const pcProfiles = ['default', 'work', 'gamedev'].map(n =>
    facts(n, `C:\\Users\\migo\\${n === 'default' ? '.claude' : `.claude-${n}`}`),
  )
  const rules = [{ pc: 'C:\\migo', server: '/home/agent/migo' }]
  const up = buildPreview({
    id: 'u',
    at: 1,
    direction: 'up',
    source: manifest({
      platform: 'win32',
      home: 'C:\\Users\\migo',
      profiles: pcProfiles,
      projects: [
        project({ folder: 'C--migo-b', path: 'C:\\migo\\b' }),
        project({ folder: 'C--migo-a', path: 'C:\\migo\\a' }),
        project({ profile: 'work', folder: 'C--migo-w', path: 'C:\\migo\\w' }),
        project({ profile: 'work', folder: 'D--out', path: 'D:\\out' }),
        project({ profile: 'work', folder: 'E--x', path: 'E:\\x' }),
      ],
    }),
    target: manifest({
      platform: 'linux',
      home: '/home/agent',
      profiles: [facts('default', '/home/agent/.claude'), facts('gamedev', '/home/agent/.claude-gamedev')],
    }),
    given: { 'work/D--out': null },
    rules,
    there: { '/home/agent/migo/w': false },
  })
  const down = buildPreview({
    id: 'd',
    at: 1,
    direction: 'down',
    source: manifest({
      platform: 'linux',
      home: '/home/agent',
      profiles: [facts('default', '/home/agent/.claude'), facts('gamedev', '/home/agent/.claude-gamedev')],
      projects: [
        project({ folder: '-home-agent-migo-a', path: '/home/agent/migo/a' }),
        project({ profile: 'gamedev', folder: '-home-agent-srv', path: '/home/agent/srv' }),
      ],
    }),
    target: manifest({ platform: 'win32', home: 'C:\\Users\\migo', profiles: pcProfiles.slice(0, 2) }),
    given: {},
    rules,
  })
  const draw = (p = up, lang = 'en') =>
    renderInBoard(
      <SyncPlaces p={p} send={async () => null} passwords={{}} enabled onSaid={() => {}} />,
      board({}),
      lang,
    )
  const profileFoldsIn = (nodes: Node[]) => findAll(nodes, el => el.tag === 'details' && hasClass(el, 'sync-profile'))
  const summaryOf = (d: Node) => textOf(find([d], el => el.tag === 'summary'))

  test('this computer → the server: each profile its folders, there or to be made, its projects with where and how', () => {
    const folds = profileFolds(up)
    expect(folds.map(f => [f.name, f.from, f.to, f.create, f.projects.length])).toEqual([
      ['default', 'C:\\Users\\migo\\.claude', '/home/agent/.claude', false, 2],
      ['work', 'C:\\Users\\migo\\.claude-work', '/home/agent/.claude-work', true, 3],
      ['gamedev', 'C:\\Users\\migo\\.claude-gamedev', '/home/agent/.claude-gamedev', false, 0],
    ])
    // each profile's own projects only, by their path
    expect(folds[0]?.projects.map(x => [x.from, x.to, x.kind])).toEqual([
      ['C:\\migo\\a', '/home/agent/migo/a', 'rule'],
      ['C:\\migo\\b', '/home/agent/migo/b', 'rule'],
    ])
    expect(folds[1]?.projects.map(x => [x.from, x.to, x.kind, x.there])).toEqual([
      ['C:\\migo\\w', '/home/agent/migo/w', 'rule', false],
      ['D:\\out', null, 'left', null],
      ['E:\\x', null, 'none', null],
    ])
  })

  test('the server → this computer: the server’s folder first, the profile this computer lacks to be made', () => {
    const folds = profileFolds(down)
    expect(folds.map(f => [f.name, f.from, f.to, f.create, f.projects.length])).toEqual([
      ['default', '/home/agent/.claude', 'C:\\Users\\migo\\.claude', false, 1],
      ['gamedev', '/home/agent/.claude-gamedev', 'C:\\Users\\migo\\.claude-gamedev', true, 1],
    ])
    expect(folds.flatMap(f => f.projects.map(x => [x.profile, x.from, x.to, x.kind]))).toEqual([
      ['default', '/home/agent/migo/a', 'C:\\migo\\a', 'rule'],
      ['gamedev', '/home/agent/srv', null, 'none'],
    ])
  })

  test('drawn above where the projects go: a fold each, closed with three; each project with its place, how, and its choice', () => {
    const nodes = draw()
    const text = nodes.map(textOf).join(' ')
    const outer = find(nodes, el => el.tag === 'details' && hasClass(el, 'sync-profiles'))
    expect(summaryOf(outer)).toBe('Profiles · 3')
    expect(text.indexOf('Profiles · 3')).toBeLessThan(text.indexOf('Where the projects go'))
    const folds = profileFoldsIn(nodes)
    expect(folds.map(summaryOf)).toEqual([
      'default · C:\\Users\\migo\\.claude → /home/agent/.claude · already there · 2 projects',
      'work · C:\\Users\\migo\\.claude-work → /home/agent/.claude-work · will be made · 3 projects',
      'gamedev · C:\\Users\\migo\\.claude-gamedev → /home/agent/.claude-gamedev · already there · 0 projects',
    ])
    expect(folds.map(d => d.attrs.has('open'))).toEqual([false, false, false])
    for (const line of [
      'C:\\migo\\a → /home/agent/migo/a (by a rule)',
      'C:\\migo\\w → /home/agent/migo/w (by a rule) · not there yet',
      'D:\\out → no place yet (left out)',
      'E:\\x → no place yet (no git remote)',
      'No projects in it.',
    ])
      expect(text).toContain(line)
    // the profile's projects with the same choices as where the projects go
    expect(buttons(folds)).toEqual([
      'Choose…',
      'Leave out',
      'Choose…',
      'Leave out',
      'Choose…',
      'Leave out',
      'Choose…',
      'Put back',
      'Choose…',
      'Leave out',
    ])
    // said once: no line apart for the profile to be made
    expect(text).not.toContain('is not there yet')
    const ru = draw(up, 'ru').map(textOf).join(' ')
    expect(ru).toContain('Профили · 3')
    expect(ru).toContain('будет создан')
    expect(ru).toContain('места пока нет')
    expect(ru).not.toContain('sync.panel')
  })

  test('two profiles: their folds open; the other way round, the server’s folder first', () => {
    const nodes = draw(down)
    const folds = profileFoldsIn(nodes)
    expect(folds.map(d => d.attrs.has('open'))).toEqual([true, true])
    expect(summaryOf(folds[1] as Node)).toBe(
      'gamedev · /home/agent/.claude-gamedev → C:\\Users\\migo\\.claude-gamedev · will be made · 1 project',
    )
    const text = nodes.map(textOf).join(' ')
    expect(text).toContain('/home/agent/migo/a → C:\\migo\\a (by a rule)')
    expect(text).toContain('/home/agent/srv → no place yet (no git remote)')
  })

  test('profiles but no project anywhere: the profiles alone', () => {
    const empty = { ...up, pairs: [], unpaired: [], rules: [], suggested: [] }
    const nodes = draw(empty)
    expect(profileFoldsIn(nodes).length).toBe(3)
    expect(nodes.map(textOf).join(' ')).not.toContain('Where the projects go')
  })
})
