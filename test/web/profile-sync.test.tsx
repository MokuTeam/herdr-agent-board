// "Sync profiles", the Remote access panel's Sync tab (components/access/ProfileSync.tsx,
// ServerSetup.tsx ServerSync), drawn for each state of the board's view (core/profile-sync/view.ts):
// where to install the board first without it on the server; nothing looked at; the preview in the
// owner's order (the profiles and where the projects go, the ticks, the choices, then what is
// in it folded), its conflicts with the target's kept by default, the deletions not ticked, what
// is held back and what can't go, the projects not paired with a path to give; a run's progress;
// its end, a profile made there and the sign-in it needs; a failure.
import { expect, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { buildPreview, type Manifest, type ProfileFacts } from '../../src/core/profile-sync/plan.ts'
import { SYNC_IDLE, type SyncView } from '../../src/core/profile-sync/view.ts'
import type { ServerView } from '../../src/core/server-view.ts'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { ProfileSync } from '../../web/src/components/access/ProfileSync.tsx'
import { ServerSync } from '../../web/src/components/access/ServerSetup.tsx'
import { SETUP_START } from '../../web/src/models/server-setup.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'

const NOW = new Date(2026, 9, 28, 12, 0).getTime()
const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const folds = (nodes: Node[]): Element[] => findAll(nodes, el => el.tag === 'details' && hasClass(el, 'sync-group'))
const summaryOf = (d: Element): string => textOf(find([d], el => el.tag === 'summary'))

const facts = (
  name: string,
  dir: string,
  files: ProfileFacts['files'],
  synced: ProfileFacts['synced'] = {},
): ProfileFacts => ({
  name,
  dir,
  files,
  synced,
  secretFiles: name === 'default' ? ['.credentials.json'] : [],
})
const manifest = (
  platform: string,
  home: string,
  profiles: ProfileFacts[],
  more: Partial<Manifest> = {},
): Manifest => ({
  v: 1,
  platform,
  home,
  profiles,
  projects: [],
  clones: [],
  findings: [],
  held: [],
  cantGo: [],
  ...more,
})

const PREVIEW = buildPreview({
  id: 'p1',
  at: NOW,
  direction: 'up',
  source: manifest(
    'win32',
    'C:\\Users\\migo',
    [
      facts(
        'default',
        'C:\\Users\\migo\\.claude',
        {
          'CLAUDE.md': ['c2', 2048],
          'settings.json': ['s', 10],
          'agents/x.md': ['x2', 5],
          'skills/a/SKILL.md': ['k', 7],
        },
        { 'CLAUDE.md': 'c1', 'agents/x.md': 'x1', 'agents/gone.md': 'g' },
      ),
      facts('work', 'C:\\Users\\migo\\.claude-work', { 'CLAUDE.md': ['w', 3] }),
    ],
    {
      projects: [
        {
          profile: 'default',
          folder: 'C--notes',
          path: 'C:\\notes',
          state: 'plain',
          remote: null,
          top: null,
          worktree: false,
          files: 3,
          bytes: 3000,
        },
      ],
      held: [{ profile: 'default', what: 'env GITHUB_TOKEN' }],
      cantGo: [{ profile: 'default', what: 'hook Stop: C:\\x\\beep.exe' }],
    },
  ),
  target: manifest('linux', '/home/agent', [
    facts(
      'default',
      '/home/agent/.claude',
      { 'CLAUDE.md': ['c1', 10], 'agents/x.md': ['x9', 9], 'agents/gone.md': ['g', 1] },
      { 'CLAUDE.md': 'c1', 'agents/x.md': 'x1', 'agents/gone.md': 'g' },
    ),
  ]),
  given: {},
})

const draw = (sync: SyncView | null, lang = 'en'): Node[] =>
  renderInBoard(<ProfileSync sync={sync} send={async () => null} passwords={{}} enabled />, board({ now: NOW }), lang)

test('shown where the board on the server has its address, not before', () => {
  const server: ServerView = {
    admin: { user: 'root', key: '' },
    sudo: null,
    phase: 'idle',
    facts: null,
    choice: null,
    plan: null,
    progress: null,
    hint: null,
    error: null,
    setup: null,
    testAfter: null,
    hostKey: null,
  }
  const view = (installDomain: string): AccessView => ({
    tunnel: {
      settings: {
        on: false,
        host: 'ssh.example.com',
        sshPort: 22,
        user: 'boardtunnel',
        key: '',
        socket: TUNNEL_SOCKET,
        domain: 'board.example.com',
        port: null,
        publicPort: null,
      },
      problems: [],
      blocked: null,
      listenPort: 12424,
      status: { state: 'off', since: NOW, probe: null },
      ssh: 'ssh',
      key: { path: 'k', generated: true, exists: true, publicKey: null, error: null },
      hostKey: null,
    },
    login: { password: true, totp: true, passkeys: [], lockout: null },
    logins: [],
    attempts: [],
    server: { ...server, installDomain },
  })
  const part = (v: AccessView) =>
    renderInBoard(<ServerSync view={v} send={async () => null} state={SETUP_START} />, board({ now: NOW }))
  const has = (nodes: Node[]): boolean => findAll(nodes, el => hasClass(el, 'access-sync')).length > 0
  expect(has(part(view('')))).toBe(false)
  expect(part(view('')).map(textOf).join(' ')).toContain('Install the board on the server first')
  expect(has(part(view('workbench.example.com')))).toBe(true)
})

test('nothing looked at: the direction, Preview, and the words on what never goes', () => {
  const nodes = draw(null)
  expect(textOf(find(nodes, el => el.tag === 'h3'))).toBe('Sync profiles')
  const radios = findAll(nodes, el => el.tag === 'input' && el.attrs.get('type') === 'radio')
  expect(radios.length).toBe(2)
  expect(nodes.map(textOf).join(' ')).toContain('Secrets never go')
  expect(findAll(nodes, el => el.tag === 'button').map(textOf)).toEqual(['Preview'])
})

test('the preview grouped and folded; the target’s kept in a conflict; deletions not ticked; held back, can’t go, unpaired', () => {
  const nodes = draw({ ...SYNC_IDLE, phase: 'preview', direction: 'up', preview: PREVIEW })
  const text = nodes.map(textOf).join(' ')
  expect(text).toContain('4 files to send (2.0 KB), 1 in conflict, 1 deleted on the source.')
  // the profiles in a block of their own, the one to be made said there, once
  expect(text).toContain('work · C:\\Users\\migo\\.claude-work → /home/agent/.claude-work · will be made · 0 projects')
  expect(text).toContain('default · C:\\Users\\migo\\.claude → /home/agent/.claude · already there · 1 project')
  expect(text).not.toContain('is not there yet')
  // in the owner's order: the profiles and their projects, the choices, then what is in it folded
  expect(folds(nodes).map(summaryOf)).toEqual([
    'Profiles · 2',
    'Where the projects go',
    'Changed on both sides since the last sync · 1',
    'Deleted on the source since the last sync · 1',
    'Added · 2 files · 10 B',
    'Changed · 1 file · 2.0 KB',
    'Merged by key (each side keeps its own secrets and hooks) · 1 file · 10 B',
    'Held back (secrets) · 2',
    'Can’t go (they run only on the source) · 1',
  ])
  const select = find(nodes, el => el.tag === 'select')
  expect(select.attrs.get('value') ?? 'target').toBe('target')
  const tick = find(nodes, el => el.tag === 'input' && el.attrs.get('name') === 'sync-deletions')
  expect(tick.attrs.has('checked')).toBe(false)
  // the project without a place, and the rule suggested for it, first
  expect(text).toContain('Without a place · 1')
  expect(text).toContain('default: C:\\notes (no git remote)')
  expect(text).toContain('Suggested: C:\\notes ↔ /home/agent/notes (1 project)')
  expect(text).toContain('default: .credentials.json')
  expect(findAll(nodes, el => el.tag === 'button').map(textOf)).toEqual([
    'Preview',
    // the project in its profile
    'Choose…',
    'Leave out',
    'Use this rule',
    'This computer…',
    'The server…',
    'Choose…',
    'Leave out',
    'Add a rule',
    'Apply',
    'Close',
  ])
  // in Russian, every word there
  const ru = draw({ ...SYNC_IDLE, phase: 'preview', direction: 'up', preview: PREVIEW }, 'ru')
    .map(textOf)
    .join(' ')
  expect(ru).toContain('Синхронизация профилей')
  expect(ru).not.toContain('sync.panel')
})

test('a run, its end with a profile made there, and a failure', () => {
  const running = draw({
    ...SYNC_IDLE,
    phase: 'applying',
    direction: 'up',
    progress: { files: 3, filesTotal: 10, bytes: 2048, bytesTotal: 1024 * 1024, step: 'files' },
  })
  expect(running.map(textOf).join(' ')).toContain('Sending 3 of 10 files (2.0 KB of 1.0 MB)…')
  expect(findAll(running, el => el.tag === 'button').map(textOf)).toEqual(['Preview', 'Cancel'])
  const done = draw({
    ...SYNC_IDLE,
    phase: 'done',
    direction: 'up',
    result: { files: 3, bytes: 2048, deleted: 1, kept: 1, created: ['work'], install: true, gone: 0, skipped: [] },
  }).map(textOf)
  expect(done.join(' ')).toContain('Synced: 3 files (2.0 KB), 1 deleted, 1 conflicts kept as the target had them.')
  expect(done.join(' ')).toContain(
    'Made the profile work there: sign in to Claude in it (/login) before using it. The board’s hooks are in it.',
  )
  const failed = draw({
    ...SYNC_IDLE,
    phase: 'failed',
    direction: 'down',
    error: 'No board is installed on this server.',
  })
  expect(failed.map(textOf).join(' ')).toContain('The sync stopped: No board is installed on this server.')
})

test('as reviewed: each group that changes how this computer runs ticked apart, unticked; history apart; a deletion changed there its own tick', () => {
  const p = buildPreview({
    id: 'p2',
    at: NOW,
    direction: 'down',
    source: manifest(
      'linux',
      '/home/agent',
      [
        {
          ...facts(
            'default',
            '/home/agent/.claude',
            {
              'settings.json': ['s2', 9],
              'history.jsonl': ['h2', 9],
              'paste-cache/p.txt': ['p1', 3],
              'agents/x.md': ['x', 2],
            },
            { 'agents/gone.md': 'g', 'agents/mine.md': 'm' },
          ),
          views: {
            settings: {
              env: { SRV: '1' },
              hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send x' }] }] },
              model: 'opus',
            },
          },
        },
      ],
      { findings: [{ profile: 'default', rel: 'agents/x.md', kinds: ['GitHub token'] }] },
    ),
    target: manifest('win32', 'C:Usersmigo', [
      {
        ...facts(
          'default',
          'C:Usersmigo.claude',
          { 'agents/gone.md': ['g', 1], 'agents/mine.md': ['m2', 1], 'agents/x.md': ['x0', 1] },
          { 'agents/gone.md': 'g', 'agents/mine.md': 'm', 'agents/x.md': 'x0' },
        ),
        views: { settings: { model: 'sonnet' } },
      },
    ]),
    given: {},
  })
  const nodes = draw({ ...SYNC_IDLE, phase: 'preview', direction: 'down', preview: p })
  const text = nodes.map(textOf).join(' ')
  // session history goes only when ticked: not counted to send until then
  expect(text).toContain('1 file to send (9 B), 0 in conflict, 2 deleted on the source.')
  expect(text).toContain('Keep the Claude sessions on this computer idle while this runs')
  expect(folds(nodes).map(summaryOf)).toEqual([
    // the profile, with no project, still said
    'Profiles · 1',
    // each group's tick in its fold's line, the fold closed
    'Environment variables (env) · 1',
    'Hooks: commands Claude runs on its events · 1',
    'Session history and edit history · 2 files · 12 B',
    'Deleted on the source since the last sync · 2',
    'Merged by key (each side keeps its own secrets and hooks) · 1 file · 9 B',
    'Held back (secrets) · 1',
    'Not sent: a secret would be cut from them, and the target has its own copy · 1',
  ])
  const runFolds = folds(nodes).filter(d => hasClass(d, 'sync-run'))
  expect(runFolds.map(d => d.attrs.has('open'))).toEqual([false, false])
  expect(
    runFolds.map(d =>
      find([d], el => el.tag === 'summary').children.some(c => c.kind === 'element' && c.tag === 'input'),
    ),
  ).toEqual([true, true])
  expect(text).toContain('default: settings.json · model (changed)')
  expect(text).toContain('default: settings.json · env SRV (new)')
  expect(text).toContain('Let the server change these on this computer')
  expect(text).toContain('tick only what you know and trust')
  expect(text).toContain('default: agents/x.md: GitHub token')
  const ticks = findAll(nodes, el => el.tag === 'input' && el.attrs.get('type') === 'checkbox')
  expect(ticks.map(el => el.attrs.get('name'))).toEqual([
    'sync-allow-env',
    'sync-allow-hooks',
    'sync-allow-history',
    'sync-delete-default:agents/mine.md',
    'sync-deletions',
  ])
  for (const el of ticks) expect(el.attrs.has('checked')).toBe(false)
  const ru = draw({ ...SYNC_IDLE, phase: 'preview', direction: 'down', preview: p }, 'ru')
    .map(textOf)
    .join(' ')
  expect(ru).toContain('Разрешить серверу изменить это на этом компьютере')
  expect(ru).not.toContain('sync.panel')
  // what the target left as it was, and why
  const done = draw({
    ...SYNC_IDLE,
    phase: 'done',
    direction: 'down',
    result: {
      files: 1,
      bytes: 9,
      deleted: 0,
      kept: 0,
      created: [],
      install: null,
      gone: 0,
      skipped: [{ profile: 'default', rel: 'agents/x.md', why: 'changed' }],
    },
  })
  expect(folds(done).map(summaryOf)).toEqual(['Left as they were on the target · 1'])
  expect(done.map(textOf).join(' ')).toContain('default: agents/x.md (changed there since the preview)')
})
