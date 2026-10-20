// The toolbar's segmented controls folded and unfolded in a fake row (hooks/useSegmentFolds.ts,
// its DOM side, support/fake-dom.ts): the row lays them out as the stylesheet would, one line
// shrinking its segments alike when they do not fit (the wide toolbar), or each control on a
// line of its own (a phone). Folded, a control's segments stay in the row, hidden, with its pill
// beside them, as React draws it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { segmentFoldIn } from '../../web/src/hooks/useSegmentFolds.ts'
import { FOLD_SLACK, withFold } from '../../web/src/models/segment-fold.ts'
import { box, type FakeElement, FakeWorld, type RectBox } from './support/fake-dom.ts'
import { canonical, parseHtml } from './support/markup.ts'
import { asDom } from './support/react-commit.ts'

const GAP = 6
/** Each pill's width: the choice on show, its count and the chevron. */
const PICK: Record<string, number> = { 'lanes-pick': 110, 'profiles-pick': 100 }

interface Scene {
  /** All of each control's segments at full size. */
  natural: Record<string, number>
  /** The row's room for the controls. */
  room: number
  /** Each control on a line of its own, 100% of it (a phone, app.css at 560px). */
  lines?: boolean
}

let world: FakeWorld
let scene: Scene = { natural: {}, room: 0 }
let row: FakeElement | null = null
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1440, h: 900 }, rects: el => rectOf(el) })
  world.install()
})
afterEach(() => world.uninstall())

const px = (value: unknown): number | null => {
  const m = /^([\d.]+)px$/.exec(String(value ?? ''))
  return m ? Number(m[1]) : null
}

/** What a flex item asks for, and whether it may shrink. */
function basis(el: FakeElement): { width: number; shrinks: boolean } {
  const pick = PICK[el.id]
  if (pick !== undefined) return { width: pick, shrinks: false }
  const natural = scene.natural[el.id] ?? 0
  if (el.style.width === 'max-content') return { width: natural, shrinks: el.style.flex !== 'none' }
  return { width: px(el.style.width) ?? natural, shrinks: el.style.flex !== 'none' }
}

/** The widths the row gives its controls as they are drawn now. */
function layout(): Map<FakeElement, number> {
  const items = row?.querySelectorAll('.controls .segmented, .controls .segment-pick').filter(el => !el.hidden) ?? []
  const widths = new Map<FakeElement, number>()
  if (scene.lines) {
    // Segments take their line whole (and no more, max-width) unless told otherwise; the pills
    // share one at their own widths.
    for (const el of items) {
      const own = basis(el).width
      if (!el.classList.contains('segmented')) widths.set(el, Math.min(own, scene.room))
      else widths.set(el, el.style.flex === 'none' ? own : scene.room)
    }
    return widths
  }
  const asked = items.map(basis)
  const total = asked.reduce((sum, a) => sum + a.width, 0) + GAP * Math.max(0, items.length - 1)
  const over = Math.max(0, total - scene.room)
  const shrinking = asked.filter(a => a.shrinks).reduce((sum, a) => sum + a.width, 0)
  items.forEach((el, i) => {
    const a = asked[i] ?? { width: 0, shrinks: false }
    widths.set(el, a.shrinks && shrinking ? Math.max(0, a.width - (over * a.width) / shrinking) : a.width)
  })
  return widths
}

function rectOf(el: FakeElement): RectBox | null {
  const width = layout().get(el)
  return width === undefined ? null : box(0, 0, width, 28)
}

/** The row as React draws it with `folded` folded. */
function draw(folded: ReadonlySet<string>): FakeElement {
  row?.remove()
  const control = (id: string, cls: string) =>
    `<div class="${cls}" id="${id}" role="tablist"${folded.has(id) ? ' hidden=""' : ''}><span class="thumb"></span><button role="tab">${id}</button></div>` +
    (folded.has(id) ? `<button class="pill-toggle segment-pick" id="${id}-pick">${id}</button>` : '')
  const markup = `<div class="toolbar-row"><div class="titles"></div><div class="controls"><button class="pill-toggle icon-only" id="new-session"></button>${control('lanes', 'segmented')}${control('profiles', 'segmented profiles')}<label class="search"></label></div></div>`
  const [node] = parseHtml(markup)
  if (node?.kind !== 'element') throw new Error('no row')
  const el = world.mount(node)
  row = el
  for (const seg of el.querySelectorAll('.segmented'))
    Object.defineProperty(seg, 'scrollWidth', {
      get: () => Math.max(scene.natural[seg.id] ?? 0, Math.round(seg.clientWidth)),
      configurable: true,
    })
  return el
}

/**
 * The row folded and unfolded until it rests, a change at a time as the hook draws them, from
 * `folded`: each change, and the controls folded at the end.
 */
function settle(folded: string[] = []): { changes: string[]; folded: string[] } {
  let now: ReadonlySet<string> = new Set(folded)
  const changes: string[] = []
  for (let i = 0; i < 8; i++) {
    const change = segmentFoldIn(asDom(draw(now)))
    if (!change) return { changes, folded: [...now].sort() }
    changes.push(`${change.folded ? 'fold' : 'unfold'} ${change.id}`)
    now = withFold(now, change.id, change.folded)
  }
  throw new Error(`no rest: ${changes.join(', ')}`)
}

const NATURAL = { lanes: 240, profiles: 254 }
const BOTH = NATURAL.lanes + GAP + NATURAL.profiles

describe('in one row, shrinking alike', () => {
  test('room for every segment of both: neither folds', () => {
    scene = { natural: NATURAL, room: BOTH }
    expect(settle()).toEqual({ changes: [], folded: [] })
    scene = { natural: NATURAL, room: 1440 }
    expect(settle()).toEqual({ changes: [], folded: [] })
  })

  test('both cut (the owner’s window): the profile switch folds, and the lanes fit beside its pill', () => {
    scene = { natural: NATURAL, room: 400 }
    expect(settle()).toEqual({ changes: ['fold profiles'], folded: ['profiles'] })
  })

  test('still less room: the lanes fold too', () => {
    scene = { natural: NATURAL, room: 330 }
    expect(settle()).toEqual({ changes: ['fold profiles', 'fold lanes'], folded: ['lanes', 'profiles'] })
  })

  test('each decides for itself: lanes too wide beside a pill fold, and the profile switch then fits again', () => {
    scene = { natural: { lanes: 300, profiles: 200 }, room: 380 }
    expect(settle()).toEqual({
      changes: ['fold profiles', 'fold lanes', 'unfold profiles'],
      folded: ['lanes'],
    })
  })

  test('room back: a folded control unfolds once its segments fit with the slack to spare, the lanes first', () => {
    scene = { natural: NATURAL, room: BOTH }
    // Each one fits beside the other's pill; together just so, which is not enough to unfold.
    expect(settle(['lanes', 'profiles'])).toEqual({ changes: ['unfold lanes'], folded: ['profiles'] })
    scene = { natural: NATURAL, room: BOTH + FOLD_SLACK }
    expect(settle(['lanes', 'profiles'])).toEqual({ changes: ['unfold lanes', 'unfold profiles'], folded: [] })
  })

  test('between folding and unfolding, each control stays as it is: no flip-flop', () => {
    scene = { natural: NATURAL, room: BOTH + FOLD_SLACK - 3 }
    expect(settle()).toEqual({ changes: [], folded: [] })
    expect(settle(['profiles'])).toEqual({ changes: [], folded: ['profiles'] })
  })

  test('trying a folded control’s segments leaves the row as it was', () => {
    scene = { natural: NATURAL, room: 330 }
    const el = draw(new Set(['lanes', 'profiles']))
    const before = canonical([el.node])
    expect(segmentFoldIn(asDom(el))).toBe(null)
    expect(canonical([el.node])).toBe(before)
  })
})

describe('each control on a line of its own (a phone)', () => {
  test('a control folds only when all of its segments do not fit the line, the other stays', () => {
    scene = { natural: { lanes: 300, profiles: 200 }, room: 280, lines: true }
    expect(settle()).toEqual({ changes: ['fold lanes'], folded: ['lanes'] })
    scene = { natural: { lanes: 300, profiles: 200 }, room: 300 + FOLD_SLACK, lines: true }
    expect(settle(['lanes'])).toEqual({ changes: ['unfold lanes'], folded: [] })
    scene = { natural: { lanes: 150, profiles: 200 }, room: 280, lines: true }
    expect(settle()).toEqual({ changes: [], folded: [] })
  })
})

test('a folded control whose segments would cut another control’s stays folded', () => {
  // A layout where trying the lanes squeezes only the profile switch.
  scene = { natural: NATURAL, room: 1440 }
  const el = draw(new Set(['lanes']))
  const lanes = el.querySelector('#lanes')
  const profiles = el.querySelector('#profiles')
  if (!lanes || !profiles) throw new Error('no controls')
  Object.defineProperty(profiles, 'clientWidth', { get: () => (lanes.hidden ? 254 : 200), configurable: true })
  expect(segmentFoldIn(asDom(el))).toBe(null)
  Object.defineProperty(profiles, 'clientWidth', { get: () => 254, configurable: true })
  expect(segmentFoldIn(asDom(el))).toEqual({ id: 'lanes', folded: false })
})
