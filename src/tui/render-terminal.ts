// The terminal board in its Terminal style ("look": "terminal" in config.json), the web board's
// Terminal style drawn with characters: the column heads bold in their colors over a heavy rule,
// lanes as "▾ name count" over a thin rule in cyan and magenta in turn, and each card a rounded box
// of three lines (name, age and tag; what it does; what it is at), the selected one's border in the
// accent with › before its name. A session asleep in Idle stays one quiet line. The colors are the
// terminal's own sixteen, so a terminal theme (Omarchy's included) colors the board too. Keys and
// clicks work as in the classic board: the click map covers every line of a box.
import { COLUMNS, noteOf } from '../core/board.ts'
import { categoryInfo } from '../core/categories.ts'
import { t } from '../core/lang.ts'
import type { ColumnId, Config, Item } from '../core/types.ts'
import type { Hit } from './input.ts'
import { alarm, type Body, filtersOn, footer, inputKeys, isWide, tagOf } from './render.ts'
import { type Lane, laneOrder, type TuiState } from './state.ts'
import { age, fit, paint, width } from './terminal.ts'

export const isTerminalLook = (cfg: Pick<Config, 'look'>): boolean => cfg.look === 'terminal'

/** The title row, the column heads and their rule. */
export const TERMINAL_HEADER_ROWS = 3

/** Each column's color in this style: Waiting on others magenta, as on the web board. */
const COLOR: Readonly<Record<ColumnId, string>> = {
  work: 'green',
  me: 'yellow',
  ext: 'magenta',
  done: 'blue',
  idle: 'gray',
}

const ACCENT = 'blue'
const EDGE = 'gray'
/** A card's state glyph, as the web board's Terminal style draws it. */
const GLYPH: Readonly<Record<ColumnId, string>> = { work: '●', me: '●', ext: '●', done: '●', idle: '○' }

/** The lane colors, in turn down the lanes on show. */
const laneColor = (i: number): string => (i % 2 ? 'magenta' : 'cyan')

/** "▾ 1 Webshop  4 ────────", all of it in the lane's color. */
function laneHead(l: Lane, i: number, w: number): string {
  const count = l.cols.reduce((n, c) => n + c.length, 0)
  const color = laneColor(i)
  const label = `▾ ${l.num} ${l.info.title}`
  const rest = Math.max(0, w - width(label) - width(String(count)) - 4)
  return ` ${paint(label, color, 'bold')}  ${paint(String(count), color)} ${paint('─'.repeat(rest), color, 'dim')}`
}

/** What the card is at, its third line: the tool at work, or why it needs you. */
function marker(it: Item): { text: string; color: string } {
  if (it.column === 'work')
    return it.tool?.pending
      ? { text: `▶ ${it.tool.label ?? it.tool.name}${it.tool.detail ? ` ${it.tool.detail}` : ''}`, color: 'green' }
      : { text: `▶ ${t('card.thinking')}`, color: 'green' }
  if (it.column === 'me') {
    const why = it.attention === 'decision' ? 'att.decision' : it.attention === 'later' ? 'att.later' : 'att.ask'
    return { text: t(why), color: 'yellow' }
  }
  return { text: '', color: 'gray' }
}

/**
 * A session in one line, `w` cells: asleep in Idle, or in the narrow list (`noted`: what it does,
 * waits for or asks after the name, as far as there is room).
 */
function oneLine(state: TuiState, it: Item, w: number, isSel: boolean, noted = false): string {
  const since = it.column === 'ext' ? it.waitSince || it.activity : it.activity
  const right = state.busy.get(it.key) ?? alarm(state, it) + age(since, state.now)
  const glyph = isSel ? '›' : it.sleeping ? 'z' : GLYPH[it.column]
  const name = it.favorite ? `★ ${it.name}` : it.name
  const room = Math.max(1, w - 3 - width(right))
  const nameW = noted ? Math.min(room, Math.max(12, Math.min(24, Math.floor(w / 3)))) : room
  const noteW = room - nameW - 1
  const note = noted && noteW > 4 ? ` ${paint(fit(noteOf(it), noteW), 'gray')}` : ''
  const pad = noted && noteW > 4 ? '' : ' '.repeat(Math.max(0, room - nameW))
  const color = isSel ? ACCENT : it.sleeping ? 'gray' : COLOR[it.column]
  const shownName = paint(fit(name, nameW), isSel ? 'bold' : it.sleeping && 'dim')
  return `${paint(glyph, color, isSel && 'bold')} ${shownName}${note}${pad} ${paint(right, 'gray')}`
}

/** A card's box, `w` cells wide: five lines, or one for a session asleep in Idle. */
export function cardBox(state: TuiState, it: Item, w: number, isSel: boolean): string[] {
  if (it.sleeping && it.column === 'idle' && !it.favorite) return [` ${oneLine(state, it, w - 2, isSel)} `]
  const inner = Math.max(4, w - 4)
  const edge = isSel ? [ACCENT, 'bold'] : [EDGE]
  const side = paint('│', ...edge)
  const row = (text: string) => `${side} ${text} ${side}`
  const since = it.column === 'ext' ? it.waitSince || it.activity : it.activity
  const busy = state.busy.get(it.key)
  const when = age(since, state.now)
  // A narrow box keeps its name readable: the clock gives up its time first (the web board's too).
  const clock = alarm(state, it)
  const shortClock = inner - width(clock) - width(when) - 4 < 10 && clock ? `${[...clock][0]} ` : clock
  const right = busy ?? shortClock + when
  const room = inner - 2 - width(right) - 1
  const tag = tagOf(state, it, Math.floor((room - 1) / 2))
  const nameW = Math.max(1, tag ? room - width(tag.text) - 1 : room)
  const name = it.favorite ? `★ ${it.name}` : it.name
  const glyph = isSel ? paint('›', ACCENT, 'bold') : paint(it.sleeping ? 'z' : GLYPH[it.column], COLOR[it.column])
  const shownTag = tag ? `${paint(tag.text, tag.color)} ` : ''
  const first = `${glyph} ${paint(fit(name, nameW), 'bold')} ${shownTag}${paint(right, busy ? 'yellow' : 'gray')}`
  const note = noteOf(it)
  const noteColor = it.column === 'ext' ? 'magenta' : it.column === 'me' ? null : 'gray'
  const mark = marker(it)
  return [
    paint(`╭${'─'.repeat(w - 2)}╮`, ...edge),
    row(first),
    row(paint(fit(note, inner), noteColor)),
    row(paint(fit(mark.text, inner), mark.color)),
    paint(`╰${'─'.repeat(w - 2)}╯`, ...edge),
  ]
}

/** The board's lines: a grid of boxes on a wide screen, a list on a narrow one. */
export function bodyTerminal(state: TuiState, W: number): Body {
  return isWide(W) ? gridBody(state, W) : listBody(state, W)
}

function gridBody(state: TuiState, W: number): Body {
  const colW = Math.floor((W - 2) / COLUMNS.length)
  const lines: string[] = []
  const tops = new Map<string, number>()
  const heights = new Map<string, number>()
  state.hits = []
  for (const [i, l] of state.lanes.entries()) {
    lines.push(laneHead(l, i, W - 1))
    state.hits.push([])
    // Each column stacks its own boxes, a blank line between two.
    const stacks = l.cols.map(col =>
      col.flatMap((it, n) => {
        const box = cardBox(state, it, colW - 1, it.key === state.sel)
        heights.set(it.key, box.length)
        const cells = box.map((text, k) => ({ text, key: it.key as string | null, first: k === 0 }))
        return n ? [{ text: ' '.repeat(colW - 1), key: null, first: false }, ...cells] : cells
      }),
    )
    const height = Math.max(...stacks.map(st => st.length))
    for (let r = 0; r < height; r++) {
      let row = ' '
      const rowHits: Hit[] = []
      stacks.forEach((st, ci) => {
        const cell = st[r]
        row += `${cell ? cell.text : ' '.repeat(colW - 1)} `
        if (!cell?.key) return
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

function listBody(state: TuiState, W: number): Body {
  const lines: string[] = []
  const tops = new Map<string, number>()
  state.hits = []
  for (const [i, l] of state.lanes.entries()) {
    lines.push(laneHead(l, i, W - 1))
    state.hits.push([])
    let column: ColumnId | null = null
    for (const it of laneOrder(l)) {
      // Each column's name, in its color, heads its cards in the lane, as the web board's narrow page has it.
      if (it.column !== column) {
        column = it.column
        lines.push(`   ${paint(COLUMNS.find(c => c.id === column)?.title ?? '', COLOR[column], 'bold')}`)
        state.hits.push([])
      }
      tops.set(it.key, lines.length)
      lines.push(`   ${oneLine(state, it, W - 5, it.key === state.sel, true)}`)
      state.hits.push([{ x0: 1, x1: W - 1, key: it.key }])
    }
    lines.push('')
    state.hits.push([])
  }
  return { lines, tops, heights: new Map(), colW: 0 }
}

/** "AGENT BOARD · 11 sessions, 2 asleep, ⏰ 2", the filters on, the time; the column heads on a wide screen. */
export function headerTerminal(state: TuiState, W: number, colW: number): string[] {
  const { items, lanes, filter, cfg } = state
  const asleep = items.filter(i => i.sleeping).length
  const counts = paint(
    ` · ${t('tui.sessions', { n: items.length })}${asleep ? `, ${t('tui.asleep', { n: asleep })}` : ''}${state.scheduled ? `, ⏰ ${t('tui.sched', { n: state.scheduled })}` : ''}`,
    'gray',
  )
  const filt = filter ? paint(`  ${t('tui.filter', { title: categoryInfo(cfg, filter).title })}`, 'yellow') : ''
  const left = `${paint(' AGENT BOARD', ACCENT, 'bold')}${counts}${filt}${filtersOn(state)}`
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the escape sequences it measures around
  const plain = left.replace(/\x1b\[[0-9;]*m/g, '')
  const time = new Date(state.now).toTimeString().slice(0, 5)
  const top = `${left}${' '.repeat(Math.max(1, W - width(plain) - 6))}${paint(time, 'gray')}`
  if (!colW) return [top, paint('─'.repeat(W - 1), 'gray')]
  const heads = COLUMNS.map(c => {
    const n = lanes.reduce((s, l) => s + (l.cols[COLUMNS.indexOf(c)]?.length ?? 0), 0)
    // The column shown alone in brackets; the others quiet while it is.
    const alone = state.column === c.id
    const quiet = !!state.column && !alone
    const title = fit(alone ? `[${c.title} ${n}]` : `${c.title} ${n}`, colW - 1)
    return {
      title: paint(title, quiet ? 'gray' : COLOR[c.id], !quiet && 'bold'),
      rule: paint('━'.repeat(colW - 1), quiet ? 'gray' : COLOR[c.id], quiet && 'dim'),
    }
  })
  return [top, ` ${heads.map(h => h.title).join(' ')}`, ` ${heads.map(h => h.rule).join(' ')}`]
}

function boardKeys(state: TuiState, W: number): string {
  // The way out early, so a narrow terminal keeps it.
  const hints: [string, string][] = [
    ['Enter', t('key.enter')],
    ['q', t(state.closesOnQuit ? 'key.close' : 'key.back')],
    ['hjkl', t('key.move')],
    ['/', t('key.search')],
    ['W M O D I', t('key.only')],
    ['m', t('key.m')],
    ['w', t('key.w')],
    ['x', t('key.x')],
    ['c', t('key.c')],
    ['z', t('key.z')],
    ['1-9', t('key.filter')],
    ['o', t('key.o')],
    ['r', t('key.r')],
    ['f', t('key.f')],
  ]
  let keys = ''
  let used = 0
  for (const [key, text] of hints) {
    const w = width(` ${key} ${text} `)
    if (used + w > W - 1) break
    keys += ` ${paint(key, ACCENT, 'bold')} ${paint(text, 'gray')} `
    used += w
  }
  return keys
}

/** As the classic board's, the keys in the accent and the new ones (move, search, a column alone) among them. */
export function footerTerminal(state: TuiState, W: number): string[] {
  const [msg = '', keys = ''] = footer(state, W)
  if (state.mode === 'input' && state.input) return [msg, inputKeys(state.input.label, state.input.text, W)]
  return [msg, state.mode === 'board' ? boardKeys(state, W) : keys]
}
