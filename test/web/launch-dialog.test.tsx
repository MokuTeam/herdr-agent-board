// The React "new session" window (components/launch) against the old page's launch.js, step by
// step: the old initLaunch as it was at the parity baseline, and the React engine on the window
// <LaunchDialogView> draws, with React's own handlers, both in a fake DOM
// (support/launch-sides.tsx). After every step the window (markup, the inline style its spring
// wrote, the fields), the focus, what was selected or scrolled into view, what went inert, the
// page's new cards, localStorage and every request and toast must be the same. The profile choice
// is new (the old page had no profiles): its tests run the React window alone.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardProfile } from '../../src/core/payload.ts'
import type { LaunchView } from '../../src/core/types.ts'
import type { LaunchContext } from '../../web/src/models/launch-form.ts'
import { LAUNCH_PROFILES } from '../../web/src/models/launch-profile.ts'
import { reducedMotion } from '../../web/src/models/spring.ts'
import { item } from './support/board.tsx'
import type { EventFields } from './support/fake-dom.ts'
import {
  type From,
  type LaunchScene,
  type LaunchSide,
  oldLaunchSide,
  pointRect,
  reactLaunchSide,
} from './support/launch-sides.tsx'

type Step = (side: LaunchSide) => Promise<unknown>

/** Lets the server's answers and their follow-ups come in (no time passes). */
async function idle(side: LaunchSide): Promise<void> {
  for (let i = 0; i < 6; i++) await side.world.flush()
}

async function run(make: () => LaunchSide, steps: Step[]): Promise<string[]> {
  const side = make()
  try {
    const shots: string[] = []
    for (const step of steps) {
      await step(side)
      await idle(side)
      shots.push(side.snapshot())
    }
    await side.world.settle()
    shots.push(side.snapshot())
    return shots
  } finally {
    await side.dispose()
  }
}

/** Both sides the same after every step; returns the baseline's snapshots. */
async function compare(steps: Step[], scene: () => LaunchScene = board): Promise<string[]> {
  const baseline = await run(() => oldLaunchSide(scene()), steps)
  const react = await run(() => reactLaunchSide(scene()), steps)
  expect(react.length).toBe(baseline.length)
  for (const [i, shot] of baseline.entries()) expect(`react step ${i}\n${react[i]}`).toBe(`react step ${i}\n${shot}`)
  return baseline
}

// ---------------------------------------------------------------- the board and the steps

const cat = (id: string, title: string, paths: string[] = []): BoardCategory => ({
  id,
  title,
  color: '#007AFF',
  colorName: 'blue',
  paths,
  configured: true,
  fallback: false,
})
const CATEGORIES = [cat('acme', 'Acme', ['C:\\Work\\acme']), cat('web', 'Web', ['/srv/web']), cat('other', 'Other')]
const SITE = item({ key: 's2', name: 'site', cwd: '/srv/web', category: 'web', workspace: 'Ops', activity: 40 })
const ITEMS = [
  item({ key: 's1', name: 'acme', cwd: 'C:\\Work\\acme', category: 'acme', workspace: 'Acme', activity: 50 }),
  SITE,
]

function board(fields: Partial<LaunchScene> = {}): LaunchScene {
  return {
    t: translator('en'),
    categories: CATEGORIES,
    items: ITEMS,
    launches: [],
    filter: 'all',
    canMutate: true,
    ...fields,
  }
}

const open =
  (ctx: LaunchContext = {}, from: From = 'new-session'): Step =>
  side =>
    side.open(ctx, from)
const tick =
  (ms = 16): Step =>
  side =>
    side.world.tick(ms)
const settle: Step = side => side.world.settle()
const inWindow = (selector: string) => `.launch ${selector}`
const field = (name: string) => inWindow(`[name="${name}"]`)

/** Types `text` into a field (its whole value). */
const type =
  (name: string, text: string): Step =>
  async side => {
    const el = side.el(field(name))
    el.value = text
    await side.world.fire(el, 'input')
  }
const focus =
  (selector: string): Step =>
  async side => {
    const el = side.el(selector)
    el.focus()
    await side.world.fire(el, 'focus')
    await side.world.fire(el, 'focusin')
  }
const blur =
  (selector: string): Step =>
  async side => {
    const el = side.el(selector)
    el.blur()
    await side.world.fire(el, 'blur')
    await side.world.fire(el, 'focusout')
  }
/** A key on what has the focus (or on `selector`). */
const key =
  (k: string, fields: EventFields = {}, selector?: string): Step =>
  async side => {
    const el = selector ? side.el(selector) : side.world.document.activeElement
    if (!el) throw new Error('nothing has the focus')
    await side.world.fire(el, 'keydown', { key: k, ...fields })
  }
const click =
  (selector: string): Step =>
  side =>
    side.world.fire(side.el(selector), 'click')
const press =
  (selector: string): Step =>
  side =>
    side.world.fire(side.el(selector), 'pointerdown')
/** Ticks or unticks a checkbox the way a click does. */
const check =
  (name: string, on: boolean): Step =>
  async side => {
    const el = side.el(field(name))
    el.checked = on
    await side.world.fire(el, 'click')
    await side.world.fire(el, 'change')
  }
/** Picks an option of a select. */
const choose =
  (name: string, value: string): Step =>
  async side => {
    const el = side.el(field(name))
    el.value = value
    await side.world.fire(el, 'input')
    await side.world.fire(el, 'change')
  }
const release =
  (route: string): Step =>
  async side =>
    side.server.release(route)
const hold =
  (route: string): Step =>
  async side =>
    side.server.hold(route)
/** Opens, lets the options and the folder's check come in, and lets the window grow. */
const openAndSettle = (ctx: LaunchContext = {}, from: From = 'new-session'): Step[] => [
  open(ctx, from),
  tick(30),
  tick(160),
  settle,
]

/** Clicks the row of the columns for `path`. */
const clickRow =
  (path: string, type = 'click'): Step =>
  async side => {
    const row = side.world
      .wrap(side.world.body)
      .querySelectorAll('.col-row')
      .find(el => el.getAttribute('data-path') === path)
    if (!row) throw new Error(`no row ${path}`)
    row.focus()
    await side.world.fire(row, type)
  }

const fieldsLine = (shot: string | undefined) => shot?.split('\n').find(line => line.startsWith('fields:')) ?? ''
const logLine = (shot: string | undefined) => shot?.split('\n').find(line => line.startsWith('log:')) ?? ''
const focusLine = (shot: string | undefined) => shot?.split('\n').find(line => line.startsWith('focus:')) ?? ''

const FAILED: LaunchView = {
  id: 'L1',
  name: 'acme fix',
  cwd: 'C:\\Work\\acme',
  category: 'acme',
  workspace: 'Acme',
  workspaceId: 'w2',
  state: 'failed',
  step: 'agent',
  error: 'launcher exited 1',
  kind: 'launcher',
  pane: null,
  key: null,
  startedAt: 100,
  doneAt: null,
  message: 'Fix the invoices',
  worktree: { branch: 'fix-invoices' },
  newWorkspace: false,
}

// ---------------------------------------------------------------- tests

describe('the window opens and grows out of what opened it', () => {
  test('from the toolbar: the first suggestion, its name and lane, the workspaces, the worktree row', async () => {
    const shots = await compare([open(), tick(), tick(), tick(30), tick(160), settle])
    expect(shots[0]).toContain('open: true')
    expect(shots[0]).toContain('focus: section.launch-win')
    expect(shots[0]).toContain('inert: div#page')
    expect(shots[0]).toContain('transform:translate(')
    // The most recent folder comes first (no lane on show), named after itself; its lane is picked by its folder.
    expect(fieldsLine(shots.at(-1))).toContain('name="web" cwd="/srv/web" workspace="w3"')
    expect(shots.at(-1)).toContain('aria-pressed="true" data-cat="web"')
    expect(shots.at(-1)).toContain('class="row wt-row"')
    expect(focusLine(shots.at(-1))).toBe('focus: input[name=name].row-value')
    expect(shots.at(-1)).toContain('selected: input[name=name].row-value')
  })

  test("from a lane's +: the lane's folder, a name not taken yet, the lane's workspace", async () => {
    const shots = await compare(openAndSettle({ category: 'acme' }, 'lane-new'))
    expect(fieldsLine(shots.at(-1))).toContain('name="acme 2" cwd="C:\\\\Work\\\\acme" workspace="w2"')
  })

  test("from a card's New here: the card's folder and workspace", async () => {
    const shots = await compare(openAndSettle({ item: SITE }, 'card'))
    expect(fieldsLine(shots.at(-1))).toContain('cwd="/srv/web" workspace="w3"')
  })

  test('from a menu, in a new workspace: grown out of the point, the new name field first', async () => {
    const shots = await compare(openAndSettle({ newWorkspace: true, category: 'web' }, pointRect(500, 300)))
    expect(fieldsLine(shots.at(-1))).toContain('workspace="" newWorkspace="Web"')
    expect(focusLine(shots.at(-1))).toBe('focus: input[name=newWorkspace]')
  })

  test('from something off screen or nothing: a little drop from below', async () => {
    const far = await compare([open({}, 'far'), tick()])
    expect(far[0]).toContain('transform:translate(0px, 24px) scale(0.94)')
    await compare([open({}, null), tick(), settle])
  })

  test('without fresh data it says why and stays closed', async () => {
    const shots = await compare([open()], () => board({ canMutate: false }))
    expect(shots[0]).toContain('open: false')
    expect(logLine(shots[0])).toContain(`toast error ${translator('en')('mobile.readOnly')}`)
  })

  test('closed before the options came: they are left out', async () => {
    const shots = await compare([hold('options'), open(), key('Escape'), release('options'), settle])
    expect(shots.at(-1)).toContain('open: false')
  })

  test("a command as the launcher, and the page's language", async () => {
    const command: Step = async side => {
      side.server.options = { ...OPTIONS_COMMAND }
    }
    await compare([command, ...openAndSettle()])
    await compare(openAndSettle(), () => board({ t: translator('ru') }))
  })

  test('with reduced motion it shows and goes at once', async () => {
    const motion: { matches: boolean } = reducedMotion
    motion.matches = true
    try {
      const shots = await compare([open(), tick(30), key('Escape')])
      expect(shots[0]).toContain('opacity:1')
      expect(shots.join('\n')).not.toContain('scale(')
      expect(shots.at(-1)).toContain('<div class="launch" hidden>')
    } finally {
      motion.matches = false
    }
  })
})

describe('the folder field', () => {
  test('Windows paths: completion from what is typed, the arrows, Tab and Enter take a folder and go on', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'other' }),
      focus(field('cwd')),
      type('cwd', 'C:\\Wo'),
      key('ArrowDown'),
      key('Tab'),
      type('cwd', 'C:\\Work\\ac'),
      key('ArrowUp'),
      key('ArrowUp'),
      key('Enter'),
      tick(160),
    ])
    expect(shots.join('\n')).toContain('aria-activedescendant="launch-opt-0"')
    expect(shots.join('\n')).toContain('class="active pop-item"')
    expect(fieldsLine(shots.at(-1))).toContain('cwd="C:\\\\Work\\\\acme\\\\"')
  })

  test('forward slashes and a drive in lower case: the server says the folder, a click takes it', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'other' }),
      focus(field('cwd')),
      type('cwd', 'c:/work/be'),
      press(inWindow('.folder-pop')),
      click('#launch-opt-0 .pop-name'),
      tick(160),
      settle,
    ])
    expect(fieldsLine(shots.at(-1))).toContain('cwd="C:\\\\Work\\\\beta\\\\"')
  })

  test('home and the drives while only "~" or a drive letter is typed', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'other' }),
      focus(field('cwd')),
      type('cwd', '~'),
      type('cwd', 'd'),
      key('ArrowDown'),
      key('Enter'),
      tick(160),
    ])
    expect(shots.join('\n')).toContain('<span class="pop-name">Home</span>')
    expect(fieldsLine(shots.at(-1))).toContain('cwd="D:\\\\"')
  })

  test('an offline share, a file, a missing folder: the mark and the note say so', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'other' }),
      type('cwd', '\\\\offline\\share'),
      tick(160),
      type('cwd', 'C:\\Work\\notes.txt'),
      tick(160),
      type('cwd', '/srv/nowhere'),
      tick(100),
      tick(100),
    ])
    expect(shots.join('\n')).toContain('data-state="bad"')
    expect(shots.join('\n')).toContain('data-state="wait"')
  })

  test('the list: down opens it, Esc closes it first, a blur closes it a moment later', async () => {
    const shots = await compare([
      ...openAndSettle(),
      focus(field('cwd')),
      key('Escape'),
      key('ArrowDown'),
      blur(field('cwd')),
      tick(60),
      tick(80),
    ])
    expect(shots[shots.length - 4]).toContain('open: true')
    expect(shots.at(-1)).toContain('class="folder-pop" hidden=""')
  })

  test('an input method composing keeps its Enter and Esc', async () => {
    const shots = await compare([
      ...openAndSettle(),
      focus(field('cwd')),
      key('Enter', { isComposing: true }),
      key('Escape', { keyCode: 229 }),
    ])
    expect(shots.at(-1)).toContain('open: true')
    expect(logLine(shots.at(-1))).not.toContain('POST /api/launch ')
  })
})

describe('browsing the folders in columns', () => {
  test('from the folder typed: its folders down to it; a click opens the next, arrows walk, Enter takes it', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      click(inWindow('.folder-browse')),
      clickRow('C:\\Work\\beta'),
      key('ArrowUp'),
      key('ArrowLeft'),
      key('ArrowRight'),
      key('ArrowDown'),
      key('Enter'),
      tick(160),
    ])
    expect(shots[shots.length - 9]).toContain('aria-label="This computer"')
    expect(shots.join('\n')).toContain('class="col-row on"')
    expect(focusLine(shots.at(-1))).toBe('focus: input[name=cwd]')
  })

  test('a folder it may not read, a double click, Browse again, Esc closes the columns first', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'other' }),
      type('cwd', 'C:\\Users\\me\\private'),
      tick(160),
      click(inWindow('.folder-browse')),
      clickRow('C:\\Users\\me\\notes', 'dblclick'),
      click(inWindow('.folder-browse')),
      key('Escape', {}, field('cwd')),
      key('Escape', {}, field('cwd')),
    ])
    expect(shots.join('\n')).toContain('No access')
    expect(shots[shots.length - 3]).toContain('open: true')
    expect(shots.at(-1)).toContain('open: false')
  })

  test('the columns stay open for the next opening, as before', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      click(inWindow('.folder-browse')),
      click(inWindow('.launch-cancel')),
      settle,
      ...openAndSettle({ category: 'web' }, 'lane-new'),
    ])
    expect(shots.at(-1)).toContain('class="folder-cols">')
  })
})

describe('the form', () => {
  test('a category picked, the name typed (and its branch), a worktree with a good and a bad branch', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      click(inWindow('[data-cat="web"]')),
      type('name', 'Счета Acme'),
      check('wt', true),
      type('branch', 'bad..name'),
      type('branch', 'fix/invoices'),
      check('wt', false),
    ])
    expect(fieldsLine(shots[shots.length - 6])).toContain('branch="scheta-acme"')
    expect(shots.join('\n')).toContain('New branch from main, checked out in C:\\Work\\acme-scheta-acme')
    expect(shots.join('\n')).toContain('class="error field-note wt-note"')
  })

  test('a new workspace: its default name, put in the field; then back to one of herdr', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      choose('workspace', ''),
      type('newWorkspace', ''),
      key('Enter', { ctrlKey: true }),
      type('newWorkspace', 'Invoices'),
      choose('workspace', 'w3'),
    ])
    expect(focusLine(shots[shots.length - 5])).toBe('focus: input[name=newWorkspace]')
    expect(shots.join('\n')).toContain('Name the new workspace')
  })

  test('what a start lacks: a name, its first character, the folder; the first problem gets the focus', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      type('name', ''),
      key('Enter', {}, field('name')),
      type('name', '-acme'),
      click(inWindow('.launch-go')),
      type('name', 'acme'),
      type('cwd', ''),
      key('Enter', { metaKey: true }),
    ])
    expect(focusLine(shots[shots.length - 6])).toBe('focus: input[name=name].row-value')
    expect(focusLine(shots.at(-1))).toBe('focus: input[name=cwd]')
  })

  test('fresh data going away: Start goes gray with why; back: on again', async () => {
    const goStale: Step = async side => {
      side.scene.canMutate = false
      await side.sync()
    }
    const goFresh: Step = async side => {
      side.scene.canMutate = true
      await side.sync()
    }
    const shots = await compare([...openAndSettle({ category: 'acme' }, 'lane-new'), goStale, goFresh])
    expect(shots[shots.length - 3]).toContain(`disabled="" title="${translator('en')('mobile.readOnly')}`)
  })
})

describe('starting', () => {
  test('Ctrl+Enter starts: the body, the last workspace kept, the card drawn, the window folds into it', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      type('message', 'Fix the invoices'),
      check('wt', true),
      key('Enter', { ctrlKey: true }),
      tick(),
      settle,
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
    ])
    const sent = logLine(shots.at(-1))
    expect(sent).toContain(
      'POST /api/launch {"name":"acme 2","cwd":"C:\\\\Work\\\\acme","category":"acme","workspace":{"id":"w2","label":"Acme"},"message":"Fix the invoices","worktree":{"branch":"acme-2"}}',
    )
    expect(sent).toContain('started L7')
    expect(shots.at(-1)).toContain('storage: [["board.launch.workspace","w2"]]')
    expect(shots.at(-1)).toContain('data-key="launch:L7"')
    // Started: no draft is left; the next window starts afresh.
    expect(fieldsLine(shots.at(-1))).toContain('message=""')
  })

  test('Enter in the name field or the folder field starts; a folder not checked yet is checked first', async () => {
    await compare([...openAndSettle({ category: 'acme' }, 'lane-new'), key('Enter', {}, field('name')), settle])
    await compare([
      ...openAndSettle({ category: 'other' }),
      type('cwd', '/srv/web/app'),
      key('Enter', {}, field('cwd')),
      settle,
    ])
  })

  test('refused about a field: its note and the focus; refused otherwise: under the form', async () => {
    const refuse =
      (reply: { status: number; body: unknown }): Step =>
      async side => {
        side.server.start = reply
      }
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      refuse({ status: 400, body: { ok: false, field: 'worktree', error: 'That branch exists' } }),
      check('wt', true),
      key('Enter', { ctrlKey: true }),
      refuse({ status: 500, body: { error: 'herdr is not running' } }),
      key('Enter', { ctrlKey: true }),
    ])
    expect(shots.join('\n')).toContain('That branch exists')
    expect(focusLine(shots[shots.length - 3])).toBe('focus: input[name=branch]')
    expect(shots.at(-1)).toContain('<p class="launch-error" role="alert">herdr is not running</p>')
  })

  test('closed while the start was on its way: it still counts, and a refusal is a toast', async () => {
    const refuse: Step = async side => {
      side.server.start = { status: 409, body: { ok: false, error: 'busy' } }
    }
    const started = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      hold('launch'),
      key('Enter', { ctrlKey: true }),
      key('Escape'),
      settle,
      release('launch'),
      settle,
    ])
    expect(logLine(started.at(-1))).toContain('started L7')
    expect(started.at(-1)).toContain('<div class="launch" hidden>')
    // Still folding away when the answer comes: the window shows it, as before.
    const folding = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      refuse,
      hold('launch'),
      key('Enter', { ctrlKey: true }),
      key('Escape'),
      release('launch'),
    ])
    expect(logLine(folding.at(-1))).not.toContain('toast')
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      refuse,
      hold('launch'),
      key('Enter', { ctrlKey: true }),
      key('Escape'),
      settle,
      release('launch'),
    ])
    expect(logLine(shots.at(-1))).toContain('toast error busy')
  })

  test('a failed launch started again: its values, its title; started, the old one is dismissed', async () => {
    const shots = await compare(
      [...openAndSettle({ retry: FAILED }, 'card'), key('Enter', { ctrlKey: true }), settle],
      () => board({ launches: [FAILED] }),
    )
    expect(shots[0]).toContain('Start it again')
    expect(fieldsLine(shots[3])).toContain(
      'name="acme fix" cwd="C:\\\\Work\\\\acme" workspace="w2" newWorkspace="" branch="fix-invoices" message="Fix the invoices" wt=true',
    )
    expect(logLine(shots.at(-1))).toContain('POST /api/launch/L1/dismiss {}')
  })
})

describe('closing', () => {
  test('Esc, Cancel and the close button fold it back; its form stays as the draft of its place', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      type('name', 'Invoices'),
      type('message', 'Look at March'),
      key('Escape'),
      settle,
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      click(inWindow('.launch-close')),
      settle,
      ...openAndSettle({ category: 'web' }, 'lane-new'),
      click(inWindow('.launch-cancel')),
      settle,
    ])
    expect(shots[7]).toContain('open: false')
    expect(fieldsLine(shots[12])).toContain('name="Invoices"')
    expect(fieldsLine(shots[12])).toContain('message="Look at March"')
    expect(fieldsLine(shots[18])).not.toContain('Invoices')
  })

  test('a click beside it closes it, unless something was written', async () => {
    const shots = await compare([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      type('message', 'keep me'),
      click('.launch-scrim'),
      type('message', ''),
      click('.launch-scrim'),
      settle,
    ])
    expect(focusLine(shots[5])).toBe('focus: section.launch-win')
    expect(shots.at(-1)).toContain('focus: button#lane-new.lane-new')
  })

  test('opened again while it folds away: it turns around from where it is', async () => {
    await compare([...openAndSettle(), key('Escape'), tick(), tick(), open({ category: 'web' }, 'lane-new'), settle])
  })
})

// ---------------------------------------------------------------- the profile (the old page had none)

const boardProfile = (id: string, title: string, color: string, hidden = false): BoardProfile => ({
  id,
  title,
  color,
  colorName: 'indigo',
  dir: id === 'default' ? 'C:\\Users\\me\\.claude' : `C:\\Users\\me\\.claude-${id}`,
  hidden,
  inherited: id === 'default',
  exists: true,
  hooks: hidden ? null : true,
  sessions: 1,
  limits: null,
})
const PRIVATE = boardProfile('default', 'Private', '#5856D6')
const WORK = boardProfile('work', 'Work', '#30B0C7')
const PAYROLL = item({
  key: 's3',
  name: 'payroll',
  cwd: 'C:\\Work\\acme',
  category: 'acme',
  workspace: 'Acme',
  activity: 30,
  profile: 'work',
})
/** Private and Work shown; the sessions say which they run in. */
const twoShown = (fields: Partial<LaunchScene> = {}): LaunchScene =>
  board({
    profiles: [PRIVATE, WORK],
    items: [...ITEMS.map(i => ({ ...i, profile: 'default' })), PAYROLL],
    ...fields,
  })

/** The React window alone, for `scene`. */
const react = (steps: Step[], scene: () => LaunchScene = twoShown) => run(() => reactLaunchSide(scene()), steps)
const goLine = (shot: string | undefined) => shot?.match(/<button class="button launch-go primary"[^>]*>/)?.[0] ?? ''
/** The profile beside Start, as the canonical markup prints it (classes sorted, a line each). */
const beside = (title: string, color: string) =>
  `<span class="launch-profile" style="--c:${color}">${title}</span>\n      <button class="button launch-go primary"`
const PROFILE_ROW = '<div class="profile-row row">\n          <span class="row-label">Profile</span>'
const startBodyOf = (shot: string | undefined) =>
  logLine(shot)
    .split(' | ')
    .find(line => line.startsWith('POST /api/launch {'))
    ?.slice('POST /api/launch '.length) ?? ''

describe('the profile', () => {
  test('two shown: Start waits for a profile; a pick enables it, shows it beside Start, and goes in the body', async () => {
    const shots = await react([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      key('Enter', { ctrlKey: true }),
      click(inWindow('[data-profile="work"]')),
      key('Enter', { ctrlKey: true }),
      tick(),
      settle,
    ])
    const waiting = shots[3]
    expect(waiting).toContain(PROFILE_ROW)
    expect(waiting).toContain('aria-pressed="false" data-profile="default"')
    expect(waiting).toContain('aria-pressed="false" data-profile="work"')
    expect(goLine(waiting)).toContain('disabled="" title="Choose a profile"')
    expect(waiting).not.toContain('class="launch-profile"')
    // Ctrl+Enter: nothing goes; the row says why and has the focus.
    expect(logLine(shots[4])).not.toContain('POST /api/launch ')
    expect(shots[4]).toContain('data-for="profile">Choose a profile</p>')
    expect(focusLine(shots[4])).toBe('focus: button[name=profile]')
    // Work picked: pressed, beside Start, Start on.
    expect(shots[5]).toContain('aria-pressed="true" data-profile="work"')
    expect(shots[5]).toContain(beside('Work', '#30B0C7'))
    expect(goLine(shots[5])).not.toContain('disabled')
    expect(startBodyOf(shots.at(-1))).toBe(
      '{"name":"acme 2","cwd":"C:\\\\Work\\\\acme","category":"acme","workspace":{"id":"w2","label":"Acme"},"message":"","profile":"work"}',
    )
    expect(shots.at(-1)).toContain('["board.launch.profiles","{\\"c:/work/acme\\":\\"work\\"}"]')
  })

  test('New here from a Work card: no row, Work beside Start, the body has profile and parent', async () => {
    const shots = await react([...openAndSettle({ item: PAYROLL }, 'card'), key('Enter', { ctrlKey: true }), settle])
    const shown = shots[3]
    expect(shown).not.toContain('profile-row')
    expect(shown).toContain(beside('Work', '#30B0C7'))
    expect(goLine(shown)).not.toContain('disabled')
    expect(startBodyOf(shots.at(-1))).toContain('"profile":"work","parent":"s3"}')
  })

  test('the folder’s last profile is picked next time', async () => {
    const shots = await react([
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      click(inWindow('[data-profile="work"]')),
      key('Enter', { ctrlKey: true }),
      tick(),
      settle,
      ...openAndSettle({ category: 'acme' }, 'lane-new'),
      key('Escape'),
      settle,
      ...openAndSettle({ category: 'web' }, 'lane-new'),
    ])
    const again = shots[11]
    expect(again).toContain('aria-pressed="true" data-profile="work"')
    expect(again).toContain(beside('Work', '#30B0C7'))
    expect(goLine(again)).not.toContain('disabled')
    // Another folder: nothing picked.
    expect(shots.at(-1)).not.toContain('aria-pressed="true" data-profile=')
    expect(goLine(shots.at(-1))).toContain('title="Choose a profile"')
  })

  test('another folder and Ctrl+Enter before its check: the profile it brings is shown, not sent', async () => {
    const remembered: Step = async side => {
      side.world.storage.set(LAUNCH_PROFILES, JSON.stringify({ '/srv/web': 'default', 'c:/work/acme': 'work' }))
    }
    const shots = await react([
      remembered,
      ...openAndSettle({ category: 'web' }, 'lane-new'),
      type('cwd', 'C:\\Work\\acme'),
      key('Enter', { ctrlKey: true }),
      settle,
      key('Enter', { ctrlKey: true }),
      tick(),
      settle,
    ])
    // Private beside Start, from the lane's folder, also once the other folder is typed (not checked yet).
    for (const shot of [shots[4], shots[5]]) {
      expect(shot).toContain('aria-pressed="true" data-profile="default"')
      expect(shot).toContain(beside('Private', '#5856D6'))
      expect(logLine(shot)).not.toContain('POST /api/launch ')
    }
    expect(fieldsLine(shots[5])).toContain('cwd="C:\\\\Work\\\\acme"')
    // Ctrl+Enter checks the folder, which brings Work: nothing goes, Work shows beside Start.
    for (const shot of [shots[6], shots[7]]) {
      expect(logLine(shot)).toContain('POST /api/fs/dirs {"path":"C:\\\\Work\\\\acme","git":true}')
      expect(logLine(shot)).not.toContain('POST /api/launch ')
      expect(shot).toContain('aria-pressed="true" data-profile="work"')
      expect(shot).toContain('aria-pressed="false" data-profile="default"')
      expect(shot).toContain(beside('Work', '#30B0C7'))
      expect(goLine(shot)).not.toContain('disabled')
    }
    // Pressed again, with Work shown: Work goes.
    const sent = logLine(shots.at(-1))
      .split(' | ')
      .filter(line => line.startsWith('POST /api/launch {'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"cwd":"C:\\\\Work\\\\acme"')
    expect(sent[0]).toContain('"profile":"work"}')
  })

  test('a card whose profile is unknown, or a refusal about the profile: the choice, nothing picked or sent unasked', async () => {
    const refuse: Step = async side => {
      side.server.start = {
        status: 400,
        body: { ok: false, field: 'profile', error: 'The profile of acme is not one the board knows: choose one' },
      }
    }
    const accept: Step = async side => {
      side.server.start = { status: 200, body: { ok: true, id: 'L7' } }
    }
    // A folder no profile has: nothing picked; the pick goes with the card, for the server to check.
    const elsewhere = item({ ...PAYROLL, profile: null, profileFolder: 'D:\\elsewhere' })
    const unknown = await react(
      [
        ...openAndSettle({ item: elsewhere }, 'card'),
        click(inWindow('[data-profile="default"]')),
        key('Enter', { ctrlKey: true }),
        settle,
      ],
      () => twoShown({ items: [elsewhere] }),
    )
    expect(unknown[3]).toContain(PROFILE_ROW)
    expect(unknown[3]).not.toContain('aria-pressed="true" data-profile=')
    expect(goLine(unknown[3])).toContain('disabled=""')
    expect(startBodyOf(unknown.at(-1))).toContain('"profile":"default","parent":"s3"}')

    // One shown (Work hidden), a card with no report: as before profiles, until the server asks.
    const teammate = () =>
      board({ profiles: [PRIVATE, { ...WORK, hidden: true }], items: ITEMS.map(i => ({ ...i, profile: null })) })
    const card = ITEMS[0]
    if (!card) throw new Error('no card')
    const shots = await react(
      [
        ...openAndSettle({ item: { ...card, profile: null } }, 'card'),
        refuse,
        key('Enter', { ctrlKey: true }),
        key('Enter', { ctrlKey: true }),
        accept,
        click(inWindow('[data-profile="default"]')),
        key('Enter', { ctrlKey: true }),
        settle,
      ],
      teammate,
    )
    expect(shots[3]).not.toContain('profile-row')
    expect(shots[3]).not.toContain('launch-profile')
    // Refused: the choice shows, its one profile not picked, the server's words under it.
    expect(shots[5]).toContain(PROFILE_ROW)
    expect(shots[5]).toContain('aria-pressed="false" data-profile="default"')
    expect(shots[5]).not.toContain('data-profile="work"')
    expect(shots[5]).toContain('The profile of acme is not one the board knows: choose one')
    expect(goLine(shots[5])).toContain('disabled="" title="Choose a profile"')
    // Sent twice: as before profiles, then with the profile picked and the card it came from;
    // Ctrl+Enter before the pick sent nothing.
    const sent = logLine(shots.at(-1))
      .split(' | ')
      .filter(line => line.startsWith('POST /api/launch {'))
    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toContain('"profile"')
    expect(sent[0]).not.toContain('"parent"')
    expect(sent[1]).toContain('"profile":"default","parent":"s1"}')
  })
})

const OPTIONS_COMMAND = {
  launcher: { kind: 'command', name: 'my-cli' },
  workspaces: [{ id: 'w2', label: 'Acme' }],
  focused: '',
  board: '',
  recent: [],
  error: '',
}
