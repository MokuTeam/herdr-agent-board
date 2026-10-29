// "Where the projects go" in the sync's preview (components/access/SyncPlaces.tsx) and its folder
// picker (FolderChooser.tsx, models/folder-chooser.ts): breadcrumbs on either side, folders in
// order, the listings of both sides read; the picker drawn on the server (New folder) and on this
// computer (its top); the projects grouped by the rule that places them, by git remote, chosen,
// left out and without a place, a folder not there yet said with what it means.
import { describe, expect, test } from 'bun:test'
import type { ProjectFact } from '../../src/core/profile-sync/paths.ts'
import { buildPreview, type Manifest } from '../../src/core/profile-sync/plan.ts'
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
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

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
