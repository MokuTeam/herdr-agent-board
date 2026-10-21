// The Telegram router's decisions, kept apart from its loop so they can be tested: which pane a
// topic's messages go to, and the prompt they are typed in as. A port of herdr-wake's route.mjs.
// Pure: the caller hands in herdr's snapshot and the sessions last seen in each pane.
import { type TopicSnapshot, tabKeys } from './topics.ts'

/** A message tg-mcp's router queue hands out (`/router/wait`). */
export interface RouteItem {
  key: string
  pane?: string
  live_panes?: string[]
  topic?: string
  text?: string
  meta?: Record<string, string | undefined>
  queued_at?: string
  id?: number | string
}

/** Where a topic's messages go: a running Claude, or a pane whose last session is resumed first. */
export interface RouteTarget {
  pane: string
  title: string
  session?: string
}

type RoutePane = {
  pane_id: string
  tab_id?: string
  agent?: string | null
  cwd?: string
  terminal_title_stripped?: string
}

/** A path in a comparable form: one kind of slash, no trailing slash, case-insensitive with a drive letter. */
export function samePath(p: unknown): string {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
}

/** Sessions send X-Herdr-Pane as "<machine>:<pane id>"; a hint from another machine is no use here. */
export function localPane(hint: string | null | undefined, machine: string): string | null {
  if (!hint) return null
  const parts = hint.split(':')
  if (parts.length < 3) return hint // a bare pane id such as "w1:p2"
  return (parts[0] ?? '').toLowerCase() === machine.toLowerCase() ? parts.slice(1).join(':') || null : null
}

/**
 * The pane for a message: a running Claude first, else a pane whose last session can be
 * resumed. Candidates in order: the server's hints (the pane behind the bot message the user
 * replied to, panes connected for the key), then the panes of the tab the key names, most
 * recently active Claude first. `known` maps pane id -> last session seen there.
 */
export function resolve(
  item: RouteItem,
  snap: TopicSnapshot & {
    panes: RoutePane[]
    agents?: { pane_id: string; state_change_seq?: number }[]
  },
  known: Readonly<Record<string, { session: string; title?: string }>>,
  machine: string,
): RouteTarget | null {
  const all: readonly RoutePane[] = snap.panes
  const panes = new Map(all.map(p => [p.pane_id, p]))
  const seq = new Map((snap.agents ?? []).map(a => [a.pane_id, a.state_change_seq ?? 0]))
  const order: string[] = []
  const add = (id: string | null | undefined) => {
    if (id && panes.has(id) && !order.includes(id)) order.push(id)
  }
  add(localPane(item.pane, machine))
  for (const hint of item.live_panes ?? []) add(localPane(hint, machine))
  // The key names a herdr tab (the launcher in tg-mcp's README) or, by default, a working directory.
  const tabs = tabKeys(snap).get(item.key) ?? []
  const dir = samePath(item.key)
  const isClaude = (p: RoutePane) => Number(p.agent === 'claude')
  const inKey = all
    .filter(p => (p.tab_id !== undefined && tabs.includes(p.tab_id)) || (p.cwd && samePath(p.cwd) === dir))
    .sort((a, b) => isClaude(b) - isClaude(a) || (seq.get(b.pane_id) ?? 0) - (seq.get(a.pane_id) ?? 0))
  for (const p of inKey) add(p.pane_id)

  const live = order.find(id => panes.get(id)?.agent === 'claude')
  if (live) return { pane: live, title: panes.get(live)?.terminal_title_stripped || '' }
  const resumable = order.find(id => known[id] && !panes.get(id)?.agent)
  const last = resumable ? known[resumable] : undefined
  if (resumable && last) return { pane: resumable, session: last.session, title: last.title ?? '' }
  return null
}

/** One prompt for a topic's messages; it starts with "[telegram ...]", as tg-mcp tells agents. */
export function formatPrompt(items: readonly RouteItem[], now: number = Date.now()): string {
  return items
    .map(it => {
      const meta = it.meta ?? {}
      const attrs: Record<string, string | undefined> = { message_id: meta.message_id }
      for (const k of ['file_id', 'file_kind', 'file_name', 'in_reply_to']) if (meta[k]) attrs[k] = meta[k]
      if (now - Date.parse(it.queued_at ?? '') > 120_000) attrs.queued_at = it.queued_at
      const head = Object.entries(attrs)
        .map(([k, v]) => (/^[\w.:+-]+$/.test(String(v)) ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`))
        .join(' ')
      return `[telegram ${head}]\n${it.text}`
    })
    .join('\n\n')
}
