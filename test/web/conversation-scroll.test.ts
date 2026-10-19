// The session sheet's conversation scroll (web/src/models/conversation-scroll.ts, as upstream's
// renderSheetBody): to the bottom when a session opens and when the conversation is drawn anew near
// the bottom, never on a render that leaves the conversation as it was. The regression: with the
// sheet open and its body overflowing a pixel off the bottom, opening a menu re-rendered the sheet,
// which wrote scrollTop, and the scroll closed the menu just opened (menu-engine.ts, as menu.js).
import { describe, expect, test } from 'bun:test'
import { ConversationScroll, type ScrollBox } from '../../web/src/models/conversation-scroll.ts'
import type { FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { reactMenuSide } from './support/menu-sides.tsx'

/** A scroll box as the browser's: scrollTop stays in range, and a change fires `scroll` on it. */
function scrollBox(world: FakeWorld | null, el: FakeElement | null, height: number, client: number) {
  const box = { height, top: 0, writes: 0, scrolls: 0 }
  const view: ScrollBox = {
    get scrollTop() {
      return box.top
    },
    set scrollTop(value: number) {
      box.writes++
      const next = Math.max(0, Math.min(value, box.height - client))
      if (next === box.top) return
      box.top = next
      box.scrolls++
      if (world && el) void world.fire(el, 'scroll')
    },
    get scrollHeight() {
      return box.height
    },
    clientHeight: client,
  }
  return { box, view }
}

const DETAIL = { conversation: ['first'] }
const NEWER = { conversation: ['first', 'second'] }
/** What the sheet draws the conversation from: detail, key, openings, language, form, column. */
const from = (detail: unknown, opened = 1) => [detail, 'k1', opened, 'en', false, 'doing']

describe('the conversation scroll', () => {
  test('opens at the bottom, follows a conversation drawn anew there, and is left alone otherwise', () => {
    const scroll = new ConversationScroll()
    const { box, view } = scrollBox(null, null, 600, 200)
    scroll.opened()
    scroll.rendered(view, from(DETAIL))
    expect(box.top).toBe(400)
    // A render that draws nothing new (a menu opened, the composer grew): no write at all.
    box.height = 601
    scroll.rendered(view, from(DETAIL))
    expect(box.writes).toBe(1)
    // A new detail near the bottom: to the bottom again.
    scroll.scrolled(view)
    scroll.rendered(view, from(NEWER))
    expect(box.top).toBe(401)
    // Scrolled up to read: a new detail leaves it there…
    view.scrollTop = 100
    scroll.scrolled(view)
    const writes = box.writes
    box.height = 700
    scroll.rendered(view, from(DETAIL))
    expect(box.writes).toBe(writes)
    expect(box.top).toBe(100)
    // …until the session is opened again.
    scroll.opened()
    scroll.rendered(view, from(DETAIL, 2))
    expect(box.top).toBe(500)
  })

  test('a menu opened with the sheet open and its body overflowing stays open through the re-render', async () => {
    const side = reactMenuSide()
    try {
      const { world } = side
      const [node] = parseHtml('<div id="sheet-body"></div>')
      if (node?.kind !== 'element') throw new Error('no sheet body')
      const body = world.mount(node)
      const { box, view } = scrollBox(world, body, 300, 291)
      const scroll = new ConversationScroll()
      scroll.opened()
      scroll.rendered(view, from(DETAIL))
      expect(box.top).toBe(9)
      // The file chips grow the conversation by a pixel: no longer exactly at the bottom.
      box.height = 301
      await side.open([{ id: 'open', label: 'Open' }], { x: 100, y: 100 })
      await world.tick()
      expect(side.isOpen()).toBe(true)
      // Opening the menu changed the page's state, so the sheet renders again: nothing scrolls.
      scroll.rendered(view, from(DETAIL))
      await world.settle()
      expect(side.isOpen()).toBe(true)
      expect(box.scrolls).toBe(1)
      // The conversation drawn anew does go to the bottom, and that scroll closes the menu (as upstream's).
      scroll.rendered(view, from(NEWER))
      await world.flush()
      expect(box.top).toBe(10)
      expect(side.isOpen()).toBe(false)
    } finally {
      await side.dispose()
    }
  })
})
