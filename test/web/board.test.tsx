// The React board against the old #board: lanes in category order with their tag, count, "+"
// and columns, the empty and filtered lanes the stylesheet hides, the empty board's line, cards
// moved by the user ahead of the server, and the buttons a read-only board disables. The old
// side is web/app.js's own code for the cards and its laneOf/render() markup for the lanes
// (support/old-board.ts).
import { describe, expect, test } from 'bun:test'
import { Board } from '../../web/src/components/Board.tsx'
import { board as boardContext, item, renderInBoard } from './support/board.tsx'
import { bothBoards, type Scene } from './support/board-scene.tsx'
import { byId, canonical, pageMarkup } from './support/markup.ts'

const MIN = 60_000
const ago = (minutes: number) => Date.now() - (minutes + 0.5) * MIN

const ITEMS = [
  item({ key: 'a', name: 'Alpha', column: 'work', status: 'working', category: 'proj', activity: ago(1) }),
  item({ key: 'b', name: 'Beta', column: 'me', attention: 'ask', category: 'proj', askSince: ago(5) }),
  item({ key: 'e', name: 'Eps', column: 'ext', category: 'proj', wait: 'review', activity: ago(8) }),
  item({ key: 'c', name: 'Gamma', column: 'done', status: 'done', result: 'Fixed', activity: ago(100) }),
  item({ key: 'd', name: 'Delta', column: 'idle', status: 'sleeping', sleeping: true, activity: ago(300) }),
  item({ key: 'f', name: 'Phi', column: 'done', status: 'done', category: 'proj', activity: ago(2) }),
]

/** The card's new quiet facts are not in the old page's markup: compare the rest. */
const withoutFacts = (html: string) => html.replace(/[ \t]*<div class="card-facts">[\s\S]*?<\/div>\n/g, '')

function same(scene: Scene) {
  const { old, react } = bothBoards(scene)
  expect(withoutFacts(react)).toBe(withoutFacts(old))
}

describe('board markup parity', () => {
  test('every lane in category order, cards in their columns, the unused lane empty', () => {
    same({ items: ITEMS })
  })

  test('one lane picked: the others filtered', () => {
    same({ items: ITEMS, filter: 'proj' })
    same({ items: ITEMS, filter: 'other' })
  })

  test('sleepers hidden and a search: counts and empty lanes follow what is on show', () => {
    same({ items: ITEMS, sleepers: false })
    same({ items: ITEMS, query: 'alpha' })
  })

  test('nothing on show: the empty board says why, before and after the first session', () => {
    same({ items: [] })
    same({ items: ITEMS, query: 'no such session' })
    same({ items: ITEMS, filter: 'unused' })
    same({ items: [], categories: [] })
  })

  test('cards the user moved show in their new lane and column until the server agrees', () => {
    same({
      items: ITEMS,
      moves: [
        { key: 'c', cat: 'proj', column: 'idle' },
        { key: 'e', cat: 'other', column: null },
        { key: 'f', cat: null, column: 'me' },
      ],
    })
  })

  test('read only: the lanes\' "+" waits for fresh herdr data, with the reason as its title', () => {
    same({ items: ITEMS, canMutate: false })
    same({ items: ITEMS, canMutate: false, canEdit: false })
  })

  test('in Russian', () => {
    same({ lang: 'ru', items: ITEMS, open: 'b' })
  })

  test('before the first board: the empty #board of the page', () => {
    const react = renderInBoard(<Board />, boardContext({ data: null }))
    expect(canonical(react)).toBe(canonical([byId(pageMarkup(), 'board')]))
  })
})
