// The QR code (components/Qr.tsx): black modules on white, with no stroke of their own. The page's
// `svg { stroke: currentColor; stroke-width: 1.6 }` (styles/app.css) is inherited by every shape
// that names no stroke, and a 1.6-unit stroke in the text colour covers the 1-unit modules (#201).
import { describe, expect, test } from 'bun:test'
import { Qr } from '../../web/src/components/Qr.tsx'
import { find, findAll, reactMarkup } from './support/markup.ts'

describe('Qr', () => {
  const svg = find(
    reactMarkup(<Qr text="otpauth://totp/board?secret=ABC" className="access-qr" />),
    el => el.tag === 'svg',
  )
  const shapes = findAll(svg.children, el => el.tag === 'rect' || el.tag === 'path')

  test('draws black modules on white', () => {
    expect(shapes.map(el => [el.tag, el.attrs.get('fill')])).toEqual([
      ['rect', '#fff'],
      ['path', '#000'],
    ])
  })

  test('its shapes carry no stroke, whatever the page sets on svg', () => {
    for (const el of shapes) expect(el.attrs.get('stroke')).toBe('none')
  })
})
