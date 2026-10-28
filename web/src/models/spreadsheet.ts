// A spreadsheet as the quick look shows it, without the DOM or the library that reads it
// (viewers/spreadsheet-worker.ts reads it with SheetJS, viewers/spreadsheet.ts draws it): each
// sheet a grid of cells as Excel shows them, merged cells spanning rows and columns, hidden rows
// and columns left out, the rows Excel keeps frozen at the top, numbers and dates in the page's
// language.

/** A cell as it is drawn: its text as Excel shows it, a number (aligned right), how far it spans. */
export interface SheetCell {
  t: string
  n?: true
  rs?: number
  cs?: number
}

/** A row's cells: a cell, null for an empty one, 0 for one a merged cell above or before covers. */
export type SheetRow = (SheetCell | null | 0)[]

export interface SheetData {
  name: string
  rows: SheetRow[]
  /** Widths in characters, as Excel keeps them; null where it keeps none. */
  widths: (number | null)[]
  /** Rows frozen at the top (0 for none). */
  frozen: number
  /** More rows or columns than are shown. */
  cut: boolean
}

/** What the worker answers. */
export type SheetReply =
  | { ok: true; sheets: SheetData[] }
  | { ok: false; why: 'password' | 'broken' | 'big' | 'other'; message: string }

/** Rows and columns shown of a sheet at most, and cells of a whole workbook. */
export const SHEET_LIMITS = { rows: 20_000, cols: 200, cells: 600_000 }

export interface Range {
  s: { r: number; c: number }
  e: { r: number; c: number }
}

export interface GridSource {
  /** Rows and columns to read, from the sheet's first cell. */
  rows: number
  cols: number
  /** The cell at a row and column (0-based, from the first cell), as the reader has it. */
  cell(r: number, c: number): { text: string; number: boolean } | null
  merges?: Range[]
  hiddenRows?: Set<number>
  hiddenCols?: Set<number>
}

/**
 * The grid drawn: hidden rows and columns left out, merged cells spanning what they cover (less
 * what is hidden), trailing empty rows and columns cut.
 */
export function sheetGrid(src: GridSource): SheetRow[] {
  const rowsShown = [...Array(src.rows).keys()].filter(r => !src.hiddenRows?.has(r))
  const colsShown = [...Array(src.cols).keys()].filter(c => !src.hiddenCols?.has(c))
  const rowAt = new Map(rowsShown.map((r, i) => [r, i]))
  const colAt = new Map(colsShown.map((c, i) => [c, i]))
  const grid: SheetRow[] = rowsShown.map(r =>
    colsShown.map(c => {
      const cell = src.cell(r, c)
      return cell && cell.text !== '' ? { t: cell.text, ...(cell.number && { n: true as const }) } : null
    }),
  )
  // What a merge covers, of what is shown: by its own span, not the whole sheet's.
  const shownIn = (from: number, to: number, last: number, at: Map<number, number>) => {
    const out: number[] = []
    for (let i = Math.max(0, from); i <= Math.min(to, last); i++) if (at.has(i)) out.push(i)
    return out
  }
  for (const m of src.merges ?? []) {
    const rows = shownIn(m.s.r, m.e.r, src.rows - 1, rowAt)
    const cols = shownIn(m.s.c, m.e.c, src.cols - 1, colAt)
    const [top, left] = [rows[0], cols[0]]
    if (top === undefined || left === undefined) continue
    const row = grid[rowAt.get(top) as number] as SheetRow
    const at = colAt.get(left) as number
    const head = row[at] ?? { t: '' }
    if (head === 0) continue
    row[at] = { ...head, ...(rows.length > 1 && { rs: rows.length }), ...(cols.length > 1 && { cs: cols.length }) }
    for (const r of rows)
      for (const c of cols)
        if (r !== top || c !== left) (grid[rowAt.get(r) as number] as SheetRow)[colAt.get(c) as number] = 0
  }
  return trimmed(grid)
}

/** Without the empty rows at the end and the empty columns on the right. */
function trimmed(grid: SheetRow[]): SheetRow[] {
  let rows = grid.length
  while (rows > 0 && (grid[rows - 1] as SheetRow).every(c => c === null)) rows--
  let cols = 0
  for (const row of grid.slice(0, rows))
    for (let c = row.length - 1; c >= cols; c--) {
      const cell = row[c]
      if (cell === null) continue
      cols = Math.max(cols, c + (cell !== 0 && cell?.cs ? cell.cs : 1))
      break
    }
  return grid.slice(0, rows).map(row => row.slice(0, cols))
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e] ?? '')

/**
 * The sheets an .ods keeps hidden (content.xml: a table whose style says `table:display="false"`),
 * by name: SheetJS reads them as visible.
 */
export function odsHiddenTables(contentXml: string): Set<string> {
  const hiddenStyles = new Set<string>()
  for (const m of contentXml.matchAll(/<style:style\b([^>]*)>([\s\S]*?)<\/style:style>/g)) {
    const [, attrs = '', body = ''] = m
    const name = /style:name="([^"]+)"/.exec(attrs)?.[1]
    if (name && /style:family="table"/.test(attrs) && /table:display="false"/.test(body)) hiddenStyles.add(name)
  }
  const hidden = new Set<string>()
  if (!hiddenStyles.size) return hidden
  for (const m of contentXml.matchAll(/<table:table\b([^>]*)>/g)) {
    const attrs = m[1] ?? ''
    const style = /table:style-name="([^"]+)"/.exec(attrs)?.[1]
    const name = /table:name="([^"]+)"/.exec(attrs)?.[1]
    if (name && style && hiddenStyles.has(style)) hidden.add(unescapeXml(name))
  }
  return hidden
}

/** TRUE and FALSE as Excel shows them in the page's language: ИСТИНА and ЛОЖЬ in Russian. */
export const booleanText = (lang: string): { true: string; false: string } =>
  lang.startsWith('ru') ? { true: 'ИСТИНА', false: 'ЛОЖЬ' } : { true: 'TRUE', false: 'FALSE' }

/** Rows frozen at the top of a sheet, from its XML's pane (at most five are kept frozen). */
export function frozenRows(sheetXml: string): number {
  const pane = /<pane\b[^>]*>/.exec(sheetXml)?.[0] ?? ''
  if (!/state="frozen(Split)?"/.test(pane)) return 0
  return Math.min(5, Math.max(0, Math.floor(Number(/ySplit="([\d.]+)"/.exec(pane)?.[1] ?? 0))))
}

/** Each sheet's file in an .xlsx, by its relationship id (xl/_rels/workbook.xml.rels). */
export function sheetFiles(relsXml: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const rel of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(rel)?.[1]
    if (id && target) files.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  return files
}

/** The page's language's thousands and decimal separators. */
export function separators(lang: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(lang).formatToParts(12345.6)
  return {
    group: parts.find(p => p.type === 'group')?.value ?? ',',
    decimal: parts.find(p => p.type === 'decimal')?.value ?? '.',
  }
}

/**
 * A number as its format writes it in English (SheetJS's), in the page's language: Excel on a
 * Russian Windows shows `1 234,50` for `#,##0.00`. Only the commas and points between digits.
 */
export function localNumber(text: string, seps: { group: string; decimal: string }): string {
  if (seps.group === ',' && seps.decimal === '.') return text
  return text.replace(/(?<=\d)[,.](?=\d)/g, ch => (ch === ',' ? seps.group : seps.decimal))
}

const DATE_PART: Record<string, (value: string) => string> = {
  day: v => (v.length > 1 ? 'dd' : 'd'),
  month: v => (v.length > 1 ? 'mm' : 'm'),
  year: () => 'yyyy',
  // A point in a format is a decimal point (of seconds) unless escaped.
  literal: v => v.replace(/[^\s./-]/g, '').replace(/\./g, '\\.'),
}

/**
 * Excel's short date (format 14, "as the system writes a date") as the page's language writes
 * it, as a format: `dd\.mm\.yyyy` in Russian, `m/d/yyyy` in English.
 */
export function shortDate(lang: string): string {
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(2026, 0, 2))
    .map(p => DATE_PART[p.type]?.(p.value) ?? '')
    .join('')
}
