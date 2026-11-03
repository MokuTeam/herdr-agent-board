// A card's head gives way to its name (#324; web/src/models/card-head.ts, hooks/head-fitter.ts,
// hooks/useHeadFit.ts, styles/cards.css). The owner's columns, about 480px wide, cut names of one
// client to "Clien…" while the profile chip read "D…" and the state word, the clock and the age
// kept their width. What gives way and in which order, fitted on stand-in rows (no browser here):
// all rows together in a few layouts, hidden rows when they show again, a class that styles the
// name; the hook drawn by react-dom in a small DOM; the card's markup.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { useRef } from 'react'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { NameText } from '../../web/src/components/Card.tsx'
import { createHeadFitter, type HeadEnv, type HeadFitter } from '../../web/src/hooks/head-fitter.ts'
import { HEAD_STEPS, type HeadStep, nameParts, profileMark } from '../../web/src/models/card-head.ts'
import { ALL_LANES } from '../../web/src/models/lane-picks.ts'
import { board as boardContext, item, payload, renderInBoard } from './support/board.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { MiniElement, miniWindow } from './support/mini-dom.ts'

test('what gives way, in order: the state word, then the profile down to its mark, then the clock to its glyph', () => {
  expect([...HEAD_STEPS]).toEqual(['status', 'profile', 'alarm'])
})

type Part = 'card-status' | 'profile-tag' | 'alarm' | 'age'
const STEP: Partial<Record<Part, HeadStep>> = { 'card-status': 'status', 'profile-tag': 'profile', alarm: 'alarm' }
const SHORT: Partial<Record<Part, number>> = { 'card-status': 0, 'profile-tag': 18, alarm: 12 }

/**
 * A stand-in for a card's head: the issue's row in a card 480px wide (452px inside), each part
 * its width as drawn, the name whole while what is left of the row holds it. An open card's name
 * has "› " before it in the Terminal style (15px), from its card's class.
 */
interface Stand {
  name: number
  parts: Partial<Record<Part, number>>
  width: number
  cls: string
  words: string
  given: HeadStep[]
}
// The issue's row: "Default" (60px), "Waiting on others" (95px), a clock with "Fri 10:00" (70px), "44 min" (40px).
const PARTS: Partial<Record<Part, number>> = { 'profile-tag': 60, 'card-status': 95, alarm: 70, age: 40 }
const stand = (name: number, parts = PARTS): Stand => ({ name, parts, width: 452, cls: 'card', words: 'a', given: [] })
const taken = (r: Stand) =>
  Object.entries(r.parts).reduce((sum, [part, width = 0]) => {
    const step = STEP[part as Part]
    const w = step && r.given.includes(step) ? (SHORT[part as Part] ?? 0) : width
    return sum + (w ? w + 8 : 0)
  }, 21)

/** The fitter on stand-ins; `layouts`: how often a read followed a write (the page laid out again). */
function standIns() {
  const seen = { layouts: 0, reads: new Map<Stand, number>(), flushes: 0, cut: new Map<Stand, boolean[]>() }
  let dirty = false
  let resize: (changes: { row: Stand; width: number }[]) => void = () => {}
  const later: (() => void)[] = []
  const env: HeadEnv<Stand> = {
    key: r => `${r.cls}\n${r.words}`,
    present: r => HEAD_STEPS.filter(s => Object.keys(r.parts).some(p => STEP[p as Part] === s)),
    give(r, given) {
      if (r.given.join(' ') === given.join(' ')) return
      r.given = [...given]
      dirty = true
    },
    cut(r) {
      if (dirty) seen.layouts++
      dirty = false
      seen.reads.set(r, (seen.reads.get(r) ?? 0) + 1)
      return taken(r) + r.name + (r.cls.includes('selected') ? 15 : 0) > r.width
    },
    observer(resized) {
      resize = resized
      return { observe() {}, unobserve() {} }
    },
    flushSync(update) {
      seen.flushes++
      update()
    },
    later: fit => later.push(fit),
  }
  const fitter = createHeadFitter(env)
  const add = (...rows: Stand[]) => {
    for (const r of rows) fitter.add(r, cut => seen.cut.set(r, [...(seen.cut.get(r) ?? []), cut]))
  }
  return {
    fitter,
    seen,
    add,
    /** The observer reports these rows at these widths. */
    resize: (...changes: [Stand, number][]) => {
      for (const [r, width] of changes) if (width) r.width = width
      resize(changes.map(([row, width]) => ({ row, width })))
    },
    /** The render is done: what `changed` queued runs. */
    tick: () => {
      for (const fit of later.splice(0)) fit()
    },
    reset: () => {
      seen.layouts = 0
      seen.reads.clear()
    },
  }
}
const given = (r: Stand) => r.given.join(' ')

describe('the head fitted', () => {
  test('each row takes only the steps its name needs; one too long takes all and is cut', () => {
    const s = standIns()
    const rows = [
      stand(120),
      stand(160),
      stand(260),
      stand(300),
      stand(400),
      stand(400, { 'card-status': 95, age: 40 }),
    ]
    s.add(...rows)
    s.resize(...rows.map(r => [r, 452] as [Stand, number]))
    expect(rows.map(given)).toEqual([
      '',
      'status',
      'status profile',
      'status profile alarm',
      'status profile alarm',
      // Without a profile or a clock, the steps for them are not taken.
      'status',
    ])
    expect(rows.map(r => s.seen.cut.get(r) ?? [])).toEqual([[], [], [], [], [true], [true]])
    // What is cut is heard at once, all rows in one flushSync.
    expect(s.seen.flushes).toBe(1)
  })

  test('150 rows are fitted in a few layouts, not some for every row', () => {
    const s = standIns()
    const rows = Array.from({ length: 150 }, (_, i) => stand([120, 160, 260, 300, 400][i % 5] ?? 0))
    s.add(...rows)
    s.resize(...rows.map(r => [r, 452] as [Stand, number]))
    // A round per step at most: steps 0 to 3, each read once the writes before it are laid out.
    expect(s.seen.layouts).toBeLessThanOrEqual(HEAD_STEPS.length)
    expect(rows.filter(r => given(r) === 'status profile alarm')).toHaveLength(60)
  })

  test('a width that moved a little starts from the steps the row had; a wider row takes them back', () => {
    const s = standIns()
    const r = stand(300)
    s.add(r)
    s.resize([r, 452])
    expect(given(r)).toBe('status profile alarm')
    s.reset()
    s.resize([r, 451])
    // Three steps still, and two reads to know it (three leave it whole, two cut it), not four.
    expect([given(r), s.seen.reads.get(r)]).toEqual(['status profile alarm', 2])
    s.resize([r, 700])
    expect(given(r)).toBe('')
  })

  test('a hidden row is not measured; it is fitted when it shows again, whatever changed meanwhile', () => {
    const s = standIns()
    const r = stand(120)
    s.add(r)
    s.resize([r, 452])
    expect(given(r)).toBe('')
    // Its lane hidden: no box. Its words change to a long name, the page changes its type.
    s.resize([r, 0])
    s.reset()
    r.words = 'b'
    r.name = 400
    s.fitter.changed(r)
    s.tick()
    s.fitter.pageChanged()
    expect(s.seen.reads.get(r)).toBeUndefined()
    // Shown again at the width it had: fitted with what it says now.
    s.resize([r, 452])
    expect([given(r), s.seen.cut.get(r)]).toEqual(['status profile alarm', [true]])
  })

  test('a change of what styles the name (the card opened: "› " before it) fits it again; a render that changes nothing does not', () => {
    const s = standIns()
    // A name that just fits: 452 - 21 - 68 - 103 - 78 - 48 = 134.
    const r = stand(134)
    s.add(r)
    s.resize([r, 452])
    expect(given(r)).toBe('')
    s.reset()
    s.fitter.changed(r)
    s.tick()
    expect(s.seen.reads.get(r)).toBeUndefined()
    r.cls = 'card selected'
    s.fitter.changed(r)
    s.tick()
    expect(given(r)).toBe('status')
  })

  test('the page changing its type fits every row now; a row removed is not fitted', () => {
    const s = standIns()
    const [a, b] = [stand(160), stand(160)]
    s.add(a, b)
    s.resize([a, 452], [b, 452])
    s.fitter.remove(b)
    s.reset()
    a.name = 300
    b.name = 300
    s.fitter.pageChanged()
    expect([given(a), s.seen.reads.has(b)]).toEqual(['status profile alarm', false])
  })
})

describe('the hook in a page', () => {
  let dom: ReturnType<typeof miniWindow>
  let draw: (cls: string, words: string) => void
  let unmount: () => void
  let head: MiniElement | undefined
  const events: string[] = []
  let resize: (changes: { row: HTMLElement; width: number }[]) => void = () => {}

  const all = (node: { childNodes: unknown[] }): MiniElement[] =>
    node.childNodes.flatMap(c => (c instanceof MiniElement ? [c, ...all(c)] : []))
  const row = () => head as MiniElement
  const at = (width: number) => resize([{ row: row() as unknown as HTMLElement, width }])
  const settle = () => new Promise(done => setTimeout(done, 0))

  beforeAll(async () => {
    dom = miniWindow(800)
    const { createRoot } = await import('react-dom/client')
    const { flushSync } = await import('react-dom')
    const { useHeadFit } = await import('../../web/src/hooks/useHeadFit.ts')
    // A row is cut when its words are long; an open card's name has less room.
    const env: HeadEnv<HTMLElement> = {
      key: row => `${row.parentElement?.className}\n${row.textContent}`,
      present: () => ['status'],
      give(row, steps) {
        row.setAttribute('data-give', steps.join(' '))
      },
      cut(row) {
        const words = (row.textContent ?? '').replace(/^(cut|whole) /, '')
        events.push(`read ${words}`)
        return words.length > (row.parentElement?.className.includes('selected') ? 4 : 6)
      },
      observer(resized) {
        resize = resized
        return {
          observe: row => events.push(`observe ${row.textContent}`),
          unobserve: row => events.push(`unobserve ${row.textContent}`),
        }
      },
      flushSync,
      later: fit => queueMicrotask(fit),
    }
    const fitter: HeadFitter<HTMLElement> = createHeadFitter(env)
    function Head({ words }: { words: string }) {
      const ref = useRef<HTMLSpanElement>(null)
      const cut = useHeadFit(ref, fitter)
      return (
        <div>
          <span ref={ref}>{`${cut ? 'cut' : 'whole'} ${words}`}</span>
        </div>
      )
    }
    const container = dom.document.body.appendChild(dom.document.createElement('div'))
    const root = createRoot(container as unknown as HTMLElement)
    draw = (cls, words) =>
      flushSync(() =>
        root.render(
          <article className={cls}>
            <Head words={words} />
          </article>,
        ),
      )
    unmount = () => flushSync(() => root.unmount())
    draw('card', 'abc')
    head = all(dom.document.body).find(el => el.parentElement?.localName === 'article')
  })

  afterAll(async () => {
    await new Promise(done => setTimeout(done, 20))
    dom.uninstall()
  })

  test('mounted, it is watched and fitted at its first width; drawn as the fit says', async () => {
    expect(events).toEqual(['observe whole abc'])
    at(300)
    expect([row().textContent, events.at(-1)]).toEqual(['whole abc', 'read abc'])
    draw('card', 'abcdefgh')
    await settle()
    expect([row().textContent, row().getAttribute('data-give')]).toEqual(['cut abcdefgh', 'status'])
  })

  test('hidden, changed and shown again: not measured while hidden, fitted when it shows', async () => {
    at(0)
    events.length = 0
    draw('card', 'abc')
    await settle()
    expect(events).toEqual([])
    at(300)
    expect([row().textContent, events.includes('read abc')]).toEqual(['whole abc', true])
  })

  test('its card’s class changing fits it again', async () => {
    draw('card', 'abcde')
    await settle()
    expect(row().textContent).toBe('whole abcde')
    draw('card selected', 'abcde')
    await settle()
    expect(row().textContent).toBe('cut abcde')
  })

  test('unmounted, it is no longer watched', () => {
    events.length = 0
    unmount()
    expect(events).toEqual(['unobserve cut abcde'])
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
      find(renderInBoard(<NameText name={name} cut={cut} was={was} />, boardContext(), 'en'), el =>
        hasClass(el, 'name'),
      )
    const cut = drawn(true, 'Client-Case-Templates', 'Was “x”')
    expect(cut.attrs.get('class')).toBe('name split')
    // What shows: the two parts, out of a screen reader's way; what is read: the whole name, once.
    const spans = findAll(cut.children, el => el.tag === 'span')
    expect(spans.map(el => [el.attrs.get('class'), el.attrs.get('aria-hidden'), textOf(el)])).toEqual([
      ['sr-only', undefined, 'Client-Case-Templates'],
      ['name-head', 'true', 'Client-Case'],
      ['name-tail', 'true', '-Templates'],
    ])
    expect(cut.attrs.get('title')).toBe('Client-Case-Templates\nWas “x”')
    // Prose is cut at its end, as before, and named in its tooltip.
    const prose = drawn(true, 'Card names on the board')
    expect([prose.attrs.get('class'), textOf(prose), prose.attrs.get('title')]).toEqual([
      'name',
      'Card names on the board',
      'Card names on the board',
    ])
  })
})
