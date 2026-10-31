// The board's record of the messages with pictures it typed into Claude sessions (core/sent-pictures.ts):
// sent-pictures.json in the state folder, the newest 200 of the last 30 days. Only a message with
// pictures writes it; only a thread with a picture mark Claude Code named no file for reads it.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isSentPictures, type SentPictures } from '../core/sent-pictures.ts'
import { readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const sentPicturesFile = (): string => join(stateDir(), 'sent-pictures.json')

const KEEP = 200
const KEEP_MS = 30 * 86_400_000

const isList = (v: unknown): v is SentPictures[] => Array.isArray(v) && v.every(isSentPictures)

/** One more; a record that cannot be written costs the thread its preview, never the message. */
export function rememberPictures(entry: SentPictures, log: (text: string) => void = () => {}): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    updateJson(
      sentPicturesFile(),
      list => [...(list ?? []).filter(e => entry.at - e.at < KEEP_MS), entry].slice(-KEEP),
      isList,
    )
  } catch (err) {
    log(`sent pictures: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The ones sent to `session`. */
export const picturesSentTo = (session: string): SentPictures[] =>
  (readJson(sentPicturesFile(), isList) ?? []).filter(e => e.session === session)
