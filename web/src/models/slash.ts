// The chat box's slash command list (#191): when it shows, what it shows in which order, what a
// key does to it, and which commands this browser sends most. The commands come from
// GET /api/session/<key>/commands (adapters/slash-commands.ts); hooks/useSlash.ts holds the state.
import type { SlashCommand } from '../../../src/core/slash-commands.ts'

export type { SlashCommand }

/** What follows the leading slash while it is still a command's name (no space, no line); null for any other text. */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text)
  return m ? (m[1] ?? '') : null
}

/** The command a text starts with when its argument is still to come ("/model "): the hint shows for it. */
export function slashArgument(text: string, list: readonly SlashCommand[]): SlashCommand | null {
  const m = /^\/(\S+)[ \t]+$/.exec(text)
  if (!m) return null
  const name = (m[1] ?? '').toLowerCase()
  return list.find(c => c.hint && c.name.toLowerCase() === name) ?? null
}

/** How well a command's name meets the query: 0 starts with it, 1 a word in it does, 2 has it, 3 its description has it; null none. */
function tier(c: SlashCommand, q: string): number | null {
  if (!q) return 0
  const name = c.name.toLowerCase()
  if (name.startsWith(q)) return 0
  if (name.split(/[:\-_.]/).some(w => w.startsWith(q))) return 1
  if (name.includes(q)) return 2
  if (q.length > 1 && c.description.toLowerCase().includes(q)) return 3
  return null
}

/**
 * The commands for what is typed: the closest matches first and, among equals, the ones this
 * browser sent most, then the rest by name.
 */
export function rankCommands(
  list: readonly SlashCommand[],
  query: string,
  uses: Readonly<Record<string, number>> = {},
): SlashCommand[] {
  const q = query.toLowerCase()
  const scored: { c: SlashCommand; t: number; n: number }[] = []
  for (const c of list) {
    const t = tier(c, q)
    if (t !== null) scored.push({ c, t, n: uses[c.name] ?? 0 })
  }
  scored.sort((a, b) => a.t - b.t || b.n - a.n || a.c.name.localeCompare(b.c.name))
  return scored.map(s => s.c)
}

/** The box's text once a command is picked: the command and a space, for what follows. */
export const completion = (c: SlashCommand): string => `/${c.name} `

export type SlashKey = 'next' | 'prev' | 'complete' | 'close' | null

export interface SlashKeyPress {
  key: string
  shiftKey: boolean
  isComposing: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * What a key does while the list shows. `typed`: the box already holds the lit command whole, so
 * Enter sends it as before instead of completing it again.
 */
export function slashKey(e: SlashKeyPress, typed: boolean): SlashKey {
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return null
  if (e.key === 'ArrowDown') return 'next'
  if (e.key === 'ArrowUp') return 'prev'
  if (e.key === 'Tab') return e.shiftKey ? 'prev' : 'complete'
  if (e.key === 'Enter' && !e.shiftKey) return typed ? null : 'complete'
  if (e.key === 'Escape') return 'close'
  return null
}

const USES_KEY = 'agent-board:slash-uses'
/** The most commands the count keeps: the least sent go first. */
const MAX_USES = 100

/** How often this browser sent each command (localStorage); {} where it cannot be read. */
export function readUses(store: Pick<Storage, 'getItem'> | null = storage()): Record<string, number> {
  try {
    const value: unknown = JSON.parse(store?.getItem(USES_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && v > 0) out[k] = v
    return out
  } catch {
    return {}
  }
}

/** A sent message that starts with one of `known`'s commands counts one more send of it. */
export function noteUse(
  text: string,
  known: readonly SlashCommand[] | null,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = storage(),
): void {
  const m = /^\/(\S+)/.exec(text.trimStart())
  const name = m?.[1]
  if (!name || !known?.some(c => c.name === name) || !store) return
  const uses = readUses(store)
  uses[name] = (uses[name] ?? 0) + 1
  const kept = Object.entries(uses)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_USES)
  try {
    store.setItem(USES_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {}
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
