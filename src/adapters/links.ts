// The transcripts' links between sessions (core/links.ts), kept up to date. A transcript only
// grows, so each one is read once, in the background, and from then on only from where the last
// read stopped. Only the lines with one of a few markers are parsed. Nothing here writes; whoever
// keeps the events (adapters/edge-log.ts) gets each new one with where it was read (onEvents).
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { type EventSource, type LinkEvent, type LinkState, lineEvents, newState } from '../core/links.ts'

// The lines worth parsing; Agent and Task calls name the agents a message to whom is no session's;
// a fork's copied lines are its source's (and the first says whose fork it is).
const MARKERS = [
  'spawn-agent',
  '"SendMessage"',
  '"kind":"peer"',
  'pane=',
  '"name":"Agent"',
  '"name":"Task"',
  '"forkedFrom"',
  // herdr typing into another pane (core/transcript-links.ts promptsOf)
  'agent prompt',
  'send-text',
  'send-keys',
  'pane run',
].map(m => Buffer.from(m))
const CHUNK = 4 << 20
const MAX_LINE = 64 << 20 // a line longer than this (a pasted screenshot) is skipped, not held

/** Where the lines that hold a marker start, up to `last`, in order. */
function markedLines(buf: Buffer, last: number): number[] {
  const starts = new Set<number>()
  for (const m of MARKERS) {
    for (let i = buf.indexOf(m); i >= 0 && i < last; i = buf.indexOf(m, i)) {
      starts.add(buf.lastIndexOf(10, i) + 1)
      i = buf.indexOf(10, i) + 1 // on from the next line: one hit is enough for a line
      if (!i) break
    }
  }
  return [...starts].sort((a, b) => a - b)
}

export interface LinksIndex {
  /** Read on in these transcripts (the most active first, as the board lists them). */
  update(paths: readonly (string | null | undefined)[]): void
  /** The events read so far from a transcript. */
  events(path: string | null | undefined): LinkEvent[]
  /** Whether every transcript asked for was read to its end. */
  idle(): boolean
}

/** An event as it was read: the event, and where (core/links.ts EventSource). */
export interface FoundEvent {
  event: LinkEvent
  source: EventSource
}

/** A line's uuid and session id, for the events found in it. */
function lineIds(line: string, path: string): { uuid: string; session: string } {
  let o: Record<string, unknown> | null = null
  try {
    o = JSON.parse(line)
  } catch {}
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return { uuid: s(o?.uuid), session: s(o?.sessionId) || basename(path).replace(/\.jsonl$/i, '') }
}

/**
 * The transcripts' events, kept up to date: `update(paths)` reads what each one gained since,
 * one file at a time in the background, and calls onChange() when new events came in (a prompt
 * alone is none: core/links.ts), after onEvents(path, found) with them and where they were read.
 */
export function createLinks({
  onChange = () => {},
  onEvents,
}: {
  onChange?: () => void
  onEvents?: (path: string, found: FoundEvent[]) => void
} = {}): LinksIndex {
  const files = new Map<string, { offset: number; events: LinkEvent[]; state: LinkState }>()
  const queue: string[] = []
  let running = false

  async function read(path: string): Promise<boolean> {
    const f = files.get(path) ?? { offset: 0, events: [], state: newState() }
    files.set(path, f)
    const st = await stat(path).catch(() => null)
    if (!st) return false
    // Rewritten from the start (it never is, but a smaller file cannot be read on from the old place).
    if (st.size < f.offset) Object.assign(f, { offset: 0, events: [], state: newState() })
    if (st.size === f.offset) return false
    const before = f.events.length
    const found: FoundEvent[] = []
    const fh = await open(path, 'r')
    try {
      let carry = Buffer.alloc(0)
      let pos = f.offset
      while (pos < st.size) {
        const base = pos - carry.length // where buf starts in the file
        const want = Math.min(CHUNK, st.size - pos)
        const chunk = Buffer.alloc(want)
        const { bytesRead } = await fh.read(chunk, 0, want, pos)
        if (!bytesRead) break
        pos += bytesRead
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        const last = buf.lastIndexOf(10) // '\n'
        if (last < 0) {
          carry = buf.length > MAX_LINE ? Buffer.alloc(0) : buf
          continue
        }
        for (const start of markedLines(buf, last)) {
          const line = buf.toString('utf8', start, buf.indexOf(10, start))
          const events = lineEvents(line, f.state)
          f.events.push(...events)
          if (onEvents && events.length) {
            const source = { transcript: path, offset: base + start, ...lineIds(line, path) }
            for (const event of events) found.push({ event, source })
          }
        }
        carry = Buffer.from(buf.subarray(last + 1))
      }
      // A line still being written is read again next time, whole.
      f.offset = pos - carry.length
    } finally {
      await fh.close()
    }
    if (found.length) onEvents?.(path, found)
    // Prompts are not links: the board's next refresh writes them into the edge log, none of their own.
    return f.events.slice(before).some(e => e.kind !== 'prompted')
  }

  async function drain(): Promise<void> {
    if (running) return
    running = true
    let changed = false
    try {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        try {
          if (await read(path)) changed = true
        } catch {}
      }
    } finally {
      running = false
    }
    if (changed) onChange()
  }

  return {
    update(paths) {
      for (const p of paths) if (p && !queue.includes(p)) queue.push(p)
      void drain()
    },
    events: path => (path ? (files.get(path)?.events ?? []) : []),
    idle: () => !running && !queue.length,
  }
}
