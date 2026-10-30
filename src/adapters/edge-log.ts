// The edge log: every event the links index reads from a transcript (core/links.ts: spawn, fork,
// sent, received, prompted), one JSON line each (core/links.ts Edge), numbered, kept for good, for
// an audit outside the board. Its lines are in segments of about SEGMENT_BYTES, each named by its
// first line's number, none ever removed. A board that starts again reads every transcript from
// the start: marks.json keeps, per transcript, the byte offset its logged lines go up to, and the
// newest segment's own lines complete it after a crash between the two writes, so no event is
// written twice. One flush writes into one segment.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Edge, edgeOf, ends, isOwn, type LinkItem } from '../core/links.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import type { FoundEvent } from './links.ts'
import { stateDir } from './paths.ts'

export const edgeLogDir = (): string => join(stateDir(), 'edge-log')
export const SEGMENT_BYTES = 4 << 20
export const READ_LIMIT = 1000
const SEGMENT = /^edges-(\d{12})\.jsonl$/
const segmentName = (first: number): string => `edges-${String(first).padStart(12, '0')}.jsonl`

type Marks = { version: 1; marks: Record<string, number> }
const isMarks = (v: unknown): v is Marks => isRecord(v) && isRecord(v.marks)

/** A board item as the edge log sees it: the links' item, and the transcript it reads. */
export type EdgeItem = LinkItem & { transcript?: string | null }

export interface EdgeLog {
  /** Events the links index read (adapters/links.ts onEvents); those logged already are left out. */
  add(path: string, found: readonly FoundEvent[]): void
  /** Write the events added since, each with its session and the one at its other end among `items`. How many. */
  flush(items: readonly EdgeItem[]): number
  /** The lines after number `since`, at most `limit`, and the number to ask after next time. */
  read(since: number, limit?: number): { edges: Edge[]; next: number }
}

export function createEdgeLog({
  dir = edgeLogDir(),
  segmentBytes = SEGMENT_BYTES,
}: {
  dir?: string
  segmentBytes?: number
} = {}): EdgeLog {
  const marksFile = join(dir, 'marks.json')
  let loaded = false
  let seq = 0
  let marks: Record<string, number> = {}
  // The marks with what waits in `pending`: a line read again is not added again.
  const upto = new Map<string, number>()
  let pending: { path: string; found: readonly FoundEvent[] }[] = []

  const segments = (): number[] => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {}
    return names
      .map(n => SEGMENT.exec(n)?.[1])
      .filter((n): n is string => !!n)
      .map(Number)
      .sort((a, b) => a - b)
  }
  const lines = (first: number): Edge[] => {
    let text = ''
    try {
      text = readFileSync(join(dir, segmentName(first)), 'utf8')
    } catch {}
    const out: Edge[] = []
    for (const line of text.split('\n')) {
      try {
        const e: unknown = JSON.parse(line)
        if (isRecord(e) && typeof e.seq === 'number') out.push(e as Edge)
      } catch {}
    }
    return out
  }

  function load(): void {
    if (loaded) return
    loaded = true
    marks = { ...readJson(marksFile, isMarks)?.marks }
    const last = segments().at(-1)
    if (last !== undefined) {
      seq = last - 1
      for (const e of lines(last)) {
        seq = Math.max(seq, e.seq)
        if (typeof e.transcript === 'string' && typeof e.offset === 'number')
          marks[e.transcript] = Math.max(marks[e.transcript] ?? 0, e.offset + 1)
      }
    }
    for (const [path, mark] of Object.entries(marks)) if (typeof mark === 'number') upto.set(path, mark)
  }

  return {
    add(path, found) {
      load()
      const from = upto.get(path) ?? 0
      const fresh = found.filter(f => f.source.offset >= from)
      if (!fresh.length) return
      pending.push({ path, found: fresh })
      upto.set(path, Math.max(...fresh.map(f => f.source.offset + 1)))
    },

    flush(items) {
      load()
      if (!pending.length) return 0
      const end = ends(items)
      const byTranscript = new Map(items.filter(it => it.transcript).map(it => [it.transcript, it]))
      const out: string[] = []
      const done: Record<string, number> = {}
      let n = seq
      for (const { path, found } of pending) {
        const item = byTranscript.get(path) ?? null
        for (const { event, source } of found) {
          done[path] = Math.max(done[path] ?? 0, source.offset + 1)
          if (!isOwn(item, event)) continue
          out.push(JSON.stringify(edgeOf(event, source, item, end(item ?? { key: '' }, event), ++n)))
        }
      }
      if (out.length) {
        mkdirSync(dir, { recursive: true })
        const last = segments().at(-1)
        let size = 0
        try {
          size = last === undefined ? 0 : statSync(join(dir, segmentName(last))).size
        } catch {}
        const text = `${out.join('\n')}\n`
        const file = last === undefined || (size && size + Buffer.byteLength(text) > segmentBytes) ? seq + 1 : last
        appendFileSync(join(dir, segmentName(file)), text, { mode: 0o600 })
      }
      seq = n
      pending = []
      Object.assign(marks, done)
      mkdirSync(dir, { recursive: true })
      replaceFile(marksFile, JSON.stringify({ version: 1, marks } satisfies Marks))
      return out.length
    },

    read(since, limit = READ_LIMIT) {
      load()
      const after = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0
      const edges: Edge[] = []
      const segs = segments()
      // The segment that holds the line after `since`, and the ones after it.
      const from = Math.max(
        0,
        segs.findLastIndex(first => first <= after + 1),
      )
      for (const first of segs.slice(from)) {
        for (const e of lines(first)) if (e.seq > after && edges.length < limit) edges.push(e)
        if (edges.length >= limit) break
      }
      return { edges, next: edges.at(-1)?.seq ?? after }
    },
  }
}
