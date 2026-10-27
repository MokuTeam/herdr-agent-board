// What the message box sends aside (hooks/useAside.ts): the text, when its switch is on, or what
// follows /btw at its start, as Claude Code's own side question is typed.

/** The side question in `text` (switch on, or "/btw …"), '' for one still empty, null for a message to the session. */
export function asideQuestion(text: string, on: boolean): string | null {
  if (on) return text.trim()
  const btw = /^\s*\/btw(?:\s+|$)([\s\S]*)$/i.exec(text)
  return btw ? (btw[1] ?? '').trim() : null
}
