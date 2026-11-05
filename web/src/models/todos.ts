// Tasks (#202, src/core/todos.ts) on the page: the 📌 menu under an agent's message (its points,
// the ones pinned checked), the toolbar's count, and the panel's groups by lane and session; the
// points agents proposed done first, for the user to confirm (#319).

import type { BoardCategory } from '../../../src/core/payload.ts'
import { isProposed, messagePoints, sortTodos, type Todo, type TodoOwner } from '../../../src/core/todos.ts'
import type { AssistantTurn } from '../../../src/core/transcript.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import type { MenuEntry } from './menu-model.ts'

/** What the panel shows: the user's points, the agents' promises, or both. */
export type TodoFilter = 'mine' | 'agents' | 'all'
export const TODO_FILTERS: readonly TodoFilter[] = ['mine', 'agents', 'all']

/** The message a point came from, as the page knows it. */
export type Anchor = { id?: string; at: number }
export const anchorOf = (turn: Pick<AssistantTurn, 'id' | 'at'>): Anchor => ({
  ...(turn.id && { id: turn.id }),
  at: turn.at,
})

/** This message's open point with this text and owner, if pinned. */
export function pinnedPoint(todos: readonly Todo[], anchor: Anchor, text: string, owner: TodoOwner): Todo | undefined {
  return todos.find(
    x =>
      !x.done &&
      x.owner === owner &&
      x.text === text &&
      x.anchor?.at === anchor.at &&
      (x.anchor?.id ?? '') === (anchor.id ?? ''),
  )
}

/** How many of a message's points are pinned, open, for anyone. */
export function pinnedCount(
  todos: readonly Todo[] | undefined,
  turn: Pick<AssistantTurn, 'id' | 'at' | 'text'>,
): number {
  if (!todos?.length) return 0
  const anchor = anchorOf(turn)
  return messagePoints(turn.text).filter(
    p => pinnedPoint(todos, anchor, p, 'user') || pinnedPoint(todos, anchor, p, 'agent'),
  ).length
}

const MENU_LABEL_MAX = 90
const short = (s: string): string => (s.length > MENU_LABEL_MAX ? `${s.slice(0, MENU_LABEL_MAX - 1)}…` : s)

/**
 * The 📌 menu: the message's points for the user, checked when pinned (a pick pins or unpins and
 * keeps the menu open for the next); then the same points as the agent's promise, in a submenu.
 * Ids: `user:<n>` and `agent:<n>`, n the point's place in `points`.
 */
export function pinMenu(points: readonly string[], todos: readonly Todo[], anchor: Anchor, t: Translator): MenuEntry[] {
  const mine = points.map((p, n) => ({
    id: `user:${n}`,
    label: short(p),
    checked: !!pinnedPoint(todos, anchor, p, 'user'),
    keep: true,
  }))
  return [
    ...mine,
    { separator: true },
    {
      id: 'agent',
      label: t('todo.pinForAgent'),
      submenu: points.map((p, n) => ({
        id: `agent:${n}`,
        label: short(p),
        checked: !!pinnedPoint(todos, anchor, p, 'agent'),
      })),
    },
  ]
}

/** A picked id of pinMenu: whose, and which point. */
export function pinPicked(id: string): { owner: TodoOwner; n: number } | null {
  const m = id.match(/^(user|agent):(\d+)$/)
  return m ? { owner: m[1] as TodoOwner, n: Number(m[2]) } : null
}

/** The toolbar's count: the user's own open points, on sessions the board shows; proposed ones apart. */
export const openMine = (items: readonly Item[]): number =>
  items.reduce((n, i) => n + (i.todos ?? []).filter(x => !x.done && x.owner === 'user' && !x.proposed).length, 0)

/** The points agents proposed done, for the user to confirm (#319). */
export const proposedCount = (items: readonly Item[]): number =>
  items.reduce((n, i) => n + (i.todos ?? []).filter(isProposed).length, 0)

export const fits = (x: Todo, filter: TodoFilter): boolean =>
  filter === 'all' || (filter === 'mine' ? x.owner === 'user' : x.owner === 'agent')

export interface TodoGroup {
  item: Item
  open: Todo[]
}

/** Sessions with open points for the filter, the one with the oldest point first. */
export function todoGroups(items: readonly Item[], filter: TodoFilter): TodoGroup[] {
  return items
    .map(item => ({ item, open: sortTodos(item.todos ?? []).filter(x => !x.done && fits(x, filter)) }))
    .filter(g => g.open.length)
    .sort((a, b) => (a.open[0]?.at ?? 0) - (b.open[0]?.at ?? 0))
}

/** Sessions with points an agent proposed done (#319), the oldest proposal first. */
export function proposedGroups(items: readonly Item[]): TodoGroup[] {
  const first = (g: TodoGroup) => Math.min(...g.open.map(x => x.proposed?.at ?? x.at))
  return items
    .map(item => ({ item, open: sortTodos(item.todos ?? []).filter(isProposed) }))
    .filter(g => g.open.length)
    .sort((a, b) => first(a) - first(b))
}

/** A lane of the panel: its sessions' open points (proposed ones are above, apart). */
export interface TodoLane {
  id: string
  title: string
  color: string
  groups: TodoGroup[]
}

/**
 * The open points for the filter by lane, as the board orders its lanes (a lane it does not know
 * after them), then by session, the one with the oldest point first (#319).
 */
export function todoLanes(
  items: readonly Item[],
  categories: readonly Pick<BoardCategory, 'id' | 'title' | 'color'>[],
  filter: TodoFilter,
): TodoLane[] {
  const groups = items
    .map(item => ({ item, open: sortTodos(item.todos ?? []).filter(x => !x.done && !x.proposed && fits(x, filter)) }))
    .filter(g => g.open.length)
    .sort((a, b) => (a.open[0]?.at ?? 0) - (b.open[0]?.at ?? 0))
  const order = new Map(categories.map((c, i) => [c.id, i]))
  const lanes = new Map<string, TodoLane>()
  for (const g of groups) {
    const id = g.item.category || ''
    const c = categories.find(x => x.id === id)
    const lane = lanes.get(id) ?? { id, title: c?.title || id, color: c?.color ?? '', groups: [] }
    lane.groups.push(g)
    lanes.set(id, lane)
  }
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...lanes.values()].sort((a, b) => rank(a.id) - rank(b.id))
}

/** The done points for the filter, newest first, with their sessions. */
export function doneTodos(items: readonly Item[], filter: TodoFilter): { item: Item; todo: Todo }[] {
  return items
    .flatMap(item => (item.todos ?? []).filter(x => x.done && fits(x, filter)).map(todo => ({ item, todo })))
    .sort((a, b) => (b.todo.done ?? 0) - (a.todo.done ?? 0))
}

/** "To chat": the point as a quote, before what the box held. */
export function quoteDraft(text: string, before: string): string {
  const quote = `> ${text}\n\n`
  return before.trim() ? `${quote}${before}` : quote
}

/** A point's age, short: 5m, 3h, 2d. */
export function ageText(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}
