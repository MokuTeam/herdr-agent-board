// A card dragged onto the archive (upstream's #57, 98e1f7a): where a card let go lands on the
// archive's place (models/archive-drop.ts dropsOn), upstream's own test and the same answers as
// upstream's web/archive-model.js at the merge; and the place itself (components/DropArchive.tsx)
// against what upstream's app.js makes of it there (its dropPlace, showDropPlace and the spring
// that brings it up and takes it away), run on a stand-in element, in English and Russian.
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type { ArchiveEntryFacts } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { DROP_SPRING, DropPlace, dropPlaceAt } from '../../web/src/components/DropArchive.tsx'
import { type DropArchiveView, dropsOn, dropWhy } from '../../web/src/models/archive-drop.ts'
import type { SpringOptions } from '../../web/src/models/spring.ts'
import { board, item, renderInBoard } from './support/board.tsx'
import { canonical, parseHtml } from './support/markup.ts'
import { oldCode, oldFunction, oldModule } from './support/old-app.ts'

const MERGE = '98e1f7a'
const OLD_ARCHIVE = await oldModule('web/archive-model.js', MERGE)
const oldDropsOn = oldFunction(OLD_ARCHIVE, 'dropsOn')
const oldArchiveBlock = oldFunction(OLD_ARCHIVE, 'archiveBlock')

describe('dropsOn', () => {
  test('a card dragged onto the archive place: over it (with some slop), or flicked at it from close by', () => {
    const r = { left: 600, right: 820, top: 900, bottom: 956 }
    expect(dropsOn(r, { x: 700, y: 930 })).toBe(true)
    expect(dropsOn(r, { x: 590, y: 890 })).toBe(true) // the slop around it
    expect(dropsOn(r, { x: 700, y: 800 })).toBe(false) // held still above it
    expect(dropsOn(r, { x: 700, y: 800 }, { x: 0, y: 1500 })).toBe(true) // flicked down at it
    expect(dropsOn(r, { x: 700, y: 800 }, { x: 0, y: -1500 })).toBe(false) // flicked away
    expect(dropsOn(r, { x: 700, y: 500 }, { x: 0, y: 9000 })).toBe(false) // too far for a flick to count
  })

  test("the same answers as upstream's: points all around the place, held still or flicked every way", () => {
    const r = { left: 600, right: 820, top: 900, bottom: 956 }
    const speeds = [-3000, -1500, -400, 0, 400, 1500, 3000]
    let checked = 0
    let landed = 0
    const differ: unknown[] = []
    for (let x = 380; x <= 1040; x += 22)
      for (let y = 680; y <= 1180; y += 20)
        for (const vx of speeds)
          for (const vy of speeds) {
            const p = { x, y }
            const v = { x: vx, y: vy }
            const ours = dropsOn(r, p, v)
            if (ours !== oldDropsOn(r, p, v)) differ.push([x, y, vx, vy, ours])
            if (ours) landed++
            checked++
          }
    expect(differ).toEqual([])
    expect(landed).toBeGreaterThan(1000)
    // Without a velocity, and with other slop, reach and deceleration.
    for (const p of [
      { x: 590, y: 890 },
      { x: 560, y: 930 },
      { x: 700, y: 760 },
    ]) {
      expect(dropsOn(r, p)).toBe(oldDropsOn(r, p) === true)
      const options = { pad: 4, reach: 60, rate: 0.998 }
      expect(dropsOn(r, p, { x: 0, y: 800 }, options)).toBe(oldDropsOn(r, p, { x: 0, y: 800 }, options) === true)
    }
    expect(checked).toBeGreaterThan(20_000)
  })
})

// ---------------------------------------------------------------- the place

/** Just enough of an element for upstream's drop place: its classes, attributes, markup, last child's text and style. */
class StandIn {
  className = ''
  innerHTML = ''
  readonly attrs = new Map<string, string>()
  readonly lastElementChild: { textContent: string | null } = { textContent: null }
  readonly style = { opacity: '', transform: '' }
  readonly classList = {
    contains: (name: string): boolean => this.className.split(' ').includes(name),
    add: (name: string): void => {
      if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim()
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter(n => n && n !== name)
        .join(' ')
    },
    toggle: (name: string, on: boolean): void => (on ? this.classList.add(name) : this.classList.remove(name)),
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  /** As the page would serialize it: the last child (the span) with the text it was given. */
  get outerHTML(): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')
    const span = `<span>${esc(this.lastElementChild.textContent ?? '')}</span>`
    return `<div class="${this.className}"${attrs}>${this.innerHTML.replace(/<span><\/span>$/, span)}</div>`
  }
}

interface OldPlace {
  place: StandIn
  /** The spring upstream made for it: its options, and where it was last sent. */
  spring: { options: SpringOptions; target: number | null }
  show(it: Item): string
}

/** Upstream's place at the merge (app.js), made on a stand-in element, its spring a recorder. */
function oldPlace(lang: string, schedules: ArchiveEntryFacts[], canMutate: boolean, canEdit: boolean): OldPlace {
  const place = new StandIn()
  const made: OldPlace['spring'][] = []
  class Spring {
    target: number | null = null
    constructor(readonly options: SpringOptions) {
      made.push(this)
    }
    to(v: number): void {
      this.target = v
    }
  }
  const code = oldCode(
    'web/app.js',
    [
      'ICON',
      'dropPlace',
      { statement: 'dropPlace.className' },
      { statement: 'dropPlace.setAttribute' },
      { statement: 'dropPlace.innerHTML' },
      { statement: 'document.body.append(dropPlace)' },
      'dropShown',
      'showDropPlace',
    ],
    {
      document: { createElement: () => place, body: { append: () => {} } },
      Spring,
      archiveBlock: oldArchiveBlock,
      state: { data: { schedules } },
      canMutate: () => canMutate,
      canEdit: () => canEdit,
      t: translator(lang),
    },
    MERGE,
  )
  const spring = made[0]
  if (!spring) throw new Error('no spring for the drop place')
  const show = oldFunction(code, 'showDropPlace')
  return { place, spring, show: it => String(show(it)) }
}

const newPlace = (lang: string, view: DropArchiveView | null, on: boolean): string =>
  canonical(renderInBoard(createElement(DropPlace, { view, on }), board(), lang))

const oldMarkup = (place: StandIn): string => canonical(parseHtml(place.outerHTML))

const FREE = item({ key: 'a', agent: 'claude' })

interface PlaceScene {
  it?: Item
  schedules?: ArchiveEntryFacts[]
  canMutate?: boolean
  canEdit?: boolean
}

const SCENES: [string, PlaceScene][] = [
  ['a session that may go', {}],
  ['a session at work', { it: item({ key: 'a', agent: 'claude', status: 'working' }) }],
  ['a session with a dialog in its terminal', { it: item({ key: 'a', agent: 'claude', status: 'blocked' }) }],
  ['a shell, not Claude', { it: item({ key: 'a', agent: 'shell' }) }],
  ['a session restarting', { schedules: [{ key: 'a', kind: 'restart', step: 'sleep' }] }],
  ['a read-only board', { canMutate: false }],
  ['an offline board', { canMutate: false, canEdit: false }],
]

describe("the archive's place", () => {
  for (const lang of ['en', 'ru']) {
    test(`before any drag: not drawn, no text (${lang})`, () => {
      const old = oldPlace(lang, [], true, true)
      expect(newPlace(lang, null, false)).toBe(oldMarkup(old.place))
    })

    for (const [name, s] of SCENES)
      test(`up with the drag, over it, going, gone: ${name} (${lang})`, () => {
        const it = s.it ?? FREE
        const schedules = s.schedules ?? []
        const canMutate = s.canMutate ?? true
        const canEdit = s.canEdit ?? true
        const old = oldPlace(lang, schedules, canMutate, canEdit)
        const why = dropWhy(it, schedules, canMutate, canEdit)
        // The drag starts: it comes up, saying why the session may not go (upstream's showDropPlace).
        expect(old.show(it)).toBe(why)
        expect(old.spring.target).toBe(1)
        expect(newPlace(lang, { up: true, over: false, why }, true)).toBe(oldMarkup(old.place))
        // The card over it (onDragMove).
        old.place.classList.toggle('over', true)
        expect(newPlace(lang, { up: true, over: true, why }, true)).toBe(oldMarkup(old.place))
        // Let go: it goes, still drawn as it was until its spring rests (onDragEnd).
        old.spring.target = 0
        expect(newPlace(lang, { up: false, over: true, why }, true)).toBe(oldMarkup(old.place))
        // Gone: no longer drawn (the spring's onRest at 0).
        old.spring.options.onRest?.(0)
        expect(newPlace(lang, { up: false, over: true, why }, false)).toBe(oldMarkup(old.place))
        // The next drag: off the card's place again.
        old.show(it)
        expect(newPlace(lang, { up: true, over: false, why }, true)).toBe(oldMarkup(old.place))
      })
  }

  test("why a session may not go: the archive's own reasons, then a board that cannot act", () => {
    expect(dropWhy(FREE, [], true, true)).toBe('')
    expect(dropWhy(item({ key: 'a', agent: 'claude', status: 'working' }), [], false, false)).toBe(
      'archive.why.working',
    )
    expect(dropWhy(FREE, [], false, true)).toBe('mobile.readOnly')
    expect(dropWhy(FREE, [], false, false)).toBe('live.off')
    expect(dropWhy(undefined, [], true, true)).toBe('archive.why.starting')
  })

  test("its spring: upstream's, and the same rise and growth on the way", () => {
    const old = oldPlace('en', [], true, true)
    const { damping, response, precision } = old.spring.options
    expect({ damping, response, precision }).toEqual(DROP_SPRING)
    for (const v of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.04]) {
      old.spring.options.onUpdate?.(v)
      const style = { opacity: '', transform: '' }
      dropPlaceAt(style, v)
      expect(style).toEqual(old.place.style)
    }
  })
})
