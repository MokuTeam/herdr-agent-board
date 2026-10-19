// Viewing is a browser-local receipt, never acceptance, a pin, or a Herdr state.

/** The fields of a board item the receipts look at. */
export type AttentionItem = {
  key: string
  column: string
  activity?: number
  result?: string
  lastText?: string
  askSince?: number | null
}
/** Session key -> the result token it was viewed at. */
export type Seen = Record<string, string>

export const resultToken = (item: AttentionItem): string =>
  JSON.stringify([item.activity ?? 0, item.result ?? '', item.lastText ?? ''])

export const unseenResult = (item: AttentionItem, seen: Seen): boolean =>
  item.column === 'done' && !!(item.result || item.lastText) && seen[item.key] !== resultToken(item)

export const attentionTime = (item: AttentionItem): number | null =>
  item.column === 'me' ? item.askSince || item.activity || null : null

export function nextAttention(items: AttentionItem[], current: string | null, seen: Seen): string | null {
  const candidates = items.filter(item => item.column === 'me' || unseenResult(item, seen))
  if (!candidates.length) return null
  const index = candidates.findIndex(item => item.key === current)
  return candidates[(index + 1) % candidates.length]?.key ?? null
}

export function recordView(seen: Seen, item: AttentionItem): Seen {
  const next = { ...seen, [item.key]: resultToken(item) }
  // Bound storage even when sessions are no longer on the board.
  return Object.fromEntries(Object.entries(next).slice(-500))
}
