import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../src/core/categories.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { cardBox } from '../../src/tui/render-terminal.ts'
import { createState } from '../../src/tui/state.ts'
import { cardBgTask } from '../../web/src/models/card.ts'
import { item } from './support/board.tsx'
import { bothCards, drawBoth } from './support/board-scene.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { drawSheet } from './support/sheet-scene.tsx'

const textOf = (node: Node): string => (node.kind === 'text' ? node.text : node.children.map(textOf).join(''))

describe('cardBgTask model (#676)', () => {
  const en = translator('en')
  const ru = translator('ru')
  const now = Date.UTC(2026, 10, 24, 10, 0)

  test('formats running and stuck states in English and Russian', () => {
    expect(cardBgTask({}, now, en)).toBeNull()

    const fresh = cardBgTask(
      { bgTasks: { count: 1, since: now - 12 * 60_000, detail: 'Run build', stuckMin: 30 } },
      now,
      en,
    )
    expect(fresh).toMatchObject({
      count: 1,
      label: 'Background task · 12 min',
      detail: 'Run build',
      stuck: false,
    })

    const stuckEn = cardBgTask(
      { bgTasks: { count: 1, since: now - 45 * 60_000, detail: 'Chrome screenshot', stuckMin: 30, stuck: true } },
      now,
      en,
    )
    expect(stuckEn).toMatchObject({
      count: 1,
      label: 'Task may be stuck · 45 min',
      detail: 'Chrome screenshot',
      stuck: true,
    })
    expect(stuckEn?.tooltip).toContain('Running past the 30 min threshold')

    const stuckRu = cardBgTask(
      { bgTasks: { count: 2, since: now - 2 * 3600_000, detail: '', stuckMin: 30, stuck: true } },
      now,
      ru,
    )
    expect(stuckRu).toMatchObject({
      count: 2,
      label: '2 задачи · могла зависнуть (2 ч)',
      stuck: true,
    })
  })
})

describe('Card and Sheet rendering for background tasks (#676)', () => {
  test('renders running and stuck background task lines on agy cards and leaves other agents unchanged', () => {
    const now = Date.now()
    const freshAgy = item({
      key: 'a1',
      name: 'Atlas',
      agent: 'agy',
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, since: now - 10 * 60_000, detail: 'Run build', stuckMin: 30 },
    })
    const stuckAgy = item({
      key: 'a2',
      name: 'Ben',
      agent: 'agy',
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, since: now - 45 * 60_000, detail: 'Headless Chrome', stuckMin: 30, stuck: true },
    })
    const claude = item({
      key: 'c1',
      name: 'Cleo',
      agent: 'claude',
      status: 'working',
      column: 'work',
    })
    const codex = item({
      key: 'x1',
      name: 'Anna',
      agent: 'codex',
      status: 'done',
      column: 'done',
    })

    const { react } = drawBoth({ items: [freshAgy, stuckAgy, claude, codex] })
    const cFresh = find(react, el => el.tag === 'article' && el.attrs.get('data-key') === 'a1')
    const freshNow = findAll([cFresh], el => hasClass(el, 'bg-task'))
    expect(freshNow).toHaveLength(1)
    expect(hasClass(freshNow[0] as Element, 'stuck')).toBe(false)
    expect(textOf(freshNow[0] as Node)).toContain('Background task')
    expect(textOf(freshNow[0] as Node)).toContain('Run build')
    expect(textOf(cFresh)).not.toContain('Thinking')

    const cStuck = find(react, el => el.tag === 'article' && el.attrs.get('data-key') === 'a2')
    const stuckNow = findAll([cStuck], el => hasClass(el, 'bg-task'))
    expect(stuckNow).toHaveLength(1)
    expect(hasClass(stuckNow[0] as Element, 'stuck')).toBe(true)
    expect(textOf(stuckNow[0] as Node)).toContain('Task may be stuck')
    expect(textOf(stuckNow[0] as Node)).toContain('Headless Chrome')

    for (const key of ['c1', 'x1']) {
      const { react: html } = bothCards({ items: [claude, codex] }, key)
      expect(html).not.toContain('bg-task')
    }
  })

  test('renders Task row inside SheetCard in English and Russian', () => {
    const now = Date.now()
    const stuck = item({
      key: 'a2',
      agent: 'agy',
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, since: now - 45 * 60_000, detail: 'Headless Chrome', stuckMin: 30, stuck: true },
    })
    const en = drawSheet({ items: [stuck], open: 'a2', lang: 'en' }).reactTitle
    const enCard = find(en, el => el.attrs.get('id') === 'sheet-card')
    expect(enCard.attrs.has('hidden')).toBe(false)
    expect(textOf(enCard)).toContain('Task')
    expect(textOf(enCard)).toContain('Task may be stuck')
    expect(textOf(enCard)).toContain('Headless Chrome')
    expect(findAll([enCard], el => hasClass(el, 'bgtask-value') && hasClass(el, 'stuck'))).toHaveLength(1)

    const ru = drawSheet({ items: [stuck], open: 'a2', lang: 'ru' }).reactTitle
    const ruCard = find(ru, el => el.attrs.get('id') === 'sheet-card')
    expect(textOf(ruCard)).toContain('Задача')
    expect(textOf(ruCard)).toContain('Задача могла зависнуть')
  })

  test('TUI terminal look renders running and stuck bg tasks and stylesheets keep Terminal isolation', () => {
    useLanguage('en')
    const state = createState(DEFAULT_CONFIG, false)
    const now = Date.now()
    state.now = now
    const running = cardBox(
      state,
      item({
        key: 'a1',
        name: 'Atlas',
        agent: 'agy',
        status: 'working',
        column: 'work',
        bgTasks: { count: 1, since: now - 10 * 60_000, detail: 'Build', stuckMin: 30 },
      }),
      42,
      false,
    ).join('\n')
    expect(running).toContain('Background task')
    expect(running).toContain('\x1b[32m')

    const stuck = cardBox(
      state,
      item({
        key: 'a2',
        name: 'Ben',
        agent: 'agy',
        status: 'working',
        column: 'work',
        bgTasks: { count: 1, since: now - 45 * 60_000, detail: 'Chrome', stuckMin: 30, stuck: true },
      }),
      42,
      false,
    ).join('\n')
    expect(stuck).toContain('Task may be stuck')
    expect(stuck).toContain('\x1b[33m')

    const root = join(import.meta.dir, '..', '..')
    const cardsCss = readFileSync(join(root, 'web', 'styles', 'cards.css'), 'utf8')
    const termCss = readFileSync(join(root, 'web', 'styles', 'look-terminal.css'), 'utf8')
    expect(cardsCss).toContain('.now.bg-task.stuck')
    expect(termCss).toContain(':root[data-look="terminal"] .now.bg-task.stuck')
  })
})
