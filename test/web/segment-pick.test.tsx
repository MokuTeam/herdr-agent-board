// A toolbar control folded into its pill (components/SegmentPick.tsx): the lanes control and the
// profile switch draw it in their segments' place, naming the choice on show with its count; it
// opens every choice as a menu on the board's menu engine (hooks/useSegmentPicks.ts), where a
// pick does what that segment's click does, and says whether its menu is up.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { Lanes } from '../../web/src/components/Lanes.tsx'
import { MenuLayer } from '../../web/src/components/menu/ContextMenu.tsx'
import { ProfileSwitch } from '../../web/src/components/ProfileSwitch.tsx'
import { type SegmentChoices, type SegmentPicks, segmentPickMenus } from '../../web/src/hooks/useSegmentPicks.ts'
import { segmentMenu } from '../../web/src/models/segment-fold.ts'
import { board, renderInBoard } from './support/board.tsx'
import { byId, canonical, type Element, findAll, hasClass, type Node, reactMarkup } from './support/markup.ts'
import { reactMenuSide } from './support/menu-sides.tsx'
import { asDom } from './support/react-commit.ts'

const LANES = [
  { id: 'all', title: 'All', n: 4 },
  { id: 'blu', title: 'bluBanyan', n: 3 },
  { id: 'proj', title: 'Projects', n: 1 },
]
const PROFILES = [
  { id: 'all', title: 'All profiles', color: '', n: 4 },
  { id: 'default', title: 'Private', color: '#5856D6', n: 1 },
  { id: 'work', title: 'Work', color: '#30B0C7', n: 3 },
]
const NO_PICKS: SegmentPicks = { open() {}, expanded: null }

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const elementsIn = (nodes: Node[]): Element[] => nodes.filter((n): n is Element => n.kind === 'element')

const lanes = (picked: string, folded: boolean, picks = NO_PICKS, lang = 'en') =>
  renderInBoard(
    <Lanes options={LANES} picked={picked} onPick={() => {}} folded={folded} picks={picks} />,
    board(),
    lang,
  )
const profiles = (picked: string, folded: boolean, picks = NO_PICKS, lang = 'en') =>
  renderInBoard(
    <ProfileSwitch options={PROFILES} picked={picked} onPick={() => {}} folded={folded} picks={picks} />,
    board(),
    lang,
  )

describe('the pill in the segments’ place', () => {
  test('unfolded: the segments as before, no pill', () => {
    const nodes = lanes('blu', false)
    expect(elementsIn(nodes).map(el => el.attrs.get('id'))).toEqual(['lanes'])
    expect(byId(nodes, 'lanes').attrs.has('hidden')).toBe(false)
    expect(elementsIn(profiles('work', false)).map(el => el.attrs.get('id'))).toEqual(['profiles'])
  })

  test('folded lanes: the segments hidden, right after them a pill naming the lane on show, its count and a chevron', () => {
    const nodes = lanes('blu', true)
    expect(elementsIn(nodes).map(el => el.attrs.get('id'))).toEqual(['lanes', 'lanes-pick'])
    expect(byId(nodes, 'lanes').attrs.get('hidden')).toBe('')
    expect(canonical([byId(nodes, 'lanes-pick')])).toBe(
      canonical(
        reactMarkup(
          <button
            type="button"
            className="pill-toggle segment-pick"
            id="lanes-pick"
            title="Category: bluBanyan"
            aria-label="Category: bluBanyan"
            aria-haspopup="menu"
            aria-expanded="false"
          >
            <span className="segment-pick-title">bluBanyan</span>
            <span className="n">3</span>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>,
        ),
      ),
    )
  })

  test('a lane gone since: the pill names the first, as the thumb sits under it', () => {
    expect(textOf(byId(lanes('gone', true), 'lanes-pick'))).toBe('All4')
  })

  test('the folded profile switch: the profile on show in its color, as its segment has it; "All profiles" in none', () => {
    const work = byId(profiles('work', true), 'profiles-pick')
    expect([work.attrs.get('class'), work.attrs.get('style'), work.attrs.get('aria-label'), textOf(work)]).toEqual([
      'pill-toggle segment-pick profiles',
      '--c:#30B0C7',
      'Profile: Work',
      'Work3',
    ])
    const all = byId(profiles('all', true), 'profiles-pick')
    expect([all.attrs.has('style'), all.attrs.get('aria-label'), textOf(all)]).toEqual([
      false,
      'Profile: All profiles',
      'All profiles4',
    ])
    expect(byId(profiles('work', true), 'profiles').attrs.get('hidden')).toBe('')
  })

  test('in Russian', () => {
    expect(byId(lanes('blu', true, NO_PICKS, 'ru'), 'lanes-pick').attrs.get('aria-label')).toBe('Категория: bluBanyan')
    expect(byId(profiles('work', true, NO_PICKS, 'ru'), 'profiles-pick').attrs.get('aria-label')).toBe('Профиль: Work')
  })

  test('its menu up: that pill says so, the other not', () => {
    const picks = { open() {}, expanded: 'lanes' }
    expect(byId(lanes('blu', true, picks), 'lanes-pick').attrs.get('aria-expanded')).toBe('true')
    expect(byId(profiles('work', true, picks), 'profiles-pick').attrs.get('aria-expanded')).toBe('false')
  })
})

describe('the menu out of the pill', () => {
  /** The lanes' choices; what a pick asked for goes to `picked`. */
  const choices = (picked: string[], tint = false): SegmentChoices => ({
    label: 'Categories',
    options: tint ? PROFILES : LANES,
    picked: tint ? 'default' : 'blu',
    tint,
    onPick: id => void picked.push(id),
  })

  test('every choice with its count, the one on show checked; keys move, Enter picks as a click on that segment', async () => {
    const side = reactMenuSide()
    try {
      const picked: string[] = []
      const expanded: (string | null)[] = []
      const control = segmentPickMenus({ menu: side.engine, coarse: () => false, expanded: id => expanded.push(id) })
      const stop = control.watch()
      const opener = asDom(side.page('opener'))
      control.open('lanes', opener, true, choices(picked))
      await side.world.flush()
      const [menu] = side.levels()
      if (!menu) throw new Error('no menu')
      // Under the pill, from its left edge; named as the control; the keys light the first choice.
      expect([menu.style.left, menu.style.top, menu.getAttribute('aria-label')]).toEqual([
        '100px',
        '134px',
        'Categories',
      ])
      expect(menu.getAttribute('aria-activedescendant')).toBe('menu-1-0')
      const items = menu.querySelectorAll('.menu-item')
      expect(
        items.map(el => [el.querySelector('.mi-label')?.textContent, el.querySelector('.mi-count')?.textContent]),
      ).toEqual([
        ['All', '4'],
        ['bluBanyan', '3'],
        ['Projects', '1'],
      ])
      expect(items.map(el => el.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
      expect(expanded).toEqual(['lanes'])

      for (const key of ['ArrowDown', 'ArrowDown', 'Enter'])
        await side.world.fire(side.world.document.activeElement ?? side.world.wrap(side.world.body), 'keydown', { key })
      await side.world.settle()
      expect(picked).toEqual(['proj'])
      expect(side.isOpen()).toBe(false)
      // The focus back on the pill, which says its menu is down.
      expect(side.world.document.activeElement).toBe(side.page('opener'))
      expect(expanded).toEqual(['lanes', null])
      stop()
    } finally {
      await side.dispose()
    }
  })

  test('Esc closes it, the focus back on the pill, nothing picked; opened by the pointer, nothing lit', async () => {
    const side = reactMenuSide()
    try {
      const picked: string[] = []
      const expanded: (string | null)[] = []
      const control = segmentPickMenus({ menu: side.engine, coarse: () => false, expanded: id => expanded.push(id) })
      const stop = control.watch()
      const opener = asDom(side.page('opener'))
      control.open('profiles', opener, false, choices(picked, true))
      await side.world.flush()
      expect(side.levels()[0]?.getAttribute('aria-activedescendant')).toBe(null)
      await side.world.fire(side.world.document.activeElement ?? side.world.wrap(side.world.body), 'keydown', {
        key: 'Escape',
      })
      await side.world.settle()
      expect([picked, side.isOpen(), expanded]).toEqual([[], false, ['profiles', null]])
      expect(side.world.document.activeElement).toBe(side.page('opener'))
      stop()
    } finally {
      await side.dispose()
    }
  })

  test('a finger: bigger rows', async () => {
    const side = reactMenuSide()
    try {
      const control = segmentPickMenus({ menu: side.engine, coarse: () => true, expanded: () => {} })
      control.open('lanes', asDom(side.page('opener')), false, choices([]))
      await side.world.flush()
      expect(side.levels()[0]?.classList.contains('touch')).toBe(true)
    } finally {
      await side.dispose()
    }
  })

  test('a profile’s count in its color, "All profiles"’ in none, a lane’s plain', () => {
    const counts = (items: ReturnType<typeof segmentMenu>) =>
      findAll(
        reactMarkup(
          <MenuLayer
            layer={{ id: 'menu-1', items, note: '', checks: true, touch: false, label: '', active: -1, sub: -1 }}
          />,
        ),
        el => hasClass(el, 'mi-count'),
      ).map(el => [el.attrs.get('class'), el.attrs.get('style') ?? null, textOf(el)])
    expect(counts(segmentMenu(PROFILES, 'default', true))).toEqual([
      ['mi-count tint', null, '4'],
      ['mi-count tint', '--c:#5856D6', '1'],
      ['mi-count tint', '--c:#30B0C7', '3'],
    ])
    expect(counts(segmentMenu(LANES, 'blu', false))).toEqual([
      ['mi-count', null, '4'],
      ['mi-count', null, '3'],
      ['mi-count', null, '1'],
    ])
    // Menus without counts draw as before.
    expect(counts([{ id: 'a', label: 'Alpha' }])).toEqual([])
  })
})

test('the strings', () => {
  expect(translator('en')('tb.lanesPick', { title: 'X' })).toBe('Category: X')
  expect(translator('en')('tb.profilesPick', { title: 'X' })).toBe('Profile: X')
})
