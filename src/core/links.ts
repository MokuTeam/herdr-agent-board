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
// Pure: adapters/links.ts reads the transcripts' lines in the background.
import { spawnOf, spawnResult } from './transcript-links.ts'

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

/** What a transcript's lines carry over to later ones (lineEvents). */
export interface LinkState {
  /** spawn-agent calls waiting for what they printed. */
  pending: Map<string, { name: string; at: number }>
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
 * summary, at } | { kind: 'received', name, pipe, id, text, at }]. `state` carries what a later
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
          summary: clip(String(input.summary ?? firstLine(input.message)), 200),
          at,
        })
        continue
      }
      const spawn = spawnOf(str(b.name), input)
      if (spawn) state.pending.set(id, { ...spawn, at })
    } else if (o.type === 'user' && b?.type === 'tool_result' && state.pending.has(str(b.tool_use_id))) {
      const call = state.pending.get(str(b.tool_use_id))
      state.pending.delete(str(b.tool_use_id))
      const text =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map(c => rec(c)?.text ?? '').join('\n')
            : ''
      const r = !b.is_error && spawnResult(text)
      if (r && call) out.push({ kind: 'spawn', name: r.name || call.name, pane: r.pane, at: call.at })
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
  /** The message pipe its Claude process listens on, while it runs. */
  pipe?: string
}

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
 * The links between the board's items, from each one's events (`eventsOf(item)`): by key,
 * { from: { key, name, at } | null, started: [{ key, name, at }], talks: [{ key, name, in, out,
 * at }] }. A started session is matched by its pane and the name spawn-agent gave it (a pane id
 * is used again once its tab is gone); a message's other end by its pipe while that session
 * runs, else by its name when exactly one session on the board has it.
 */
export function relate<T extends LinkItem>(
  items: readonly T[],
  eventsOf: (item: T) => readonly LinkEvent[] | undefined,
): Map<string, ItemLinks> {
  const names = (it: T) => new Set([it.name, it.autoName].filter(Boolean).map(norm))
  const byName = new Map<string, T[]>()
  for (const it of items) for (const n of names(it)) if (n) byName.set(n, [...(byName.get(n) ?? []), it])
  const byPipe = new Map(items.filter(it => it.pipe).map(it => [String(it.pipe).replace(/^uds:/, ''), it]))
  const one = (name: string, self: T): T | null => {
    // A name with no letters or digits (a broadcast "*", an emoji) names no one.
    if (!norm(name)) return null
    const list = (byName.get(norm(name)) ?? []).filter(it => it.key !== self.key)
    return list.length === 1 ? (list[0] ?? null) : null
  }
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
    // A fork's events from before it started are its source's, copied; its card says whose fork it is.
    const own = a.fork
    const read = (eventsOf(a) ?? []).filter(ev => !own || ev.kind === 'fork' || ev.at >= own.at)
    const events: readonly LinkEvent[] =
      own?.of && !read.some(ev => ev.kind === 'fork') ? [...read, { kind: 'fork', of: own.of, at: own.at }] : read
    for (const ev of events) {
      if (ev.kind === 'spawn') {
        const b = items.find(it => it.key !== a.key && it.pane && it.pane === ev.pane && names(it).has(norm(ev.name)))
        if (!b) continue
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
        const b = items.find(it => it.key !== a.key && (it.session === ev.of || it.key === ev.of))
        if (!b) continue
        linksOf(a.key).from = { key: b.key, name: b.name, at: ev.at, fork: true }
        const theirs = linksOf(b.key).started
        if (!theirs.some(x => x.key === a.key)) theirs.push({ key: a.key, name: a.name, at: ev.at, fork: true })
      } else if (ev.kind === 'sent') {
        // A reply goes to the pipe the message came from.
        const b = ev.to.startsWith('uds:') ? (byPipe.get(ev.to.slice(4)) ?? one(ev.name, a)) : one(ev.to, a)
        if (b && b.key !== a.key) talk(a, b, 'out', ev.at)
      } else {
        const b = byPipe.get(ev.pipe.replace(/^uds:/, '')) ?? one(ev.name, a)
        if (b && b.key !== a.key) talk(a, b, 'in', ev.at)
      }
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
