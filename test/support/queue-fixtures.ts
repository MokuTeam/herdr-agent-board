// Transcript lines as Claude Code 2.1 writes them around its queue (shapes copied from real
// transcripts, texts invented), as upstream's test/queue.test.mjs builds them.

export type Line = Record<string, unknown>

export const T0 = Date.parse('2026-10-19T14:54:00.000Z')
export const ts = (s: number): string => new Date(T0 + s * 1000).toISOString()

/** A queue operation: enqueue, dequeue, remove or popAll. */
export const q = (s: number, operation: string, content?: string, more: Line = {}): Line => ({
  type: 'queue-operation',
  operation,
  timestamp: ts(s),
  sessionId: 's1',
  ...(content === undefined ? {} : { content }),
  ...more,
})

export const user = (s: number, content: unknown, more: Line = {}): Line => ({
  type: 'user',
  isSidechain: false,
  timestamp: ts(s),
  message: { role: 'user', content },
  origin: { kind: 'human' },
  ...more,
})

export const said = (s: number, text: string): Line => ({
  type: 'assistant',
  isSidechain: false,
  timestamp: ts(s),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

export const call = (s: number, id: string, name: string, input: Line): Line => ({
  type: 'assistant',
  isSidechain: false,
  timestamp: ts(s),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})

export const result = (s: number, id: string): Line => ({
  type: 'user',
  isSidechain: false,
  timestamp: ts(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

/** A message taken into the running turn: kept as a queued_command attachment. */
export const absorbed = (s: number, prompt: unknown, from: number): Line => ({
  type: 'attachment',
  isSidechain: false,
  timestamp: ts(s),
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: ts(from) },
})

export const system = (s: number, subtype: string): Line => ({
  type: 'system',
  isSidechain: false,
  subtype,
  timestamp: ts(s),
})

export const jsonl = (lines: Line[]): string => `${lines.map(l => JSON.stringify(l)).join('\n')}\n`

/** A session at work: a prompt, then a long Bash call. */
export const busy: Line[] = [
  user(0, 'busy 60'),
  call(1, 'b1', 'Bash', { command: 'node -e "setTimeout(()=>{},60000)"' }),
]
