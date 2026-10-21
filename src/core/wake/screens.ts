// The dialogs wake recognises on a pane's screen (plain text, escapes stripped), as herdr-wake
// does (herdr-wake/src/screen.mjs). Claude Code's input box is read with the board's own
// inputDraft (src/core/dialogs/input-box.ts), not a copy of it.

/** /exit in a session with background shells or scheduled tasks asks whether to stop them. */
export function isExitTasksDialog(plain: string): boolean {
  return /will stop when you exit/.test(plain)
}

/** Claude asks whether to trust a folder that has no trust recorded (or an explicit "no"). */
export function isTrustDialog(plain: string): boolean {
  return /Yes, I trust this folder/.test(plain)
}

/** A launcher that starts Claude with development channels gets a confirmation dialog first. */
export function isChannelsWarning(plain: string): boolean {
  return /Loading development channels/.test(plain) && /❯\s*1\.\s*I am using this for local development/.test(plain)
}
