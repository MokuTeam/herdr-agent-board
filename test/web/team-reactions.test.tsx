import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { ThreadLine } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, hasClass } from './support/markup.ts'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const ANNA = 'A'.repeat(43)

const msg = (id: string, over: Partial<ThreadLine> = {}): ThreadLine => ({
  id,
  dir: 'in',
  from: ANNA,
  who: 'anna',
  text: 'check this out',
  ts: '2026-11-11T11:00:00Z',
  ...over,
})

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

let createRoot: typeof import('react-dom/client').createRoot
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let TeamMessageComp: typeof import('../../web/src/components/team/TeamMessage.tsx').TeamMessage

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ TeamMessage: TeamMessageComp } = await import('../../web/src/components/team/TeamMessage.tsx'))
})

afterAll(async () => {
  await new Promise(done => setTimeout(done, 25))
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

function pressClick(el: Element | null) {
  el?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
  el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

function mount() {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    draw(node: ReactNode) {
      act(() => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ now: NOW })}>{node}</BoardContext.Provider>
          </I18nProvider>,
        )
      })
    },
    unmount() {
      act(() => root.unmount())
      host.remove()
    },
  }
}

describe('TeamMessage reactions UI (#687)', () => {
  test('renders reaction chips with counts, active class/aria-pressed, and tooltip naming reactors; click toggles', () => {
    const calls: Array<[string, string, boolean]> = []
    const m = mount()
    try {
      const line = msg('m1', {
        reactions: [
          { emoji: '👍', count: 2, me: true, peers: ['anna'] },
          { emoji: '👀', count: 1, me: false, peers: ['cleo'] },
        ],
      })
      m.draw(
        <TeamMessageComp
          line={line}
          first={true}
          last={true}
          named={false}
          quote={null}
          onQuote={() => {}}
          onReact={(id, emoji, remove) => calls.push([id, emoji, remove])}
        />,
      )
      const chips = [...m.host.querySelectorAll('button.team-react-chip:not(.team-react-add)')]
      expect(chips).toHaveLength(2)
      expect(chips[0]?.classList.contains('me')).toBe(true)
      expect(chips[0]?.getAttribute('aria-pressed')).toBe('true')
      expect(chips[0]?.getAttribute('title')).toBe('You, anna')
      expect(chips[1]?.classList.contains('me')).toBe(false)
      expect(chips[1]?.getAttribute('aria-pressed')).toBe('false')
      expect(chips[1]?.getAttribute('title')).toBe('cleo')

      // '+' chip sits at the end of .team-reactions; first pressClick opens anchored picker, second closes cleanly
      const addChip = m.host.querySelector('.team-reactions > button.team-react-add:last-child')
      expect(addChip).toBeTruthy()
      act(() => {
        pressClick(addChip)
      })
      expect(m.host.querySelector('.team-msg > .team-emoji-picker')).toBeTruthy()
      act(() => {
        pressClick(addChip)
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      // Click own chip -> remove = true; click other's chip -> remove = false
      act(() => {
        chips[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        chips[1]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(calls).toEqual([
        ['m1', '👍', true],
        ['m1', '👀', false],
      ])
    } finally {
      m.unmount()
    }
  })

  test('desktop floating hover bar offers quick 1-click emoji + searchable picker + reply, closes on Escape', () => {
    const calls: Array<[string, string, boolean]> = []
    const replied: string[] = []
    const m = mount()
    try {
      m.draw(
        <TeamMessageComp
          line={msg('m2')}
          first={true}
          last={true}
          named={false}
          quote={null}
          onQuote={() => {}}
          onReply={id => {
            replied.push(id)
          }}
          onReact={(id, emoji, remove) => calls.push([id, emoji, remove])}
        />,
      )
      const bar = m.host.querySelector('.team-msg-bar')
      expect(bar).toBeTruthy()
      const barEmojis = [...(bar?.querySelectorAll('button.team-bar-emoji') ?? [])]
      expect(barEmojis).toHaveLength(4)
      // Clicking a quick emoji on the floating bar reacts immediately in 1 click
      act(() => {
        barEmojis[1]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(calls).toEqual([['m2', '👀', false]])
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      // Reply button inside the floating bar still works
      const replyBtn = bar?.querySelector('button.team-msg-reply')
      expect(replyBtn).toBeTruthy()
      act(() => {
        replyBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(replied).toEqual(['m2'])

      const reactBtn = bar?.querySelector('button.team-msg-react') ?? null
      expect(reactBtn).toBeTruthy()
      // First pressClick (pointerdown + click) opens popover inside .team-msg-row; second closes cleanly without reopening
      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-msg-row > .team-emoji-picker')).toBeTruthy()
      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      // Re-open, search, and pick rocket
      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-msg-row > .team-emoji-picker')).toBeTruthy()
      expect(m.host.querySelectorAll('.team-react-pick')).toHaveLength(6)

      const search = m.host.querySelector('input.team-emoji-search') as HTMLInputElement | null
      expect(search).toBeTruthy()
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(search, 'rocket')
        search?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const gridBtns = [...m.host.querySelectorAll('button.team-emoji-btn')]
      expect(gridBtns.some(b => b.getAttribute('aria-label') === 'rocket')).toBe(true)
      expect(gridBtns.some(b => b.getAttribute('aria-label') === 'thumbsup')).toBe(false)

      act(() => {
        gridBtns
          .find(b => b.getAttribute('aria-label') === 'rocket')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(calls).toEqual([
        ['m2', '👀', false],
        ['m2', '🚀', false],
      ])
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      // Re-open and click outside (.team-bubble, then document.body) -> closes picker
      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeTruthy()
      act(() => {
        m.host.querySelector('.team-bubble')?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeTruthy()
      act(() => {
        dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()

      // Re-open and press Escape on document -> closes picker
      act(() => {
        pressClick(reactBtn)
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeTruthy()
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(m.host.querySelector('.team-emoji-picker')).toBeNull()
    } finally {
      m.unmount()
    }
  })

  test('phone long-press shows quick reactions and searchable picker inside team-msg-when', async () => {
    const calls: Array<[string, string, boolean]> = []
    const m = mount()
    try {
      m.draw(
        <TeamMessageComp
          line={msg('m3')}
          first={true}
          last={true}
          named={false}
          quote={null}
          onQuote={() => {}}
          onReact={(id, emoji, remove) => calls.push([id, emoji, remove])}
        />,
      )
      const bubble = m.host.querySelector('.team-bubble')
      expect(bubble).toBeTruthy()
      await act(async () => {
        bubble?.dispatchEvent(
          Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }), {
            pointerType: 'touch',
          }),
        )
        await new Promise(done => setTimeout(done, 500))
      })

      expect(m.host.querySelector('.team-msg-when')).toBeTruthy()
      const moreBtn = m.host.querySelector('button.team-react-more')
      expect(moreBtn).toBeTruthy()
      const quickBtns = [...m.host.querySelectorAll('button.team-react-pick:not(.team-react-more)')]
      expect(quickBtns).toHaveLength(6)

      // Open searchable picker from + button on phone
      act(() => {
        moreBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(m.host.querySelector('.team-msg-when .team-emoji-picker')).toBeTruthy()

      // Click quick reaction 👀 -> calls onReact and closes long-press panel
      act(() => {
        quickBtns[1]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(calls).toEqual([['m3', '👀', false]])
      expect(m.host.querySelector('.team-msg-when')).toBeNull()
    } finally {
      m.unmount()
    }
  })

  test('TeamMessage without onReact or reactions leaves ThreadPane rendering unchanged', () => {
    const tree = renderInBoard(
      <TeamMessageComp line={msg('m4')} first={true} last={true} named={false} quote={null} onQuote={() => {}} />,
      board({ now: NOW }),
    )
    expect(findAll(tree, n => hasClass(n, 'team-reactions'))).toHaveLength(0)
    expect(findAll(tree, n => hasClass(n, 'team-msg-react'))).toHaveLength(0)
    expect(findAll(tree, n => hasClass(n, 'team-msg-bar'))).toHaveLength(0)
  })

  test('team-emoji-picker is a floating popover in team.css', () => {
    const css = readFileSync(resolve(import.meta.dir, '../../web/styles/team.css'), 'utf8')
    expect(css).toMatch(/\.team-emoji-picker\s*\{[^}]*position:\s*absolute\b/)
  })
})
