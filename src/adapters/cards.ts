// Cards: what agents (and the user, from the board) said about a session that herdr cannot
// see: its category, what it works on, what it waits for. One small JSON file per session, so
// sessions writing at the same time never clobber each other. Keyed by the Claude session id,
// which survives sleep and resume; agents without one are keyed by their pane.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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

/** Remove a card; one that is not there is no error. */
export function removeCard(key: string): void {
  try {
    unlinkSync(file(key))
  } catch {}
}

/** Every card by key. */
export function allCards(): Map<string, Card> {
  const cards = new Map<string, Card>()
  let names: string[]
  try {
    names = readdirSync(cardsDir())
  } catch {
    return cards
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const card = readJson(join(cardsDir(), name), isCard)
    if (card?.key) cards.set(card.key, card)
  }
  return cards
}
