// The session panel's row fitted to its width (hooks/useActionRow.ts, its DOM side) against
// upstream's own fitActions at #58's merge (web/app.js), on the same fake row: the buttons' widths
// come from their words, the row's `.icons` and `.measuring`, and `.over` hides a button as
// upstream's stylesheet does.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { fitActions, NOT_MEASURED, PRIORITY, type RowWidths, rowButtons } from '../../web/src/hooks/useActionRow.ts'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { oldCode, oldFunction, oldModule } from './support/old-app.ts'
import { asDom } from './support/react-commit.ts'

const MERGE = 'b2c5afa'
const WORDS: Record<string, string> = {
  'sheet-focus': 'Go to herdr',
  'sheet-mokupilot': 'MokuPilot',
  'sheet-term': 'Terminal',
  'sheet-changes': 'Changes',
  'sheet-history': 'History',
  'sheet-wake': 'Wake',
  'sheet-sleep': 'Sleep',
  'sheet-restart': 'Restart',
  'sheet-archive': 'Archive',
  'sheet-new': 'New session here',
}
// Upstream's row: Fork is the React board's own, drawn only where the board can fork.
const UPSTREAM = PRIORITY.filter(id => id in WORDS)
const PAGE = `<div id="sheet"><div class="composer-actions">${UPSTREAM.map(
  id => `<button class="button" id="${id}"><svg></svg><span>${WORDS[id]}</span></button>`,
).join('')}<button class="button" id="sheet-more"><svg></svg></button></div></div>`

let world: FakeWorld
let room = 0
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1200, h: 800 }, computed: el => computed(el) })
  world.install()
  for (const node of parseHtml(PAGE)) if (node.kind === 'element') world.mount(node)
})
afterEach(() => world.uninstall())

const page = (id: string): FakeElement => {
  const el = world.document.getElementById(id)
  if (!el) throw new Error(`no #${id}`)
  return el
}
const actions = (): FakeElement => {
  const el = world.document.querySelector('#sheet .composer-actions')
  if (!el) throw new Error('no row')
  return el
}

/** What the stylesheet would make of it: 8 px a letter and 26 px of icon and padding, 30 px an icon. */
function computed(el: FakeElement): Record<string, string> {
  if (el.className.includes('composer-actions')) return { width: `${room}px`, columnGap: '6px' }
  if (el.tagName !== 'BUTTON') return {}
  const row = actions().classList
  if (el.classList.contains('over') && !row.contains('measuring')) return { width: 'auto' }
  if (el.id === 'sheet-more' || (row.contains('icons') && el.id !== 'sheet-focus')) return { width: '30px' }
  return { width: `${26 + 8 * el.textContent.trim().length}px` }
}

/** The row as the classes have it: icons or words, and what is left to More. */
const classes = () => ({
  icons: actions().classList.contains('icons'),
  over: [...UPSTREAM, 'sheet-more'].filter(id => !page(id).hidden && page(id).classList.contains('over')),
})

test('the row shows as many as fit and More the rest, as upstream’s fitActions has it, width by width', async () => {
  const fitRow = (await oldModule('web/row-model.js', MERGE)).get('fitRow')
  const narrowSheet = { matches: false }
  const old = oldFunction(
    oldCode(
      'web/app.js',
      ['PRIORITY', 'actionRow', 'fitActions'],
      {
        $: (selector: string) => world.document.querySelector(selector),
        document: world.document,
        narrowSheet,
        fitRow,
        rowWidths: { key: '' },
      },
      MERGE,
    ),
    'fitActions',
  )
  let widths: RowWidths = NOT_MEASURED
  const ours = (narrow: boolean) => {
    const fit = fitActions(asDom(actions()), rowButtons(asDom(actions()), narrow), widths)
    if (!fit) return null
    widths = fit.widths
    return { icons: fit.shown.icons, over: [...UPSTREAM, 'sheet-more'].filter(id => fit.shown.over.has(id)) }
  }
  const hide = (...ids: string[]) => {
    for (const id of ids) page(id).hidden = true
  }
  const scenes: (() => void)[] = [
    () => {}, // all of them
    () => hide('sheet-mokupilot', 'sheet-changes'), // no MokuPilot, not in git
    () => hide('sheet-sleep', 'sheet-restart'), // asleep
    () => {
      // another language: other words, other widths
      const span = page('sheet-focus').querySelector('span')
      if (span) span.textContent = 'Перейти в herdr'
    },
    () => hide('sheet-term'), // no terminal
  ]
  let checked = 0
  let roomForMore = 0
  for (const change of scenes) {
    change()
    for (const narrow of [false, true]) {
      narrowSheet.matches = narrow
      for (room = 0; room <= 1100; room += 9) {
        old()
        const theirs = room ? classes() : null
        const mine = ours(narrow)
        checked++
        if (
          !narrow ||
          page('sheet-term').hidden ||
          !mine ||
          !theirs ||
          JSON.stringify(mine) === JSON.stringify(theirs)
        ) {
          expect(mine).toEqual(theirs)
          continue
        }
        // On a phone the terminal is always under More, so More is always on the row: upstream left
        // it no room when the rest fit, and the row ran off the panel (#100). Here one more goes to More.
        expect(mine.icons).toBe(theirs.icons)
        expect(theirs.over.every(id => mine.over.includes(id))).toBe(true)
        expect(mine.over.length).toBe(theirs.over.length + 1)
        roomForMore++
      }
    }
  }
  expect(checked).toBeGreaterThan(1000)
  expect(roomForMore).toBeGreaterThan(0)
})

test('the widths are taken once per set of buttons, language and layout; the row’s classes stay as they were', () => {
  room = 500
  actions().classList.add('icons')
  const first = fitActions(asDom(actions()), rowButtons(asDom(actions()), false), NOT_MEASURED)
  expect(actions().className).toBe('composer-actions icons')
  expect(first?.widths.buttons[0]).toEqual({
    words: 26 + 8 * 'Go to herdr'.length,
    icon: 26 + 8 * 'Go to herdr'.length,
  })
  expect(first?.widths.buttons[1]).toEqual({ words: 26 + 8 * 'MokuPilot'.length, icon: 30 })
  expect(first?.widths.more).toBe(30)
  room = 300
  const again = first && fitActions(asDom(actions()), rowButtons(asDom(actions()), false), first.widths)
  expect(again?.widths).toBe(first?.widths)
  // On a phone the Terminal stays under More: another set, measured anew, and it is over.
  const phone = first && fitActions(asDom(actions()), rowButtons(asDom(actions()), true), first.widths)
  expect(phone?.widths).not.toBe(first?.widths)
  expect(phone?.widths.buttons).toHaveLength(9)
  room = 2000
  const wide = fitActions(asDom(actions()), rowButtons(asDom(actions()), true), NOT_MEASURED)
  expect([...(wide?.shown.over ?? [])]).toEqual(['sheet-term'])
  // Everything fits: More goes.
  const all = fitActions(asDom(actions()), rowButtons(asDom(actions()), false), NOT_MEASURED)
  expect(all?.shown).toEqual({ icons: false, over: new Set(['sheet-more']) })
  // Not laid out: nothing to say.
  room = 0
  expect(fitActions(asDom(actions()), rowButtons(asDom(actions()), false), NOT_MEASURED)).toBeNull()
})

test('Fork, where the board draws it, is measured with the rest and has its place after the call', () => {
  const fork = world.document.createElement('button')
  fork.id = 'sheet-fork'
  fork.className = 'button'
  fork.textContent = 'Fork'
  page('sheet-mokupilot').after(fork)
  const buttons = rowButtons(asDom(actions()), false)
  expect(buttons.row.map(el => el.id).slice(0, 4)).toEqual([
    'sheet-focus',
    'sheet-mokupilot',
    'sheet-fork',
    'sheet-term',
  ])
  room = 2000
  const all = fitActions(asDom(actions()), buttons, NOT_MEASURED)
  expect(all?.widths.buttons[2]).toEqual({ words: 26 + 8 * 'Fork'.length, icon: 30 })
  // Room for the first three with their words and the rest as icons: Fork is not left to More.
  room = 26 + 8 * 'Go to herdr'.length + 30 * 9 + 30 + 6 * 10
  const tight = fitActions(asDom(actions()), buttons, NOT_MEASURED)
  expect(tight?.shown.over.has('sheet-fork')).toBe(false)
})
