// Antigravity CLI (`agy`) input box, read from an ANSI capture of its pane (`herdr agent read
// --ansi` or `herdr pane read --source visible --ansi`): the `>` line between two horizontal rules
// (`───`). Antigravity draws prompt placeholders dim (SGR 2), so only non-dim text counts as user
// input. Gated strictly to panes herdr reports as `agy`; never called for Claude, pi or Codex.
import { stripAnsi } from './input-box.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const ESCAPES = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g
const RULE = /^\s*─{8,}/
const DIALOG_FOOTER = /\b(?:enter to (?:continue|confirm|select|submit)|esc(?:ape)? to close)\b|↑↓|↑\/↓/i

/** A line without ANSI escapes and without SGR-2 dim placeholder fragments. */
function nonDimText(line: string): string {
  let dim = false
  let out = ''
  let last = 0
  for (const m of line.matchAll(ESCAPES)) {
    if (!dim) out += line.slice(last, m.index)
    last = m.index + m[0].length
    if (m[2] !== 'm') continue
    const codes = m[1] === '' || m[1] === undefined ? [0] : m[1].split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 38 || c === 48 || c === 58) i += codes[i + 1] === 2 ? 4 : 2
      else if (c === 0 || c === 22) dim = false
      else if (c === 2) dim = true
    }
  }
  if (!dim) out += line.slice(last)
  return out
}

/**
 * What the user has typed into Antigravity CLI's input box: '' when empty or dim-only,
 * typed text otherwise, or null when no complete current input box is visible (a dialog,
 * picker, or incomplete capture).
 */
export function agyDraft(ansiScreen: unknown): string | null {
  const lines = String(ansiScreen ?? '').split(/\r?\n/)
  const plain = (i: number): string => stripAnsi(lines[i] ?? '')
  for (let i = lines.length - 1; i > 0; i--) {
    if (!plain(i).trimStart().startsWith('>')) continue
    if (!RULE.test(plain(i - 1))) continue
    const parts: string[] = []
    let end = i
    for (; end < lines.length && !(end > i && RULE.test(plain(end))); end++) parts.push(nonDimText(lines[end] ?? ''))
    if (end === lines.length) return null
    const footer = lines
      .slice(end + 1)
      .map(stripAnsi)
      .join('\n')
    if (/^\s*[❯→]/m.test(footer) || DIALOG_FOOTER.test(footer)) return null
    parts[0] = (parts[0] ?? '').replace(/^\s*>\s?/, '')
    return parts.join('\n').trim()
  }
  return null
}
