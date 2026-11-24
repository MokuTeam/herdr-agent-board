// MokuBoard BrandMark component & NavRail header branding (#705).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandMark } from '../../web/src/components/BrandMark.tsx'
import { NavRail } from '../../web/src/components/NavRail.tsx'
import { board, renderInBoard } from './support/board.tsx'
import { byId, findAll, hasClass, type Node, parseHtml } from './support/markup.ts'

const noop = () => {}
const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

describe('BrandMark & NavRail header (#705)', () => {
  test('BrandMark renders opposing brackets in currentColor and focus tile in --brand-accent', () => {
    const nodes = parseHtml(renderToStaticMarkup(<BrandMark />))
    const svg = nodes[0]
    expect(svg?.kind).toBe('element')
    if (svg?.kind !== 'element') return
    expect(svg.tag).toBe('svg')
    expect(hasClass(svg, 'brand-mark')).toBe(true)
    expect(svg.attrs.get('aria-hidden')).toBe('true')
    expect(svg.attrs.get('width')).toBe('18')
    expect(svg.attrs.get('height')).toBe('18')
    expect(svg.attrs.get('style')).toContain('width:18px')

    const paths = findAll(nodes, el => el.tag === 'path')
    const rects = findAll(nodes, el => el.tag === 'rect')
    expect(paths).toHaveLength(2)
    expect(rects).toHaveLength(1)
    expect(paths.every(p => p.attrs.get('fill') === 'currentColor')).toBe(true)
    expect(rects[0]?.attrs.get('fill')).toBe('var(--brand-accent, #7b2fff)')
  })

  test('BrandMark supports monochrome mask mode and optional accessible title', () => {
    const nodes = parseHtml(renderToStaticMarkup(<BrandMark size={24} mono title="MokuBoard" />))
    const svg = nodes[0]
    expect(svg?.kind).toBe('element')
    if (svg?.kind !== 'element') return
    expect(hasClass(svg, 'mono')).toBe(true)
    expect(svg.attrs.get('role')).toBe('img')
    expect(svg.attrs.get('aria-label')).toBe('MokuBoard')
    expect(svg.attrs.has('aria-hidden')).toBe(false)
    expect(svg.attrs.get('width')).toBe('24')

    const rects = findAll(nodes, el => el.tag === 'rect')
    expect(rects[0]?.attrs.get('fill')).toBe('currentColor')
  })

  test('NavRail shows the MokuBoard wordmark in #rail-expand without a second mark (#719)', () => {
    for (const lang of ['en', 'ru'] as const) {
      const nodes = renderInBoard(
        <NavRail
          expanded
          onToggleExpand={noop}
          drawerOpen={false}
          onCloseDrawer={noop}
          activePlace="board"
          onBoard={noop}
          onSchedule={noop}
          onCategories={noop}
          onArchive={noop}
          onSettings={noop}
        />,
        board(),
        lang,
      )
      const headBtn = byId(nodes, 'rail-expand')
      expect(findAll([headBtn], el => el.tag === 'svg' && hasClass(el, 'brand-mark'))).toHaveLength(0)
      expect(findAll([headBtn], el => hasClass(el, 'rail-brand')).map(textOf)).toEqual(['MokuBoard'])
    }
  })
})
