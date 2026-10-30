// Who works with whom among the board's sessions, from what their transcripts recorded:
//   spawn      the session ran spawn-agent, which printed "pane=<id> name=<name>" for the
//              session it started
//   sent       it called SendMessage with another session's name
//   received   another session's message came in (Claude Code records the sender's name and
//              its message pipe with it)
//   fork       it is a fork of another session: its transcript starts with a copy of that one's
//              conversation, whose calls and messages are the other session's, not this one's.
//              Claude Code marks each copied line `forkedFrom` in some versions; in others the
//              copies keep only their time, older than the fork: the board's forks say on their
//              card whose fork they are and since when (forkCard), and older events are left out
//   prompted   it ran a herdr command that types into another pane (`herdr agent prompt <target>`,
//              `pane send-text <pane>`, …): for the edge log only, the board's links leave it out
// Pure: adapters/links.ts reads the transcripts' lines in the background.
import { promptsOf, spawnResults, spawnsOf } from './transcript-links.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = (s: unknown): string =>
  String(s ?? '')
    .split('\n')
    .find(l => l.trim())
    ?.trim() ?? ''

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

export type LinkEvent =
  | { kind: 'spawn'; name: string; pane: string; at: number }
  | { kind: 'fork'; of: string; at: number }
  | { kind: 'sent'; to: string; name: string; summary: string; at: number }
  | { kind: 'received'; name: string; pipe: string; id: string; text: string; at: number }
  | { kind: 'prompted'; target: string; verb: string; at: number }

/** What a transcript's lines carry over to later ones (lineEvents). */
export interface LinkState {
  /** spawn-agent calls waiting for what they printed: the names each spawn-agent in the call gave. */
  pending: Map<string, { names: string[]; at: number }>
  /** Calls and messages seen already. */
  seen: Set<string>
  /** A sender's message pipe -> its name. */
  pipes: Map<string, string>
  /** Agents the session named, and its teammates. */
  agents: Set<string>
  /** The session it is a fork of, once a copied line said so. */
  forkOf?: string
}

/** What a fork's card says before its Claude starts: whose fork it is, and since when. */
export const forkCard = (of: string, now = Date.now()): { forkOf: string; forkAt: number } => ({
  forkOf: of,
  forkAt: now,
})

export const newState = (): LinkState => ({ pending: new Map(), seen: new Set(), pipes: new Map(), agents: new Set() })

// A line a fork copied from its source, as Claude Code writes it: `"forkedFrom":{"sessionId":…}`
// (in a message's text the quotes would be escaped).
const FORKED = /"forkedFrom":\{"sessionId":"([0-9a-f-]{36})"/
const TIMESTAMP = /"timestamp":"([^"]+)"/

function received(origin: Rec, at: number, state: LinkState): LinkEvent | null {
  const id = String(origin.msg_id ?? '')
  if (id && state.seen.has(id)) return null
  if (id) state.seen.add(id)
  const name = String(origin.name ?? '').slice(0, 120)
  const pipe = String(origin.from ?? '').slice(0, 300)
  if (!name && !pipe) return null
  if (pipe && name) state.pipes.set(pipe, name)
  return { kind: 'received', name, pipe, id, text: clip(firstLine(origin.body), 200), at }
}

/**
 * The events in one transcript line: [{ kind: 'spawn', name, pane, at } | { kind: 'sent', to,
 * summary, at } | { kind: 'received', name, pipe, id, text, at } | { kind: 'prompted', target,
 * verb, at }]. `summary`: the one SendMessage gave, never the message. `state` carries what a later
 * line completes (a spawn-agent call waits for its output) and what was seen already (a call is
 * recorded twice when a request is logged with it).
 */
export function lineEvents(line: string, state: LinkState): LinkEvent[] {
  // A copied line is the source's: only the first one counts, for whose fork this is.
  const copied = FORKED.exec(line)
  if (copied) {
    if (state.forkOf) return []
    state.forkOf = copied[1] ?? ''
    return [{ kind: 'fork', of: state.forkOf, at: Date.parse(TIMESTAMP.exec(line)?.[1] ?? '') || 0 }]
  }
  const o = parse(line)
  if (!o || o.isSidechain || !['user', 'assistant', 'attachment'].includes(str(o.type))) return []
  const at = Date.parse(str(o.timestamp)) || 0
  const events = (...list: (LinkEvent | null)[]): LinkEvent[] => list.filter((e): e is LinkEvent => !!e)
  if (o.type === 'attachment') {
    const a = rec(o.attachment)
    const origin = rec(a?.origin)
    if (a?.type === 'queued_command' && origin?.kind === 'peer')
      return events(received(origin, Date.parse(str(a.timestamp)) || at, state))
    return []
  }
  const origin = rec(o.origin)
  if (o.type === 'user' && origin?.kind === 'peer') return events(received(origin, at, state))
  const content = rec(o.message)?.content
  const out: LinkEvent[] = []
  for (const raw of Array.isArray(content) ? content : []) {
    const b = rec(raw)
    if (o.type === 'assistant' && b?.type === 'tool_use') {
      const id = str(b.id)
      if (state.seen.has(id)) continue
      state.seen.add(id)
      const input = rec(b.input)
      // Agents it starts by name, and its teammates: a message to one of them is not to a session.
      if ((b.name === 'Agent' || b.name === 'Task') && typeof input?.name === 'string') state.agents.add(input.name)
      if (b.name === 'SendMessage' && typeof input?.to === 'string' && typeof input.message === 'string') {
        const to = input.to
          .replace(/\s*\[[^\]]*\]\s*$/, '')
          .trim()
          .slice(0, 300)
        if (to === '*' || ['main', 'team-lead'].includes(to) || state.agents.has(to)) continue
        // A reply to the pipe a message came from: the sender's name, for when that pipe is gone.
        out.push({
          kind: 'sent',
          to,
          name: state.pipes.get(to) ?? '',
          summary: clip(typeof input.summary === 'string' ? input.summary : '', 200),
          at,
        })
        continue
      }
      // Only a command that names herdr is read for one that types into another pane.
      for (const p of promptsOf(str(b.name), input)) out.push({ kind: 'prompted', ...p, at })
      const spawns = spawnsOf(str(b.name), input)
      if (spawns.length) state.pending.set(id, { names: spawns.map(s => s.name), at })
    } else if (o.type === 'user' && b?.type === 'tool_result' && state.pending.has(str(b.tool_use_id))) {
      const call = state.pending.get(str(b.tool_use_id))
      state.pending.delete(str(b.tool_use_id))
      const text =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map(c => rec(c)?.text ?? '').join('\n')
            : ''
      // Every session the call started, by the name spawn-agent printed for it (else the one it gave).
      if (call && !b.is_error)
        out.push(
          ...spawnResults(text).map(
            (r, i): LinkEvent => ({
              kind: 'spawn',
              name: r.name || (call.names[i] ?? ''),
              pane: r.pane,
              at: call.at,
            }),
          ),
        )
    }
  }
  return out
}

/** A board item as the links see it. */
export interface LinkItem {
  key: string
  /** Its Claude session id: a fork names its source by it. */
  session?: string | null
  /** A fork's card: the session it is a fork of, and when it started. */
  fork?: { of: string; at: number } | null
  name: string
  autoName?: string
  pane?: string | null
  /** Panes it had before, closed by wake as it went to sleep (#204): its card's `panes`. */
  formerPanes?: string[]
  /** The message pipe its Claude process listens on, while it runs. */
  pipe?: string
}

/** Whether the item is the one in `pane`: its pane now, or one wake closed as it went to sleep (#204). */
export const inPane = (it: Pick<LinkItem, 'pane' | 'formerPanes'>, pane: string): boolean =>
  !!pane && (it.pane === pane || !!it.formerPanes?.includes(pane))

export interface SessionRef {
  key: string
  name: string
  at: number
  /** A fork: it started with a copy of the other one's conversation. */
  fork?: true
}
/** Messages with one other session: how many came in, how many went out, the latest. */
export interface Talk extends SessionRef {
  in: number
  out: number
}
/** How a session works with the others on the board. */
export interface ItemLinks {
  /** The session that started it. */
  from: SessionRef | null
  /** The sessions it started, newest first. */
  started: SessionRef[]
  /** The sessions it wrote with, latest first. */
  talks: Talk[]
}

// As web/src/models/helper-model.ts matches names: keep the two alike.
const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The item at an event's other end, among `items`, for the session `self` whose event it is: null
 * when none is, or the session itself. A started session is matched by its pane (or one it had
 * before wake closed it, #204) and the name spawn-agent gave it (a pane id is used again once its
 * tab is gone); a fork's source by its session id; a message's other end by its pipe while that
 * session runs, else by its name when exactly one session on the board has it; a pane herdr typed
 * into by the session in it now, else the target as a name.
 */
export function ends<T extends LinkItem>(
  items: readonly T[],
): (self: Pick<LinkItem, 'key'>, ev: LinkEvent) => T | null {
  const names = (it: T) => new Set([it.name, it.autoName].filter(Boolean).map(norm))
  const byName = new Map<string, T[]>()
  for (const it of items) for (const n of names(it)) if (n) byName.set(n, [...(byName.get(n) ?? []), it])
  const byPipe = new Map(items.filter(it => it.pipe).map(it => [String(it.pipe).replace(/^uds:/, ''), it]))
  const one = (name: string, self: Pick<LinkItem, 'key'>): T | null => {
    // A name with no letters or digits (a broadcast "*", an emoji) names no one.
    if (!norm(name)) return null
    const list = (byName.get(norm(name)) ?? []).filter(it => it.key !== self.key)
    return list.length === 1 ? (list[0] ?? null) : null
  }
  const other = (self: Pick<LinkItem, 'key'>, ev: LinkEvent): T | null | undefined => {
    switch (ev.kind) {
      case 'spawn':
        return items.find(it => it.key !== self.key && inPane(it, ev.pane) && names(it).has(norm(ev.name)))
      case 'fork':
        return items.find(it => it.key !== self.key && (it.session === ev.of || it.key === ev.of))
      case 'sent':
        // A reply goes to the pipe the message came from.
        return ev.to.startsWith('uds:') ? (byPipe.get(ev.to.slice(4)) ?? one(ev.name, self)) : one(ev.to, self)
      case 'received':
        return byPipe.get(ev.pipe.replace(/^uds:/, '')) ?? one(ev.name, self)
      case 'prompted':
        return (ev.target && items.find(it => it.pane === ev.target)) || one(ev.target, self)
    }
  }
  return (self, ev) => {
    const b = other(self, ev)
    return b && b.key !== self.key ? b : null
  }
}

/** Whether an event is the item's own: a fork's from before it started are its source's, copied. */
export const isOwn = (item: Pick<LinkItem, 'fork'> | null, ev: LinkEvent): boolean =>
  !item?.fork || ev.kind === 'fork' || ev.at >= item.fork.at

/** An item's own events (isOwn), and for a fork whose transcript does not say so yet, what its card says. */
export function ownEvents(item: Pick<LinkItem, 'fork'>, read: readonly LinkEvent[]): readonly LinkEvent[] {
  const own = item.fork
  const mine = read.filter(ev => isOwn(item, ev))
  return own?.of && !mine.some(ev => ev.kind === 'fork') ? [...mine, { kind: 'fork', of: own.of, at: own.at }] : mine
}

/**
 * The links between the board's items, from each one's events (`eventsOf(item)`): by key,
 * { from: { key, name, at } | null, started: [{ key, name, at }], talks: [{ key, name, in, out,
 * at }] }, each event's other end as `ends` finds it. Prompts are not links.
 */
export function relate<T extends LinkItem>(
  items: readonly T[],
  eventsOf: (item: T) => readonly LinkEvent[] | undefined,
): Map<string, ItemLinks> {
  const end = ends(items)
  const out = new Map<string, ItemLinks>(items.map(it => [it.key, { from: null, started: [], talks: [] }]))
  const linksOf = (key: string): ItemLinks => {
    const links = out.get(key)
    if (!links) throw new Error(`no item ${key}`)
    return links
  }
  const talk = (a: T, b: T, dir: 'in' | 'out', at: number) => {
    const links = linksOf(a.key)
    let t = links.talks.find(x => x.key === b.key)
    if (!t) {
      t = { key: b.key, name: b.name, in: 0, out: 0, at: 0 }
      links.talks.push(t)
    }
    t[dir]++
    t.at = Math.max(t.at, at)
  }
  for (const a of items) {
    for (const ev of ownEvents(a, eventsOf(a) ?? [])) {
      if (ev.kind === 'prompted') continue
      const b = end(a, ev)
      if (!b) continue
      if (ev.kind === 'spawn') {
        const mine = linksOf(a.key).started
        const prev = mine.find(x => x.key === b.key)
        if (prev) prev.at = Math.max(prev.at, ev.at)
        else mine.push({ key: b.key, name: b.name, at: ev.at })
        const theirs = linksOf(b.key)
        // Started again in the same pane under the same name: the latest start counts. A fork is
        // the session it is a fork of's, whoever started it.
        if (!theirs.from || (!theirs.from.fork && theirs.from.at <= ev.at))
          theirs.from = { key: a.key, name: a.name, at: ev.at }
      } else if (ev.kind === 'fork') {
        linksOf(a.key).from = { key: b.key, name: b.name, at: ev.at, fork: true }
        const theirs = linksOf(b.key).started
        if (!theirs.some(x => x.key === a.key)) theirs.push({ key: a.key, name: a.name, at: ev.at, fork: true })
      } else talk(a, b, ev.kind === 'sent' ? 'out' : 'in', ev.at)
    }
  }
  for (const links of out.values()) {
    links.started.sort((x, y) => y.at - x.at)
    links.started = links.started.slice(0, 12)
    links.talks.sort((x, y) => y.at - x.at)
    links.talks = links.talks.slice(0, 8)
  }
  return out
}

/** Where an event was read: its transcript, the line's byte offset and uuid, the transcript's session id. */
export interface EventSource {
  transcript: string
  offset: number
  uuid: string
  session: string
}

/**
 * A line of the edge log (adapters/edge-log.ts): an event as the board read it, with the session
 * it is from and the one at its other end, by their session ids, keys and names at that moment
 * (null when the board had none). A message's text is left out.
 */
export type Edge = (LinkEvent extends infer E ? (E extends LinkEvent ? Omit<E, 'text'> : never) : never) & {
  seq: number
  session: string
  key: string | null
  sessionName: string | null
  toSession: string | null
  toKey: string | null
  toName: string | null
  transcript: string
  offset: number
  uuid: string
}

/** The edge log's line for an event of `item` (null: no session on the board reads that transcript now). */
export function edgeOf(
  ev: LinkEvent,
  src: EventSource,
  item: Pick<LinkItem, 'key' | 'name' | 'session'> | null,
  other: Pick<LinkItem, 'key' | 'name' | 'session'> | null,
  seq = 0,
): Edge {
  const { text: _text, ...fields } = ev as LinkEvent & { text?: string }
  return {
    seq,
    ...fields,
    session: item?.session || src.session,
    key: item?.key ?? null,
    sessionName: item?.name ?? null,
    toSession: other?.session ?? null,
    toKey: other?.key ?? null,
    toName: other?.name ?? null,
    transcript: src.transcript,
    offset: src.offset,
    uuid: src.uuid,
  } as Edge
}
