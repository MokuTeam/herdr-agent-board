// Text on a terminal: ANSI styles, how many cells a character takes, fitting text to a width.
import { t } from '../core/lang.ts'

export const CSI = '\x1b['
const CODES: Readonly<Record<string, number>> = {
  bold: 1,
  dim: 2,
  inverse: 7,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
}

export type Style = string | null | false | undefined

/** `text` in the named styles; unknown names and empty values are skipped. */
export function paint(text: string, ...styles: Style[]): string {
  const codes = styles.flatMap(s => (s && CODES[s] ? [CODES[s]] : []))
  return codes.length ? `${CSI}${codes.join(';')}m${text}${CSI}0m` : text
}

// East Asian wide and emoji code points take two cells.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
]

/** Cells a code point takes: 0 for control and combining characters, 2 for wide ones, else 1. */
export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  for (const [a, b] of WIDE) {
    if (cp < a) break
    if (cp <= b) return 2
  }
  return 1
}

const cellsOf = (ch: string): number => charWidth(ch.codePointAt(0) ?? 0)

/** Cells `s` takes on screen. */
export function width(s: string): number {
  let w = 0
  for (const ch of s) w += cellsOf(ch)
  return w
}

/** Exactly `w` cells: cut with an ellipsis or padded with spaces. */
export function fit(text: unknown, w: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const s = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ')
  if (w <= 0) return ''
  const total = width(s)
  if (total <= w) return s + ' '.repeat(w - total)
  let cut = ''
  let used = 0
  for (const ch of s) {
    const cw = cellsOf(ch)
    if (used + cw > w - 1) break
    cut += ch
    used += cw
  }
  return `${cut}…${' '.repeat(w - 1 - used)}`
}

/** "5m", "3h", "2d" since `ms`; empty when there is no time. */
export function age(ms: number | null | undefined, now: number): string {
  if (!ms) return ''
  const m = Math.floor((now - ms) / 60_000)
  if (m < 1) return t('ago.short.now')
  if (m < 60) return t('ago.short.min', { n: m })
  const h = Math.floor(m / 60)
  return h < 24 ? t('ago.short.h', { n: h }) : t('ago.short.d', { n: Math.floor(h / 24) })
}
