// A spreadsheet as the quick look shows it (models/spreadsheet.ts, #176), and as its worker reads
// one with SheetJS (viewers/spreadsheet-worker.ts): cells as Excel shows them in the page's
// language, merged cells, hidden rows, columns and sheets, frozen rows, what is cut.
import { describe, expect, test } from 'bun:test'
import { utils, write } from 'xlsx'
import {
  frozenRows,
  localNumber,
  odsHiddenTables,
  type SheetRow,
  separators,
  sheetFiles,
  sheetGrid,
  shortDate,
} from '../../web/src/models/spreadsheet.ts'
import { zipEntries, zipRead } from '../../web/src/models/zip.ts'
import { bookOf, UNPACKED_LIMIT } from '../../web/src/viewers/spreadsheet-worker.ts'
import { zip } from './support/zip.ts'

/** An .xlsx with its first sheet's XML changed: what Excel writes and SheetJS's writer does not. */
async function rezip(bytes: Uint8Array, change: (sheetXml: string) => string): Promise<Uint8Array> {
  const parts = await Promise.all(
    (zipEntries(bytes) ?? []).map(async e => {
      const data = new TextDecoder().decode(await zipRead(bytes, e))
      return { name: e.name, data: e.name === 'xl/worksheets/sheet1.xml' ? change(data) : data }
    }),
  )
  return zip(parts)
}

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

  test('the visible sheets, their cells formatted in the page’s language, merged cells spanning', async () => {
    const ru = await bookOf(workbook(), 'ru')
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
    const en = await bookOf(workbook(), 'en')
    if (!en.ok) throw new Error(en.message)
    expect(texts(en.sheets[0]?.rows ?? [])[1]).toEqual(['10/2/2026', 'Ромашка', '1,234.50'])
  })

  test('a zip that is no workbook: broken, not "password protected"; an .xlsx of text: broken', async () => {
    const zipStart = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(' not a zip at all')])
    expect(await bookOf(zipStart, 'en', 'a.xlsx')).toMatchObject({ ok: false, why: 'broken' })
    const text = new TextEncoder().encode('nonsense, really')
    expect(await bookOf(text, 'en', 'export.xlsx')).toMatchObject({ ok: false, why: 'broken' })
    // An .xls a web page saved is often its text: SheetJS reads that as a sheet.
    expect(await bookOf(text, 'en', 'export.xls')).toMatchObject({ ok: true })
  })

  test('dates of a workbook counted from 1904, and TRUE and FALSE as Excel shows them', async () => {
    const wb = utils.book_new()
    const sheet = utils.aoa_to_sheet([[46297 - 1462, true, false]])
    Object.assign(sheet.A1 as object, { z: 'm/d/yy' })
    utils.book_append_sheet(wb, sheet, 'Даты')
    wb.Workbook = { WBProps: { date1904: true } }
    const bytes = new Uint8Array(write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const ru = await bookOf(bytes, 'ru')
    if (!ru.ok) throw new Error(ru.message)
    expect(texts(ru.sheets[0]?.rows ?? [])).toEqual([['02.10.2026', 'ИСТИНА', 'ЛОЖЬ']])
    const en = await bookOf(bytes, 'en')
    if (!en.ok) throw new Error(en.message)
    expect(texts(en.sheets[0]?.rows ?? [])).toEqual([['10/2/2026', 'TRUE', 'FALSE']])
  })

  test('the rows shown and one more read: more than that is "cut"', async () => {
    const many = utils.book_new()
    utils.book_append_sheet(many, utils.aoa_to_sheet(Array.from({ length: 20_005 }, (_, i) => [i])), 'Много')
    const read = await bookOf(new Uint8Array(write(many, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), 'en')
    if (!read.ok) throw new Error(read.message)
    expect([read.sheets[0]?.rows.length, read.sheets[0]?.cut]).toEqual([20_000, true])
  })

  test('a range that says A1:XFD1048576 for one cell (a stale <dimension>) is not "cut"', async () => {
    const wb = utils.book_new()
    utils.book_append_sheet(wb, utils.aoa_to_sheet([['одна']]), 'Одна')
    const plain = new Uint8Array(write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const stale = await rezip(plain, xml =>
      xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>'),
    )
    const single = await bookOf(stale, 'en', 'stale.xlsx')
    if (!single.ok) throw new Error(single.message)
    expect([texts(single.sheets[0]?.rows ?? []), single.sheets[0]?.cut]).toEqual([[['одна']], false])
  })

  test('a workbook that unpacks to more than the limit (a zip bomb) is not read', async () => {
    const bomb = zip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>', claims: UNPACKED_LIMIT },
    ])
    expect(await bookOf(bomb, 'en', 'bomb.xlsx')).toMatchObject({ ok: false, why: 'big' })
  })

  test('frozen rows read from the head of the sheet’s own XML in the zip', async () => {
    const wb = utils.book_new()
    utils.book_append_sheet(wb, utils.aoa_to_sheet([['Дата'], [1], [2]]), 'Лист')
    const plain = new Uint8Array(write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    // The same workbook with a frozen first row, as Excel writes it.
    const pane =
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'
    const frozen = await bookOf(
      await rezip(plain, xml => xml.replace('<sheetData', `${pane}<sheetData`)),
      'en',
      'frozen.xlsx',
    )
    if (!frozen.ok) throw new Error(frozen.message)
    expect(frozen.sheets[0]?.frozen).toBe(1)
    const none = await bookOf(plain, 'en', 'plain.xlsx')
    expect(none.ok && none.sheets[0]?.frozen).toBe(0)
  })
})

describe('an .ods’s hidden sheets', () => {
  test('a table whose style says it is not displayed', () => {
    const content =
      '<office:automatic-styles>' +
      '<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style>' +
      '<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style>' +
      '<style:style style:name="ce1" style:family="table-cell"><style:table-properties table:display="false"/></style:style>' +
      '</office:automatic-styles><office:body><office:spreadsheet>' +
      '<table:table table:name="Видимый" table:style-name="ta1"></table:table>' +
      '<table:table table:style-name="ta2" table:name="Скрытый &amp; второй"></table:table>' +
      '<table:table table:name="Ячейки" table:style-name="ce1"></table:table>' +
      '</office:spreadsheet></office:body>'
    expect([...odsHiddenTables(content)]).toEqual(['Скрытый & второй'])
    expect(odsHiddenTables('<office:body/>').size).toBe(0)
  })
})
