// Side questions on the page: what the message box sends aside, the box's switch only where the
// board can ask one, and the cards (components/sheet/Aside.tsx, models/aside.ts).
import { expect, test } from 'bun:test'
import { AsideDeck, useAsideBox } from '../../web/src/components/sheet/Aside.tsx'
import type { Aside } from '../../web/src/hooks/useAside.ts'
import { asideQuestion, dollars, kilo } from '../../web/src/models/aside.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

const text = (nodes: Node[]): string =>
  nodes.map(n => ('text' in n ? n.text : text((n as { children: Node[] }).children))).join('')

test('the box sends aside what it holds with its switch on, or what follows /btw; else it is a message', () => {
  expect(asideQuestion('  what was the code word? ', true)).toBe('what was the code word?')
  expect(asideQuestion('', true)).toBe('')
  expect(asideQuestion('/btw what was the code word?', false)).toBe('what was the code word?')
  expect(asideQuestion('  /BTW\nwhich file?', false)).toBe('which file?')
  expect(asideQuestion('/btw', false)).toBe('')
  expect(asideQuestion('/btwx no', false)).toBe(null)
  expect(asideQuestion('please run /btw later', false)).toBe(null)
  expect(asideQuestion('hello', false)).toBe(null)
  expect([dollars(0.270216), dollars(0.0412), dollars(1.5)]).toEqual(['0.27', '0.041', '1.50'])
  expect([kilo(33758), kilo(200), kilo(0)]).toEqual([34, 1, 1])
})

const claude = item({ key: 'a', agent: 'claude', session: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Acme' })

function Probe({ value }: { value: string }) {
  const box = useAsideBox(value, () => {})
  return <i data-can={String(box.can)} data-question={String(box.question)} />
}
const probe = (fields: Parameters<typeof payload>[0], open = 'a', value = '/btw hi') => {
  const nodes = renderInBoard(<Probe value={value} />, board({ data: payload(fields), ui: { open } }))
  const i = findAll(nodes, el => el.tag === 'i')[0]
  return [i?.attrs.get('data-can'), i?.attrs.get('data-question')]
}

test('only where the board can ask aside, and only a Claude session: else the box is a message box as before', () => {
  expect(probe({ items: [claude], aside: true })).toEqual(['true', 'hi'])
  // A board that does not say (an older one, or no Claude Code on its PATH): /btw goes to the session.
  expect(probe({ items: [claude] })).toEqual(['false', 'null'])
  expect(probe({ items: [claude], aside: false })).toEqual(['false', 'null'])
  expect(probe({ items: [{ ...claude, agent: 'pi' }], aside: true })).toEqual(['false', 'null'])
  expect(probe({ items: [{ ...claude, session: null }], aside: true })).toEqual(['false', 'null'])
  expect(probe({ items: [claude], aside: true }, 'other')).toEqual(['false', 'null'])
})

const asked = (fields: Partial<Aside>): Aside => ({
  id: 1,
  key: 'a',
  question: 'What was the code word?',
  state: 'answered',
  text: '**MANGO-77**',
  error: '',
  costUsd: 0.270216,
  tokens: { context: 33758, cached: 1200, output: 8 },
  ms: 2900,
  ...fields,
})
const deck = (list: Aside[], lang = 'en') =>
  renderInBoard(<AsideDeck sessionKey="a" list={list} controls={{ close() {}, again() {} }} />, board(), lang)
const byClass = (nodes: Node[], name: string) =>
  findAll(nodes, el => (el.attrs.get('class') ?? '').split(' ').includes(name))

test('a card: what was asked, the answer, and that it went as a request of its own with its price and context', () => {
  const nodes = deck([asked({})])
  expect(text(byClass(nodes, 'aside-q'))).toBe('What was the code word?')
  expect(text(byClass(nodes, 'aside-answer'))).toBe('MANGO-77')
  expect(findAll(byClass(nodes, 'aside-answer'), el => el.tag === 'b')).toHaveLength(1)
  expect(text(byClass(nodes, 'aside-meta'))).toBe(
    'a request of its own · ≈ $0.27 · 34k tokens of context · 1k from the cache · 3 s',
  )
  expect(text(byClass(deck([asked({ costUsd: null, tokens: null, ms: 0 })]), 'aside-meta'))).toBe(
    'a request of its own',
  )
  expect(text(byClass(deck([asked({})], 'ru'), 'aside-meta'))).toBe(
    'отдельный запрос · ≈ $0.27 · 34k токенов контекста · 1k из кэша · 3 с',
  )
})

test('on its way it says so and its button cancels; one that failed says why and asks again; none: nothing drawn', () => {
  const asking = deck([asked({ state: 'asking', text: '' })])
  expect(text(byClass(asking, 'aside-wait'))).toBe('Asking a copy of the conversation…')
  expect(byClass(asking, 'aside-close')[0]?.attrs.get('aria-label')).toBe('Cancel')
  expect(byClass(asking, 'aside-meta')).toEqual([])
  const failed = deck([asked({ state: 'failed', text: '', error: 'No answer in 180 s' })])
  expect(text(byClass(failed, 'aside-error'))).toBe('No answer in 180 sAsk again')
  expect(byClass(failed, 'aside-close')[0]?.attrs.get('aria-label')).toBe('Close')
  expect(deck([])).toEqual([])
})
