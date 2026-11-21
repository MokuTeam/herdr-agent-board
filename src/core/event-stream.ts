// Server-sent events as a reader takes them apart (the master reading a node's `GET /api/events`,
// services/nodes/link.ts): text in as it comes, whole events out. Pure. Only what the board's own
// streams send is read: `data:` lines, an `event:` name, comments (`: ping`) and `retry:`.

/** One event: its name ('' for an unnamed one, the payload's) and its data lines joined by \n. */
export interface StreamEvent {
  name: string
  data: string
}

/**
 * The events whole in `text` and what is left of it for the next chunk. An event ends at a blank
 * line (\n\n, or \r\n\r\n). One with neither a name nor data (a comment, a `retry:`) gives none.
 */
export function takeEvents(text: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = []
  const blocks = text.replaceAll('\r\n', '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    let name = ''
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const at = line.indexOf(':')
      const field = at < 0 ? line : line.slice(0, at)
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '')
      if (field === 'event') name = value
      else if (field === 'data') data.push(value)
    }
    if (name || data.length) events.push({ name, data: data.join('\n') })
  }
  return { events, rest }
}
