// Claude Code's input box, read from an ANSI capture of its pane (herdr agent read --ansi), the
// same way herdr-wake reads it: the "❯" line right under a horizontal rule, up to the next rule.
// Claude draws its placeholder and prompt suggestions dim (SGR 2), so only text that is not dim
// is something the user typed.

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const ESCAPES = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g
const RULE = /^\s*─{8,}/
// The rule over the box carries the session's name at its right end ("──── anna ─"). A name
// longer than the rule takes its whole start, cut with "…" and no run of dashes left (#484).
const NAMED_RULE = /^\s*─*\s+\S.*\s─\s*$/
const width = (s: string): number => [...s.trimEnd()].length

/**
 * Whether a plain line is the rule Claude Code draws over its input box: a run of dashes, or a
 * rule that carries the session's name, which Claude draws as wide as the rule under the box
 * (`bottom`, the next rule down; undefined when there is none), so a heading that ends in a dash
 * over a picker is not taken for it.
 */
export const boxTop = (top: string, bottom: string | undefined): boolean =>
  RULE.test(top) || (NAMED_RULE.test(top) && bottom !== undefined && RULE.test(bottom) && width(top) === width(bottom))

export const stripAnsi = (s: string): string => s.replace(ESCAPES, '')

/** A line without its escapes and without the parts drawn dim. */
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
      if (c === 38 || c === 48 || c === 58)
        i += codes[i + 1] === 2 ? 4 : 2 // a colour's arguments
      else if (c === 0 || c === 22) dim = false
      else if (c === 2) dim = true
    }
  }
  if (!dim) out += line.slice(last)
  return out
}

/**
 * What the user has typed into the input box: '' when it is empty or shows only a dim
 * placeholder or suggestion, null when there is no complete current input box on screen (a
 * dialog, a picker, or an incomplete capture). Never fall back to a box above a newer cursor.
 */
export function inputDraft(ansiScreen: unknown): string | null {
  const lines = String(ansiScreen ?? '').split(/\r?\n/)
  const plain = (i: number): string => stripAnsi(lines[i] ?? '')
  for (let i = lines.length - 1; i > 0; i--) {
    if (!plain(i).trimStart().startsWith('❯')) continue
    if (!RULE.test(plain(i - 1)) && !NAMED_RULE.test(plain(i - 1))) continue
    const parts: string[] = []
    let end = i
    for (; end < lines.length && !(end > i && RULE.test(plain(end))); end++) parts.push(nonDimText(lines[end] ?? ''))
    if (end === lines.length) return null
    if (!boxTop(plain(i - 1), plain(end))) continue
    // A dialog can leave the previous input box above it, with or without a new ❯ cursor.
    // Its instructions are not the normal prompt's "esc to interrupt" or "tab to accept".
    const footer = lines
      .slice(end + 1)
      .map(stripAnsi)
      .join('\n')
    if (
      /^\s*❯/m.test(footer) ||
      /\b(?:esc(?:ape)? to (?:cancel|close)|enter to (?:continue|confirm|select|submit))\b/i.test(footer)
    )
      return null
    parts[0] = (parts[0] ?? '').replace(/^\s*❯\s?/, '')
    return parts.join('\n').trim()
  }
  return null
}

// The line under a dialog that says how to answer it: "Enter to confirm · Esc to cancel", "Esc to
// start without it", "Enter to select · ↑/↓ to navigate". Not a working Claude's "esc to interrupt".
const HOW_TO_ANSWER = /\b(?:enter|esc(?:ape)?) to (?!interrupt\b)\p{L}/iu
const CHOICE = /^\s*❯\s*\S/

/**
 * Whether the screen ends in a dialog: what Claude Code draws when it wants an answer before its
 * input box takes text (the folder trust, a project's MCP servers, a permission, a first-run notice
 * or an upsell). Told by its shape, not its words: a choice marked ❯, and under it, as the screen's
 * last line, how to answer it. A complete current input box is never one (inputDraft).
 */
export function choiceDialog(ansiScreen: unknown): boolean {
  if (inputDraft(ansiScreen) !== null) return false
  const lines = stripAnsi(String(ansiScreen ?? '')).split(/\r?\n/)
  let end = lines.length - 1
  while (end >= 0 && !lines[end]?.trim()) end--
  if (end < 1 || !HOW_TO_ANSWER.test(lines[end] ?? '')) return false
  return lines.slice(0, end).some(l => CHOICE.test(l))
}

/** What a screen shows where a line would be typed: the input box and its text, a dialog, or neither (null). */
export type PromptScreen = { kind: 'box'; draft: string } | { kind: 'dialog' } | null

export function promptScreen(ansiScreen: unknown): PromptScreen {
  const draft = inputDraft(ansiScreen)
  if (draft !== null) return { kind: 'box', draft }
  return choiceDialog(ansiScreen) ? { kind: 'dialog' } : null
}
