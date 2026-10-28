// The spreadsheet viewer's worker (#176): reads an .xlsx, .xlsm, .xls or .ods with SheetJS off
// the page's thread and answers each visible sheet as a grid of cells as Excel shows them
// (models/spreadsheet.ts), which viewers/spreadsheet.ts draws. Bundled apart from app.js
// (server/viewers.ts); it reads the file through the board's file route, with its token.
import { type CellObject, read, SSF, utils, type WorkBook, type WorkSheet } from 'xlsx'
import {
  frozenRows,
  localNumber,
  SHEET_LIMITS,
  type SheetData,
  type SheetReply,
  separators,
  sheetFiles,
  sheetGrid,
  shortDate,
} from '../models/spreadsheet.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type ZipFiles = Record<string, { content?: Uint8Array | string } | undefined>

/** A file of an .xlsx's package as text ('' when it is not one, or not there). */
function packaged(files: ZipFiles | undefined, path: string): string {
  const content = files?.[path]?.content
  if (!content) return ''
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE = [0xd0, 0xcf, 0x11, 0xe0]

/**
 * The workbook's visible sheets, as the quick look draws them. An .xlsx or .xlsm is a zip (an OLE
 * file with a password): anything else named so is broken, not text to show (SheetJS reads any
 * text as a sheet, which an .xls or .ods saved by a web page may well be).
 */
export function bookOf(bytes: ArrayBuffer | Uint8Array, lang: string, name = ''): SheetReply {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const starts = (sig: number[]) => sig.every((b, i) => head[i] === b)
  if (/\.xls[xm]$/i.test(name) && !starts(ZIP) && !starts(OLE))
    return { ok: false, why: 'broken', message: 'not a zip' }
  let wb: WorkBook
  try {
    wb = read(bytes, { type: 'array', cellNF: true, cellStyles: true, bookFiles: true })
  } catch (err) {
    const message = messageOf(err)
    // SheetJS's words for a file with a password (an .xlsx's encrypted package, an .xls's or an
    // .ods's own); a zip it cannot read is broken, whatever it says of encryption.
    const locked = /password|ECMA-376 Encrypted|EncryptionInfo|Encryption Flags|ODS Encryption/i.test(message)
    return { ok: false, why: locked ? 'password' : 'broken', message }
  }
  const local = { seps: separators(lang), date: shortDate(lang) }
  const files = (wb as WorkBook & { files?: ZipFiles }).files
  const ids = sheetFiles(packaged(files, 'xl/_rels/workbook.xml.rels'))
  let budget = SHEET_LIMITS.cells
  const sheets: SheetData[] = []
  wb.SheetNames.forEach((name, i) => {
    const props = wb.Workbook?.Sheets?.[i] as { Hidden?: number; id?: string } | undefined
    const ws = wb.Sheets[name]
    if (props?.Hidden || !ws) return
    const xml = props?.id && ids.get(props.id) ? packaged(files, ids.get(props.id) as string) : ''
    const sheet = sheetOf(name, ws, local, budget, frozenRows(xml))
    budget -= sheet.rows.length * (sheet.rows[0]?.length ?? 0)
    sheets.push(sheet)
  })
  return { ok: true, sheets }
}

/** The page's language's separators and short date. */
interface Local {
  seps: { group: string; decimal: string }
  date: string
}

// Excel's formats 14 and 22, "the system's short date", as SheetJS names them: in the page's language.
const SYSTEM_DATES: Record<string, (date: string) => string> = {
  'm/d/yy': date => date,
  'm/d/yy h:mm': date => `${date} h:mm`,
}

/** A cell's text as Excel shows it in the page's language. */
function textOf(cell: CellObject, local: Local): string {
  const text = cell.w ?? (cell.v == null ? '' : String(cell.v))
  if (cell.t !== 'n' || typeof cell.v !== 'number') return text
  const format = typeof cell.z === 'string' ? cell.z : 'General'
  const system = SYSTEM_DATES[format]
  if (system) return SSF.format(system(local.date), cell.v)
  return SSF.is_date(format) ? text : localNumber(text, local.seps)
}

function sheetOf(name: string, ws: WorkSheet, local: Local, budget: number, frozen: number): SheetData {
  const ref = ws['!ref']
  if (!ref || budget <= 0) return { name, rows: [], widths: [], frozen: 0, cut: !!ref }
  const range = utils.decode_range(ref)
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
  return { name, rows: grid, widths, frozen: Math.min(frozen, grid.length), cut: rows < allRows || cols < allCols }
}

async function answer(url: string, lang: string, name: string): Promise<SheetReply> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, why: 'other', message: `${res.status} ${res.statusText}` }
    return bookOf(await res.arrayBuffer(), lang, name)
  } catch (err) {
    return { ok: false, why: 'other', message: messageOf(err) }
  }
}

// In a worker only: the tests import this module for what it reads, not to answer.
if ('WorkerGlobalScope' in globalThis)
  self.onmessage = async (e: MessageEvent<{ url: string; lang: string; name: string }>) =>
    postMessage(await answer(e.data.url, e.data.lang, e.data.name))
