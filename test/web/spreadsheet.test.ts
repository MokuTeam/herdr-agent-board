// A spreadsheet as the quick look shows it (models/spreadsheet.ts, #176), and as its worker reads
// one with SheetJS (viewers/spreadsheet-worker.ts): cells as Excel shows them in the page's
// language, merged cells, hidden rows, columns and sheets, frozen rows, what is cut.
import { describe, expect, test } from 'bun:test'
import { utils, write } from 'xlsx'
import {
  frozenRows,
  localNumber,
  type SheetRow,
  separators,
  sheetFiles,
  sheetGrid,
  shortDate,
} from '../../web/src/models/spreadsheet.ts'
import { bookOf } from '../../web/src/viewers/spreadsheet-worker.ts'

const texts = (rows: SheetRow[]) => rows.map(r => r.map(c => (c === 0 ? '·' : (c?.t ?? ''))))

describe('a spreadsheet’s grid', () => {
  const cells: Record<string, string> = {
    '0,0': 'Title',
    '1,0': 'a',
    '1,1': '1',
    '2,0': 'b',
    '2,2': 'x',
    '4,0': 'gone',
  }
  const source = {
    rows: 6,
    cols: 4,
    cell: (r: number, c: number) =>
      cells[`${r},${c}`] ? { text: cells[`${r},${c}`] as string, number: c === 1 } : null,
  }

  test('cells as they are, numbers marked, empty rows and columns at the end cut', () => {
    const grid = sheetGrid(source)
    expect(texts(grid)).toEqual([
      ['Title', '', ''],
      ['a', '1', ''],
      ['b', '', 'x'],
      ['', '', ''],
      ['gone', '', ''],
    ])
    expect(grid[1]?.[1]).toEqual({ t: '1', n: true })
  })

  test('a merged cell spans what it covers, less what is hidden; hidden rows and columns go', () => {
    const grid = sheetGrid({
      ...source,
      merges: [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
        { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
      ],
      hiddenRows: new Set([3, 4]),
      hiddenCols: new Set([1]),
    })
    expect(texts(grid)).toEqual([
      ['Title', '·'],
      ['a', ''],
      ['·', 'x'],
    ])
    expect(grid[0]?.[0]).toEqual({ t: 'Title', cs: 2 })
    expect(grid[1]?.[0]).toEqual({ t: 'a', rs: 2 })
  })

  test('the rows Excel keeps frozen, and which file each sheet is', () => {
    expect(frozenRows('<sheetView><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')).toBe(1)
    expect(frozenRows('<pane xSplit="2" ySplit="3" state="frozenSplit"/>')).toBe(3)
    expect(frozenRows('<pane ySplit="2400" state="split"/>')).toBe(0)
    expect(frozenRows('<pane ySplit="40" state="frozen"/>')).toBe(5)
    expect(frozenRows('')).toBe(0)
    const rels = sheetFiles(
      '<Relationships><Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Target="/xl/worksheets/sheet9.xml" Id="rId2" Type="…/worksheet"/></Relationships>',
    )
    expect([...rels]).toEqual([
      ['rId1', 'xl/worksheets/sheet1.xml'],
      ['rId2', 'xl/worksheets/sheet9.xml'],
    ])
  })

  test('numbers and the short date in the page’s language, as Excel shows them there', () => {
    const ru = separators('ru')
    expect(ru.decimal).toBe(',')
    expect(localNumber('1,234.50', ru)).toBe(`1${ru.group}234,50`)
    expect(localNumber('-0.5%', ru)).toBe('-0,5%')
    expect(localNumber('1.23E+05', ru)).toBe('1,23E+05')
    expect(localNumber('т.е. 12.5 руб.', ru)).toBe('т.е. 12,5 руб.')
    expect(localNumber('1,234.50', separators('en'))).toBe('1,234.50')
    expect(shortDate('ru')).toBe('dd\\.mm\\.yyyy')
    expect(shortDate('en')).toBe('m/d/yyyy')
  })
})

describe('a workbook as the worker reads it', () => {
  function workbook(): Uint8Array {
    const wb = utils.book_new()
    const sales = utils.aoa_to_sheet([
      ['Дата', 'Клиент', 'Сумма'],
      [46297, 'Ромашка', 1234.5],
      [46298, 'Лютик', 7],
    ])
    // Format 14, "the system's short date".
    for (const at of ['A2', 'A3']) Object.assign(sales[at], { z: 'm/d/yy' })
    for (const at of ['C2', 'C3']) Object.assign(sales[at], { z: '#,##0.00' })
    const totals = utils.aoa_to_sheet([
      ['Итоги', null, null],
      ['План', 100, 120],
    ])
    totals['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]
    utils.book_append_sheet(wb, sales, 'Продажи')
    utils.book_append_sheet(wb, totals, 'Итоги')
    utils.book_append_sheet(wb, utils.aoa_to_sheet([['secret']]), 'Скрытый')
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] }
    return new Uint8Array(write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  }

  test('the visible sheets, their cells formatted in the page’s language, merged cells spanning', () => {
    const ru = bookOf(workbook(), 'ru')
    if (!ru.ok) throw new Error(ru.message)
    expect(ru.sheets.map(s => s.name)).toEqual(['Продажи', 'Итоги'])
    const [sales, totals] = ru.sheets
    const group = separators('ru').group
    expect(texts(sales?.rows ?? [])).toEqual([
      ['Дата', 'Клиент', 'Сумма'],
      ['02.10.2026', 'Ромашка', `1${group}234,50`],
      ['03.10.2026', 'Лютик', '7,00'],
    ])
    expect(sales?.rows[1]?.[2]).toMatchObject({ n: true })
    expect(totals?.rows[0]?.[0]).toEqual({ t: 'Итоги', cs: 3 })
    expect(totals?.rows[0]?.slice(1)).toEqual([0, 0])
    expect(sales?.cut).toBe(false)
    const en = bookOf(workbook(), 'en')
    if (!en.ok) throw new Error(en.message)
    expect(texts(en.sheets[0]?.rows ?? [])[1]).toEqual(['10/2/2026', 'Ромашка', '1,234.50'])
  })

  test('a zip that is no workbook: broken, not "password protected"; an .xlsx of text: broken', () => {
    const zipStart = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(' not a zip at all')])
    expect(bookOf(zipStart, 'en', 'a.xlsx')).toMatchObject({ ok: false, why: 'broken' })
    const text = new TextEncoder().encode('nonsense, really')
    expect(bookOf(text, 'en', 'export.xlsx')).toMatchObject({ ok: false, why: 'broken' })
    // An .xls a web page saved is often its text: SheetJS reads that as a sheet.
    expect(bookOf(text, 'en', 'export.xls')).toMatchObject({ ok: true })
  })
})
