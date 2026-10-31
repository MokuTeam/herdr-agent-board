// The pictures the board sent with a message, for the session's thread. Claude Code takes a pasted
// picture's path out of the prompt ("[Image #9]" in its place) and names the file in a meta line of
// the same prompt, from which the thread puts the path back (core/transcript.ts withImages). A
// message that reaches the session while it works goes into the running turn and is kept as a
// queued command with no such line, nor does its queue keep the path: the thread showed
// "[Image #9]…\nFiles:" with no file and no preview. The board's own record of what it sent (the
// message route, adapters/sent-pictures-store.ts) gives it the paths back. Pure.
import { messageKey } from './message-key.ts'
import { withImages } from './transcript.ts'

/** One message with pictures the board typed into a Claude session. */
export interface SentPictures {
  /** The Claude session it went to. */
  session: string
  /** Its words (messageKey of what was typed). */
  key: string
  /** The pictures' paths, as typed. */
  pictures: string[]
  /** When the board typed it (ms). */
  at: number
}

export const isSentPictures = (v: unknown): v is SentPictures => {
  const r = v as Partial<SentPictures> | null
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.session === 'string' &&
    typeof r.key === 'string' &&
    typeof r.at === 'number' &&
    Array.isArray(r.pictures) &&
    r.pictures.every(p => typeof p === 'string')
  )
}

/** Claude Code takes the message in when its Enter comes, after the board's record: a little before that is the clocks' slack. */
const BEFORE_MS = 5_000
/** A message the board typed reaches the queue at once, or once its pictures are read: one queued much later is someone else's. */
export const SENT_WITHIN_MS = 15 * 60_000

const MARKS = /\[Image #(\d+)\]/g

/**
 * A message as the thread shows it (`at`: when the session took it) with its pictures' paths back
 * under it, as it was sent, when it still has its "[Image #N]" marks and the board sent these
 * words with pictures to this session (`sent`, read only then) shortly before. Otherwise the
 * text as it is.
 */
export function picturesBack(text: string, at: number, sent: () => readonly SentPictures[]): string {
  const ids = [...text.matchAll(MARKS)].map(m => Number(m[1]))
  if (!ids.length) return text
  const key = messageKey(text)
  let best: SentPictures | null = null
  for (const r of sent())
    if (r.key === key && r.pictures.length && at >= r.at - BEFORE_MS && at <= r.at + SENT_WITHIN_MS)
      if (!best || r.at > best.at) best = r
  return best ? withImages(text, ids, best.pictures) : text
}
