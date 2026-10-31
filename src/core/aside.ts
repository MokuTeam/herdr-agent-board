// A side question to a session (/btw from the board): Claude Code's own /btw, typed into the
// session's pane. Claude Code answers it from the conversation, with no tools, in an overlay over
// its input box, and never writes it to the conversation; the board reads the answer off the
// screen and closes the overlay. services/aside.ts drives it; this file reads the screen.
//
// The overlay as Claude Code 2.1 draws it (plain text, herdr agent read --source visible):
//
//   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔   a rule, a notice may sit in it
//       /btw an earlier question     earlier ones, while its history holds them
//       /btw what is the code word?  this one, on one line, cut short with "…" when long
//
//         PINEAPPLE                  the answer, two columns right of it, wrapped to the terminal's width
//
//       ↑/↓ to scroll · c to copy · f to fork · Esc to close
//
// While it answers the body says "✽ Answering…" and the footer only "Esc to close". A /btw that
// fails gets no "c to copy" either: text that stays there with no spinner is taken for its error. An answer
// longer than the overlay scrolls: each Down shows three lines further, the question stays on top.

/**
 * The longest question the board passes on. Claude Code turns a paste of more than 800 characters
 * into "[Pasted text #1]", and that is sent to the conversation as a message, not run as /btw;
 * "/btw " and the question stay under it.
 */
export const ASIDE_MAX = 790

/** The line typed into the session: /btw and the question on one line (Enter would end it early). */
export const btwLine = (question: string): string => `/btw ${question.replace(/\s+/g, ' ').trim()}`

export type BtwScreen =
  /** No /btw overlay on screen. */
  | { state: 'none' }
  /** A /btw overlay with another question in it. */
  | { state: 'other' }
  /** Ours, still answering. */
  | { state: 'answering' }
  /** Ours, with no "Answering…" and no answer: what it says instead (an error, when it stays). */
  | { state: 'stopped'; text: string }
  /** Ours, answered: the lines of the answer in sight, without their indent (blank ones kept). */
  | { state: 'answered'; lines: string[] }

const FOOTER = /\bEsc to close\s*$/
const RULE = /▔{4,}/
const ANSWERING = /^\S?\s*Answering…\s*$/
const indent = (line: string): number => line.length - line.trimStart().length

/** Whether the overlay's question line (cut short with "…" when long) is `question`'s. */
function sameQuestion(shown: string, question: string): boolean {
  const want = btwLine(question)
  const got = shown.replace(/\s+/g, ' ').trim()
  if (got === want) return true
  return got.endsWith('…') && want.startsWith(got.slice(0, -1).trimEnd())
}

/** What `screen` (plain text) shows of a /btw overlay for `question`. */
export function readBtw(screen: string, question: string): BtwScreen {
  const lines = String(screen ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ''))
  let footer = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (FOOTER.test(lines[i] ?? '')) {
      footer = i
      break
    }
  if (footer < 0) return { state: 'none' }
  let rule = -1
  for (let i = footer - 1; i >= 0; i--)
    if (RULE.test(lines[i] ?? '')) {
      rule = i
      break
    }
  if (rule < 0) return { state: 'none' }
  // The question lines sit less indented than the answer: the last of them is the one shown.
  let asked = -1
  for (let i = rule + 1; i < footer; i++) {
    const l = lines[i] ?? ''
    if (l.trimStart().startsWith('/btw ') && indent(l) <= 4) asked = i
  }
  if (asked < 0) return { state: 'none' }
  if (!sameQuestion(lines[asked] ?? '', question)) return { state: 'other' }
  const body = lines.slice(asked + 1, footer)
  if (body.some(l => ANSWERING.test(l.trim()))) return { state: 'answering' }
  if (!/\bc to copy\b/.test(lines[footer] ?? '')) {
    const text = body
      .map(l => l.trim())
      .filter(Boolean)
      .join(' ')
    return text ? { state: 'stopped', text } : { state: 'answering' }
  }
  // One blank line under the question and one over the footer frame the answer; blank lines
  // inside it are its own (they keep the lines in sight lined up while it scrolls).
  if (body.length && !body[0]?.trim()) body.shift()
  if (body.length && !body.at(-1)?.trim()) body.pop()
  // The answer sits two columns right of the question, in every window of a scrolled one: a window
  // of nothing but code or a nested list keeps its own indent, so it meets the window before.
  const cut = indent(lines[asked] ?? '') + 2
  return { state: 'answered', lines: body.map(l => l.slice(Math.min(cut, indent(l)))) }
}

/**
 * The answer read so far, `seen`, with `shown`: the lines in sight after one more scroll down. The
 * longest end of `seen` that `shown` starts with is where they meet; with no overlap at all the
 * scroll went further than the overlay is high, and `shown` follows on.
 */
export function mergeScroll(seen: readonly string[], shown: readonly string[]): string[] {
  for (let k = Math.min(seen.length, shown.length); k > 0; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) same = seen[seen.length - k + i] === shown[i]
    if (same) return [...seen, ...shown.slice(k)]
  }
  return [...seen, ...shown]
}
