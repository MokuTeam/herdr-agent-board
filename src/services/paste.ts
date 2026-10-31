// A message with pictures typed into Claude Code on the board's own server (server mode). herdr's
// `agent prompt` writes the message as one paste and its Enter right behind it. Claude Code reads
// a pasted picture's path before the box shows "[Image #1]", and an Enter that comes meanwhile is
// lost: it holds it back while it pastes, and forgets it once the paste had pictures (2.1.308; a
// paste of text alone gets it back). A tablet's screenshot (2732×2048) takes the server half a
// second to several seconds to read: the Enter always came too early, and the message stayed in
// the input box while the board said it had gone. Here the board waits for the paste to be over
// and, the message still in the box, gives it its Enter.

import { inputDraft, stillPasting } from '../core/dialogs/input-box.ts'
import { stillTyped } from '../core/launch/spawn-args.ts'

/** The pane, through herdr. */
export interface PasteIO {
  /** Its visible screen with its escapes (null: herdr could not read it). */
  screen(): Promise<string | null>
  enter(): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

/** How long the board waits for Claude Code to take in the pictures (the server's slowest seen: 6 s for one). */
export const PASTE_WAIT_MS = 45_000
export const PASTE_POLL_MS = 250
/** The box still holding the message this long after its Enter: one more. */
export const ENTER_AGAIN_MS = 2_000
/** Reads in a row without the message in the box before it counts as taken (the first may come before "Pasting…" shows). */
const GONE_READS = 2

/** taken: out of the box; inBox: still in it, Enter or not; pasting: Claude Code still reads its pictures. */
export type PasteEnd = 'taken' | 'inBox' | 'pasting'

/**
 * Whether the input box holds the message the board typed: a picture's mark, or its first line
 * (the text, or with files alone the line that names them), or the chip of a long paste.
 */
export const holdsMessage = (draft: string, text: string): boolean =>
  /\[Image #\d+\]/.test(draft) || stillTyped(draft, text)

/**
 * Whether the box holds the message's own first line (its first 30 characters but spaces): the
 * board's message typed before. Not a picture's mark alone, which the user's own text can have.
 */
export function holdsItsLine(draft: string, text: string): boolean {
  const squeeze = (s: string): string => s.replace(/\s+/g, '')
  const head = squeeze(text.split('\n')[0] ?? '').slice(0, 30)
  return !!head && squeeze(draft).includes(head)
}

/** Waits until the message `text` is out of Claude Code's input box, giving it its Enter once the paste is over. */
export async function settlePaste(
  io: PasteIO,
  text: string,
  { waitMs = PASTE_WAIT_MS, pollMs = PASTE_POLL_MS }: { waitMs?: number; pollMs?: number } = {},
): Promise<PasteEnd> {
  const deadline = io.now() + waitMs
  let gone = 0
  let enters = 0
  let enteredAt = 0
  let pasting = false
  while (io.now() < deadline) {
    await io.sleep(pollMs)
    const screen = await io.screen()
    pasting = screen !== null && stillPasting(screen)
    if (pasting) {
      gone = 0
      continue
    }
    const draft = screen === null ? null : inputDraft(screen)
    // No box (a dialog that came with the turn, a screen herdr could not read) or another text in it.
    if (draft === null || !holdsMessage(draft, text)) {
      if (++gone >= GONE_READS) return 'taken'
      continue
    }
    gone = 0
    if (enters === 0 || (enters === 1 && io.now() - enteredAt >= ENTER_AGAIN_MS)) {
      await io.enter()
      enters++
      enteredAt = io.now()
    }
  }
  return pasting ? 'pasting' : 'inBox'
}
