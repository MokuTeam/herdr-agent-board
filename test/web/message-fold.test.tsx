// A very long message folds in the thread (components/sheet/MessageText.tsx, #174), drawn by
// react-dom into a small DOM (support/mini-dom.ts) so its effects run: it measures, folds at two
// screens, opens and folds again from one button that keeps the focus, keeps its links out of the
// Tab order while folded, stays open as the thread is read again and moves on, and follows the
// window's height.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { Thread as ThreadView } from '../../web/src/components/sheet/Thread.tsx'
import type { I18nProvider as Provider } from '../../web/src/i18n/I18nProvider.tsx'
import { layout, MiniElement, MiniEvent, type MiniNode, miniWindow } from './support/mini-dom.ts'

type Dom = ReturnType<typeof miniWindow>
let dom: Dom
let render: (conversation: ConversationTurn[]) => void
let root: { unmount(): void }
let flush: (fn: () => void) => void
const resized: string[] = []

// A message's drawn height: a long text is 5000 px, anything else 100.
const LONG = `${'A line of a long answer. '.repeat(400)}[the docs](https://example.com/docs)`

beforeAll(async () => {
  dom = miniWindow(800)
  layout.scrollHeight = el => (el.textContent.length > 5000 ? 5000 : 100)
  // react-dom looks at the window when it loads: after it is there.
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { Thread } = (await import('../../web/src/components/sheet/Thread.tsx')) as { Thread: typeof ThreadView }
  const { I18nProvider } = (await import('../../web/src/i18n/I18nProvider.tsx')) as { I18nProvider: typeof Provider }
  const { NO_LINKS } = await import('../../web/src/components/sheet/ThreadLinks.tsx')
  const container = dom.document.body.appendChild(dom.document.createElement('div'))
  const r = createRoot(container as unknown as HTMLElement)
  root = r
  flush = flushSync
  const links = { ...NO_LINKS, onResize: () => resized.push('resized') }
  render = conversation =>
    flushSync(() =>
      r.render(
        <I18nProvider lang="en">
          <Thread conversation={conversation} item={{}} links={links} />
        </I18nProvider>,
      ),
    )
})

afterAll(async () => {
  flush(() => root.unmount())
  // What react-dom scheduled for after a draw runs before the window goes.
  await new Promise(done => setTimeout(done, 20))
  dom.uninstall()
})

const all = (node: MiniNode): MiniElement[] =>
  node.childNodes.flatMap(c => (c instanceof MiniElement ? [c, ...all(c)] : []))
const bubbles = () => all(dom.document.body).filter(el => el.className.startsWith('msg '))
const body = (bubble: MiniElement | undefined) => all(bubble ?? dom.document.body).find(el => el.localName === 'div')
const button = (bubble: MiniElement | undefined) =>
  all(bubble ?? dom.document.body).find(el => el.localName === 'button')
const click = (el: MiniElement | undefined) => flush(() => el?.dispatchEvent(new MiniEvent('click')))
const link = (bubble: MiniElement | undefined) => all(bubble ?? dom.document.body).find(el => el.localName === 'a')

const turns: ConversationTurn[] = [
  { role: 'user', text: 'Explain it all', at: 1 },
  { role: 'assistant', text: LONG, at: 2 },
]

test('a message taller than two screens folds, its links out of the Tab order; a short one does not', () => {
  render(turns)
  const [short, long] = bubbles()
  expect(body(short)?.className).toBe('md')
  expect(button(short)).toBeUndefined()
  expect(body(long)?.className).toBe('md folded')
  expect(body(long)?.style.maxHeight).toBe('1600px')
  expect(button(long)?.textContent).toBe('Show all')
  expect(button(long)?.getAttribute('aria-expanded')).toBe('false')
  expect(button(long)?.getAttribute('aria-controls')).toBe(body(long)?.id)
  expect(link(long)?.getAttribute('tabindex')).toBe('-1')
})

test('it opens and folds again from one button, which keeps the focus; the thread hears of each', () => {
  render(turns)
  const long = bubbles()[1]
  const toggle = button(long)
  toggle?.focus()
  click(toggle)
  expect(body(long)?.className).toBe('md')
  expect(body(long)?.style.maxHeight ?? '').toBe('')
  expect(button(long)).toBe(toggle)
  expect(toggle?.textContent).toBe('Show less')
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  expect(link(long)?.hasAttribute('tabindex')).toBe(false)
  expect(dom.document.activeElement).toBe(toggle as MiniElement)
  expect(resized).toEqual(['resized'])
  click(toggle)
  expect(body(long)?.className).toBe('md folded')
  expect(toggle?.textContent).toBe('Show all')
  expect(dom.document.activeElement).toBe(toggle as MiniElement)
  expect(resized).toEqual(['resized', 'resized'])
})

test('one opened stays open when the thread is read again, moves on, and drops its oldest turn', () => {
  const isOpen = (bubble: MiniElement | undefined) => body(bubble)?.className === 'md'
  render(turns)
  expect(isOpen(bubbles()[1])).toBe(false)
  click(button(bubbles()[1]))
  expect(isOpen(bubbles()[1])).toBe(true)
  render(structuredClone(turns))
  expect(isOpen(bubbles()[1])).toBe(true)
  const more: ConversationTurn[] = [...turns, { role: 'user', text: 'Thanks', at: 3 }]
  render(more)
  expect(isOpen(bubbles()[1])).toBe(true)
  render(more.slice(1))
  expect(isOpen(bubbles()[0])).toBe(true)
})

test("pi's text blocks of one message share its time: the one opened stays open as the window drops the oldest", () => {
  const pi: ConversationTurn[] = [
    { role: 'user', text: 'Go', at: 10 },
    { role: 'assistant', text: `First. ${LONG}`, at: 20 },
    { role: 'assistant', text: `Second. ${LONG}`, at: 20 },
  ]
  render(pi)
  click(button(bubbles()[2]))
  expect(bubbles().map(b => body(b)?.className)).toEqual(['md', 'md folded', 'md'])
  render(pi.slice(1))
  expect(bubbles().map(b => body(b)?.className)).toEqual(['md folded', 'md'])
})

test("it follows the window's height: no fold once two screens hold it, a fold again when they do not", () => {
  render([{ role: 'assistant', text: LONG, at: 30 }])
  expect(body(bubbles()[0])?.className).toBe('md folded')
  flush(() => dom.resize(3000))
  expect(body(bubbles()[0])?.className).toBe('md')
  expect(button(bubbles()[0])).toBeUndefined()
  flush(() => dom.resize(800))
  expect(body(bubbles()[0])?.className).toBe('md folded')
})
