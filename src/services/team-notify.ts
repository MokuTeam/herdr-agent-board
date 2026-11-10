// The owner hears of the team's messages (#355): a desktop notification for each new one (the
// sender as this board knows them, the start of the text), and the count of unread messages the
// head shows, which a thread loses when the owner opens it. Only what came to this board, and
// nothing from a muted thread. Made by the web board for the team service's inbound hook; with no
// `team` it is never asked, so it reads and writes nothing.
import { markRead, readReads } from '../adapters/team-reads.ts'
import { readAllInbox, readInbox } from '../adapters/team-store.ts'
import { t as boardT } from '../core/lang.ts'
import { type Incoming, toastBody, unreadByThread, unreadCount } from '../core/team-unread.ts'
import type { Translator } from '../core/types.ts'
import type { TeamDesktop } from '../integrations/team-toast.ts'
import type { InboundEvent } from './team-hub.ts'

export interface TeamNotifyOptions {
  desktop: TeamDesktop
  /** The name this board knows a peer by (its roster, its pins): never a message's own word. */
  nameOf: (peer: string) => string
  /** A muted thread raises nothing and counts nothing (#216's mute; none before it). */
  muted?: (thread: string) => boolean
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

/** Every message that came in, by its thread (a pair's thread without a topic until #216 gives them topics). */
function incoming(): Incoming[] {
  const out: Incoming[] = []
  for (const [peer, items] of Object.entries(readAllInbox()))
    for (const i of items) out.push({ thread: `${peer}/general`, at: i.receivedAt })
  return out
}

export function createTeamNotify(o: TeamNotifyOptions): TeamNotify {
  const now = o.now ?? Date.now
  const muted = o.muted ?? (() => false)
  const t = o.t ?? boardT
  // The count is read from the files only when something changed it: the payload asks often.
  let cached: { all: number; by: Record<string, number> } | null = null
  const counts = () => {
    if (cached) return cached
    const reads = readReads(now())
    const list = incoming()
    cached = { all: unreadCount(list, reads, muted), by: unreadByThread(list, reads, muted) }
    return cached
  }
  return {
    inbound(e) {
      cached = null
      if (muted(e.thread)) return
      const text = e.held ? null : (readInbox(e.from).find(i => i.id === e.id)?.text ?? null)
      o.desktop.show({
        id: e.id,
        thread: e.thread,
        title: o.nameOf(e.from),
        body: text === null ? t('team.toast.held') : toastBody(text),
        label: t('team.title'),
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
