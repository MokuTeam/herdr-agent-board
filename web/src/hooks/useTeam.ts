// The Team panel's view (GET /api/team, local only), the thread with the selected peer (GET
// /api/team/thread/<peer>) and its two changes (POST /api/team/send { to, text }, POST
// /api/team/trust { peer }), and an agent's drafts (POST /api/team/draft/<id>/send or /discard). As Remote access (hooks/useAccess.ts), the payload carries only
// `teamRev`: the view is fetched when the panel opens and again whenever that number changes while
// it is open. Nothing is asked while the panel is closed, or without `teamRev` (offersTeam).
import { useEffect, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { isTeamView, isThread, offersTeam, sendError, type TeamView, type ThreadMessage } from '../models/team.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** What the panel draws. */
export interface TeamNow {
  view: TeamView | null
  /** The peer whose thread is on show, and its messages. */
  peer: string | null
  thread: ThreadMessage[]
}

export interface TeamSource {
  now: Store<TeamNow>
  select(peer: string | null): void
  /** true: sent (kept at the hub's door, delivery follows); false: refused, and toasted. */
  send(to: string, text: string): Promise<boolean>
  trust(peer: string): Promise<void>
  /** Sends an agent's draft (it goes marked as an agent request); false: refused, and toasted. */
  sendDraft(id: string): Promise<boolean>
  discardDraft(id: string): Promise<void>
  /** The panel open or not, and the payload's teamRev: fetched on opening and on each new revision while open. */
  sync(open: boolean, rev: number): void
}

export interface TeamDeps {
  t(): Translator
  toast(text: string, error?: boolean): void
}

/** The view and the thread, without React: useTeam draws from it. */
export function teamSource(deps: TeamDeps): TeamSource {
  const now = new Store<TeamNow>({ view: null, peer: null, thread: [] })
  let open = false
  let rev = 0
  // Only the latest fetch is drawn: an older one may come back after it.
  let asked = 0

  async function load(): Promise<void> {
    const mine = ++asked
    try {
      const view = await api.get('/api/team', isTeamView, { cache: 'no-store' })
      const peer = now.get().peer
      const thread = peer
        ? (await api.get(`/api/team/thread/${encodeURIComponent(peer)}`, isThread, { cache: 'no-store' })).messages
        : []
      if (mine === asked) now.set({ ...now.get(), view, thread })
    } catch (err) {
      if (mine === asked) deps.toast(errorText(err, deps.t()), true)
    }
  }

  return {
    now,
    select(peer) {
      now.set({ ...now.get(), peer, thread: [] })
      if (open) void load()
    },
    async send(to, text) {
      try {
        await api.post('/api/team/send', { to, text })
      } catch (err) {
        deps.toast(sendError(err instanceof ApiError ? err.reply.error : undefined, deps.t()), true)
        return false
      }
      void load()
      return true
    },
    async trust(peer) {
      try {
        await api.post('/api/team/trust', { peer })
      } catch (err) {
        deps.toast(errorText(err, deps.t()), true)
      }
      void load()
    },
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
    async discardDraft(id) {
      try {
        await api.post(`/api/team/draft/${encodeURIComponent(id)}/discard`, {})
      } catch (err) {
        deps.toast(errorText(err, deps.t()), true)
      }
      void load()
    },
    sync(nextOpen, nextRev) {
      if (nextOpen && (!open || nextRev !== rev)) void load()
      open = nextOpen
      rev = nextRev
    },
  }
}

/** The panel's view and thread while `open`, and how to change them. Idle on a page that does not offer Team. */
export function useTeam(
  open: boolean,
): TeamNow & Pick<TeamSource, 'select' | 'send' | 'trust' | 'sendDraft' | 'discardDraft'> {
  const t = useT()
  const { data, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [source] = useState(() =>
    teamSource({ t: () => latest.current.t, toast: (text, error) => latest.current.toast(text, error) }),
  )
  const state = useStore(source.now)
  const offered = offersTeam(data)
  const rev = data?.teamRev ?? 0
  useEffect(() => source.sync(open && offered, rev), [source, open, offered, rev])
  return {
    ...state,
    select: source.select,
    send: source.send,
    trust: source.trust,
    sendDraft: source.sendDraft,
    discardDraft: source.discardDraft,
  }
}
