// The new-session window's pure parts (models/launch.ts, models/launch-form.ts) and the calls'
// narrowing (api/launch.ts). Where the old launch.js had the same part on its own, the baseline's
// is run beside it on the same inputs.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { LaunchView } from '../../src/core/types.ts'
import { asListing, asOptions } from '../../web/src/api/launch.ts'
import { FROM_BELOW, windowPaint } from '../../web/src/models/grow.ts'
import {
  chainOf,
  completionItems,
  failureHint,
  folderColumn,
  growFrom,
  launcherLine,
  launcherName,
  launchWhere,
  retries,
  rootItems,
  sameish,
  stepText,
  suggestionItems,
} from '../../web/src/models/launch.ts'
import {
  draftOf,
  type FolderCheck,
  fieldOf,
  formProblems,
  formStart,
  goButton,
  type LaunchFields,
  startBody,
  startedLaunch,
  workspaceChoice,
  workspaceName,
  worktreeNote,
} from '../../web/src/models/launch-form.ts'
import { item } from './support/board.tsx'
import { oldCode, oldFunction } from './support/old-app.ts'

const t = translator('en')
const nested = (name: string) => ({ name, indent: '  ' })

describe('the folder columns', () => {
  const PATHS = [
    'C:\\Work\\acme',
    'C:/Work/acme/',
    'c:\\',
    '/srv/web/app',
    '/',
    '\\\\server\\share\\x',
    '//server/share',
    'relative\\path',
  ]

  test('the chain down to a folder, either separator, drive letters and UNC, as the old page made it', () => {
    const old = oldFunction(oldCode('web/launch.js', [nested('chainOf')], {}), 'chainOf')
    for (const path of PATHS)
      for (const sep of ['\\', '/']) expect(chainOf(path, sep)).toEqual(old(path, sep) as string[])
    expect(chainOf('C:\\Work\\acme', '\\')).toEqual(['C:\\', 'C:\\Work', 'C:\\Work\\acme'])
    expect(chainOf('/srv/web', '/')).toEqual(['/srv', '/srv/web'])
  })

  test('the same folder but for the case and a trailing separator, as before', () => {
    const old = oldFunction(oldCode('web/launch.js', [nested('sameish')], {}), 'sameish')
    for (const a of PATHS) for (const b of PATHS) expect(sameish(a, b)).toBe(old(a, b) as boolean)
    expect(sameish('C:\\Work\\', 'c:\\work')).toBe(true)
    expect(sameish('C:\\Work', 'C:/Work')).toBe(false)
  })

  test('a column: the roots (home first), or the folders inside one (hidden ones left out), the next one lit', () => {
    const roots = folderColumn(
      {
        path: '',
        roots: [
          { name: '~', path: 'C:\\Users\\me' },
          { name: 'C:', path: 'C:\\' },
        ],
      },
      'c:\\',
      t,
    )
    expect(roots).toEqual({
      label: 'This computer',
      rows: [
        { path: 'C:\\Users\\me', name: 'Home', icon: 'home', chev: false, on: false },
        { path: 'C:\\', name: 'C:', icon: 'drive', chev: false, on: true },
      ],
      empty: 'No folders inside',
    })
    const work = folderColumn({ path: 'C:\\Work\\', sep: '\\', entries: ['.git', 'acme'] }, 'C:\\Work\\acme\\', t)
    expect(work.rows).toEqual([{ path: 'C:\\Work\\acme', name: 'acme', icon: 'folder', chev: true, on: true }])
    expect(folderColumn({ path: '/srv', sep: '/', entries: ['web'] }, undefined, t).rows[0]?.path).toBe('/srv/web')
    // No separator said: a backslash, as before.
    expect(folderColumn({ path: '/srv', entries: ['web'] }, undefined, t).rows[0]?.path).toBe('/srv\\web')
    expect(folderColumn({ path: 'C:\\Users\\me\\private', entries: [], error: 'denied' }, undefined, t).empty).toBe(
      'No access to it',
    )
  })

  test('the list under the field: suggestions with why, roots by what is typed, completions of a folder', () => {
    expect(suggestionItems([{ path: 'C:\\Work\\acme\\', why: 'lane' }], t)).toEqual([
      { path: 'C:\\Work\\acme\\', label: 'acme', detail: 'C:\\Work\\acme\\', why: 'lane folder' },
    ])
    const roots = {
      roots: [
        { name: '~', path: '/home/me' },
        { name: 'C:', path: 'C:\\' },
        { name: 'D:', path: 'D:\\' },
      ],
    }
    expect(rootItems(roots, '~', t).map(x => x.label)).toEqual(['Home'])
    expect(rootItems(roots, 'd', t).map(x => x.path)).toEqual(['D:\\'])
    expect(rootItems(roots, '/h', t).map(x => x.path)).toEqual(['/home/me'])
    expect(rootItems(null, '', t)).toEqual([])
    const work = { path: 'C:\\Work', dir: true, sep: '\\', entries: ['.cache', 'acme', 'beta', 'xacme'] }
    expect(completionItems(work, 'c:/work/', 'ac').map(x => x.path)).toEqual(['C:\\Work\\acme', 'C:\\Work\\xacme'])
    expect(completionItems(work, 'c:/work/', '.').map(x => x.label)).toEqual(['.cache'])
    expect(completionItems({ path: 'C:\\Work', exists: false }, 'c:/work/', '')).toEqual([])
    // No answer about the folder: completions start from what was typed.
    expect(completionItems({ dir: true, entries: ['a'] }, '~/', '')[0]?.path).toBe('~/a')
  })
})

describe('the motion', () => {
  const WIN = { left: 210, top: 70, width: 580, height: 560, bottom: 630 }
  const RECTS = [
    null,
    { left: 840, top: 12, width: 130, height: 30, bottom: 42 },
    { left: 30, top: 120, width: 24, height: 24, bottom: 144 },
    { left: 0, top: 0, width: 2000, height: 10, bottom: 10 },
    { left: 10, top: 900, width: 100, height: 20, bottom: 920 },
    { left: 10, top: -50, width: 100, height: 20, bottom: -30 },
    { left: 10, top: 10, width: 0, height: 20, bottom: 30 },
  ]

  test('where the window grows from, as the old measure() said', () => {
    const style = { transform: 'scale(0.5)' }
    const win = { style, getBoundingClientRect: () => WIN }
    const measure = oldFunction(oldCode('web/launch.js', [nested('measure')], { win, innerHeight: 700 }), 'measure')
    for (const rect of RECTS) expect(growFrom(rect, WIN, 700)).toEqual(measure(rect) as never)
    expect(style.transform).toBe('scale(0.5)')
    expect(growFrom(null, WIN, 700)).toEqual(FROM_BELOW)
    expect(growFrom(RECTS[3], WIN, 700).s).toBe(0.6)
    expect(growFrom(RECTS[2], WIN, 700).s).toBe(0.08)
  })

  test('how it is drawn on the spring, with and without reduced motion, as the old paint() drew it', () => {
    for (const reduced of [false, true]) {
      const win = { style: { transform: '', opacity: '' } }
      const scrim = { style: { opacity: '' } }
      for (const from of [FROM_BELOW, { dx: 300, dy: -200, s: 0.2 }])
        for (const p of [-0.1, 0, 0.25, 0.5, 0.9, 1, 1.02]) {
          oldFunction(
            oldCode('web/launch.js', [nested('paint')], { win, scrim, from, reducedMotion: { matches: reduced } }),
            'paint',
          )(p)
          expect(windowPaint(p, from, reduced)).toEqual({
            transform: win.style.transform,
            opacity: win.style.opacity,
            scrim: scrim.style.opacity,
          })
        }
    }
  })
})

describe('the cards of sessions on their way', () => {
  const l = (fields: Partial<LaunchView>): LaunchView => ({
    id: 'L1',
    name: 'acme',
    cwd: '/srv/web/',
    category: 'web',
    workspace: 'Ops',
    workspaceId: null,
    state: 'starting',
    step: 'prepare',
    error: '',
    kind: '',
    pane: null,
    key: null,
    startedAt: 0,
    doneAt: null,
    message: '',
    worktree: null,
    newWorkspace: false,
    ...fields,
  })

  test('the step it is at, what to do about a failure, whether it may start again, where it goes', () => {
    expect(stepText(l({ step: 'command' }), t, 'my-cli')).toBe('Starting with my-cli…')
    expect(stepText(l({ state: 'waiting', step: 'agent' }), t, '')).toBe(t('launch.step.dialog'))
    expect(stepText(l({ state: 'done' }), t, '')).toBe(t('launch.step.done'))
    expect([
      failureHint(l({ kind: 'dialog' })),
      failureHint(l({ kind: '' })),
      failureHint(l({ kind: 'timeout' })),
    ]).toEqual(['launch.hint.dialogFailed', 'launch.hint.other', 'launch.hint.timeout'])
    expect([retries(l({ kind: 'message' })), retries(l({ kind: 'launcher' }))]).toEqual([false, true])
    expect(launchWhere(l({}), t)).toBe('web · workspace Ops')
    expect(launchWhere(l({ cwd: 'C:\\Work\\acme\\', workspace: '' }), t)).toBe('acme')
  })

  test("the window's line about the launcher, and the command's name", () => {
    expect(launcherLine({ kind: 'herdr', agent: 'claude' }, t)).toBe(t('launch.viaHerdr', { agent: 'Claude' }))
    expect(launcherLine({ kind: 'herdr', agent: 'codex' }, t)).toBe(t('launch.viaHerdr', { agent: 'codex' }))
    expect(launcherLine({ kind: 'command', name: 'my-cli' }, t)).toBe(t('launch.viaCommand', { name: 'my-cli' }))
    expect([
      launcherName({ kind: 'command', name: 'my-cli' }),
      launcherName({ kind: 'herdr', agent: 'claude' }),
    ]).toEqual(['my-cli', ''])
  })
})

// ---------------------------------------------------------------- the form

const fields = (f: Partial<LaunchFields> = {}): LaunchFields => ({
  name: 'acme',
  cwd: 'C:\\Work\\acme',
  workspace: 'w2',
  newWorkspace: '',
  wt: false,
  branch: '',
  message: '',
  ...f,
})
const ok: FolderCheck = { input: 'C:\\Work\\acme', path: 'C:\\Work\\acme', exists: true, dir: true }

describe('what the form starts with', () => {
  const card = item({ key: 's1', name: 'acme', cwd: 'C:\\Work\\acme', category: 'acme', workspace: 'Acme' })
  const board = { items: [card], filter: [] as string[] }

  test('a card: its folder, a free name, its lane and workspace; set, they stop following the folder', () => {
    expect(formStart({ item: card }, null, board)).toEqual({
      category: 'acme',
      cwd: 'C:\\Work\\acme',
      name: 'acme 2',
      message: '',
      wt: false,
      branch: '',
      workspace: { label: 'Acme' },
      set: { category: true, cwd: true, name: false, branch: false, workspace: true, newWorkspace: true },
      lanes: [],
    })
  })

  test('a lane, the lane on show, a new workspace, nothing at all', () => {
    expect(formStart({ category: 'web' }, null, board).category).toBe('web')
    expect(formStart({}, null, { ...board, filter: ['ops'] })).toMatchObject({
      category: 'ops',
      set: { category: true },
      lanes: [],
    })
    expect(formStart({ newWorkspace: true }, null, board)).toMatchObject({
      workspace: { create: '' },
      set: { workspace: true, newWorkspace: false },
    })
    expect(formStart({}, null, board)).toMatchObject({
      category: 'other',
      cwd: '',
      name: '',
      workspace: null,
      set: { category: false, cwd: false, name: false, workspace: false, newWorkspace: false },
    })
  })

  test('several lanes on show: the first picked, said in the form, unless the place names a lane', () => {
    const several = { ...board, filter: ['ops', 'web'] }
    // The first picked, not the first in the board's order; set, so the folder does not move it.
    expect(formStart({}, null, several)).toMatchObject({
      category: 'ops',
      set: { category: true },
      lanes: ['ops', 'web'],
    })
    expect(formStart({}, null, { ...board, filter: ['web', 'ops'] })).toMatchObject({
      category: 'web',
      lanes: ['web', 'ops'],
    })
    // A lane's +, a card, a draft or a failed launch name the lane: nothing to say.
    expect(formStart({ category: 'acme' }, null, several)).toMatchObject({ category: 'acme', lanes: [] })
    expect(formStart({ item: card }, null, several)).toMatchObject({ category: 'acme', lanes: [] })
    expect(formStart({}, { category: 'web' }, several)).toMatchObject({ category: 'web', lanes: [] })
    // A new workspace from the board's menu names none: the first picked too.
    expect(formStart({ newWorkspace: true }, null, several)).toMatchObject({ category: 'ops', lanes: ['ops', 'web'] })
  })

  test('a draft of the place, or a failed launch, gives every value back', () => {
    const draft = {
      name: 'Invoices',
      cwd: '/srv/web',
      category: 'web',
      message: 'Look at March',
      workspace: 'Fresh',
      newWorkspace: true,
      worktree: { branch: 'march' },
    }
    expect(formStart({ category: 'acme' }, draft, board)).toMatchObject({
      category: 'web',
      name: 'Invoices',
      message: 'Look at March',
      wt: true,
      branch: 'march',
      workspace: { create: 'Fresh' },
      set: { name: true, branch: true, newWorkspace: true },
    })
    // A new workspace's name that was only what the session's name gives goes on following it.
    expect(formStart({ category: 'acme' }, { ...draft, workspace: 'invoices' }, board).set.newWorkspace).toBe(false)
    expect(formStart({ category: 'acme' }, { ...draft, newWorkspace: false }, board).workspace).toEqual({
      label: 'Fresh',
    })
    const retry = { ...draft, id: 'L1', workspaceId: 'w2' } as const
    expect(formStart({ retry: { ...launchOf(retry) } }, draft, board).workspace).toEqual({ id: 'w2' })
  })
})

function launchOf(fields: {
  id: string
  workspaceId: string
  name: string
  cwd: string
  category: string
}): LaunchView {
  return {
    workspace: '',
    state: 'failed',
    step: 'agent',
    error: '',
    kind: 'launcher',
    pane: null,
    key: null,
    startedAt: 0,
    doneAt: null,
    message: '',
    worktree: null,
    newWorkspace: false,
    ...fields,
  }
}

describe('the workspace it offers', () => {
  const workspaces = [
    { id: 'w1', label: 'Board' },
    { id: 'w2', label: 'Acme' },
    { id: 'w3', label: undefined },
  ]
  const scene = {
    workspaces,
    board: 'Board',
    want: null,
    wanted: false,
    category: 'acme',
    title: 'Acme',
    items: [],
    fallback: '',
  }

  test("the board's own left out; by default the one named like the lane, else a new one", () => {
    expect(workspaceChoice(scene)).toEqual({ list: workspaces.slice(1), value: 'w2', create: false, seed: '' })
    expect(workspaceChoice({ ...scene, title: 'Web' })).toEqual({
      list: workspaces.slice(1),
      value: '',
      create: true,
      seed: '',
    })
    expect(workspaceChoice({ ...scene, title: 'Web', fallback: 'w3' }).value).toBe('w3')
  })

  test('the one wanted: by label, by id, a new one by name; an id herdr no longer has shows the first', () => {
    expect(workspaceChoice({ ...scene, wanted: true, want: { label: 'Acme' } }).value).toBe('w2')
    expect(workspaceChoice({ ...scene, wanted: true, want: { label: 'Gone' } })).toMatchObject({
      value: '',
      create: true,
      seed: 'Gone',
    })
    expect(workspaceChoice({ ...scene, wanted: true, want: { create: 'Fresh' } })).toMatchObject({
      create: true,
      seed: 'Fresh',
    })
    expect(workspaceChoice({ ...scene, wanted: true, want: { id: 'w9' } })).toMatchObject({
      value: 'w2',
      create: false,
    })
    expect(workspaceChoice({ ...scene, workspaces: [], wanted: true, want: { id: 'w9' } })).toMatchObject({
      value: '',
      create: false,
    })
  })

  test("a new one's default name: the session's name in kebab-case, else the lane's title, the folder's, Sessions", () => {
    expect(workspaceName('New Test Project', 'acme', 'Acme', 'C:\\Work\\x', t)).toBe('new-test-project')
    expect(workspaceName('Новый проект', 'other', 'Other', '', translator('ru'))).toBe('новый-проект')
    expect(workspaceName('', 'acme', 'Acme', 'C:\\Work\\x', t)).toBe('Acme')
    expect(workspaceName('!!!', 'other', 'Other', 'C:\\Work\\x\\', t)).toBe('x')
    expect(workspaceName(' ', 'other', 'Other', '', t)).toBe('Sessions')
  })
})

describe('the worktree, what the form lacks, the Start button', () => {
  test('where a new branch goes, either kind of path; a bad branch says why', () => {
    expect(worktreeNote({ root: 'C:\\Work\\acme', branch: 'main' }, true, ' fix/x ', t)).toEqual({
      text: t('launch.worktreeAt', { path: 'C:\\Work\\acme-fix-x', branch: 'main' }),
      error: false,
    })
    expect(worktreeNote({ root: '/srv/web/', branch: 'trunk' }, true, 'next', t).text).toContain('/srv/web-next')
    // The setup's ticket convention, when on: under <repo>-wt/<ticket>.
    expect(worktreeNote({ root: '/srv/web/', branch: 'trunk' }, true, 'fix/x', t, true).text).toContain(
      '/srv/web-wt/fix-x',
    )
    // From a linked worktree, a ticket worktree goes beside the main checkout, as the launch makes it.
    const inWorktree = { root: '/srv/web-wt/14312', branch: 'feature-y', repo: '/srv/web' }
    expect(worktreeNote(inWorktree, true, 'EA-1', t, true).text).toContain('/srv/web-wt/EA-1')
    expect(worktreeNote(inWorktree, true, 'EA-1', t, true).text).toContain('feature-y')
    expect(worktreeNote(inWorktree, true, 'next', t).text).toContain('/srv/web-wt/14312-next')
    expect(worktreeNote({ root: '/srv/web', branch: 'trunk' }, true, 'a..b', t)).toEqual({
      text: t('launch.err.branch'),
      error: true,
    })
    expect(worktreeNote({ root: '/srv/web', branch: 'trunk' }, false, 'a..b', t)).toEqual({ text: '', error: false })
  })

  test('problems in the order of the form, each in its words', () => {
    const git = { root: 'C:\\Work\\acme', branch: 'main' }
    const all = formProblems(
      fields({ name: ' ', workspace: '', newWorkspace: ' ', wt: true, branch: '' }),
      { ...ok, exists: false },
      git,
      t,
    )
    expect(Object.keys(all)).toEqual(['name', 'cwd', 'workspace', 'worktree'])
    expect(all.cwd).toBe(t('launch.err.cwdMissing', { path: 'C:\\Work\\acme' }))
    expect(formProblems(fields({ name: 'x'.repeat(61) }), ok, null, t).name).toBe(t('launch.err.nameLong', { max: 60 }))
    expect(formProblems(fields({ name: '/acme' }), ok, null, t).name).toBe(t('launch.err.nameStart'))
    expect(formProblems(fields({ name: 'a\u202eb' }), ok, null, t).name).toBe(t('launch.err.nameChars'))
    expect(formProblems(fields({ cwd: '' }), null, null, t).cwd).toBe(t('launch.err.cwdEmpty'))
    expect(formProblems(fields(), { ...ok, dir: false }, null, t).cwd).toBe(
      t('launch.err.cwdFile', { path: ok.path ?? '' }),
    )
    expect(formProblems(fields(), { ...ok, exists: false, slow: true }, null, t).cwd).toContain('answer')
    // An answer without a path (the server refused the request) is no problem the form can name.
    expect(formProblems(fields(), { input: 'x', exists: false }, null, t)).toEqual({})
    // No checkout: the worktree choice does not count.
    expect(formProblems(fields({ wt: true, branch: '' }), ok, null, t)).toEqual({})
  })

  test('the Start button: off without fresh data (and says why), with a problem, while checking or sending', () => {
    expect(goButton({ canMutate: true, problems: {}, checking: false, sending: false }, t)).toEqual({
      disabled: false,
      title: '',
    })
    expect(goButton({ canMutate: false, problems: { name: 'x' }, checking: false, sending: false }, t)).toEqual({
      disabled: true,
      title: t('mobile.readOnly'),
    })
    expect(
      goButton({ canMutate: true, problems: { cwd: 'a', name: 'b' }, checking: false, sending: false }, t).title,
    ).toBe('a')
    expect(goButton({ canMutate: true, problems: {}, checking: true, sending: false }, t).disabled).toBe(true)
    expect(goButton({ canMutate: true, problems: {}, checking: false, sending: true }, t).disabled).toBe(true)
    expect([fieldOf('worktree'), fieldOf('cwd')]).toEqual(['branch', 'cwd'])
  })
})

describe('what is kept and sent', () => {
  test('the draft keeps the workspace by its label, or the new one by its name', () => {
    expect(draftOf(fields({ wt: true, branch: 'b' }), 'acme', 'Acme')).toEqual({
      name: 'acme',
      cwd: 'C:\\Work\\acme',
      category: 'acme',
      message: '',
      workspace: 'Acme',
      newWorkspace: false,
      worktree: { branch: 'b' },
    })
    expect(draftOf(fields({ workspace: '', newWorkspace: 'Fresh ' }), 'acme', 'Acme')).toMatchObject({
      workspace: 'Fresh ',
      newWorkspace: true,
      worktree: null,
    })
  })

  test('the body: trimmed, the folder as the server resolved it when that is about what is typed', () => {
    const resolved = { ...ok, input: 'c:/work/acme', path: 'C:\\Work\\acme' }
    const body = startBody(fields({ name: ' acme ', cwd: 'c:/work/acme ', message: ' hi ', wt: true, branch: ' b ' }), {
      check: resolved,
      git: { root: 'C:\\Work\\acme', branch: 'main' },
      category: 'acme',
      label: 'Acme',
    })
    expect(JSON.stringify(body)).toBe(
      '{"name":"acme","cwd":"C:\\\\Work\\\\acme","category":"acme","workspace":{"id":"w2","label":"Acme"},"message":"hi","worktree":{"branch":"b"}}',
    )
    expect(
      startBody(fields({ cwd: '/elsewhere' }), { check: resolved, git: null, category: 'acme', label: '' }).cwd,
    ).toBe('/elsewhere')
    expect(
      startBody(fields({ workspace: '', newWorkspace: ' Fresh ', wt: true }), {
        check: null,
        git: null,
        category: 'x',
        label: '',
      }),
    ).toMatchObject({ workspace: { create: 'Fresh' } })
    expect('worktree' in startBody(fields({ wt: true }), { check: ok, git: null, category: 'x', label: '' })).toBe(
      false,
    )
  })

  test("the page's own card for a start, until the server has it", () => {
    const body = startBody(fields({ workspace: '', newWorkspace: 'Fresh' }), {
      check: ok,
      git: null,
      category: 'acme',
      label: '',
    })
    expect(startedLaunch('L7', body, 5000)).toMatchObject({
      id: 'L7',
      name: 'acme',
      workspace: 'Fresh',
      newWorkspace: true,
      state: 'starting',
      step: 'prepare',
      startedAt: 5000,
      pane: null,
      key: null,
    })
  })
})

describe("the server's answers, narrowed", () => {
  test('the options: a launcher it knows, the workspaces, what is missing filled in', () => {
    expect(
      asOptions({
        launcher: { kind: 'herdr', agent: 'claude' },
        workspaces: [{ id: 'w1', label: 'A' }, { id: 'w2' }, 'x'],
      }),
    ).toEqual({
      launcher: { kind: 'herdr', agent: 'claude' },
      // A board from before the agent choice: none to pick, Claude Code's start.
      agents: [],
      agent: 'claude',
      workspaces: [
        { id: 'w1', label: 'A' },
        { id: 'w2', label: undefined },
      ],
      focused: '',
      board: '',
      recent: [],
      linkedWorkspaces: false,
    })
    // The agents a start may pick, and the board's default; what is not an agent is left out.
    expect(
      asOptions({
        launcher: { kind: 'herdr', agent: 'claude' },
        agents: [{ id: 'claude', title: 'Claude Code' }, { id: 'pi', title: 'pi', extra: 1 }, { id: '' }, 'pi', null],
        agent: 'pi',
        workspaces: [],
      }),
    ).toMatchObject({
      agents: [
        { id: 'claude', title: 'Claude Code' },
        { id: 'pi', title: 'pi' },
      ],
      agent: 'pi',
    })
    expect(
      asOptions({ launcher: { kind: 'command', name: 'my-cli' }, workspaces: [], recent: ['/a', 3] }),
    ).toMatchObject({
      launcher: { kind: 'command', name: 'my-cli' },
      recent: ['/a'],
    })
    for (const bad of [
      null,
      [],
      { workspaces: [] },
      { launcher: {}, workspaces: [] },
      { launcher: { kind: 'herdr', agent: 'x' } },
    ])
      expect(asOptions(bad)).toBeNull()
  })

  test("a folder listing: what is there kept, what is missing left missing (a refusal's body too)", () => {
    expect(asListing({ error: 'header' })).toEqual({ error: 'header' })
    expect(
      asListing({
        path: 'C:\\Work',
        exists: true,
        dir: true,
        sep: '\\',
        entries: ['a', 1],
        roots: [{ name: '~', path: '/h' }, { name: 1 }],
        git: { root: 'C:\\Work', branch: 'main' },
        error: null,
      }),
    ).toEqual({
      path: 'C:\\Work',
      exists: true,
      dir: true,
      sep: '\\',
      entries: ['a'],
      roots: [{ name: '~', path: '/h' }],
      git: { root: 'C:\\Work', branch: 'main' },
      error: null,
    })
    expect(asListing({ git: null })).toEqual({ git: null })
    expect(asListing('nope')).toBeNull()
  })
})
