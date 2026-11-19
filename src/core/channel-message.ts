// A message the owner sent through a channel plugin (Telegram: plugin:tg:telegram). Claude Code
// writes it as a meta user line with origin { kind: 'channel', server } and the text inside a
// <channel source="…" message_id="…" …> envelope; the board shows it as the owner's own message.

/** What the envelope says besides the text: kept on the user's turn (core/transcript.ts UserTurn). */
export interface ChannelFacts {
  /** The channel's short name: 'telegram' for plugin:tg:telegram. */
  via: string
  /** What came with it: 'voice', 'photo', 'document'…, as the channel names it. */
  attached?: string
  /** A voice message the channel turned into the text. */
  transcribed?: true
  /** The attached file's own name, when the channel gives one. */
  fileName?: string
}

export interface ChannelMessage extends ChannelFacts {
  text: string
  /** The channel's id of the message ('' without one): the same message queued and sent again is one. */
  id: string
}

const OPEN = /<channel\b((?:\s+[\w:-]+="[^"]*")*)\s*>/
const ATTR = /([\w:-]+)="([^"]*)"/g
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
const unescaped = (s: string): string => s.replace(/&(amp|quot|apos|lt|gt);/g, (_, e: string) => ENTITIES[e] ?? '')
// A short word for the page and its CSS: letters, digits, '-' and '_' only.
const word = (s: string, n = 40): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .slice(0, n)

/** "telegram" for "plugin:tg:telegram" or "telegram": the last part of the server's name. */
export function channelName(server: string): string {
  return word(server.split(':').pop() ?? '')
}

/**
 * The owner's message in a channel envelope, or null when `text` holds none. `server` is the
 * line's origin.server, which names the channel when the envelope's source does not.
 */
export function channelMessage(text: string, server = ''): ChannelMessage | null {
  const open = OPEN.exec(text)
  if (!open) return null
  const attrs = new Map<string, string>()
  for (const m of (open[1] ?? '').matchAll(ATTR)) attrs.set(m[1] ?? '', unescaped(m[2] ?? ''))
  const rest = text.slice(open.index + open[0].length)
  const close = rest.lastIndexOf('</channel>')
  const via = channelName(attrs.get('source') || server) || 'channel'
  const attached = word(attrs.get('file_kind') ?? attrs.get('attachment_kind') ?? '', 20)
  const fileName = (attrs.get('file_name') ?? '').trim().slice(0, 200)
  return {
    via,
    text: (close < 0 ? rest : rest.slice(0, close)).trim(),
    id: (attrs.get('message_id') ?? '').slice(0, 80),
    ...(attached && { attached }),
    ...(attrs.get('transcribed') === 'true' && { transcribed: true as const }),
    ...(fileName && { fileName }),
  }
}

/** A channel's name for people: "Telegram" for 'telegram'. */
export const channelLabel = (via: string): string => via.charAt(0).toUpperCase() + via.slice(1)

const KINDS = new Set(['photo', 'voice', 'audio', 'video', 'document', 'sticker'])

/** "(photo attached)" in the board's language, for a message with a file and no text. */
export function attachedText(
  m: Pick<ChannelFacts, 'attached' | 'fileName'>,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (m.attached && KINDS.has(m.attached)) return t(`chan.attached.${m.attached}`)
  return m.fileName ? t('chan.attached.named', { name: m.fileName }) : t('chan.attached')
}
