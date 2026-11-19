// Codex's composer, read from an ANSI capture of its pane (herdr agent read --ansi): a line that
// starts with "›" (bold) and the text after it. The placeholder ("Ask Codex to do anything") is
// drawn dim (SGR 2), so only text that is not dim is something the user typed; checked with codex
// 0.169 on its start screen and with text typed into it. Unlike Claude's box it has no rules around it.
import { nonDimText, stripAnsi } from './input-box.ts'

// "› 1. Yes, proceed": the same mark in front of the highlighted option of a dialog.
const OPTION = /^\d+\.\s/

/**
 * What the user has typed into Codex's composer: '' when it is empty or shows only the dim
 * placeholder, null when the screen has no composer (nothing with "›" in front, or a dialog's
 * highlighted option). A draft over several lines gives its first line: that is enough to know one is there.
 */
export function codexDraft(ansiScreen: unknown): string | null {
  const lines = String(ansiScreen ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (
      !stripAnsi(lines[i] ?? '')
        .trimStart()
        .startsWith('›')
    )
      continue
    const text = nonDimText(lines[i] ?? '')
      .replace(/^\s*›\s?/, '')
      .trim()
    return OPTION.test(text) ? null : text
  }
  return null
}
