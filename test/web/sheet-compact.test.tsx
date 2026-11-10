// The compact session sheet (#345): the choice and where it is kept (models/sheet-density.ts), the
// frame a fold is drawn in (models/collapse.ts), the helpers' count, and the markup each part has
// whole and compact. What the parts do on a real DOM is sheet-compact-dom.test.tsx; with the head
// whole the markup is the old page's, which sheet.test.tsx keeps.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRef } from 'react'
import type { PublicHelper } from '../../src/core/helpers.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { HelpersStrip } from '../../web/src/components/helpers/HelpersStrip.tsx'
import { Composer } from '../../web/src/components/sheet/Composer.tsx'
import { SheetView } from '../../web/src/components/sheet/Sheet.tsx'
import { type HeadHelpers, SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { NO_OUTBOX } from '../../web/src/hooks/useComposer.ts'
import { emptyDetail } from '../../web/src/hooks/useSessionDetail.ts'
import { collapseFrame, type Sizes } from '../../web/src/models/collapse.ts'
import { helpersChip, helpersSum } from '../../web/src/models/helper-model.ts'
import { NO_HEAD_BUTTONS, sheetAvailability } from '../../web/src/models/sheet.ts'
import {
  DENSITY_KEYS,
  defaultCompact,
  densityClass,
  densityValue,
  keptCompact,
} from '../../web/src/models/sheet-density.ts'
import { onRevealDetails, revealSheetDetails } from '../../web/src/models/sheet-reveal.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'
import { byClass, byId, canonical, findAll, hasClass, type Node } from './support/markup.ts'
import { composerOf } from './support/sheet-scene.tsx'

const t = translator('en')

describe('the choice between a compact and a whole head', () => {
  test('a phone starts compact, a wider panel whole', () => {
    expect(densityClass(true)).toBe('phone')
    expect(densityClass(false)).toBe('wide')
    expect(defaultCompact('phone')).toBe(true)
    expect(defaultCompact('wide')).toBe(false)
    expect(keptCompact('phone', null)).toBe(true)
    expect(keptCompact('wide', null)).toBe(false)
  })

  test('what this browser kept wins, for the width it was kept for; anything else is the default', () => {
    expect(keptCompact('phone', 'full')).toBe(false)
    expect(keptCompact('wide', 'compact')).toBe(true)
    for (const junk of ['', '1', 'true', 'COMPACT', 'null', '{}']) {
      expect(keptCompact('phone', junk)).toBe(true)
      expect(keptCompact('wide', junk)).toBe(false)
    }
    expect(densityValue(true)).toBe('compact')
    expect(densityValue(false)).toBe('full')
    // One key per width class: a narrow desktop window does not overwrite a wide one.
    expect(DENSITY_KEYS.phone).not.toBe(DENSITY_KEYS.wide)
    expect(Object.values(DENSITY_KEYS).every(k => k.startsWith('board.'))).toBe(true)
  })
})

describe('a fold between its folded size and its open one', () => {
  const folded: Sizes = { height: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0 }
  const open: Sizes = { height: 100, paddingTop: 0, paddingBottom: 10, marginTop: 0, marginBottom: 8 }

  test('folded and open are the stylesheet’s own sizes, and the middle is between them', () => {
    expect(collapseFrame(0, folded, open, 8, true)).toEqual({ ...folded, opacity: 0, shift: -8 })
    expect(collapseFrame(1, folded, open, 8, true)).toEqual({ ...open, opacity: 1, shift: -0 })
    const half = collapseFrame(0.5, folded, open, 8, true)
    expect([half.height, half.paddingBottom, half.marginBottom, half.opacity, half.shift]).toEqual([50, 5, 4, 0.5, -4])
  })

  test('a spring that overshoots never makes a size negative or the part more than opaque', () => {
    const past = collapseFrame(1.1, folded, open, 8, true)
    expect(past.height).toBeCloseTo(110, 6)
    expect([past.opacity, past.shift]).toEqual([1, -0])
    const before = collapseFrame(-0.1, folded, open, 8, true)
    expect([before.height, before.paddingBottom, before.opacity]).toEqual([0, 0, 0])
  })

  test('a question’s text keeps its colour and does not rise; a broken number is the open size', () => {
    const text = collapseFrame(0.3, { ...folded, height: 36 }, { ...open, height: 90 }, 0, false)
    expect([text.opacity, text.shift, text.height]).toEqual([1, -0, 52.2])
    expect(collapseFrame(Number.NaN, folded, open, 0, true).height).toBe(100)
  })
})

describe('the helpers’ count in the head', () => {
  const helper = (status: PublicHelper['status']): Pick<PublicHelper, 'status'> => ({ status })

  test('the ones at work, else all of them; the label is the strip’s own summary', () => {
    expect(helpersChip([helper('running'), helper('running'), helper('done')], [], t)).toEqual({
      count: 2,
      running: true,
      label: 'Helpers: 2 at work · 1 finished',
    })
    expect(helpersChip([helper('done'), helper('done'), helper('done')], [], t)).toEqual({
      count: 3,
      running: false,
      label: 'Helpers: 3 finished',
    })
    expect(helpersSum([], t)).toBe('')
  })

  test('workflow runs with no helper of their own are counted; with nothing there is no count', () => {
    expect(helpersChip([], [{}, {}], t)).toEqual({ count: 2, running: false, label: 'Helpers' })
    expect(helpersChip([], [], t)).toBeNull()
  })

  test('in Russian, with its plurals', () => {
    const ru = translator('ru')
    expect(helpersChip([helper('running'), helper('done'), helper('done')], [], ru)?.label).toBe(
      'Помощники: 1 в работе · 2 закончили',
    )
  })
})

describe('the head, whole and compact', () => {
  const working = item({
    key: 'a',
    name: 'Alpha',
    status: 'working',
    column: 'work',
    category: 'proj',
    workspace: 'web',
    doing: 'the login form',
  })
  const chip: HeadHelpers = { count: 2, running: true, label: 'Helpers: 2 at work', onOpen() {} }
  const head = (compact: boolean, helpers?: HeadHelpers, lang = 'en') =>
    renderInBoard(
      <SheetHead item={working} missing={false} card={{ disabled: false, open: false }} fold={{ compact, helpers }} />,
      board({ data: payload({ items: [working], categories: CATEGORIES }), ui: { open: 'a' } }),
      lang,
    )
  const inside = (nodes: Node[], id: string) => findAll(nodes, el => el.attrs.get('id') === id)

  const ids = (el: { children: Node[] }) =>
    el.children
      .filter(c => c.kind === 'element')
      .map(c => (c.kind === 'element' ? (c.attrs.get('id') ?? c.attrs.get('class')) : ''))

  test('the row is the pills, the name, the count and the chevron; the facts and the card’s fields are in the fold under it', () => {
    for (const compact of [true, false]) {
      const nodes = head(compact, chip)
      const row = byClass(nodes, 'sheet-headline')
      // The pills are the row the head always had, in its order; the name follows, then what folds it.
      expect(ids(row)).toEqual(['sheet-pills', 'sheet-name', 'sheet-helpers-chip', 'sheet-compact-toggle'])
      expect(ids(byClass(nodes, 'sheet-pills'))).toEqual([
        'sheet-status',
        'sheet-lane',
        'sheet-properties-toggle',
        'sheet-favorite',
      ])
      const fold = byId(nodes, 'sheet-details')
      for (const id of ['sheet-meta', 'sheet-card'])
        expect([id, inside(fold.children, id).length, inside(row.children, id).length]).toEqual([id, 1, 0])
      expect(findAll(fold.children, el => hasClass(el, 'sheet-fold')).length).toBe(1)
    }
    // The fold is where the stylesheet gives it its folded size (hooks/useCollapse.ts moves it).
    const compact = head(true, chip)
    expect(byId(compact, 'sheet-details').attrs.has('data-folded')).toBe(true)
    expect(byId(compact, 'sheet-name').attrs.get('title')).toBe('Alpha')
  })

  test('whole, the fold is open; the chevron says what it does, with its state for a screen reader', () => {
    for (const [compact, expanded, title] of [
      [true, 'false', 'Show details'],
      [false, 'true', 'Hide details'],
    ] as const) {
      const nodes = head(compact)
      const toggle = byId(nodes, 'sheet-compact-toggle')
      expect([toggle.tag, toggle.attrs.get('type')]).toEqual(['button', 'button'])
      expect([toggle.attrs.get('aria-expanded'), toggle.attrs.get('aria-controls'), toggle.attrs.get('title')]).toEqual(
        [expanded, 'sheet-details sheet-helpers sheet-actions', title],
      )
      expect(toggle.attrs.get('aria-label')).toBe('Session details')
      expect(byId(nodes, 'sheet-details').attrs.has('data-folded')).toBe(compact)
      // It controls the head's fold, the helpers' strip and the action row, which fold with it.
      expect(toggle.attrs.get('aria-controls')?.split(' ')[0]).toBe(byId(nodes, 'sheet-details').attrs.get('id'))
    }
    const ru = byId(head(true, undefined, 'ru'), 'sheet-compact-toggle')
    expect([ru.attrs.get('title'), ru.attrs.get('aria-label')]).toEqual(['Показать сведения', 'Сведения о сессии'])
  })

  test('the helpers’ count is a button that says what it counts, and is there only with helpers', () => {
    const button = byId(head(true, chip), 'sheet-helpers-chip')
    expect([button.tag, button.attrs.get('aria-label'), button.attrs.get('title')]).toEqual([
      'button',
      'Helpers: 2 at work',
      'Helpers: 2 at work',
    ])
    expect(byClass([button], 'dot').attrs.get('class')).toBe('dot work')
    expect(inside(head(true), 'sheet-helpers-chip')).toEqual([])
    const ended = byId(head(true, { ...chip, running: false, count: 10 }), 'sheet-helpers-chip')
    expect(byClass([ended], 'dot').attrs.get('class')).toBe('dot done')
  })

  test('with no session yet, the page starts with the empty places it always had', () => {
    const empty = renderInBoard(<SheetHead item={null} missing={false} fold={{ compact: true }} />, board())
    expect(canonical(empty)).not.toContain('sheet-compact-toggle')
    expect(canonical(empty)).not.toContain('sheet-details')
  })
})

describe('the parts that fold with the head', () => {
  const helpers: PublicHelper[] = []
  const strip = (props: { folded?: boolean }) =>
    renderInBoard(
      <HelpersStrip
        helpers={[
          {
            id: 'h1',
            kind: 'agent',
            status: 'done',
            description: 'check',
            endedAt: Date.now() - 600_000,
          } as unknown as PublicHelper,
          ...helpers,
        ]}
        workflows={[]}
        onHelper={() => {}}
        onList={() => {}}
        {...props}
      />,
      board(),
    )

  test('the strip folds only when asked to; asked nothing, its markup is the one it had', () => {
    expect(byId(strip({ folded: true }), 'sheet-helpers').attrs.has('data-folded')).toBe(true)
    expect(byId(strip({ folded: false }), 'sheet-helpers').attrs.has('data-folded')).toBe(false)
    expect(byId(strip({}), 'sheet-helpers').attrs.has('data-folded')).toBe(false)
  })

  const composer = (fold?: { folded: boolean; onToggle(): void }) => {
    const sessionItem = item({ key: 'a', name: 'Alpha', status: 'working', column: 'work', contextPct: 50 })
    return renderInBoard(
      <Composer
        composer={{ ...composerOf({ open: 'a' }), messageRef: createRef(), outbox: NO_OUTBOX }}
        item={sessionItem}
        availability={sheetAvailability({ canMutate: true, canEdit: true, missing: false, turn: true }, t)}
        buttons={NO_HEAD_BUTTONS}
        changesHidden
        present
        canMutate
        fold={fold}
      />,
      board({ data: payload({ items: [sessionItem] }) }),
    )
  }

  test('the action row folds behind the footer line, whose chevron opens it; the row’s own buttons stay in it', () => {
    const folded = composer({ folded: true, onToggle() {} })
    const row = byClass(folded, 'composer-actions')
    expect([row.attrs.get('id'), row.attrs.has('data-folded')]).toEqual(['sheet-actions', true])
    expect(findAll(row.children, el => el.attrs.get('id') === 'sheet-more').length).toBe(1)
    const toggle = byClass(folded, 'foot-toggle')
    expect([toggle.tag, toggle.attrs.get('aria-expanded'), toggle.attrs.get('aria-controls')]).toEqual([
      'button',
      'false',
      'sheet-actions',
    ])
    expect([toggle.attrs.get('aria-label'), toggle.attrs.get('title')]).toEqual(['Session actions', 'Show actions'])
    // The meter's facts stay on the line the chevron is on.
    expect(byClass(folded, 'session-meter').children.some(c => c.kind === 'element' && hasClass(c, 'meter-ctx'))).toBe(
      true,
    )
    const shown = composer({ folded: false, onToggle() {} })
    expect(byClass(shown, 'composer-actions').attrs.has('data-folded')).toBe(false)
    expect(byClass(shown, 'foot-toggle').attrs.get('aria-expanded')).toBe('true')
  })

  test('whole, the footer is as it was: no id on the row, no chevron on the line', () => {
    const nodes = composer()
    expect(byClass(nodes, 'composer-actions').attrs.has('id')).toBe(false)
    expect(byClass(nodes, 'composer-actions').attrs.has('data-folded')).toBe(false)
    expect(findAll(nodes, el => hasClass(el, 'foot-toggle'))).toEqual([])
  })

  test('an open question is cut to two lines in the compact sheet, its button under it; whole, it is the old banner', () => {
    const asking = item({
      key: 'a',
      name: 'Alpha',
      status: 'idle',
      column: 'me',
      attention: 'ask',
      question: 'Keep the name in the report? Bill the fix?',
    })
    const view = (compact: boolean) =>
      renderInBoard(
        <SheetView
          open="a"
          item={asking}
          detail={emptyDetail('a')}
          composer={composerOf({ open: 'a' })}
          compact={compact}
        />,
        board({ data: payload({ items: [asking] }), ui: { open: 'a' } }),
      )
    const banner = byClass(view(true), 'asked')
    expect(hasClass(banner, 'asked-compact')).toBe(true)
    const clip = byClass([banner], 'asked-clip')
    expect([clip.attrs.has('data-folded'), canonical([clip])]).toEqual([
      true,
      [
        '<span class="asked-clip" data-folded="">',
        '  <b>ASKS</b>',
        '  Keep the name in the report? Bill the fix?',
        '</span>',
      ].join('\n'),
    ])
    const dismiss = byClass([banner], 'asked-dismiss')
    expect([dismiss.attrs.get('data-act'), dismiss.attrs.has('disabled')]).toEqual(['dismiss', false])
    // Whole: no compact parts at all.
    const whole = byClass(view(false), 'asked')
    expect(hasClass(whole, 'asked-compact')).toBe(false)
    expect(findAll([whole], el => hasClass(el, 'asked-clip'))).toEqual([])
  })
})

describe('a flow outside the sheet asking for its fold', () => {
  test('is heard by the sheet, which says whether the head was compact for that session', () => {
    const heard: string[] = []
    let compact = true
    const stop = onRevealDetails(key => {
      heard.push(key)
      return compact
    })
    expect(revealSheetDetails('a')).toBe(true)
    compact = false
    expect(revealSheetDetails('b')).toBe(false)
    expect(heard).toEqual(['a', 'b'])
    // With no sheet to hear it, nothing was folded.
    stop()
    expect(revealSheetDetails('a')).toBe(false)
    expect(heard).toEqual(['a', 'b'])
  })
})

describe('what the stylesheet does with the folded states', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', 'sheet-compact.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  /** The declarations of the rule whose selector is exactly `selector`. */
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at).toBeGreaterThanOrEqual(0)
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  }

  test('a folded part has no height, is not drawn, and is out of the tab order and the accessibility tree, until the spring moves it', () => {
    for (const selector of [
      '#sheet .sheet-details[data-folded]:not([data-moving])',
      '#sheet .sheet-helpers[data-folded]:not([data-moving])',
      '#sheet .composer-actions[data-folded]:not([data-moving])',
    ]) {
      const body = rule(selector)
      expect([
        selector,
        /height: 0;/.test(body),
        /visibility: hidden;/.test(body),
        /overflow: hidden;/.test(body),
      ]).toEqual([selector, true, true, true])
    }
    // The spring's own state clips the part and nothing more: it sets the sizes inline.
    for (const selector of [
      '#sheet .sheet-details[data-moving]',
      '#sheet .sheet-helpers[data-moving]',
      '#sheet .composer-actions[data-moving]',
    ])
      expect(rule(selector).trim()).toBe('overflow: hidden;')
  })

  test('a question folded is cut to two lines, and not while the spring moves it', () => {
    expect(rule('.asked-clip[data-folded]:not([data-moving])')).toContain('-webkit-line-clamp: 2')
  })

  test('the head is one row in the compact sheet only, and not in the wide, low layout', () => {
    const block = '@container sheet not ((min-width: 680px) and (min-aspect-ratio: 5 / 4) and (height < 600px)) {'
    const start = css.indexOf(block)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = css.indexOf('\n}\n', start)
    for (const selector of [
      '#sheet.sheet-compact .sheet-headline > .sheet-pills',
      '#sheet.sheet-compact .sheet-pills > :not(.status-pill)',
    ]) {
      expect(css.indexOf(selector)).toBeGreaterThan(start)
      expect(css.indexOf(selector)).toBeLessThan(end)
    }
    // Nothing outside that block dissolves the pills' row or takes the lane, the pencil and the star out of it.
    const outside = `${css.slice(0, start)}${css.slice(end)}`
    expect(outside.includes('display: contents')).toBe(false)
    expect(outside.includes('.sheet-pills > :not(.status-pill)')).toBe(false)
  })
})
