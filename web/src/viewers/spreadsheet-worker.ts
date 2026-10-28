// The spreadsheet viewer's worker (#176): reads an .xlsx, .xlsm, .xls or .ods with SheetJS off
// the page's thread and answers each visible sheet as a grid of cells as Excel shows them
// (models/spreadsheet.ts), which viewers/spreadsheet.ts draws. Bundled apart from app.js
// (server/viewers.ts); it reads the file through the board's file route, with its token.
//
// What SheetJS is given is bounded: a zip that unpacks to more than UNPACKED_LIMIT is not read
// (a zip of 400 KB can hold 400 MB, and a phone's tab would go), and of each sheet only the rows
// shown and one more (to know there are more). What SheetJS does not read, this reads from the
// zip itself, only as much as it needs: a sheet's frozen rows from the head of its XML, an .ods's
// hidden sheets from its content.
import { type CellObject, read, SSF, utils, type WorkBook, type WorkSheet } from 'xlsx'
import {
  booleanText,
  frozenRows,
  localNumber,
  odsHiddenTables,
  SHEET_LIMITS,
  type SheetData,
  type SheetReply,
  separators,
  sheetFiles,
  sheetGrid,
  shortDate,
} from '../models/spreadsheet.ts'
import { looksLikeZip, unpackedSize, type ZipEntry, zipEntries, zipText } from '../models/zip.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE = [0xd0, 0xcf, 0x11, 0xe0]

/** A workbook unpacked to more than this is not read: too big to show here. */
export const UNPACKED_LIMIT = 120 << 20
// Of a sheet's XML, what is read for its frozen rows: <sheetViews> comes before the cells.
const SHEET_HEAD = 64 << 10

/**
 * The workbook's visible sheets, as the quick look draws them. An .xlsx or .xlsm is a zip (an OLE
 * file with a password): anything else named so is broken, not text to show (SheetJS reads any
 * text as a sheet, which an .xls or .ods saved by a web page may well be).
 */
export async function bookOf(input: ArrayBuffer | Uint8Array, lang: string, name = ''): Promise<SheetReply> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (/\.xls[xm]$/i.test(name) && !starts(ZIP) && !starts(OLE))
    return { ok: false, why: 'broken', message: 'not a zip' }
  const entries = zipEntries(bytes)
  // A zip whose directory cannot be read is not handed on: unread, its size is not known.
  if (!entries && looksLikeZip(bytes)) return { ok: false, why: 'broken', message: 'no central directory' }
  if (entries && unpackedSize(entries) > UNPACKED_LIMIT)
    return { ok: false, why: 'big', message: `${unpackedSize(entries)} bytes unpacked` }
  let wb: WorkBook
  try {
    wb = read(bytes, { type: 'array', cellNF: true, cellStyles: true, sheetRows: SHEET_LIMITS.rows + 1 })
  } catch (err) {
    const message = messageOf(err)
    // SheetJS's words for a file with a password (an .xlsx's encrypted package, an .xls's or an
    // .ods's own); a zip it cannot read is broken, whatever it says of encryption.
    const locked = /password|ECMA-376 Encrypted|EncryptionInfo|Encryption Flags|ODS Encryption/i.test(message)
    return { ok: false, why: locked ? 'password' : 'broken', message }
  }
  const local: Local = {
    seps: separators(lang),
    date: shortDate(lang),
    date1904: !!wb.Workbook?.WBProps?.date1904,
    booleans: booleanText(lang),
  }
  // What this reads from the zip itself only adds to what SheetJS read: if it cannot, no rows
  // are frozen and no sheet is hidden, and the workbook is shown all the same.
  const frozen = entries
    ? await frozenBySheet(bytes, entries, wb).catch(() => new Map<number, number>())
    : new Map<number, number>()
  const hidden = entries?.some(e => e.name === 'content.xml')
    ? await zipText(bytes, entries, 'content.xml').then(odsHiddenTables, () => new Set<string>())
    : new Set<string>()
  let budget = SHEET_LIMITS.cells
  const sheets: SheetData[] = []
  wb.SheetNames.forEach((sheetName, i) => {
    const ws = wb.Sheets[sheetName]
    if (wb.Workbook?.Sheets?.[i]?.Hidden || hidden.has(sheetName) || !ws) return
    const sheet = sheetOf(sheetName, ws, local, budget, frozen.get(i) ?? 0)
    budget -= sheet.rows.length * (sheet.rows[0]?.length ?? 0)
    sheets.push(sheet)
  })
  return { ok: true, sheets }
}

/** Each sheet's frozen rows (by its place in the workbook), from the head of its XML in the .xlsx. */
async function frozenBySheet(bytes: Uint8Array, entries: ZipEntry[], wb: WorkBook): Promise<Map<number, number>> {
  const frozen = new Map<number, number>()
  const files = sheetFiles(await zipText(bytes, entries, 'xl/_rels/workbook.xml.rels'))
  for (const [i, props] of (wb.Workbook?.Sheets ?? []).entries()) {
    const id = (props as { id?: string }).id
    const path = id ? files.get(id) : undefined
    if (path) frozen.set(i, frozenRows(await zipText(bytes, entries, path, SHEET_HEAD)))
  }
  return frozen
}

/** The page's language's separators, short date and booleans, and the workbook's date system. */
interface Local {
  seps: { group: string; decimal: string }
  date: string
  date1904: boolean
  booleans: { true: string; false: string }
}

// Excel's formats 14 and 22, "the system's short date", as SheetJS names them: in the page's language.
const SYSTEM_DATES: Record<string, (date: string) => string> = {
  'm/d/yy': date => date,
  'm/d/yy h:mm': date => `${date} h:mm`,
}

/** A cell's text as Excel shows it in the page's language. */
function textOf(cell: CellObject, local: Local): string {
  if (cell.t === 'b') return cell.v ? local.booleans.true : local.booleans.false
  const text = cell.w ?? (cell.v == null ? '' : String(cell.v))
  if (cell.t !== 'n' || typeof cell.v !== 'number') return text
  const format = typeof cell.z === 'string' ? cell.z : 'General'
  const system = SYSTEM_DATES[format]
  if (system) return SSF.format(system(local.date), cell.v, { date1904: local.date1904 })
  return SSF.is_date(format) ? text : localNumber(text, local.seps)
}

/**
 * Where a sheet's cells are, by the cells themselves: a sheet's own range (its <dimension>) can
 * say A1:XFD1048576 for one cell. Null for a sheet with none.
 */
function extent(ws: WorkSheet): { s: { r: number; c: number }; e: { r: number; c: number } } | null {
  let found = false
  const s = { r: Number.POSITIVE_INFINITY, c: Number.POSITIVE_INFINITY }
  const e = { r: -1, c: -1 }
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue
    const { r, c } = utils.decode_cell(key)
    found = true
    s.r = Math.min(s.r, r)
    s.c = Math.min(s.c, c)
    e.r = Math.max(e.r, r)
    e.c = Math.max(e.c, c)
  }
  if (!found) return null
  const ref = ws['!ref'] ? utils.decode_range(ws['!ref']) : null
  // From the sheet's own first cell when it says so (A1, as Excel shows it), else the first one there.
  return { s: { r: Math.min(s.r, ref?.s.r ?? s.r), c: Math.min(s.c, ref?.s.c ?? s.c) }, e }
}

function sheetOf(name: string, ws: WorkSheet, local: Local, budget: number, frozen: number): SheetData {
  const range = extent(ws)
  if (!range || budget <= 0) return { name, rows: [], widths: [], frozen: 0, cut: !!range }
  const allRows = range.e.r - range.s.r + 1
  const allCols = range.e.c - range.s.c + 1
  const cols = Math.min(allCols, SHEET_LIMITS.cols)
  const rows = Math.min(allRows, SHEET_LIMITS.rows, Math.max(1, Math.floor(budget / cols)))
  const hidden = (list: { hidden?: boolean }[] | undefined, from: number) =>
    new Set((list ?? []).flatMap((it, i) => (it?.hidden && i >= from ? [i - from] : [])))
  const hiddenCols = hidden(ws['!cols'], range.s.c)
  const grid = sheetGrid({
    rows,
    cols,
    cell(r, c) {
      const cell = ws[utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })] as CellObject | undefined
      if (!cell || cell.t === 'z') return null
      return { text: textOf(cell, local), number: cell.t === 'n' }
    },
    merges: (ws['!merges'] ?? []).map(m => ({
      s: { r: m.s.r - range.s.r, c: m.s.c - range.s.c },
      e: { r: m.e.r - range.s.r, c: m.e.c - range.s.c },
    })),
    hiddenRows: hidden(ws['!rows'], range.s.r),
    hiddenCols,
  })
  const widths = [...Array(cols).keys()]
    .filter(c => !hiddenCols.has(c))
    .map(c => ws['!cols']?.[range.s.c + c]?.wch ?? null)
    .slice(0, grid[0]?.length ?? 0)
  // SheetJS read one row more than is shown when there were more: there are.
  return { name, rows: grid, widths, frozen: Math.min(frozen, grid.length), cut: rows < allRows || cols < allCols }
}

async function answer(url: string, lang: string, name: string): Promise<SheetReply> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, why: 'other', message: `${res.status} ${res.statusText}` }
    return await bookOf(await res.arrayBuffer(), lang, name)
  } catch (err) {
    return { ok: false, why: 'other', message: messageOf(err) }
  }
}

// In a worker only: the tests import this module for what it reads, not to answer.
if ('WorkerGlobalScope' in globalThis)
  self.onmessage = async (e: MessageEvent<{ url: string; lang: string; name: string }>) =>
    postMessage(await answer(e.data.url, e.data.lang, e.data.name))
