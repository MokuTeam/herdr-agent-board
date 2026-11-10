// The owner hears of the team's messages (#355): a desktop notification for each new one (the
// sender as this board knows them, the start of the text), and the count of unread messages the
// head shows, which a thread loses when the owner opens it. Only what came to this board, and
// nothing from a muted thread (#216's mute of a thread, or of the whole team chat). Made by the web
// board for the team service's inbound hook; with no `team` it is never asked, so it reads and
// writes nothing.
import { markRead, readReads } from '../adapters/team-reads.ts'
import { readAgents, readAllInbox, readInbox, readThreads } from '../adapters/team-store.ts'
import { t as boardT } from '../core/lang.ts'
import { splitKey, TEAM, threadKey } from '../core/team-agents.ts'
import { type Incoming, toastBody, unreadByThread } from '../core/team-unread.ts'
import { GENERAL } from '../core/team-wire.ts'
import type { Translator } from '../core/types.ts'
import type { TeamDesktop } from '../integrations/team-toast.ts'
import type { InboundEvent } from './team-hub.ts'

export interface TeamNotifyOptions {
  desktop: TeamDesktop
  /** The name this board knows a peer by (its roster, its pins): never a message's own word. */
  nameOf: (peer: string) => string
  /**
   * Which threads are muted as things stand: asked once per count and once per message, so the
   * files behind it are read once each time. A muted thread raises nothing and counts nothing.
   * By default the board's own (storeMutes).
   */
  mutes?: () => (thread: string) => boolean
  /** A topic thread's title as this board keeps it (the words of whoever started it); null: none. By default team-threads.json's. */
  titleOf?: (thread: string) => string | null
  /** The board's language by default. */
  t?: Translator
  now?: () => number
}

export interface TeamNotify {
  /** A message came in and was kept: its notification, and the count moves. */
  inbound(e: InboundEvent): void
  /** The unread messages of all threads, for the head. */
  unread(): number
  /** Each thread's unread messages, for the panel. */
  unreadByThread(): Record<string, number>
  /** The owner opened `thread`: read up to now. */
  read(thread: string): void
  /** The team changed some other way (a message trimmed, a mute): the count is read again. */
  changed(): void
}

/** Every message that came in, by its thread (what came before threads: that pair's general). */
function incoming(): Incoming[] {
  const out: Incoming[] = []
  for (const [peer, items] of Object.entries(readAllInbox()))
    for (const i of items) out.push({ thread: i.thread ?? threadKey(peer, GENERAL), at: i.receivedAt })
  return out
}

/** The mutes as the board keeps them (#216): a thread's own, and the team chat's for each team thread. */
export function storeMutes(): (thread: string) => boolean {
  const threads = readThreads()
  const team = readAgents().peers[TEAM]?.muted === true
  return key => (Object.hasOwn(threads, key) && threads[key]?.muted === true) || (team && splitKey(key)?.scope === TEAM)
}

/** How long a topic's title is on a notification's small line, at most. */
const MAX_LABEL = 60

export function createTeamNotify(o: TeamNotifyOptions): TeamNotify {
  const now = o.now ?? Date.now
  const mutes = o.mutes ?? storeMutes
  const titleOf =
    o.titleOf ??
    ((key: string) => {
      const all = readThreads()
      return Object.hasOwn(all, key) ? (all[key]?.title ?? null) : null
    })
  const t = o.t ?? boardT
  // The notification's small line: a topic by its title, the team's chat, or a pair's general.
  const labelOf = (thread: string): string => {
    const parts = splitKey(thread)
    const title = parts && parts.id !== GENERAL ? titleOf(thread) : null
    if (title) return toastBody(title, MAX_LABEL)
    return parts?.scope === TEAM ? t('team.chat') : t('team.title')
  }
  // The count is read from the files only when something changed it: the payload asks often.
  let cached: { all: number; by: Record<string, number> } | null = null
  const counts = () => {
    if (cached) return cached
    const reads = readReads(now())
    const list = incoming()
    const muted = mutes()
    const by = unreadByThread(list, reads, muted)
    cached = { all: Object.values(by).reduce((a, b) => a + b, 0), by }
    return cached
  }
  return {
    inbound(e) {
      cached = null
      if (mutes()(e.thread)) return
      const text = e.held ? null : (readInbox(e.from).find(i => i.id === e.id)?.text ?? null)
      o.desktop.show({
        id: e.id,
        thread: e.thread,
        title: o.nameOf(e.from),
        body: text === null ? t('team.toast.held') : toastBody(text),
        label: labelOf(e.thread),
      })
    },
    unread: () => counts().all,
    unreadByThread: () => ({ ...counts().by }),
    read(thread) {
      markRead(thread, now())
      cached = null
    },
    changed() {
      cached = null
    },
  }
}
