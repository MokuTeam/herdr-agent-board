// A session's helpers as Claude Code leaves them on disk, made up for the tests (shapes copied
// from real transcripts, contents invented): the session's transcript, and beside it
// <session>/subagents/agent-<id>.jsonl + .meta.json, workflows/<run>/..., workflows/<run>.json.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const T0 = Date.parse('2026-10-16T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

export type Line = Record<string, unknown>
type More = Record<string, unknown>

/** Lines of a transcript, each a JSON object as Claude Code writes it. */
export const line = {
  user: (s: number, content: unknown, more: More = {}): Line => ({
    type: 'user',
    isSidechain: true,
    timestamp: at(s),
    message: { role: 'user', content },
    ...more,
  }),
  said: (s: number, text: string, stop = 'end_turn', more: More = {}): Line => ({
    type: 'assistant',
    isSidechain: true,
    timestamp: at(s),
    message: {
      model: 'claude-x',
      role: 'assistant',
      stop_reason: stop,
      usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 300 },
      content: [{ type: 'text', text }],
    },
    ...more,
  }),
  call: (s: number, id: string, name: string, input: unknown, more: More = {}): Line => ({
    type: 'assistant',
    isSidechain: true,
    timestamp: at(s),
    message: {
      model: 'claude-x',
      role: 'assistant',
      stop_reason: 'tool_use',
      usage: { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000, output_tokens: 80 },
      content: [{ type: 'tool_use', id, name, input }],
    },
    ...more,
  }),
  result: (s: number, id: string, text: string, more: More = {}): Line => ({
    type: 'user',
    isSidechain: true,
    timestamp: at(s),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    ...more,
  }),
  // What a request leaves in the transcript besides the messages: never a message of its own.
  blob: (s: number): Line => ({
    type: 'api-request-blob',
    timestamp: at(s),
    message: { role: 'user', content: [{ type: 'text', text: 'noise' }] },
  }),
}
export const jsonl = (lines: Line[]): string => `${lines.map(l => JSON.stringify(l)).join('\n')}\n`

export interface SessionDir {
  root: string
  transcript: string
  dir: string
  write(rel: string, data: Line[] | Line): string
  append(rel: string, lines: Line[]): void
  /** One helper: its meta and its transcript. */
  helper(id: string, meta: Line, lines: Line[], sub?: string): string
  remove(): void
}

/** A session folder in a temp dir: write(rel, lines|object) puts a file under it. */
export function sessionDir(): SessionDir {
  const root = mkdtempSync(join(tmpdir(), 'board-helpers-'))
  const transcript = join(root, 'b1d2c3e4-0000-4000-8000-000000000001.jsonl')
  writeFileSync(transcript, '')
  const dir = transcript.slice(0, -'.jsonl'.length)
  const write = (rel: string, data: Line[] | Line) => {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Array.isArray(data) ? jsonl(data) : JSON.stringify(data))
    return path
  }
  const append = (rel: string, lines: Line[]) => appendFileSync(join(dir, rel), jsonl(lines))
  const helper = (id: string, meta: Line, lines: Line[], sub = 'subagents') => {
    write(`${sub}/agent-${id}.meta.json`, meta)
    return write(`${sub}/agent-${id}.jsonl`, lines)
  }
  const remove = () => rmSync(root, { recursive: true, force: true })
  return { root, transcript, dir, write, append, helper, remove }
}
