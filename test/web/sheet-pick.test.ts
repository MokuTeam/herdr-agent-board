// The session head's pills (#62): where the card shows and its lane, each a menu out of the pill
// (hooks/useContextMenus.ts sheetPickMenuFrom). Its choices are the card menu's Status and
// Category; a pick moves the card as the sheet's chips did.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { MenuOpen } from '../../web/src/components/menu/menu-engine.ts'
import { type SheetPickDeps, sheetPickMenuFrom } from '../../web/src/hooks/useContextMenus.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { item } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'

function scene(card: ReturnType<SheetPickDeps['card']>) {
  const opened: { items: readonly MenuEntry[]; options: MenuOpen }[] = []
  const moves: unknown[] = []
  const pick = sheetPickMenuFrom({
    menu: { open: (items, options) => opened.push({ items, options }), isOpen: () => opened.length > 0 },
    t: () => translator('en'),
    card: () => card,
    move: (key, to) => moves.push([key, to]),
    coarse: () => false,
  })
  const button = { getBoundingClientRect: () => ({ left: 40, bottom: 60 }) } as unknown as HTMLElement
  return { pick, button, opened, moves }
}

const pinned = item({ key: 'a', column: 'ext', pin: 'ext', auto: 'done', category: 'proj' })
const card = { key: 'a', item: pinned, column: 'ext', category: 'proj', categories: CATEGORIES }
const labels = (items: readonly MenuEntry[]) =>
  items.map(i =>
    'separator' in i && i.separator
      ? '---'
      : `${'label' in i ? i.label : ''}${'checked' in i && i.checked ? ' ✓' : ''}`,
  )

describe('the sheet head’s pills', () => {
  test('Status: the columns, the one it shows in checked, Auto while it is pinned there; under the pill, from the keys', () => {
    const s = scene(card)
    s.pick('status', s.button, true)
    const [menu] = s.opened
    expect(labels(menu?.items ?? [])).toEqual(['Needs me', 'Waiting on others ✓', 'Done', 'Idle', '---', 'Auto'])
    expect(menu?.options).toMatchObject({ x: 40, y: 64, source: 'keyboard', origin: s.button, label: 'Status' })
    menu?.options.onPick?.('col:done', { id: 'col:done', label: 'Auto' })
    expect(s.moves).toEqual([['a', { cat: null, column: 'done' }]])
  })

  test('Category: the lanes, its own checked; a pick moves it there and leaves its column to the board', () => {
    const s = scene({ ...card, item: { ...pinned, pin: '' }, column: 'idle' })
    s.pick('category', s.button, false)
    const [menu] = s.opened
    expect(labels(menu?.items ?? [])).toEqual(['Project ✓', 'Other', 'Unused'])
    expect(menu?.options).toMatchObject({ source: 'mouse', label: 'Category' })
    menu?.options.onPick?.('cat:other', { id: 'cat:other', label: 'Other' })
    expect(s.moves).toEqual([['a', { cat: 'other', column: null }]])
  })

  test('with no session open, nothing opens', () => {
    const s = scene(null)
    s.pick('status', s.button, false)
    expect(s.opened).toEqual([])
  })
})
