// A card's head gives way to its name (#324; web/src/models/card-head.ts, hooks/useHeadFit.ts,
// styles/cards.css). The owner's columns, about 480px wide, cut names of one client to "Clien…"
// while the profile chip read "D…" and the state word, the clock and the age kept their width. What
// gives way and in which order, measured on a stand-in row (no browser here); the card's markup.
import { describe, expect, test } from 'bun:test'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { CardName } from '../../web/src/components/Card.tsx'
import { fitHead } from '../../web/src/hooks/useHeadFit.ts'
import { HEAD_STEPS, type HeadStep, headFit, nameParts, profileMark } from '../../web/src/models/card-head.ts'
import { ALL_LANES } from '../../web/src/models/lane-picks.ts'
import { board as boardContext, item, payload, renderInBoard } from './support/board.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'

describe('what gives way, in order', () => {
  test('the state word first, then the profile down to its mark, then the clock down to its glyph', () => {
    expect([...HEAD_STEPS]).toEqual(['status', 'profile', 'alarm'])
  })

  test('a name that fits takes no step: the row is drawn as before', () => {
    const tried: HeadStep[][] = []
    const fits = (given: HeadStep[]) => {
      tried.push(given)
      return true
    }
    expect(headFit(['status', 'profile', 'alarm'], fits)).toEqual({ given: [], cut: false })
    expect(tried).toEqual([[]])
  })

  test('only as many steps as the name needs, one at a time', () => {
    const needs = (n: number) => (given: HeadStep[]) => given.length >= n
    const all: HeadStep[] = ['status', 'profile', 'alarm']
    expect(headFit(all, needs(1))).toEqual({ given: ['status'], cut: false })
    expect(headFit(all, needs(2))).toEqual({ given: ['status', 'profile'], cut: false })
    expect(headFit(all, needs(3))).toEqual({ given: ['status', 'profile', 'alarm'], cut: false })
    // Nothing is enough: all of it gives way, and the name is cut even so.
    expect(headFit(all, needs(4))).toEqual({ given: ['status', 'profile', 'alarm'], cut: true })
  })

  test('a step the card has nothing for is not taken, whatever order the card lists them in', () => {
    const needs = (n: number) => (given: HeadStep[]) => given.length >= n
    expect(headFit(['alarm', 'status'], needs(2))).toEqual({ given: ['status', 'alarm'], cut: false })
    expect(headFit(['status'], needs(2))).toEqual({ given: ['status'], cut: true })
  })
})

/**
 * A stand-in for a card's head: the issue's row in a 480px card (452px inside), each part its
 * width as drawn; the name whole while what is left of the row holds it.
 */
function row(name: number, parts: Partial<Record<'card-status' | 'profile-tag' | 'alarm' | 'age', number>>) {
  const short: Record<string, number> = { 'card-status': 0, 'profile-tag': 18, alarm: 12 }
  const step: Record<string, HeadStep> = { 'card-status': 'status', 'profile-tag': 'profile', alarm: 'alarm' }
  const nameEl = { classList: { contains: () => false } }
  const children = [
    { classList: { contains: (c: string) => c === 'dot' } },
    { classList: { contains: (c: string) => c === 'name' } },
    ...Object.keys(parts).map(cls => ({ classList: { contains: (c: string) => c === cls } })),
  ]
  const el = {
    dataset: {} as Record<string, string>,
    children,
    querySelector: (selector: string) => (selector === '.name' ? nameEl : null),
  }
  const gap = 8
  const taken = () => {
    const given = (el.dataset.give ?? '').split(' ')
    return Object.entries(parts).reduce((sum, [cls, width = 0]) => {
      const gone = step[cls] && given.includes(step[cls])
      const w = gone ? (short[cls] ?? 0) : width
      return sum + (w ? w + gap : 0)
    }, 13 + gap)
  }
  const cut = () => taken() + name > 452
  return { el: el as unknown as HTMLElement, cut }
}

describe('the head measured', () => {
  // The issue's row: "D…" whole is "Default" (60px), "Waiting on others" (95px), a clock with
  // "Fri 10:00" (70px), "44 min" (40px).
  const PARTS = { 'profile-tag': 60, 'card-status': 95, alarm: 70, age: 40 }

  test('a short name keeps every part whole, and the row gets no data-give', () => {
    const { el, cut } = row(120, PARTS)
    expect(fitHead(el, cut)).toBe(false)
    expect(el.dataset.give).toBeUndefined()
  })

  test('a client and case name: the state word goes, and that is enough', () => {
    const { el, cut } = row(160, PARTS)
    expect(fitHead(el, cut)).toBe(false)
    expect(el.dataset.give).toBe('status')
  })

  test('a longer one: the profile becomes its mark too; longer still, the clock its glyph', () => {
    const mark = row(260, PARTS)
    expect(fitHead(mark.el, mark.cut)).toBe(false)
    expect(mark.el.dataset.give).toBe('status profile')
    const glyph = row(300, PARTS)
    expect(fitHead(glyph.el, glyph.cut)).toBe(false)
    expect(glyph.el.dataset.give).toBe('status profile alarm')
  })

  test('a name longer than the row: everything gives way and the name is cut (its tooltip names it)', () => {
    const { el, cut } = row(400, PARTS)
    expect(fitHead(el, cut)).toBe(true)
    expect(el.dataset.give).toBe('status profile alarm')
  })

  test('the row widening again takes the steps back', () => {
    const { el, cut } = row(160, PARTS)
    el.dataset.give = 'status profile alarm'
    expect(fitHead(el, cut)).toBe(false)
    expect(el.dataset.give).toBe('status')
    const wide = row(120, PARTS)
    wide.el.dataset.give = 'status'
    expect(fitHead(wide.el, wide.cut)).toBe(false)
    expect(wide.el.dataset.give).toBeUndefined()
  })

  test('without a profile or a clock, the steps for them are not taken', () => {
    const { el, cut } = row(400, { 'card-status': 95, age: 40 })
    expect(fitHead(el, cut)).toBe(true)
    expect(el.dataset.give).toBe('status')
  })
})

describe('a name cut in the middle keeps the end that tells it apart', () => {
  test('"<Client>-<Case>-Templates" and its kind: the last part after a join', () => {
    expect(nameParts('Client-Case-Templates')).toEqual({ head: 'Client-Case', tail: '-Templates' })
    expect(nameParts('Client-14041')).toEqual({ head: 'Client', tail: '-14041' })
    expect(nameParts('repo/feature_xy')).toEqual({ head: 'repo/feature', tail: '_xy' })
    expect(nameParts('Клиент-Кейс')).toEqual({ head: 'Клиент', tail: '-Кейс' })
  })

  test('prose, one word, a long or spaced last part, a short start: cut at the end, as before', () => {
    for (const name of [
      'Card names #324',
      'Alpha',
      'Agent-board Master',
      'ab-cd',
      'Client-a',
      'Client-averyveryverylongpart',
      'Client -x1',
    ])
      expect([name, nameParts(name)]).toEqual([name, null])
  })
})

const profile = (id: string, title: string, hidden = false): BoardProfile => ({
  id,
  title,
  color: '#5856D6',
  colorName: 'indigo',
  dir: `/home/me/.claude-${id}`,
  hidden,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 1,
  limits: null,
})
const DEFAULT = profile('default', 'Default')
const WORK = profile('work', 'Work')

describe('the profile mark', () => {
  test('its initial; as many first letters as tell it from the other shown profiles, up to three', () => {
    expect(profileMark({ kind: 'profile', profile: DEFAULT }, [DEFAULT, WORK])).toBe('D')
    const dev = profile('dev', 'dev')
    expect(profileMark({ kind: 'profile', profile: DEFAULT }, [DEFAULT, dev])).toBe('Def')
    expect(profileMark({ kind: 'profile', profile: dev }, [DEFAULT, dev])).toBe('Dev')
    const design = profile('design', 'Design')
    expect(profileMark({ kind: 'profile', profile: design }, [DEFAULT, design])).toBe('Des')
    // A hidden one is not on the board's cards to be told apart from.
    expect(profileMark({ kind: 'profile', profile: DEFAULT }, [DEFAULT, profile('d2', 'Dx', true)])).toBe('D')
    expect(profileMark({ kind: 'profile', profile: profile('ru', 'работа') }, [DEFAULT])).toBe('Р')
  })

  test('a folder no profile has: "?"; the wrong profile: "!"', () => {
    expect(profileMark({ kind: 'unknown', folder: '/x' }, [DEFAULT, WORK])).toBe('?')
    expect(profileMark({ kind: 'wrong', wantId: 'work', want: WORK }, [DEFAULT, WORK])).toBe('!')
  })
})

describe('the card', () => {
  const boardOf = (data: BoardPayload): Node[] =>
    renderInBoard(<Board />, boardContext({ data, ui: { filter: ALL_LANES, query: '', sleepers: true } }), 'en')
  const cardOf = (nodes: Node[], key: string): Element =>
    find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key)
  const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

  test('its tag carries its mark; a name not cut is one text, as before, whatever its end', () => {
    const nodes = boardOf(
      payload({
        items: [
          item({
            key: 'a',
            name: 'Client-Case-Templates',
            autoName: 'Client-Case-Templates',
            column: 'ext',
            category: 'other',
            profile: 'default',
          }),
          item({ key: 'b', name: 'Beta', column: 'done', category: 'other', profile: 'work', autoName: 'Old' }),
        ],
        profiles: [DEFAULT, WORK],
        categories: [
          { id: 'other', title: 'Other', color: '#8E8E93', colorName: '', paths: [], configured: true, fallback: true },
        ],
      }),
    )
    const a = cardOf(nodes, 'a')
    const tag = find(a.children, el => hasClass(el, 'profile-tag'))
    expect([tag.attrs.get('data-mark'), textOf(tag)]).toEqual(['D', 'Default'])
    // Nothing measured here: the name shows whole, one text with no tooltip, as on main.
    const name = find(a.children, el => hasClass(el, 'name'))
    expect([name.attrs.get('class'), name.children.length, textOf(name), name.attrs.get('title')]).toEqual([
      'name',
      1,
      'Client-Case-Templates',
      undefined,
    ])
    const b = find(cardOf(nodes, 'b').children, el => hasClass(el, 'name'))
    expect(b.attrs.get('title')).toBe('Was “Old”')
  })

  test('a name cut even so: whole in its tooltip, the end that tells it apart kept', () => {
    const drawn = (cut: boolean, name: string, was?: string) =>
      find(renderInBoard(<CardName name={name} cut={cut} was={was} />, boardContext(), 'en'), el =>
        hasClass(el, 'name'),
      )
    const cut = drawn(true, 'Client-Case-Templates', 'Was “x”')
    expect(cut.attrs.get('class')).toBe('name split')
    expect(findAll(cut.children, el => el.tag === 'span').map(el => [el.attrs.get('class'), textOf(el)])).toEqual([
      ['name-head', 'Client-Case'],
      ['name-tail', '-Templates'],
    ])
    expect([textOf(cut), cut.attrs.get('title')]).toEqual(['Client-Case-Templates', 'Client-Case-Templates\nWas “x”'])
    // Prose is cut at its end, as before, and named in its tooltip.
    const prose = drawn(true, 'Card names on the board')
    expect([prose.attrs.get('class'), textOf(prose), prose.attrs.get('title')]).toEqual([
      'name',
      'Card names on the board',
      'Card names on the board',
    ])
  })
})
