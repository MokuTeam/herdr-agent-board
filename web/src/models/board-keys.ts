// The board's keys: which action a key press takes, given what is open and focused. The
// keydown listener (hooks/useBoardKeys.ts) gathers the scene and carries the action out.

export interface KeyPress {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export interface KeyScene {
  /** A text field has the focus. */
  typing: boolean
  /** A side panel is open. */
  panelOpen: boolean
  query: string
  /** The quick look is open: it takes N, F2 and the digits. */
  quickLook: boolean
  /** A session's question is on show in the sheet, and the sheet or its card has the focus. */
  digits: boolean
}

export type BoardKey =
  | 'blur'
  | 'closePanel'
  | 'clearQuery'
  | 'newSession'
  | 'rename'
  | 'next'
  | 'digit'
  | 'search'
  | null

// N on a Russian layout is Т.
const isN = (key: string): boolean => ['n', 'т'].includes(key.toLowerCase())

export function boardKey(e: KeyPress, s: KeyScene): BoardKey {
  const plainKey = !s.typing && !e.metaKey && !e.ctrlKey && !e.altKey && !s.quickLook
  if (e.key === 'Escape') {
    if (s.typing) return 'blur'
    if (s.panelOpen) return 'closePanel'
    return s.query ? 'clearQuery' : null
  }
  // Shift+N: a new session, in the lane on show.
  if (isN(e.key) && e.shiftKey && plainKey) return 'newSession'
  if (e.key === 'F2' && !s.typing && !s.quickLook) return 'rename'
  if (isN(e.key) && plainKey) return 'next'
  // Digits pick an option of the question the session waits on, as in the terminal.
  if (/^[1-9]$/.test(e.key) && s.digits && !s.quickLook) return 'digit'
  if (e.key === '/' && !s.typing) return 'search'
  return null
}
