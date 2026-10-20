// What the terminal sends: keys to board actions, the stream split into tokens, mouse reports.

// Each action also takes the letter on the same key of a Russian layout (k = л, m = ь, ...).
export const KEYMAP: Readonly<Record<string, readonly string[]>> = {
  up: ['\x1b[A', '\x1bOA', 'k', 'л'],
  down: ['\x1b[B', '\x1bOB', 'j', 'о'],
  right: ['\x1b[C', '\x1bOC', 'l', 'д', '\t'],
  left: ['\x1b[D', '\x1bOD', 'h', 'р', '\x1b[Z'],
  home: ['\x1b[H', '\x1b[1~', 'g', 'п'],
  enter: ['\r', '\n'],
  quit: ['q', 'й', '\x1b'],
  exit: ['\x03'],
  message: ['m', 'ь'],
  wait: ['w', 'ц'],
  clear: ['x', 'ч'],
  sleep: ['z', 'я'],
  favorite: ['f', 'а'],
  category: ['c', 'с'],
  refresh: ['r', 'к'],
  web: ['o', 'щ'],
}

/** A key (or escape sequence) to the name of its action. */
export const ACTION: ReadonlyMap<string, string> = new Map(
  Object.entries(KEYMAP).flatMap(([name, keys]) => keys.map((k): [string, string] => [k, name])),
)

// A mouse report, any other CSI sequence, SS3, a lone Escape, or one character.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what it matches
const TOKEN = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b|[\s\S]/gu

/** Splits a chunk of terminal input into keys, escape sequences and mouse reports. */
export function tokens(data: string): string[] {
  return Array.from(data.matchAll(TOKEN), m => m[0])
}

export interface Mouse {
  /** 0 left button, 64 / 65 wheel up / down. */
  button: number
  /** 1-based column and row. */
  x: number
  y: number
  /** True for a press (M), false for a release (m). */
  press: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what it matches
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

/** An SGR mouse report ("\x1b[<0;10;5M"), or null when `tok` is not one. */
export function parseMouse(tok: string): Mouse | null {
  const m = MOUSE.exec(tok)
  if (!m) return null
  return { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' }
}

/** A clickable cell run on a body line: columns x0..x1 belong to the card `key`. */
export interface Hit {
  x0: number
  x1: number
  key: string
}

/** The card under column `x` on body line `line`. */
export function hitAt(hits: readonly (readonly Hit[])[], line: number, x: number): Hit | undefined {
  return (hits[line] ?? []).find(h => x >= h.x0 && x <= h.x1)
}
