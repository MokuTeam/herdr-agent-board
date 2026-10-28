// The quick look's spreadsheet viewer (#176): a worker reads the workbook (spreadsheet-worker.ts)
// and this draws its visible sheets, the sheet names as tabs below, as Excel and Numbers have
// them. A sheet is a table of its cells as Excel shows them, numbers to the right, merged cells
// spanning, its frozen rows held at the top; rows are drawn 300 at a time as the end comes near
// the view. Every cell's text goes in as text. Bundled apart from app.js (server/viewers.ts),
// imported when a spreadsheet is opened.
import type { SheetData, SheetReply } from '../models/spreadsheet.ts'
import type { OfficeOptions, OfficeViewer } from './office.ts'

const ROWS_AT_ONCE = 300

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

export function mount(host: HTMLElement, opts: OfficeOptions): OfficeViewer {
  const worker = new Worker(opts.worker, { type: 'module' })
  let done = false
  let seen: IntersectionObserver | null = null
  const scroller = el('div', 'ql-grid-scroll')

  /** A sheet drawn in the scroller, its first rows, the rest as they come near the view. */
  function show(sheet: SheetData): void {
    seen?.disconnect()
    const table = el('table', 'ql-grid')
    const cols = el('colgroup')
    for (const w of sheet.widths) {
      const col = el('col')
      if (w) col.style.width = `${Math.round(w)}ch`
      cols.append(col)
    }
    const body = el('tbody')
    table.append(cols, body)
    const more = el('div', 'ql-more')
    scroller.replaceChildren(table)
    scroller.scrollTo(0, 0)
    let drawn = 0
    const draw = () => {
      const end = Math.min(sheet.rows.length, drawn + ROWS_AT_ONCE)
      for (let r = drawn; r < end; r++) {
        const tr = el('tr')
        for (const cell of sheet.rows[r] ?? []) {
          if (cell === 0) continue
          const td = el('td', cell?.n ? 'n' : '')
          if (cell) {
            td.textContent = cell.t
            if (cell.rs) td.rowSpan = cell.rs
            if (cell.cs) td.colSpan = cell.cs
          }
          tr.append(td)
        }
        body.append(tr)
      }
      drawn = end
      if (drawn >= sheet.rows.length) {
        seen?.disconnect()
        more.remove()
        if (sheet.cut) {
          const cut = el('p', 'ql-grid-cut')
          cut.textContent = opts.truncated
          scroller.append(cut)
        }
      }
    }
    draw()
    hold(body, sheet.frozen)
    if (drawn < sheet.rows.length) {
      scroller.append(more)
      seen = new IntersectionObserver(([e]) => e?.isIntersecting && draw(), {
        root: scroller,
        rootMargin: '0px 0px 800px 0px',
      })
      seen.observe(more)
    }
  }

  /** The frozen rows held at the top as the sheet scrolls, each below the one before. */
  function hold(body: HTMLTableSectionElement, frozen: number): void {
    let top = 0
    for (const tr of [...body.rows].slice(0, frozen)) {
      for (const td of tr.cells) {
        td.classList.add('frozen')
        td.style.top = `${top}px`
      }
      top += tr.offsetHeight
    }
    body.rows[frozen - 1]?.classList.add('frozen-last')
  }

  worker.onmessage = (e: MessageEvent<SheetReply>) => {
    done = true
    worker.terminate()
    const reply = e.data
    if (!reply.ok) return opts.onFail(reply.why, reply.message)
    const wrap = el('div', 'ql-grid-wrap')
    wrap.append(scroller)
    if (reply.sheets.length > 1) {
      const tabs = el('div', 'ql-grid-tabs')
      tabs.setAttribute('role', 'tablist')
      const buttons = reply.sheets.map((sheet, i) => {
        const b = el('button')
        b.type = 'button'
        b.setAttribute('role', 'tab')
        b.textContent = sheet.name
        b.addEventListener('click', () => pick(i))
        return b
      })
      const pick = (i: number) => {
        for (const [j, b] of buttons.entries()) b.setAttribute('aria-selected', String(i === j))
        const sheet = reply.sheets[i]
        if (sheet) show(sheet)
      }
      tabs.append(...buttons)
      wrap.append(tabs)
      host.replaceChildren(wrap)
      pick(0)
    } else {
      host.replaceChildren(wrap)
      show(reply.sheets[0] ?? { name: '', rows: [], widths: [], frozen: 0, cut: false })
    }
    opts.onReady()
  }
  worker.onerror = e => {
    if (!done) opts.onFail('other', e.message)
    done = true
  }
  worker.postMessage({ url: opts.url, lang: opts.lang, name: opts.name })
  return {
    destroy() {
      done = true
      worker.terminate()
      seen?.disconnect()
      host.replaceChildren()
    },
  }
}
