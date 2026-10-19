// One board scene drawn both ways: by the old page's code (support/old-board.ts) and by the
// React board, inside the page's providers. Both read the clock as they draw.
import { translator } from '../../../src/core/i18n/translator.ts'
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { ColumnId, Item } from '../../../src/core/types.ts'
import { Board } from '../../../web/src/components/Board.tsx'
import type { Seen } from '../../../web/src/models/attention.ts'
import { NO_MOVES, withMove } from '../../../web/src/models/board-view.ts'
import { board, payload, renderInBoard } from './board.tsx'
import { canonical, find, type Node } from './markup.ts'
import { oldBoard } from './old-board.ts'

export const CATEGORIES: BoardCategory[] = [
  { id: 'proj', title: 'Project', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', paths: [], configured: true, fallback: true },
  {
    id: 'unused',
    title: 'Unused',
    color: '#FF9500',
    colorName: 'orange',
    paths: [],
    configured: true,
    fallback: false,
  },
]

export interface Scene {
  lang?: string
  items: Item[]
  categories?: BoardCategory[]
  schedules?: ScheduleEntry[]
  filter?: string
  query?: string
  sleepers?: boolean
  open?: string | null
  busy?: [string, string][]
  viewed?: Seen
  moves?: { key: string; cat: string | null; column: ColumnId | null }[]
  canMutate?: boolean
  canEdit?: boolean
  /** The cards as a later upstream merge draws them (support/old-board.ts), in place of the baseline's. */
  ref?: string
  /** Sessions on their way to the archive: off the board at once (#56). */
  archiving?: string[]
}

export function drawBoth(scene: Scene): { old: Node[]; react: Node[] } {
  const lang = scene.lang ?? 'en'
  const t = translator(lang)
  const data = payload({
    lang: t.lang,
    items: scene.items,
    categories: scene.categories ?? CATEGORIES,
    schedules: scene.schedules ?? [],
  })
  const ui = {
    filter: scene.filter ?? 'all',
    query: scene.query ?? '',
    sleepers: scene.sleepers ?? true,
    open: scene.open ?? null,
    busy: new Map(scene.busy ?? []),
    viewed: scene.viewed ?? {},
  }
  const canEdit = scene.canEdit ?? true
  const canMutate = scene.canMutate ?? canEdit
  const moves = scene.moves ?? []
  const now = Date.now()
  const old = oldBoard({
    t,
    data,
    ...ui,
    moved: new Map(moves.flatMap((m): [string, string][] => (m.cat ? [[m.key, m.cat]] : []))),
    movedCol: new Map(
      moves.flatMap((m): [string, { col: ColumnId; at: number }][] =>
        m.column ? [[m.key, { col: m.column, at: now }]] : [],
      ),
    ),
    canMutate,
    canEdit,
    ref: scene.ref,
    archiving: new Map((scene.archiving ?? []).map(key => [key, now])),
  })
  const pending = moves.reduce((all, m) => withMove(all, m.key, { ...m, at: now }), NO_MOVES)
  const archiving: ReadonlyMap<string, number> = new Map((scene.archiving ?? []).map(key => [key, now]))
  const value = board({ data, connected: canEdit, canMutate, canEdit, now, ui: { ...ui, moves: pending, archiving } })
  return { old, react: renderInBoard(<Board />, value, lang) }
}

/** The canonical text of both sides, inline spaces kept (cards have spaces that show). */
export function bothBoards(scene: Scene): { old: string; react: string } {
  const { old, react } = drawBoth(scene)
  return { old: canonical(old, { spaces: true }), react: canonical(react, { spaces: true }) }
}

const cardIn = (nodes: Node[], key: string) => [
  find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key),
]

/** The canonical text of one card on both sides. */
export function bothCards(scene: Scene, key: string): { old: string; react: string } {
  const { old, react } = drawBoth(scene)
  return { old: canonical(cardIn(old, key), { spaces: true }), react: canonical(cardIn(react, key), { spaces: true }) }
}
