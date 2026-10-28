// "Sync profiles" in the Remote access panel (components/access/ProfileSync.tsx), drawn for each
// state of the board's view (core/profile-sync/view.ts): not shown without the board on the
// server; nothing looked at; the preview grouped and folded, its conflicts with the target's kept
// by default, the deletions not ticked, what is held back and what can't go, the projects not
// paired with a path to give; a run's progress; its end, a profile made there and the sign-in it
// needs; a failure.
import { expect, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { buildPreview, type Manifest, type ProfileFacts } from '../../src/core/profile-sync/plan.ts'
import { SYNC_IDLE, type SyncView } from '../../src/core/profile-sync/view.ts'
import type { ServerView } from '../../src/core/server-view.ts'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { ProfileSync } from '../../web/src/components/access/ProfileSync.tsx'
import { ServerSetupBody } from '../../web/src/components/access/ServerSetup.tsx'
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
    renderInBoard(
      <ServerSetupBody view={v} send={async () => null} state={SETUP_START} onState={() => {}} now={NOW} />,
      board({ now: NOW }),
    )
  const has = (nodes: Node[]): boolean => findAll(nodes, el => hasClass(el, 'access-sync')).length > 0
  expect(has(part(view('')))).toBe(false)
  expect(has(part(view('workbench.example.com')))).toBe(true)
})

test('nothing looked at: the direction, Preview, and the words on what never goes', () => {
  const nodes = draw(null)
  expect(textOf(find(nodes, el => el.tag === 'summary'))).toBe('Sync profiles')
  const radios = findAll(nodes, el => el.tag === 'input' && el.attrs.get('type') === 'radio')
  expect(radios.length).toBe(2)
  expect(nodes.map(textOf).join(' ')).toContain('Secrets never go')
  expect(findAll(nodes, el => el.tag === 'button').map(textOf)).toEqual(['Preview'])
})

test('the preview grouped and folded; the target’s kept in a conflict; deletions not ticked; held back, can’t go, unpaired', () => {
  const nodes = draw({ ...SYNC_IDLE, phase: 'preview', direction: 'up', preview: PREVIEW })
  const text = nodes.map(textOf).join(' ')
  expect(text).toContain('4 files to send (2.0 KB), 1 in conflict, 1 deleted on the source.')
  expect(text).toContain('The profile work is not there yet: it will be made at /home/agent/.claude-work.')
  expect(folds(nodes).map(summaryOf)).toEqual([
    'Added · 2 files · 10 B',
    'Changed · 1 file · 2.0 KB',
    'Merged by key (each side keeps its own secrets and hooks) · 1 file · 10 B',
    'Changed on both sides since the last sync · 1',
    'Deleted on the source since the last sync · 1',
    'Held back (secrets) · 2',
    'Can’t go (they run only on the source) · 1',
    'Projects not paired · 1',
  ])
  const select = find(nodes, el => el.tag === 'select')
  expect(select.attrs.get('value') ?? 'target').toBe('target')
  const tick = find(nodes, el => el.tag === 'input' && el.attrs.get('name') === 'sync-deletions')
  expect(tick.attrs.has('checked')).toBe(false)
  expect(text).toContain('default: C:\\notes (no git remote, 3 files, 2.9 KB)')
  expect(text).toContain('default: .credentials.json')
  expect(findAll(nodes, el => el.tag === 'button').map(textOf)).toEqual(['Preview', 'Leave out', 'Apply', 'Close'])
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
    result: { files: 3, bytes: 2048, deleted: 1, kept: 1, created: ['work'], install: true, gone: 0 },
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
