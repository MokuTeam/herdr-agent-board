// Draws the board: state and screen size in, one string of cursor moves and text out. render() reads
// the clock from state.now and touches no stdout; it updates the state's scroll and click map.
import { COLUMNS, noteOf, statusText } from '../core/board.ts'
import { categoryInfo } from '../core/categories.ts'
import { t } from '../core/lang.ts'
import type { Item } from '../core/types.ts'
import { shortWhen } from '../core/when-format.ts'
import type { Hit } from './input.ts'
import { colOf, type Lane, laneOrder, selected, type TuiState } from './state.ts'
import { age, CSI, fit, paint, width } from './terminal.ts'

export const HEADER_ROWS = 2
export const FOOTER_ROWS = 2

export interface Size {
  columns: number
  rows: number
}

export interface Body {
  lines: string[]
  /** Item key -> body line of its first row. */
  tops: Map<string, number>
  /** Item key -> rows its card takes (wide layout). */
  heights: Map<string, number>
  /** Width of a column; 0 in the narrow layout. */
  colW: number
}

/** Wide enough for the five-column grid. */
export const isWide = (columns: number): boolean => columns >= 100

/** "⏰15:30 " when the session has something scheduled; ⏳ when it waits until the session is free. */
function alarm(state: TuiState, it: Item): string {
  const e = state.alarms.get(it.key)
  return e ? `${e.idle ? '⏳' : '⏰'}${shortWhen(e.next, t, state.now)} ` : ''
}

export function cardLines(state: TuiState, it: Item, w: number, isSel: boolean): string[] {
  const col = colOf(it.column)
  const icon = it.sleeping && it.column === 'idle' ? 'z' : col.icon
  const since = it.column === 'ext' ? it.waitSince || it.activity : it.activity
  const right = state.busy.get(it.key) ?? alarm(state, it) + age(since, state.now)
  const nameW = Math.max(1, w - 3 - width(right))
  const note = noteOf(it)
  // A sleeping session with nothing pending takes one line: it is there to be found, not read.
  const compact = it.sleeping && it.column === 'idle'
  if (isSel) {
    const first = paint(`${icon} ${fit(it.name, nameW)} ${right}`, 'inverse', 'bold')
    return compact ? [first] : [first, paint(`  ${fit(note, w - 2)}`, 'inverse')]
  }
  const dim = it.sleeping ? 'dim' : null
  const first = `${paint(icon, col.color, dim)} ${paint(fit(it.name, nameW), compact ? null : 'bold', dim)} ${paint(right, state.busy.has(it.key) ? 'yellow' : 'gray')}`
  return compact ? [first] : [first, paint(`  ${fit(note, w - 2)}`, 'gray')]
}

export function laneHeader(l: Lane, w: number): string {
  const count = l.cols.reduce((n, c) => n + c.length, 0)
  const label = ` ${l.num} ${l.info.title} `
  const rest = Math.max(0, w - width(label) - width(String(count)) - 3)
  return `${paint(label, l.info.color, 'bold', 'inverse')} ${paint(String(count), l.info.color)} ${paint('─'.repeat(rest), 'gray')}`
}

export function bodyWide(state: TuiState, W: number): Body {
  const colW = Math.floor((W - 2) / COLUMNS.length)
  const lines: string[] = []
  const tops = new Map<string, number>()
  const heights = new Map<string, number>()
  state.hits = []
  for (const l of state.lanes) {
    lines.push(laneHeader(l, W - 1))
    state.hits.push([])
    // Each column stacks its own cards, so one- and two-line cards mix freely.
    const stacks = l.cols.map(col =>
      col.flatMap(it => {
        const card = cardLines(state, it, colW - 1, it.key === state.sel)
        heights.set(it.key, card.length)
        return card.map((text, k) => ({ text, key: it.key, first: k === 0 }))
      }),
    )
    const height = Math.max(...stacks.map(st => st.length))
    for (let r = 0; r < height; r++) {
      let row = ' '
      const rowHits: Hit[] = []
      stacks.forEach((st, ci) => {
        const cell = st[r]
        row += `${cell ? cell.text : ' '.repeat(colW - 1)} `
        if (!cell) return
        rowHits.push({ x0: 2 + ci * colW, x1: 1 + (ci + 1) * colW, key: cell.key })
        if (cell.first) tops.set(cell.key, lines.length)
      })
      lines.push(row)
      state.hits.push(rowHits)
    }
    lines.push('')
    state.hits.push([])
  }
  return { lines, tops, heights, colW }
}

export function bodyNarrow(state: TuiState, W: number): Body {
  const lines: string[] = []
  const tops = new Map<string, number>()
  state.hits = []
  for (const l of state.lanes) {
    lines.push(laneHeader(l, W - 1))
    state.hits.push([])
    for (const it of laneOrder(l)) {
      const col = colOf(it.column)
      const since = it.column === 'ext' ? it.waitSince || it.activity : it.activity
      const right = state.busy.get(it.key) ?? alarm(state, it) + age(since, state.now)
      const nameW = Math.min(24, Math.floor(W / 3))
      const stateW = 14
      const noteW = Math.max(0, W - 2 - 2 - nameW - 1 - stateW - 1 - width(right) - 1)
      const status = it.column === 'ext' ? t('status.ext') : statusText(it.status)
      const text = `${col.icon} ${fit(it.name, nameW)} ${fit(status, stateW)} ${fit(noteOf(it), noteW)} ${right}`
      tops.set(it.key, lines.length)
      lines.push(
        it.key === state.sel
          ? ` ${paint(text, 'inverse')}`
          : ` ${paint(col.icon, col.color, it.sleeping && 'dim')}${text.slice(col.icon.length)}`,
      )
      state.hits.push([{ x0: 1, x1: W - 1, key: it.key }])
    }
    lines.push('')
    state.hits.push([])
  }
  return { lines, tops, heights: new Map(), colW: 0 }
}

export function header(state: TuiState, W: number, colW: number): string[] {
  const { items, lanes, filter, cfg } = state
  const asleep = items.filter(i => i.sleeping).length
  const counts = colW
    ? paint(
        `${t('tui.sessions', { n: items.length })}${asleep ? `, ${t('tui.asleep', { n: asleep })}` : ''}${state.scheduled ? `, ⏰ ${t('tui.sched', { n: state.scheduled })}` : ''}`,
        'gray',
      )
    : COLUMNS.map(c => `${paint(c.icon, c.color)} ${items.filter(i => i.column === c.id).length}`).join('  ')
  const time = new Date(state.now).toTimeString().slice(0, 5)
  const filt = filter ? paint(`  ${t('tui.filter', { title: categoryInfo(cfg, filter).title })}`, 'yellow') : ''
  const left = `${paint(' Agent board ', 'bold')} ${counts}${filt}`
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the escape sequences it measures around
  const plain = left.replace(/\x1b\[[0-9;]*m/g, '')
  const top = `${left}${' '.repeat(Math.max(1, W - width(plain) - 6))}${paint(time, 'gray')}`
  if (!colW) return [top, paint('─'.repeat(W - 1), 'gray')]
  const titles = COLUMNS.map(c => {
    const n = lanes.reduce((s, l) => s + (l.cols[COLUMNS.indexOf(c)]?.length ?? 0), 0)
    return paint(fit(`${c.icon} ${c.title} ${n}`, colW - 1), c.color, 'bold')
  })
  return [top, ` ${titles.join(' ')}`]
}

/** The keys line for the text prompt: the label, the tail of what is typed that fits, a cursor. */
function inputKeys(label: string, text: string, W: number): string {
  const shownLabel = fit(` ${label}: `, Math.min(width(` ${label}: `), Math.floor(W / 2)))
  const room = Math.max(1, W - 1 - width(shownLabel) - 1 - 24)
  const chars = [...text]
  let shown = ''
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string
    if (width(ch + shown) > room) break
    shown = ch + shown
  }
  return `${paint(shownLabel, 'bold')}${shown}${paint('█', 'gray')}${paint(`  ${t('tui.inputHint')}`, 'gray')}`
}

function boardKeys(state: TuiState, W: number): string {
  const hints: [string, string][] = [
    ['Enter', t('key.enter')],
    ['m', t('key.m')],
    ['w', t('key.w')],
    ['x', t('key.x')],
    ['c', t('key.c')],
    ['z', t('key.z')],
    ['1-9', t('key.filter')],
    ['o', t('key.o')],
    ['r', t('key.r')],
    ['q', t(state.closesOnQuit ? 'key.close' : 'key.back')],
  ]
  let keys = ''
  let used = 0
  for (const [key, text] of hints) {
    const w = width(` ${key} ${text} `)
    if (used + w > W - 1) break
    keys += ` ${paint(key, 'bold')} ${paint(text, 'gray')} `
    used += w
  }
  return keys
}

export function footer(state: TuiState, W: number): string[] {
  const { flash, loadError, mode, input, cfg } = state
  const msg =
    flash && flash.until > state.now
      ? paint(fit(` ${flash.text}`, W - 1), flash.error ? 'red' : 'green')
      : loadError
        ? paint(fit(` ${loadError}`, W - 1), 'red')
        : paint('─'.repeat(W - 1), 'gray')
  let keys: string
  if (mode === 'input' && input) {
    keys = inputKeys(input.label, input.text, W)
  } else if (mode === 'category') {
    const list = cfg.categories.map((c, i) => `${paint(String(i + 1), 'bold')} ${c.title}`).join('  ')
    keys = ` ${t('tui.catFor', { name: selected(state)?.name ?? '' })} ${list}  ${paint('n', 'bold')} ${t('tui.new')}  ${paint('Esc', 'bold')} ${t('tui.cancel')}`
  } else {
    keys = boardKeys(state, W)
  }
  return [msg, keys]
}

/** The whole screen as one write: a synchronized update with every row placed and cleared. */
export function render(state: TuiState, size: Size): string {
  const W = size.columns || 80
  const H = size.rows || 24
  const bodyH = Math.max(1, H - HEADER_ROWS - FOOTER_ROWS)
  const { lines, tops, heights, colW } = isWide(W) ? bodyWide(state, W) : bodyNarrow(state, W)
  if (state.loading) lines.splice(0, lines.length, paint(` ${t('loading')}`, 'gray'))
  else if (!state.items.length) lines.splice(0, lines.length, paint(` ${t('tui.noAgents')}`, 'gray'))
  const top = state.sel === null ? undefined : tops.get(state.sel)
  if (state.follow && top !== undefined && state.sel !== null) {
    const h = heights.get(state.sel) ?? 1
    if (top < state.scroll) state.scroll = Math.max(0, top - 1)
    if (top + h > state.scroll + bodyH) state.scroll = top + h - bodyH
    state.follow = false
  }
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, lines.length - bodyH)))
  const rows = [
    ...header(state, W, colW),
    ...Array.from({ length: bodyH }, (_, i) => lines[state.scroll + i] ?? ''),
    ...footer(state, W),
  ]
  return `\x1b[?2026h${rows.map((r, i) => `${CSI}${i + 1};1H${r}${CSI}0m${CSI}K`).join('')}\x1b[?2026l`
}
