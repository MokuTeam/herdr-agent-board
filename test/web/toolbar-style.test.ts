// Stylesheet invariants for the #651 design system, Hybrid B+C header, collapsible left rail,
// and structured Settings panel: link order, no header wrapping, flat typographic lane tabs,
// scroll-fold rules, phone drawer & horizontal lane strip breakpoint, reduced motion, and Terminal look.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
const plain = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')

const designCss = read('web/styles/design-system.css')
const railCss = read('web/styles/rail.css')
const toolbarCss = read('web/styles/toolbar.css')
const settingsCss = read('web/styles/settings-panel.css')
const terminalCss = read('web/styles/look-terminal.css')

function rule(sheet: string, selector: string): Record<string, string> | null {
  const text = plain(sheet)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(text)
  if (!found) return null
  const out: Record<string, string> = {}
  for (const decl of (found[1] ?? '').split(';')) {
    const at = decl.indexOf(':')
    if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim()
  }
  return out
}

describe('stylesheet loading order and token foundation (#651)', () => {
  test('new stylesheets load after upstream sheets and before look-terminal.css', () => {
    const links = [...read('web/index.html').matchAll(/href="styles\/([^"]+)"/g)].map(m => m[1])
    const idx = (name: string) => links.indexOf(name)
    expect(idx('design-system.css')).toBeGreaterThan(idx('app.css'))
    expect(idx('design-system.css')).toBeGreaterThan(idx('segments.css'))
    expect(idx('rail.css')).toBeGreaterThan(idx('design-system.css'))
    expect(idx('toolbar.css')).toBeGreaterThan(idx('design-system.css'))
    expect(idx('settings-panel.css')).toBeGreaterThan(idx('design-system.css'))
    // Terminal look stays last so every terminal rule wins on equal specificity.
    expect(links.at(-1)).toBe('look-terminal.css')
  })

  test('design system defines neutral surfaces, cobalt accent, radii, and 14px monochrome provider mark slot', () => {
    expect(designCss).toContain('--accent: #2558d9')
    expect(designCss).toContain('--r-sm: 6px')
    expect(designCss).toContain('--r-md: 8px')
    expect(designCss).toContain('--r-lg: 12px')
    expect(rule(designCss, '.card-top > .provider-mark')).toMatchObject({ width: '14px', height: '14px' })
    expect(rule(designCss, '.card-top > .provider-mark svg')).toMatchObject({ width: '14px', height: '14px' })
  })
})

describe('Hybrid B+C header geometry (#651)', () => {
  test('Row 1 (.tb-top) is 46px tall and never wraps', () => {
    expect(plain(toolbarCss)).not.toMatch(/flex-wrap:\s*wrap/)
    expect(rule(toolbarCss, '.tb-top')).toMatchObject({
      display: 'flex',
      'align-items': 'center',
      height: '46px',
    })
  })

  test('Row 2 (.toolbar-filters) is 36px flat typographic lane tabs with 2px active underline and smooth fold rules', () => {
    expect(rule(toolbarCss, '.toolbar-filters')).toMatchObject({
      display: 'flex',
      'align-items': 'center',
      height: '36px',
    })
    expect(rule(toolbarCss, '.toolbar-filters[data-folded]:not([data-moving])')).toMatchObject({
      height: '0',
      overflow: 'hidden',
      visibility: 'hidden',
      opacity: '0',
    })
    expect(rule(toolbarCss, '.toolbar-filters[data-moving]')).toMatchObject({ overflow: 'hidden' })
    expect(rule(toolbarCss, '.lane-tab')).toMatchObject({ height: '36px', background: 'transparent' })
    expect(rule(toolbarCss, '.lane-tab.on::after')).toMatchObject({ height: '2px', background: 'var(--accent)' })
    expect(rule(toolbarCss, '.lane-dot')).toMatchObject({ width: '6px', height: '6px', 'border-radius': '2px' })
  })

  test('phone breakpoint (<= 760px) shows drawer toggle, removes desktop rail margin, and scrolls lanes horizontally', () => {
    expect(toolbarCss).toMatch(/@media \(max-width: 760px\)/)
    expect(toolbarCss).toContain('overflow-x: auto')
    expect(railCss).toMatch(/@media \(max-width: 760px\)/)
    expect(railCss).toContain('margin-left: var(--room-left, 0px)')
    expect(railCss).toContain('.nav-rail.drawer-open')
  })

  test('reduced motion suppresses transitions on header, rail, and Settings controls', () => {
    expect(toolbarCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/)
    expect(railCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/)
    expect(settingsCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/)
  })
})

describe('Terminal look parity (#651)', () => {
  test('look-terminal.css covers rail, header, lane tabs, peek count, and Settings panel', () => {
    expect(terminalCss).toContain(':root[data-look="terminal"] .nav-rail')
    expect(terminalCss).toContain(':root[data-look="terminal"] .tb-top')
    expect(terminalCss).toContain(':root[data-look="terminal"] .lane-tab')
    expect(terminalCss).toContain(':root[data-look="terminal"] .set-nav')
    expect(rule(terminalCss, ':root[data-look="terminal"] #toolbar-peek.on .n')).toMatchObject({
      background: 'none',
    })
  })
})
