// Favorites on the page (#64): the star button in the session's head, pressed for a favorite, and
// gray while card edits cannot be made (the card's menu has its own tests in menu.test.ts).
import { expect, test } from 'bun:test'
import type { Item } from '../../src/core/types.ts'
import { SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byId } from './support/markup.ts'

/** The star's attributes in the head as the page draws it for `it`. */
const star = (it: Item, disabled = false): Record<string, string> =>
  Object.fromEntries(
    byId(
      renderInBoard(
        <SheetHead item={it} missing={false} card={{ disabled, open: false }} />,
        board({ data: payload({ items: [it] }) }),
      ),
      'sheet-favorite',
    ).attrs,
  )

test('the session’s head: a star that says what a press does, pressed for a favorite, gray while edits wait', () => {
  const it = item({ key: 's1', name: 'Alpha', column: 'idle' })
  expect(star(it)).toEqual(expect.objectContaining({ 'aria-pressed': 'false', title: 'Add to Favorites' }))
  expect(star(it)).not.toHaveProperty('disabled')
  const fav = { ...it, favorite: true }
  expect(star(fav)).toEqual(expect.objectContaining({ 'aria-pressed': 'true', title: 'Remove from Favorites' }))
  expect(star(it, true)).toHaveProperty('disabled')
})
