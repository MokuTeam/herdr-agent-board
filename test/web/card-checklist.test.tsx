import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Checklist } from '../../src/core/checklist.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardChecklist } from '../../web/src/models/card.ts'
import { item } from './support/board.tsx'
import { bothCards, drawBoth } from './support/board-scene.tsx'
import { find, findAll, hasClass, type Node } from './support/markup.ts'
import { drawSheet } from './support/sheet-scene.tsx'

const textOf = (node: Node): string => (node.kind === 'text' ? node.text : node.children.map(textOf).join(''))

const SAMPLE: Checklist = {
  done: 3,
  total: 7,
  current: 'Updating transcript tests',
  items: [
    { content: 'Define schema', status: 'completed' },
    { content: 'Read tail', status: 'completed' },
    { content: 'Gate to Claude', status: 'completed' },
    { content: 'Update transcript tests', status: 'in_progress', activeForm: 'Updating transcript tests' },
    { content: 'Add card bar', status: 'pending' },
    { content: 'Add sheet list', status: 'pending' },
    { content: 'Run check', status: 'pending' },
  ],
}

describe('cardChecklist model', () => {
  const t = translator('en')

  test('builds ratio, pct, tooltip, and ariaLabel for active Claude checklist', () => {
    const view = cardChecklist({ agent: 'claude', checklist: SAMPLE }, t)
    expect(view?.ratio).toBe('3/7')
    expect(view?.pct).toBe(43)
    expect(view?.current).toBe('Updating transcript tests')
    expect(view?.tooltip).toContain('Checklist (3/7)')
    expect(view?.tooltip).toContain('✓ Define schema')
    expect(view?.tooltip).toContain('▸ Updating transcript tests')
    expect(view?.tooltip).toContain('○ Add card bar')
    expect(view?.ariaLabel).toBe('3/7: Updating transcript tests')
  })

  test('returns null when completed, absent, or for other agents', () => {
    expect(cardChecklist({ agent: 'claude' }, t)).toBeNull()
    expect(
      cardChecklist(
        {
          agent: 'claude',
          checklist: {
            done: 2,
            total: 2,
            current: '',
            items: [
              { content: 'A', status: 'completed' },
              { content: 'B', status: 'completed' },
            ],
          },
        },
        t,
      ),
    ).toBeNull()
    for (const agent of ['pi', 'codex', 'agy', undefined]) {
      expect(cardChecklist({ ...(agent !== undefined && { agent }), checklist: SAMPLE }, t)).toBeNull()
    }
  })
})

describe('Card checklist rendering (#637)', () => {
  test('renders 3/7 inline in .what and a bottom hairline track with zero new rows', () => {
    const claude = item({
      key: 'c1',
      name: 'Anna',
      agent: 'claude',
      status: 'working',
      column: 'work',
      title: 'Session title',
      checklist: SAMPLE,
    })
    const { react } = drawBoth({ items: [claude] })
    const card = find(react, el => el.tag === 'article' && el.attrs.get('data-key') === 'c1')
    const what = findAll([card], el => hasClass(el, 'what'))
    expect(what).toHaveLength(1)
    expect(textOf(what[0] as Node)).toContain('3/7')
    expect(textOf(what[0] as Node)).toContain('Updating transcript tests')
    expect(what[0]?.attrs.get('title')).toContain('Checklist (3/7)')
    expect(what[0]?.attrs.get('title')).toContain('✓ Define schema')

    const track = findAll([card], el => hasClass(el, 'card-todo-track'))
    expect(track).toHaveLength(1)
    expect(track[0]?.attrs.get('role')).toBe('progressbar')
    expect(track[0]?.attrs.get('aria-valuenow')).toBe('3')
    expect(track[0]?.attrs.get('aria-valuemax')).toBe('7')
    const fill = findAll([card], el => hasClass(el, 'card-todo-fill'))
    expect(fill[0]?.attrs.get('style')).toContain('width:43%')
  })

  test('preserves explicit doing text inline alongside ratio and step, without duplicating identical step', () => {
    const withDoing = item({
      key: 'c1',
      agent: 'claude',
      status: 'working',
      column: 'work',
      doing: 'Auth refactor',
      checklist: SAMPLE,
    })
    const sameStep = item({
      key: 'c2',
      agent: 'claude',
      status: 'working',
      column: 'work',
      doing: 'Updating transcript tests',
      checklist: SAMPLE,
    })
    const { react } = drawBoth({ items: [withDoing, sameStep] })
    const c1 = find(react, el => el.tag === 'article' && el.attrs.get('data-key') === 'c1')
    const w1 = textOf(findAll([c1], el => hasClass(el, 'what'))[0] as Node)
    expect(w1).toContain('3/7')
    expect(w1).toContain('Auth refactor')
    expect(w1).toContain('Updating transcript tests')

    const c2 = find(react, el => el.tag === 'article' && el.attrs.get('data-key') === 'c2')
    const w2 = textOf(findAll([c2], el => hasClass(el, 'what'))[0] as Node)
    expect(w2).toBe('3/7 · Updating transcript tests')
  })

  test('hides checklist on compact sleeping cards, folded waiting cards, and non-Claude agents', () => {
    const sleepy = item({
      key: 's1',
      agent: 'claude',
      status: 'sleeping',
      sleeping: true,
      column: 'idle',
      checklist: SAMPLE,
    })
    const folded = item({
      key: 'f1',
      agent: 'claude',
      status: 'sleeping',
      sleeping: true,
      column: 'ext',
      wait: 'review',
      checklist: SAMPLE,
    })
    const pi = item({
      key: 'p1',
      agent: 'pi',
      status: 'working',
      column: 'work',
      doing: 'Fixing parser',
      checklist: SAMPLE,
    })
    const codex = item({
      key: 'x1',
      agent: 'codex',
      status: 'working',
      column: 'work',
      doing: 'Fixing tests',
      checklist: SAMPLE,
    })
    for (const key of ['s1', 'p1', 'x1']) {
      const { react } = bothCards({ items: [sleepy, folded, pi, codex] }, key)
      expect(react).not.toContain('card-todo-track')
      expect(react).not.toContain('card-todo-ratio')
    }
    const { react: foldedCard } = bothCards({ items: [folded] }, 'f1')
    expect(foldedCard).not.toContain('card-todo-track')
  })

  test('renders full ordered checklist inside SheetCard in English and Russian', () => {
    const claude = item({
      key: 'c1',
      agent: 'claude',
      status: 'working',
      column: 'work',
      checklist: SAMPLE,
    })
    const en = drawSheet({ items: [claude], open: 'c1', lang: 'en' }).reactTitle
    const enCard = find(en, el => el.attrs.get('id') === 'sheet-card')
    expect(enCard.attrs.has('hidden')).toBe(false)
    const enRows = findAll([enCard], el => el.tag === 'li')
    expect(enRows).toHaveLength(7)
    expect(textOf(enCard)).toContain('Checklist')
    expect(textOf(enCard)).toContain('3/7')
    expect(textOf(enCard)).toContain('Updating transcript tests')

    const ru = drawSheet({ items: [claude], open: 'c1', lang: 'ru' }).reactTitle
    const ruCard = find(ru, el => el.attrs.get('id') === 'sheet-card')
    expect(textOf(ruCard)).toContain('Чеклист')
    expect(textOf(ruCard)).toContain('3/7')
  })

  test('stylesheets isolate Terminal rules and honor prefers-reduced-motion', () => {
    const root = join(import.meta.dir, '..', '..')
    const cardsCss = readFileSync(join(root, 'web', 'styles', 'cards.css'), 'utf8')
    const headCss = readFileSync(join(root, 'web', 'styles', 'session-head.css'), 'utf8')
    const termCss = readFileSync(join(root, 'web', 'styles', 'look-terminal.css'), 'utf8')

    expect(cardsCss).toContain('.card-todo-track')
    expect(cardsCss).toContain('.card-todo-fill { transition: none; }')
    expect(headCss).toContain(':is(#sheet, #sidebar-sheet) .sheet-card .checklist-bar-fill { transition: none; }')
    expect(termCss).toContain(':root[data-look="terminal"] .card-todo-track')
  })
})
