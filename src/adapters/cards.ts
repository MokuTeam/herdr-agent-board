// Cards: what agents (and the user, from the board) said about a session that herdr cannot
// see: its category, what it works on, what it waits for. One small JSON file per session, so
// sessions writing at the same time never clobber each other. Keyed by the Claude session id,
// which survives sleep and resume; agents without one are keyed by their pane.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { applyTodo, type Todo, type TodoOp, todosOf } from '../core/todos.ts'
import type { Card } from '../core/types.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { cardsDir } from './paths.ts'

const safe = (key: string): string => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const file = (key: string): string => join(cardsDir(), `${safe(key)}.json`)

const isCard = (v: unknown): v is Card => isRecord(v)

export function readCard(key: string): Card | null {
  return readJson(file(key), isCard)
}

/** A change to a card: any field, or '' to clear it. */
export type CardPatch = { [K in keyof Card]?: Card[K] | '' }

/** Merge `patch` into the card and save it. Empty strings clear a field. */
export function writeCard(key: string, patch: CardPatch): Card {
  mkdirSync(cardsDir(), { recursive: true })
  return updateJson(
    file(key),
    (saved: Card | null): Card => {
      // The same order as { ...saved, ...patch, updatedAt }; '' values go just below.
      const card: Card = Object.assign({ ...(saved ?? { key }) }, patch, { updatedAt: Date.now() })
      for (const [k, v] of Object.entries(card)) if (v === '' || v === null) delete card[k]
      return card
    },
    isCard,
  )
}

/**
 * A change to a card's tasks (core/todos.ts applyTodo), read and written under the card's lock, so
 * the web board and `board todo` writing at once never lose each other's change. A card that is not
 * there gets one for an added point only.
 */
export function changeTodos(
  key: string,
  op: TodoOp,
  now = Date.now(),
): { ok: true; todo?: Todo } | { ok: false; error: string } {
  mkdirSync(cardsDir(), { recursive: true })
  let result: { ok: true; todo?: Todo } | { ok: false; error: string } = { ok: false, error: 'todo.err.gone' }
  updateJson(
    file(key),
    (saved: Card | null): Card | undefined => {
      const r = applyTodo(todosOf(saved?.todos), op, now, () => crypto.randomUUID().slice(0, 8))
      if ('error' in r) {
        result = { ok: false, error: r.error }
        return undefined
      }
      result = { ok: true, ...(r.todo && { todo: r.todo }) }
      const card: Card = { ...(saved ?? { key }), updatedAt: now }
      if (r.list.length) card.todos = r.list
      else delete card.todos
      return card
    },
    isCard,
  )
  return result
}

/** Remove a card; one that is not there is no error. */
export function removeCard(key: string): void {
  try {
    unlinkSync(file(key))
  } catch {}
}

/** Every card by key. */
export function allCards(): Map<string, Card> {
  const cards = new Map<string, Card>()
  // An invalid explicit store must not silently look like an empty board.
  const dir = cardsDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return cards
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const card = readJson(join(dir, name), isCard)
    if (card?.key) cards.set(card.key, card)
  }
  return cards
}
