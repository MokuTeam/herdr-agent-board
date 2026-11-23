// Messages between sessions through the board (#619): one way for a session to reach any other card
// of the board, this computer's or a node's (docs/design/nodes), as SendMessage reaches another
// profile's session (#251, entrypoints/wake-hook.ts). No I/O: the callers are the SendMessage and
// ListAgents hooks (entrypoints/wake-hook.ts), `board send` (entrypoints/cli.ts) and, for a node's
// session, the master's uplink (services/nodes/uplink.ts).
//
// - A target is a card of the board's payload with a name. A card that is not its session's any more
//   is left out: an awake card whose pane an awake card of another session on the same device holds
//   (one with a session id wins over one without, else the more recent activity), and an awake card
//   with no pane that is no MokuPilot day (nothing to type into).
// - A name picks the cards named so, case aside; a ref in brackets after it ("Name [1a2b3c4d]", 8 or
//   more hex) the one whose session id starts so. The whole key or session id picks its card.
// - What goes into the schedule: an entry due now, typed in once the session is free (`idle`),
//   signed by the sender, with the name and ref an answer goes to (`replyTo`) and, from another
//   computer, which one (`fromDevice`). The receiver is told to answer with `board send`
//   (core/schedule-rules.ts promptOf), which works on every computer of the board.
import { parseNodeKey } from './node-key.ts'
import { cleanName, cleanText, MAX_TEXT } from './schedule-rules.ts'

export interface Target {
  key: string
  name: string
  /** The names it answers to: the card's and the automatic one. */
  names: string[]
  session: string | null
  /** The device it runs on; null for this computer. */
  device: string | null
  pane: string | null
  cwd: string
  sleeping: boolean
  status: string
  day: boolean
  activity: number
}

/** Who sends: the session's key (a node's session's carries the device's prefix) and its name on the board. */
export interface Sender {
  key: string
  name: string
  /** The computer it runs on, when that is not the target's. */
  device?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The id a ref is the start of: the session id, else the key as its own board knows it. */
const idOf = (key: string, session: string | null): string => session ?? parseNodeKey(key)?.key ?? key

/** The first 8 characters of a session's id, as a name's ref shows it. */
export const refOf = (t: Pick<Target, 'key' | 'session'>): string => idOf(t.key, t.session).slice(0, 8)

/** "Name [ref]", as a list shows a target and SendMessage or `board send` takes it. */
export const labelOf = (t: Target): string => `${t.name} [${refOf(t)}]`

/** One that a newer card of another session in the same pane replaced. */
function replaced(t: Target, by: Target): boolean {
  if (by === t || by.sleeping || by.device !== t.device || !by.pane || by.pane !== t.pane) return false
  if (idOf(by.key, by.session) === idOf(t.key, t.session)) return false
  if (!t.session !== !by.session) return !t.session
  return by.activity > t.activity
}

/** The cards of a payload's `items` a message can go to; anything else in the list is left out. */
export function targetsOf(items: unknown): Target[] {
  if (!Array.isArray(items)) return []
  const all: Target[] = []
  for (const i of items) {
    if (!isRecord(i) || !str(i.key)) continue
    const names = [str(i.name).trim(), str(i.autoName).trim()].filter((n, k, l) => n && l.indexOf(n) === k)
    const [name] = names
    if (!name) continue
    all.push({
      key: str(i.key),
      name,
      names,
      session: str(i.session) || null,
      device: str(i.device) || null,
      pane: str(i.pane) || null,
      cwd: str(i.cwd),
      sleeping: i.sleeping === true,
      status: str(i.status),
      day: i.day === true,
      activity: Math.max(num(i.activity), num(i.lastAt)),
    })
  }
  return all.filter(t => t.sleeping || ((t.pane || t.day) && !all.some(o => replaced(t, o))))
}

/** "Name [1a2b3c4d]" split into the name (lower case) and the ref (lower case, '' for none). */
export function parseTo(named: string): { to: string; ref: string } {
  const ref = /\[([0-9a-f]+)\]\s*$/i.exec(named)?.[1]?.toLowerCase() ?? ''
  const to = named
    .replace(/\s*\[[0-9a-f]+\]\s*$/i, '')
    .trim()
    .toLowerCase()
  return { to, ref }
}

/** The targets `named` picks: by its whole key or session id, else by name and ref. */
export function matching(targets: readonly Target[], named: string): Target[] {
  const { to, ref } = parseTo(named)
  if (!to) return []
  const exact = targets.filter(t => t.key.toLowerCase() === to || t.session?.toLowerCase() === to)
  if (exact.length) return exact
  return targets.filter(
    t =>
      t.names.some(n => n.toLowerCase() === to) &&
      (ref.length < 8 || idOf(t.key, t.session).toLowerCase().startsWith(ref)),
  )
}

/** The message as the board carries it, or why it does not. */
export function messageText(message: unknown): { text: string } | { error: string } {
  const text = cleanText(message, Number.POSITIVE_INFINITY)
  if (!text.trim()) return { error: 'nothing to send' }
  if (text.length > MAX_TEXT)
    return {
      error: `${text.length} characters, the board carries ${MAX_TEXT}; send it in parts, or write it to a file and send the path`,
    }
  return { text }
}

/** The schedule entry that carries `text` from `from` to `target`, due at `now`. */
export function messageEntry(target: Target, text: string, from: Sender, now: number) {
  const name = cleanName(from.name)
  const id = idOf(from.key, null)
  return {
    key: target.key,
    name: target.name,
    // This computer's session: its pane and folder find it again after /clear (core/schedule-rules.ts targetOf).
    ...(target.device === null && target.pane && { pane: target.pane }),
    ...(target.device === null && target.cwd && { cwd: target.cwd }),
    text,
    at: now,
    next: now,
    idle: true,
    by: 'agent' as const,
    from: { key: from.key, name },
    // A name with its ref, or the whole key for a sender with no name or no hex id: either finds it again.
    replyTo: name && /^[0-9a-f]{8}/i.test(id) ? `${name} [${id.slice(0, 8)}]` : from.key,
    replyBy: 'board' as const,
    ...(from.device && { fromDevice: cleanName(from.device) }),
  }
}

/** Where a target runs, as a line names it; `own`: the master's own computer's id ('' for none). */
export const whereOf = (t: Target, own: string): string =>
  t.device ? `on node ${t.device}` : own ? `on ${own}` : "on the board's computer"

/** What `board send` asks: whom, what, who sends and from which computer (null: the board's own). */
export interface SendAsk {
  targets: readonly Target[]
  to: string
  message: unknown
  from: { key: string; name: string; device: string | null }
  /** The board's own computer's id (ownDeviceOf), '' when not known. */
  own: string
  now: number
}

/** `board send`'s entry and the line it prints, or why it sends nothing. */
export function planSend(a: SendAsk): { error: string } | { entry: ReturnType<typeof messageEntry>; line: string } {
  const fits = matching(a.targets, a.to)
  const others = fits.filter(t => t.key !== a.from.key)
  if (!others.length)
    return {
      error: fits.length ? 'that is this session: nothing was sent' : `no session "${a.to.trim()}" on the board`,
    }
  const [target] = others
  if (!target || others.length > 1)
    return {
      error:
        `"${a.to.trim()}" fits more than one session (${others.map(t => `${labelOf(t)} ${whereOf(t, a.own)}`).join(', ')}): ` +
        'send it to one of them by its name with its ref, as listed',
    }
  const m = messageText(a.message)
  if ('error' in m) return { error: `not sent: ${m.error}` }
  const fromDevice = target.device !== a.from.device ? (a.from.device ?? a.own) : ''
  const entry = messageEntry(target, m.text, { key: a.from.key, name: a.from.name, device: fromDevice }, a.now)
  return {
    entry,
    line:
      `ok · queued for ${labelOf(target)} ${whereOf(target, a.own)}: the board types it in once it is free, waking ` +
      'it first if it sleeps; the answer comes back as a board reminder',
  }
}

/** The id this board's payload gives its own computer (`devices`' local entry), '' when it has none. */
export function ownDeviceOf(payload: unknown): string {
  const devices = isRecord(payload) && Array.isArray(payload.devices) ? payload.devices : []
  const local = devices.find(d => isRecord(d) && d.id === 'local')
  return isRecord(local) && isRecord(local.status) ? str(local.status.id) : ''
}

/** The devices of a payload whose link is not online now. */
export function offlineDevices(payload: unknown): Set<string> {
  const devices = isRecord(payload) && Array.isArray(payload.devices) ? payload.devices : []
  const out = new Set<string>()
  for (const d of devices)
    if (isRecord(d) && d.id !== 'local' && typeof d.id === 'string' && !(isRecord(d.link) && d.link.state === 'online'))
      out.add(d.id)
  return out
}
