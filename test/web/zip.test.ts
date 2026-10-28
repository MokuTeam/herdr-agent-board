// The little of a zip the Office workers read themselves (models/zip.ts, #176): how big it is
// unpacked by its central directory, before a library unpacks all of it; a part's first bytes,
// or all of it.
import { describe, expect, test } from 'bun:test'
import { unpackedSize, zipEntries, zipRead, zipText } from '../../web/src/models/zip.ts'
import { zip } from './support/zip.ts'

describe('a zip read by its central directory', () => {
  const body = `<worksheet><sheetViews><pane ySplit="1" state="frozen"/></sheetViews><sheetData>${'<row/>'.repeat(50_000)}</sheetData></worksheet>`
  const bytes = zip([
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>', stored: true },
    { name: 'xl/worksheets/sheet1.xml', data: body },
  ])

  test('its parts, their sizes unpacked, and a part as text: all of it or its head', async () => {
    const entries = zipEntries(bytes)
    expect(entries?.map(e => [e.name, e.method, e.size])).toEqual([
      ['xl/_rels/workbook.xml.rels', 0, 16],
      ['xl/worksheets/sheet1.xml', 8, body.length],
    ])
    expect(unpackedSize(entries ?? [])).toBe(16 + body.length)
    expect(await zipText(bytes, entries ?? [], 'xl/_rels/workbook.xml.rels')).toBe('<Relationships/>')
    expect(await zipText(bytes, entries ?? [], 'xl/worksheets/sheet1.xml')).toBe(body)
    const head = await zipText(bytes, entries ?? [], 'xl/worksheets/sheet1.xml', 1024)
    expect(head.startsWith('<worksheet><sheetViews><pane ySplit="1"')).toBe(true)
    expect(head.length).toBeLessThan(body.length)
    expect(await zipText(bytes, entries ?? [], 'missing.xml')).toBe('')
  })

  test('a part that claims more than it holds counts at its claim; ZIP64 sizes count as no end', async () => {
    const bomb = zipEntries(zip([{ name: 'xl/worksheets/sheet1.xml', data: 'x', claims: 400 << 20 }]))
    expect(unpackedSize(bomb ?? [])).toBe(400 << 20)
    const huge = zipEntries(zip([{ name: 'a', data: 'x', claims: 0xffffffff }]))
    expect(unpackedSize(huge ?? [])).toBe(Number.POSITIVE_INFINITY)
  })

  test('not a zip: none', async () => {
    expect(zipEntries(new TextEncoder().encode('nonsense, really'))).toBeNull()
    expect(zipEntries(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull()
    const entries = zipEntries(bytes) ?? []
    const stored = entries[0]
    if (!stored) throw new Error('no part')
    expect([...(await zipRead(bytes, stored, 4))]).toEqual([...new TextEncoder().encode('<Rel')])
  })
})
