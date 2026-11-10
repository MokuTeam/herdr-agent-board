// The Team panel's data: the view (GET /api/team), the threads (GET /api/team/threads, #216), the
// thread on show (GET /api/team/threads/<scope>/<id>) and the owner's agent switches (GET
// /api/team/agents, on this computer only: a remote page never asks). Its changes: a message or a
// new topic (POST /api/team/send { to, text, thread? }), Trust (POST /api/team/trust { peer }), an
// agent's drafts (POST /api/team/draft/<id>/send or /discard), a thread's mute (POST
// /api/team/threads/<scope>/<id>/mute or /unmute) and the switches with the team chat's mute (POST
// /api/team/agents). As Remote access (hooks/useAccess.ts), the payload carries only `teamRev`: all
// of it is fetched when the panel opens and again whenever that number changes while it is open.
// Nothing is asked while the panel is closed, or without `teamRev` (offersTeam).
// Each thread's unread messages (GET /api/team/unread, #355) come with it while the payload's count
// is above 0; the thread on show in a page in front is read (POST /api/team/read { thread }), which
// takes it off the head's count.
import { useEffect, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { remotePage } from '../models/remote-page.ts'
import {
  type AgentsChange,
  type AgentsView,
  isAgentsView,
  isTeamView,
  isThreadLines,
  isThreadList,
  isUnread,
  keyParts,
  offersTeam,
  sendError,
  type TeamView,
  type ThreadLine,
  type ThreadView,
} from '../models/team.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** What the panel draws. */
export interface TeamNow {
  view: TeamView | null
  threads: ThreadView[]
  /** The key of the thread on show (`<peer>/general`, `team/<id>`...); null: the list. */
  selected: string | null
  /** The thread on show as the board keeps it; null while nothing was written in it yet. */
  thread: ThreadView | null
  lines: ThreadLine[]
  /** Each thread's unread messages, by its key. */
  unread: Record<string, number>
  /** The owner's switches; null on a remote page, which may not change them. */
  agents: AgentsView | null
}

/** A new topic: its title and an optional link (http or https). */
export interface NewTopic {
  title: string
  link?: string
}

export interface TeamSource {
  now: Store<TeamNow>
  /** A thread to show by its key, or null for the list. */
  select(key: string | null): void
  /**
   * Writes in the thread on show, or starts a topic in its scope: true when sent (kept at the hub's
   * door, delivery follows), and a new topic is then the thread on show; false: refused, and toasted.
   */
  send(text: string, topic?: NewTopic): Promise<boolean>
  trust(peer: string): Promise<void>
  /** Sends an agent's draft (it goes marked as an agent request); false: refused, and toasted. */
  sendDraft(id: string): Promise<boolean>
  discardDraft(id: string): Promise<void>
  /** Mutes a thread or lets it be heard again. */
  mute(key: string, muted: boolean): Promise<void>
  /** One change of the owner's switches (the team chat's mute among them). */
  setAgents(change: AgentsChange): Promise<void>
  /**
   * The panel open or not, the payload's teamRev and its unread count: fetched on opening and on
   * each new revision or count while open.
   */
  sync(open: boolean, rev: number, unread?: number): void
}

export interface TeamDeps {
  t(): Translator
  toast(text: string, error?: boolean): void
  /** The page is in front: what is on show there is read. */
  visible?(): boolean
  /** The page is the remote one (a phone, the domain): the switches are not asked for. */
  remote?(): boolean
}

const inFront = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'

const EMPTY: TeamNow = {
  view: null,
  threads: [],
  selected: null,
  thread: null,
  lines: [],
  unread: {},
  agents: null,
}

/** The panel's data without React: useTeam draws from it. */
export function teamSource(deps: TeamDeps): TeamSource {
  const now = new Store<TeamNow>(EMPTY)
  let open = false
  let rev = 0
  let unreadTotal = 0
  const visible = deps.visible ?? inFront
  const remote = deps.remote ?? remotePage
  // Only the latest fetch is drawn: an older one may come back after it.
  let asked = 0

  async function shown(key: string | null): Promise<{ thread: ThreadView | null; lines: ThreadLine[] }> {
    if (!key) return { thread: null, lines: [] }
    try {
      return await api.get(`/api/team/threads/${key.split('/').map(encodeURIComponent).join('/')}`, isThreadLines, {
        cache: 'no-store',
      })
    } catch (err) {
      // Nothing written in it yet (a person's general before the first message): an empty thread.
      if (err instanceof ApiError && err.status === 404) return { thread: null, lines: [] }
      throw err
    }
  }

  async function load(): Promise<void> {
    const mine = ++asked
    try {
      const view = await api.get('/api/team', isTeamView, { cache: 'no-store' })
      const { threads } = await api.get('/api/team/threads', isThreadList, { cache: 'no-store' })
      const selected = now.get().selected
      const { thread, lines } = await shown(selected)
      const agents = remote() ? null : await api.get('/api/team/agents', isAgentsView, { cache: 'no-store' })
      // Each thread's count, asked only while the payload says something is unread.
      const unread =
        unreadTotal > 0 ? { ...(await api.get('/api/team/unread', isUnread, { cache: 'no-store' })).threads } : {}
      // The thread on show, in a page in front, is read: its messages leave the count.
      if (selected && (unread[selected] ?? 0) > 0 && visible()) {
        await api.post('/api/team/read', { thread: selected })
        delete unread[selected]
      }
      if (mine === asked) now.set({ ...now.get(), view, threads, thread, lines, agents, unread })
    } catch (err) {
      if (mine === asked) deps.toast(errorText(err, deps.t()), true)
    }
  }

  /** A POST whose refusal is toasted; the panel is fetched again either way. */
  async function change(path: string, body: unknown): Promise<void> {
    try {
      await api.post(path, body)
    } catch (err) {
      deps.toast(errorText(err, deps.t()), true)
    }
    void load()
  }

  return {
    now,
    select(key) {
      now.set({ ...now.get(), selected: key, thread: null, lines: [] })
      if (open) void load()
    },
    async send(text, topic) {
      const parts = keyParts(now.get().selected ?? '')
      if (!parts) return false
      const thread = topic
        ? { title: topic.title, ...(topic.link && { link: topic.link }) }
        : parts.id === 'general'
          ? undefined
          : { id: parts.id }
      let key: unknown
      try {
        key = (await api.post('/api/team/send', { to: parts.scope, text, ...(thread && { thread }) })).thread
      } catch (err) {
        deps.toast(sendError(err instanceof ApiError ? err.reply.error : undefined, deps.t()), true)
        return false
      }
      if (topic && typeof key === 'string') now.set({ ...now.get(), selected: key, thread: null, lines: [] })
      void load()
      return true
    },
    trust: peer => change('/api/team/trust', { peer }),
    async sendDraft(id) {
      try {
        await api.post(`/api/team/draft/${encodeURIComponent(id)}/send`, {})
      } catch (err) {
        deps.toast(sendError(err instanceof ApiError ? err.reply.error : undefined, deps.t()), true)
        void load()
        return false
      }
      void load()
      return true
    },
    discardDraft: id => change(`/api/team/draft/${encodeURIComponent(id)}/discard`, {}),
    mute(key, muted) {
      const parts = keyParts(key)
      if (!parts) return Promise.resolve()
      const path = `/api/team/threads/${encodeURIComponent(parts.scope)}/${encodeURIComponent(parts.id)}`
      return change(`${path}/${muted ? 'mute' : 'unmute'}`, {})
    },
    setAgents: c => change('/api/team/agents', c),
    sync(nextOpen, nextRev, nextUnread = 0) {
      const ask = nextOpen && (!open || nextRev !== rev || nextUnread !== unreadTotal)
      open = nextOpen
      rev = nextRev
      unreadTotal = nextUnread
      if (ask) void load()
    },
  }
}

/** The panel's data while `open`, and how to change it. Idle on a page that does not offer Team. */
export function useTeam(open: boolean): TeamNow & Omit<TeamSource, 'now' | 'sync'> {
  const t = useT()
  const { data, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [source] = useState(() =>
    teamSource({ t: () => latest.current.t, toast: (text, error) => latest.current.toast(text, error) }),
  )
  const state = useStore(source.now)
  const offered = offersTeam(data)
  const rev = data?.teamRev ?? 0
  const unread = data?.teamUnread ?? 0
  useEffect(() => source.sync(open && offered, rev, unread), [source, open, offered, rev, unread])
  return {
    ...state,
    select: source.select,
    send: source.send,
    trust: source.trust,
    sendDraft: source.sendDraft,
    discardDraft: source.discardDraft,
    mute: source.mute,
    setAgents: source.setAgents,
  }
}
