// What the message box sends aside (hooks/useAside.ts): the text, when its switch is on, or what
// follows /btw at its start, as Claude Code's own side question is typed. And how an answer's
// cost reads.

/** The side question in `text` (switch on, or "/btw …"), '' for one still empty, null for a message to the session. */
export function asideQuestion(text: string, on: boolean): string | null {
  if (on) return text.trim()
  const btw = /^\s*\/btw(?:\s+|$)([\s\S]*)$/i.exec(text)
  return btw ? (btw[1] ?? '').trim() : null
}

/** A price in dollars as the card shows it: cents, or tenths of a cent under ten cents. */
export const dollars = (usd: number): string => usd.toFixed(usd < 0.1 ? 3 : 2)

/** Thousands of tokens, at least one. */
export const kilo = (n: number): number => Math.max(1, Math.round(n / 1000))
