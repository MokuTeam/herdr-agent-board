// The transcripts' links between sessions (core/links.ts), kept up to date. A transcript only
// grows, so each one is read once, in the background, and from then on only from where the last
// read stopped. Only the lines with one of a few markers are parsed. Nothing here writes.
import { open, stat } from 'node:fs/promises'
import { type LinkEvent, type LinkState, lineEvents, newState } from '../core/links.ts'

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

/**
 * The transcripts' events, kept up to date: `update(paths)` reads what each one gained since,
 * one file at a time in the background, and calls onChange() when new events came in.
 */
export function createLinks({ onChange = () => {} }: { onChange?: () => void } = {}): LinksIndex {
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
    const fh = await open(path, 'r')
    try {
      let carry = Buffer.alloc(0)
      let pos = f.offset
      while (pos < st.size) {
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
        for (const start of markedLines(buf, last))
          f.events.push(...lineEvents(buf.toString('utf8', start, buf.indexOf(10, start)), f.state))
        carry = Buffer.from(buf.subarray(last + 1))
      }
      // A line still being written is read again next time, whole.
      f.offset = pos - carry.length
    } finally {
      await fh.close()
    }
    return f.events.length > before
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
