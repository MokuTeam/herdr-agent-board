import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  boardMenu,
  cardMenu,
  chipMenu,
  firstIndex,
  isSeparator,
  laneMenu,
  lastIndex,
  launchMenu,
  type MenuEntry,
  type MenuItem,
  nextIndex,
  placeMenu,
  placeSubmenu,
  shareReasons,
  tidy,
  typeahead,
  wantsNativeMenu,
} from '../../web/src/models/menu-model.ts'
import { oldCode, oldFunction } from './support/old-app.ts'

const t = translator('en')
const vp = { width: 1000, height: 700 }

test('a menu opens down and right of the click, flips at the edges, and scrolls when taller than the window', () => {
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, { width: 220, height: 300 }, vp), {
    x: 100,
    y: 100,
    originX: 'left',
    originY: 'top',
    maxHeight: 684,
  })
  // Near the right edge it opens to the left of the pointer, near the bottom above it.
  const corner = placeMenu({ x: 950, y: 650 }, { width: 220, height: 300 }, vp)
  assert.deepEqual([corner.x, corner.y, corner.originX, corner.originY], [730, 350, 'right', 'bottom'])
  // No room either way: pressed against the margin, never off screen.
  const wide = placeMenu({ x: 150, y: 20 }, { width: 900, height: 200 }, { width: 960, height: 700 })
  assert.equal(wide.x, 52)
  // Asked to go up (the session's More, low in its panel): above whenever it fits, else down.
  const up = placeMenu({ x: 100, y: 500 }, { width: 220, height: 300 }, vp, { up: true })
  assert.deepEqual([up.y, up.originY], [200, 'bottom'])
  assert.equal(placeMenu({ x: 100, y: 100 }, { width: 220, height: 300 }, vp, { up: true }).y, 100)
  const tall = placeMenu({ x: 10, y: 300 }, { width: 200, height: 1200 }, vp)
  assert.deepEqual([tall.y, tall.maxHeight], [8, 684])
  for (const p of [
    { x: 0, y: 0 },
    { x: 999, y: 699 },
    { x: 500, y: 350 },
  ]) {
    const m = placeMenu(p, { width: 240, height: 320 }, vp)
    assert.ok(m.x >= 8 && m.x + 240 <= 992 && m.y >= 8 && m.y + 320 <= 692, JSON.stringify(p))
  }
})

test('a submenu opens beside its item, on the left when the right has no room, and moves up at the bottom', () => {
  const parent = { left: 100, right: 320, top: 50, bottom: 400 }
  const item = { top: 120, bottom: 144 }
  assert.deepEqual(placeSubmenu(item, parent, { width: 200, height: 150 }, vp), {
    x: 317,
    y: 115,
    side: 'right',
    maxHeight: 684,
  })
  const right = placeSubmenu(item, { left: 700, right: 920, top: 50, bottom: 400 }, { width: 200, height: 150 }, vp)
  assert.deepEqual([right.x, right.side], [503, 'left'])
  const low = placeSubmenu({ top: 640, bottom: 664 }, parent, { width: 200, height: 150 }, vp)
  assert.equal(low.y, 542)
})

test('keys move over separators and gray items, Home and End, and type to select', () => {
  const items = [
    { label: 'Open' },
    { separator: true },
    { label: 'Sleep', disabled: true },
    { label: 'Status' },
    { label: 'Search' },
    { label: 'Copy' },
  ]
  assert.equal(firstIndex(items), 0)
  assert.equal(lastIndex(items), 5)
  assert.equal(nextIndex(items, 0, 1), 3)
  assert.equal(nextIndex(items, 3, -1), 0)
  assert.equal(nextIndex(items, 5, 1), 0) // wraps
  assert.equal(nextIndex([{ separator: true }], -1, 1), -1)
  assert.equal(typeahead(items, 's', -1), 3) // the gray "Sleep" is passed over
  assert.equal(typeahead(items, 's', 3), 4) // the same letter again: the next one
  assert.equal(typeahead(items, 'ss', 4), 3)
  assert.equal(typeahead(items, 'se', 3), 4)
  assert.equal(typeahead(items, 'x', 3), 3)
})

test('a shared reason goes under the menu once; separators only between groups', () => {
  const r = shareReasons([
    { label: 'A', disabled: true, reason: 'stale' },
    { label: 'B', disabled: true, reason: 'stale' },
    { label: 'C', disabled: true, reason: 'own' },
  ])
  assert.equal(r.note, 'stale')
  assert.deepEqual(
    r.items.map(i => i.reason),
    ['', '', 'own'],
  )
  assert.equal(shareReasons([{ label: 'A', disabled: true, reason: 'one' }]).note, '')
  const sep = { separator: true }
  assert.deepEqual(
    tidy<{ separator?: boolean; label?: string }>([sep, { label: 'A' }, sep, sep, false, { label: 'B' }, sep]),
    [{ label: 'A' }, sep, { label: 'B' }],
  )
})

const categories = [
  { id: 'acme', title: 'Acme', color: '#007AFF' },
  { id: 'other', title: 'Other', color: '#8E8E93' },
]
const real = (items: MenuEntry[] | null | undefined): MenuItem[] =>
  (items ?? []).filter((i): i is MenuItem => !isSeparator(i))
const ids = (items: MenuEntry[] | null | undefined) => real(items).map(i => i.id)
const find = (items: MenuEntry[] | null | undefined, id: string): MenuItem | undefined =>
  real(items).find(i => i.id === id)
const idle = {
  key: 's1',
  session: 's1',
  pane: 'w1:p1',
  name: 'acme',
  cwd: 'C:\\Acme',
  status: 'idle',
  column: 'idle',
  auto: 'idle',
  category: 'acme',
}
const fresh = { t, canMutate: true, canEdit: true, categories, column: 'idle', category: 'acme' }

test('a card’s menu offers a MokuPilot call for a Claude session when MokuPilot is here, also with stale herdr data', () => {
  const claude = { ...idle, agent: 'claude' }
  const m = cardMenu(claude, { ...fresh, mokupilot: true })
  assert.deepEqual(ids(m).slice(0, 4), ['open', 'focus', 'mokupilot', 'write'])
  assert.equal(find(m, 'mokupilot')?.label, 'MokuPilot')
  // It needs the board, not herdr: still there while herdr data is stale.
  assert.equal(
    find(cardMenu(claude, { ...fresh, canMutate: false, mokupilot: true }), 'mokupilot')?.disabled,
    undefined,
  )
  assert.equal(
    find(cardMenu(claude, { ...fresh, canEdit: false, canMutate: false, mokupilot: true }), 'mokupilot')?.disabled,
    true,
  )
  // Not without MokuPilot, nor for a pane with no Claude session, nor for another agent.
  assert.equal(find(cardMenu(claude, fresh), 'mokupilot'), undefined)
  assert.equal(find(cardMenu({ ...claude, session: null }, { ...fresh, mokupilot: true }), 'mokupilot'), undefined)
  assert.equal(find(cardMenu({ ...claude, agent: 'codex' }, { ...fresh, mokupilot: true }), 'mokupilot'), undefined)
})

test('a card’s menu follows its state', () => {
  const m = cardMenu(idle, fresh)
  assert.deepEqual(ids(m), [
    'open',
    'focus',
    'write',
    'sleep',
    'rename',
    'category',
    'status',
    'reveal',
    'changes',
    'history',
    'newHere',
    'copy',
    'clear',
  ])
  assert.equal(real(find(m, 'category')?.submenu).find(c => c.checked)?.id, 'cat:acme')
  assert.deepEqual(ids(find(m, 'status')?.submenu), ['col:me', 'col:ext', 'col:done', 'col:idle'])
  assert.deepEqual(ids(find(m, 'copy')?.submenu), ['copy:name', 'copy:cwd', 'copy:session', 'copy:pane'])

  // Working: it cannot sleep, and says why.
  const working = cardMenu({ ...idle, status: 'working', column: 'work' }, { ...fresh, column: 'work' })
  assert.equal(find(working, 'sleep')?.disabled, true)
  assert.match(find(working, 'sleep')?.reason ?? '', /working/)
  // Asleep: wake instead of sleep, and going there wakes it.
  const asleep = cardMenu({ ...idle, sleeping: true, status: 'sleeping' }, fresh)
  assert.ok(find(asleep, 'wake') && !find(asleep, 'sleep'))
  assert.match(find(asleep, 'focus')?.label ?? '', /Wake/)
  // A question it asked can be waved off; a pinned card can go back to Auto.
  assert.ok(find(cardMenu({ ...idle, attention: 'question', column: 'me' }, fresh), 'dismiss'))
  const pinned = cardMenu({ ...idle, pin: 'done', column: 'done', auto: 'idle' }, { ...fresh, column: 'done' })
  const back = find(pinned, 'status')?.submenu?.at(-1)
  assert.ok(back && !isSeparator(back))
  assert.equal(back.id, 'col:idle')
  assert.equal(back.label, 'Auto')
  // The terminal, where the board offers one: looking needs no fresh data, so it is never gray.
  assert.deepEqual(ids(cardMenu(idle, { ...fresh, terminal: true })).slice(0, 3), ['open', 'focus', 'terminal'])
  assert.equal(find(cardMenu(idle, { ...fresh, terminal: true, canMutate: false }), 'terminal')?.disabled, undefined)
  assert.ok(!find(cardMenu({ ...idle, cwd: '', pane: null }, { ...fresh, terminal: true }), 'terminal'))
  // Not a Claude session (no id): no sleep, no history, no session id to copy.
  const other = cardMenu({ ...idle, session: null, key: 'pane-w1:p2' }, fresh)
  assert.ok(!find(other, 'sleep') && !find(other, 'history'))
  assert.ok(!find(find(other, 'copy')?.submenu, 'copy:session'))
})

test('Restart sits by Put to sleep for a Claude session: also mid-turn, gray while one is on its way or herdr data is stale', () => {
  const claude = { ...idle, agent: 'claude' }
  assert.deepEqual(ids(cardMenu(claude, fresh)).slice(2, 5), ['write', 'sleep', 'restart'])
  // It waits for the turn to end by itself.
  assert.equal(find(cardMenu({ ...claude, status: 'working', column: 'work' }, fresh), 'restart')?.disabled, undefined)
  const pending = find(cardMenu(claude, { ...fresh, restarting: true }), 'restart')
  assert.equal(pending?.disabled, true)
  assert.match(pending?.reason ?? '', /on its way/)
  assert.equal(find(cardMenu(claude, { ...fresh, canMutate: false }), 'restart')?.disabled, true)
  // Asleep, waking it is the restart; another agent, or a pane without a Claude session, has none.
  assert.equal(find(cardMenu({ ...claude, sleeping: true, status: 'sleeping' }, fresh), 'restart'), undefined)
  assert.equal(find(cardMenu({ ...claude, agent: 'codex' }, fresh), 'restart'), undefined)
  assert.equal(find(cardMenu({ ...claude, session: null }, fresh), 'restart'), undefined)
})

test('a card’s menu is upstream’s cardMenu at #58 (Restart, Archive), case by case', () => {
  const was = oldFunction(
    oldCode('web/menu-model.js', ['SEP', 'PIN_COLUMNS', 'COLUMN_COLOR', 'tidy', 'cardMenu'], {}, 'b2c5afa'),
    'cardMenu',
  )
  for (const tr of [t, translator('ru')])
    for (const canMutate of [true, false])
      for (const canEdit of [true, false])
        for (const fields of [
          { agent: 'claude' },
          { agent: 'claude', status: 'working', column: 'work' },
          { agent: 'claude', status: 'blocked', column: 'me' },
          { agent: 'claude', sleeping: true, status: 'sleeping' },
          { agent: 'claude', session: null },
          { agent: 'codex' },
          {},
        ])
          for (const extra of [
            {},
            { restarting: true },
            { restarting: false, mokupilot: true, terminal: true },
            { archiveWhy: 'archive.why.working' },
            { archiveWhy: '' },
          ]) {
            const it = { ...idle, ...fields }
            const c = { ...fresh, ...extra, t: tr, canMutate, canEdit }
            assert.deepEqual(cardMenu(it, c), was(it, c))
          }
})

test('stale herdr data grays what goes through herdr, with the reason once; offline grays card edits too', () => {
  const stale = cardMenu(idle, { ...fresh, canMutate: false })
  for (const id of ['focus', 'sleep', 'newHere']) assert.equal(find(stale, id)?.disabled, true, id)
  for (const id of ['open', 'rename', 'category', 'status', 'clear', 'copy']) {
    assert.ok(find(stale, id), id)
    assert.ok(!find(stale, id)?.disabled, id)
  }
  const { note } = shareReasons(stale)
  assert.match(note, /fresh data from herdr/)
  const offline = cardMenu(idle, { ...fresh, canMutate: false, canEdit: false })
  for (const id of ['rename', 'category', 'status', 'clear']) assert.equal(find(offline, id)?.disabled, true, id)
  assert.equal(find(offline, 'category')?.submenu, null)
  assert.ok(find(offline, 'open') && !find(offline, 'open')?.disabled && !find(offline, 'copy')?.disabled)
})

test('lanes, the board, starting sessions and file chips have menus of their own', () => {
  const [acme] = categories
  assert.ok(acme)
  const lane = laneMenu(acme, { ...fresh, filter: 'all' })
  assert.deepEqual(ids(lane), ['new', 'newWorkspace', 'editCat', 'showOnly'])
  assert.match(find(lane, 'new')?.label ?? '', /Acme/)
  assert.deepEqual(ids(laneMenu(acme, { ...fresh, filter: 'acme' })).at(-1), 'showAll')
  assert.equal(find(laneMenu(acme, { ...fresh, canMutate: false, filter: 'all' }), 'new')?.disabled, true)
  assert.deepEqual(ids(boardMenu({ ...fresh, filter: 'all', sleepers: true })), [
    'new',
    'newWorkspace',
    'cats',
    'archiveOpen',
    'sleepers',
    'search',
  ])
  assert.equal(find(boardMenu({ ...fresh, filter: 'acme', sleepers: false }), 'sleepers')?.checked, false)
  assert.deepEqual(ids(launchMenu({ state: 'failed', pane: 'w1:p3' }, fresh)), [
    'focus',
    'retry',
    'copyError',
    'copy:cwd',
    'dismiss',
  ])
  assert.deepEqual(ids(launchMenu({ state: 'starting', pane: null }, fresh)), ['copy:cwd', 'dismiss'])
  assert.deepEqual(ids(chipMenu({ dir: true }, fresh)), ['look', 'open', 'reveal', 'copyPath', 'newHere'])
  assert.deepEqual(ids(chipMenu({ dir: false }, fresh)), ['look', 'open', 'reveal', 'copyPath'])
})

test('the browser keeps its own menu in fields, on selected text, on links, and with Shift', () => {
  assert.equal(wantsNativeMenu({}), false)
  for (const k of ['shift', 'editable', 'inSelection', 'link']) assert.equal(wantsNativeMenu({ [k]: true }), true, k)
})

test('the model gives what the old page’s menu-model.js gave, case by case', () => {
  const names = [
    'placeMenu',
    'placeSubmenu',
    'usable',
    'nextIndex',
    'firstIndex',
    'lastIndex',
    'typeahead',
    'shareReasons',
    'tidy',
    'SEP',
    'PIN_COLUMNS',
    'COLUMN_COLOR',
    'cardMenu',
    'laneMenu',
    'boardMenu',
    'launchMenu',
    'chipMenu',
    'wantsNativeMenu',
  ]
  const old = oldCode('web/menu-model.js', names, {})
  const was = (name: string, ...args: unknown[]) => oldFunction(old, name)(...args)
  // The board's own menu opens the archive (#56).
  const boardAt56 = oldFunction(oldCode('web/menu-model.js', ['SEP', 'tidy', 'boardMenu'], {}, '2b9e6b7'), 'boardMenu')
  // placeMenu's `up` and margin as an option: the session panel's row (#54).
  const placeAt54 = oldFunction(oldCode('web/menu-model.js', ['placeMenu'], {}, '3105958'), 'placeMenu')
  const ru = translator('ru')
  for (const tr of [t, ru])
    for (const canMutate of [true, false])
      for (const canEdit of [true, false]) {
        const base = { t: tr, canMutate, canEdit }
        for (const fields of [
          {},
          { status: 'working', column: 'work' },
          { status: 'blocked', column: 'me' },
          { sleeping: true, status: 'sleeping' },
          { session: null, pane: null, cwd: '' },
          { attention: 'ask' },
          { attention: 'later', column: 'me' },
          { pin: 'done', column: 'done', auto: 'idle' },
          { pin: 'me', column: 'ext', auto: 'work' },
        ])
          for (const ctx of [fresh, { ...fresh, categories: [] }, { ...fresh, column: 'done', category: 'other' }]) {
            const it = { ...idle, ...fields }
            const c = { ...ctx, ...base }
            assert.deepEqual(cardMenu(it, c), was('cardMenu', it, c))
          }
        for (const filter of ['all', 'acme', 'other'])
          for (const sleepers of [true, false]) {
            const c = { ...base, filter, sleepers }
            for (const cat of categories) assert.deepEqual(laneMenu(cat, c), was('laneMenu', cat, c))
            assert.deepEqual(boardMenu(c), boardAt56(c))
          }
        for (const state of ['starting', 'waiting', 'trust', 'done', 'failed'])
          for (const l of [
            { state, pane: 'w1:p3' },
            { state, pane: null, kind: 'message' },
            { state, kind: 'agent' },
          ])
            assert.deepEqual(launchMenu(l, base), was('launchMenu', l, base))
        for (const dir of [true, false]) assert.deepEqual(chipMenu({ dir }, base), was('chipMenu', { dir }, base))
      }
  const viewports = [vp, { width: 320, height: 480 }, { width: 960, height: 700 }]
  for (const viewport of viewports)
    for (const x of [-5, 0, 7, 100, 500, 700, 950, 999, 1200])
      for (const y of [0, 8, 300, 650, 699])
        for (const size of [
          { width: 220, height: 300 },
          { width: 900, height: 200 },
          { width: 200, height: 1200 },
        ]) {
          assert.deepEqual(placeMenu({ x, y }, size, viewport), was('placeMenu', { x, y }, size, viewport))
          for (const options of [{}, { up: true }, { up: false }, { up: true, margin: 4 }, { margin: 12 }])
            assert.deepEqual(placeMenu({ x, y }, size, viewport, options), placeAt54({ x, y }, size, viewport, options))
          const item = { top: y, bottom: y + 24 }
          const parent = { left: x, right: x + 220, top: 0, bottom: 400 }
          assert.deepEqual(
            placeSubmenu(item, parent, size, viewport),
            was('placeSubmenu', item, parent, size, viewport),
          )
        }
  const sep = { separator: true }
  const items = [
    { label: 'Open' },
    sep,
    { label: 'Sleep', disabled: true, reason: 'busy' },
    { label: 'Status' },
    { label: 'search', disabled: true, reason: 'busy' },
    { label: 'Сон' },
    { label: 'Copy' },
  ]
  for (let from = -1; from < items.length; from++) {
    for (const dir of [1, -1]) assert.equal(nextIndex(items, from, dir), was('nextIndex', items, from, dir))
    for (const typed of ['', 's', 'ss', 'sss', 'st', 'со', 'c', 'x', null])
      assert.equal(typeahead(items, typed, from), was('typeahead', items, typed, from))
  }
  assert.equal(firstIndex([]), was('firstIndex', []))
  assert.equal(lastIndex(items), was('lastIndex', items))
  for (const min of [1, 2, 3]) assert.deepEqual(shareReasons(items, min), was('shareReasons', items, min))
  const loose: ({ separator?: boolean; label?: string } | false | null | '' | undefined)[] = [
    sep,
    sep,
    { label: 'A' },
    false,
    null,
    '',
    sep,
    undefined,
    { label: 'B' },
    sep,
    sep,
  ]
  assert.deepEqual(tidy(loose), was('tidy', loose))
  for (const scene of [{}, { shift: true }, { link: true, editable: false }])
    assert.equal(wantsNativeMenu(scene), was('wantsNativeMenu', scene))
})
