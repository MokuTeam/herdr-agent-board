// The board's keys as letters, one set for the terminal board (src/tui/input.ts adds the arrows and
// the terminal's escape sequences) and the web board in its Terminal style
// (web/src/models/terminal-keys.ts). Each action takes a Latin letter and the one on the same key of
// a Russian layout. A capital shows one column alone, as the column's initial: W Working, M Needs
// me, O Waiting on others, D Done, I Idle (the lower-case letters act on a card).
import type { ColumnId } from './types.ts'

export const LETTER_KEYS = {
  up: ['k', 'л'],
  down: ['j', 'о'],
  right: ['l', 'д'],
  left: ['h', 'р'],
  home: ['g', 'п'],
  last: ['G', 'П'],
  quit: ['q', 'й'],
  message: ['m', 'ь'],
  wait: ['w', 'ц'],
  clear: ['x', 'ч'],
  sleep: ['z', 'я'],
  favorite: ['f', 'а'],
  category: ['c', 'с'],
  refresh: ['r', 'к'],
  web: ['o', 'щ'],
  search: ['/', '.'],
} as const satisfies Record<string, readonly string[]>

export type LetterAction = keyof typeof LETTER_KEYS

const LETTER_ACTION: ReadonlyMap<string, LetterAction> = new Map(
  Object.entries(LETTER_KEYS).flatMap(([name, keys]) =>
    keys.map((k): [string, LetterAction] => [k, name as LetterAction]),
  ),
)

/** The action of a letter, or null. */
export const letterAction = (key: string): LetterAction | null => LETTER_ACTION.get(key) ?? null

export const COLUMN_KEYS: Readonly<Record<ColumnId, readonly string[]>> = {
  work: ['W', 'Ц'],
  me: ['M', 'Ь'],
  ext: ['O', 'Щ'],
  done: ['D', 'В'],
  idle: ['I', 'Ш'],
}

const COLUMN_OF: ReadonlyMap<string, ColumnId> = new Map(
  Object.entries(COLUMN_KEYS).flatMap(([id, keys]) => keys.map((k): [string, ColumnId] => [k, id as ColumnId])),
)

/** The column a key shows alone, or null. */
export const columnKey = (key: string): ColumnId | null => COLUMN_OF.get(key) ?? null

/** The column shown alone after `picked` was pressed: the same one again shows every column. */
export const toggledColumn = (shown: ColumnId | null, picked: ColumnId): ColumnId | null =>
  shown === picked ? null : picked
