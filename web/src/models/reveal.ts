// A session to show from outside (src/entrypoints/web-open.ts, a notification clicked): the page
// opened for it (#session=<key> in its address), or the event stream's `reveal` event telling an
// open page (POST /api/reveal).

/** The session a page was opened for: #session=<key>, or null. */
export const sessionInHash = (hash: string): string | null => new URLSearchParams(hash.slice(1)).get('session')

/** The session a `reveal` event names ({ key }), or null for anything else. */
export function revealedKey(data: unknown): string | null {
  try {
    const value: unknown = JSON.parse(String(data))
    return typeof value === 'object' && value !== null && 'key' in value && typeof value.key === 'string'
      ? value.key
      : null
  } catch {
    return null
  }
}

/**
 * The last session the board was asked to show, one the board had; `n` tells two asks for the
 * same session apart.
 */
export interface Reveal {
  key: string
  n: number
}

/** What listening for `reveal` takes of the board's event stream (an EventSource). */
export interface RevealSource {
  addEventListener(type: 'reveal', listener: (event: MessageEvent) => void): void
}

/**
 * Listens for the stream's `reveal` event: a session the board as it came last (`board()`) has
 * becomes the reveal, counted on from the one before. Any other changes nothing.
 */
export function listenForReveals(
  stream: RevealSource,
  board: () => { items: readonly { key: string }[] } | null,
  set: (next: (prev: Reveal | null) => Reveal) => void,
): void {
  stream.addEventListener('reveal', event => {
    const key = revealedKey(event.data)
    if (key && board()?.items.some(i => i.key === key)) set(prev => ({ key, n: (prev?.n ?? 0) + 1 }))
  })
}

/**
 * What showing `key` takes: null when the board has no such session; else its card is brought in
 * view, and its sheet opens unless it is the one open.
 */
export function revealStep(
  key: string,
  items: readonly { key: string }[],
  open: string | null,
): { openSheet: boolean } | null {
  if (!items.some(i => i.key === key)) return null
  return { openSheet: open !== key }
}
