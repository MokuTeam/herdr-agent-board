// The away journal's service (#489, core/journal.ts): after each refresh of the board it notes
// what changed (one transaction, only when something did), notices the owner's return, and keeps
// the "While you were away" strip the page and the phone read in the board's payload.
//
// The return: with presence on, its switch from away to anything else after at least
// returnMinutes away (the page going off show says nothing then: a full-screen terminal hides the
// browser all day). With presence off, the board's live streams going from none to one after at
// least returnMinutes with none: the page drops its stream while it is hidden (web/src/api/
// useBoard.ts), so that is the page shown again. A client that keeps a stream open all day means
// no return is ever seen. Both are marks in journal.db, so a restart in between loses neither.
//
// While config.json has no `journal`, observe returns at the config check: no file, no query.

import type { BoardDb } from '../adapters/db.ts'
import { type JournalStore, journalStore, openJournalDb, type StripMark } from '../adapters/journal-store.ts'
import {
  awaySince,
  diffStates,
  type JournalConfig,
  type JournalList,
  journalConfig,
  journalList,
  KEEP_MS,
  moved,
  type StateRow,
  withRecord,
} from '../core/journal.ts'
import type { JournalPayload } from '../core/payload.ts'
import type { Presence } from '../core/presence.ts'
import type { Config, Item } from '../core/types.ts'

export interface JournalService {
  /** One refresh's items: what moved is recorded, a return noticed. */
  observe(items: readonly Item[]): void
  /** The payload's part; null while the journal is off (or before its first refresh). */
  view(): JournalPayload | null
  /** The list since `since` (ms), up to `until`; null while off. */
  list(since: number, until?: number): JournalList | null
  /** Since when `--away` lists (core/journal.ts awaySince); null: no absence on record, or off. */
  awaySince(): number | null
  /** The strip dismissed (every page's and the phone's); false when none was on show. */
  dismiss(): boolean
  stop(): void
}

interface Options {
  cfg: Pick<Config, 'journal'>
  log: (line: string) => void
  /** Presence on record while it is on in config.json, else null (services/presence.ts view). */
  presence: () => Presence | null
  /** How many live streams the board has now (the page's, the phone's). */
  viewers: () => number
  /** The strip changed out of a refresh (a dismiss): publish the board. */
  onChange?: () => void
  now?: () => number
}

const HOUR = 60 * 60_000

export function createJournal({ cfg, log, presence, viewers, onChange, now = Date.now }: Options): JournalService {
  let db: BoardDb | null = null
  let store: JournalStore | null = null
  let states: Map<string, StateRow> = new Map()
  let strip: StripMark | null = null
  let stripList: JournalList | null = null
  let prunedAt = 0
  let logged = false

  // Everything is read before the store is kept: a read that fails leaves nothing half open, and
  // the next refresh opens it again.
  function open(): JournalStore {
    if (store) return store
    const opened = openJournalDb(true)
    if (!opened) throw new Error('journal.db could not be opened')
    try {
      const s = journalStore(opened)
      const read = s.states()
      const shown = s.strip()
      db = opened
      states = read
      strip = shown
      stripList = null
      prunedAt = 0
      store = s
      return s
    } catch (err) {
      try {
        opened.close()
      } catch {}
      throw err
    }
  }
  function close(): void {
    try {
      db?.close()
    } catch {}
    db = null
    store = null
    states = new Map()
    strip = null
    stripList = null
  }
  function safe<T>(fallback: T, run: () => T): T {
    try {
      const out = run()
      logged = false
      return out
    } catch (err) {
      if (!logged) log(`journal: ${err instanceof Error ? err.message : String(err)}`)
      logged = true
      return fallback
    }
  }

  /**
   * Away or back, as presence or the live streams say; a return long enough sets the strip, unless
   * nothing at all happened meanwhile. A call is the state it was taken from (away stays away), and
   * `back` is never before `left`, so a clock set back cannot leave the owner away for good.
   */
  function notice(c: JournalConfig, s: JournalStore, at: number): void {
    const marks = s.away()
    const away = marks.left !== undefined && (marks.back === undefined || marks.left > marks.back)
    const p = presence()
    let left: number | undefined
    let back: number | undefined
    if (p) {
      const state = p.state === 'call' ? (p.before ?? 'here') : p.state
      const since = p.since || at
      if (state === 'away') {
        // Already away: a call taken and ended meanwhile does not start the absence again.
        if (!away) left = since
      } else if (away) back = since > (marks.left ?? 0) ? since : at
    } else {
      const n = viewers()
      if (n === 0 && !away) left = at
      else if (n > 0 && away) back = at
    }
    if (left !== undefined) s.setMarks({ left })
    if (back === undefined || marks.left === undefined) return
    const from = marks.left
    back = Math.max(back, from + 1)
    const list = back - from >= c.returnMinutes * 60_000 ? listOf(s, from, back) : null
    // No strip for a return where no card moved, even with cards that waited on the owner before.
    const next = list && moved(list) ? { from, to: back, dismissed: false } : undefined
    s.setMarks({ back, ...(next && { strip: next }) })
    if (next) {
      strip = next
      stripList = list
    }
  }
  const listOf = (s: JournalStore, since: number, until?: number): JournalList =>
    withRecord(journalList(s.movesSince(since), states, since, until), s.start() ?? undefined)

  return {
    observe(items) {
      const c = journalConfig(cfg.journal)
      if (!c) {
        if (store) close()
        return
      }
      safe(undefined, () => {
        const s = open()
        const at = now()
        // The first refresh with the journal on notes the cards and sets the start mark, in one
        // transaction: a board with no cards then still records the first session started later.
        const seed = s.start() === null
        const { moves, states: changed, renames } = diffStates(states, items, at, seed)
        if (seed || moves.length || changed.size || renames.length) {
          s.record(moves, changed, { renames, ...(seed && { start: at }) })
          for (const [from] of renames) states.delete(from)
          for (const [key, state] of changed) states.set(key, state)
        }
        if (at - prunedAt >= HOUR) {
          prunedAt = at
          if (s.prune(at - KEEP_MS)) states = s.states()
        }
        notice(c, s, at)
      })
    },
    view() {
      if (!journalConfig(cfg.journal) || !store) return null
      if (!strip) return { strip: null, last: null }
      const { from, to, dismissed } = strip
      if (!dismissed && !stripList) {
        const s = store
        stripList = safe(null, () => listOf(s, from, to))
      }
      return { strip: !dismissed && stripList ? { ...stripList, from, to } : null, last: { from, to } }
    },
    list(since, until) {
      if (!journalConfig(cfg.journal)) return null
      return safe(null, () => {
        return listOf(open(), since, until)
      })
    },
    awaySince() {
      if (!journalConfig(cfg.journal)) return null
      return safe(null, () => awaySince(presence(), open().away()))
    },
    dismiss() {
      if (!journalConfig(cfg.journal) || !store || !strip || strip.dismissed) return false
      const next = { ...strip, dismissed: true }
      const s = store
      const ok = safe(false, () => {
        s.setMarks({ strip: next })
        return true
      })
      if (!ok) return false
      strip = next
      onChange?.()
      return true
    },
    stop: close,
  }
}
