// Messages between sessions through the board (#619): one way for a session to reach any other card
// of the board, this computer's or a node's (docs/design/nodes), as SendMessage reaches another
// profile's session (#251, entrypoints/wake-hook.ts). No I/O: the callers are the SendMessage and
// ListAgents hooks (entrypoints/wake-hook.ts), `board send` (entrypoints/cli.ts) and, for a node's
// session, the master's uplink (services/nodes/uplink.ts).
//
// - A target is a card of the board's payload with a name. A card that is not its session's any more
//   is left out: an awake card whose pane an awake card of another session on the same device holds
//   (one with a session id wins over one without, else the more recent activity), an awake card
//   with no pane that is no MokuPilot day (nothing to type into), and a card a session left on one
//   device when it moved to another (#639: the one with the older activity).
// - A name picks the cards named so, case aside; a ref in brackets after it ("Name [1a2b3c4d]", 8 or
//   more hex) the one whose session id starts so. The whole key or session id picks its card.
// - What goes into the schedule: an entry due now, typed in once the session is free (`idle`),
//   signed by the sender, with the name and ref an answer goes to (`replyTo`) and, from another
//   computer, which one (`fromDevice`). The receiver is told to answer with `board send`
//   (core/schedule-rules.ts promptOf), which works on every computer of the board.
import { type BgTaskSummary, bgTaskActive, isBgTaskStuck } from './bg-task.ts'
import { parseNodeKey } from './node-key.ts'
import { cleanName, cleanText, MAX_TEXT } from './schedule-rules.ts'

export interface Target {
  key: string
  name: string
  /** The names it answers to: the card's and the automatic one. */
  names: string[]
  session: string | null
  /** The agent kind on the board (`claude`, `agy`, `pi`, `codex`, ...); null when absent. */
  agent: string | null
  /** The device it runs on; null for this computer. */
  device: string | null
  pane: string | null
  cwd: string
  sleeping: boolean
  status: string
  day: boolean
  activity: number
  /** The device its own board marked it moved to (#642, card `moved.to`); null when no mark. */
  movedTo: string | null
  /** When that move mark was written (`card.moved.at`); null when unmarked or unrecorded. */
  movedAt: number | null
  bgTasks?: BgTaskSummary
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

/** A ref SendMessage and `board send` take: 8 hex characters. */
const HEX_REF = /^[0-9a-f]{8}/i

/**
 * "Name [ref]", as a list shows a target and SendMessage or `board send` takes it; a card whose id is
 * no hex (a pane's, a pi file's) shows its whole key, which picks it as well.
 */
export const labelOf = (t: Target): string =>
  HEX_REF.test(idOf(t.key, t.session)) ? `${t.name} [${refOf(t)}]` : `${t.name} (key ${t.key})`

/** A name as it goes into a line for an agent: no line breaks or other control characters, at most 60. */
const plainName = (s: string): string =>
  s
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A name as a reply's `replyTo` carries it (cleanName: no brackets, at most 60), lower case: what names are compared by. */
const nameKey = (s: string): string => cleanName(plainName(s)).toLowerCase()

/** One that a newer card of another session in the same pane replaced. */
function replaced(t: Target, by: Target): boolean {
  if (by === t || by.sleeping || by.device !== t.device || !by.pane || by.pane !== t.pane) return false
  if (idOf(by.key, by.session) === idOf(t.key, t.session)) return false
  if (!t.session !== !by.session) return !t.session
  return by.activity > t.activity
}

/**
 * One whose session runs on another device now (#639): a move (`board move --device`, #616) can leave
 * the card it had where it was, under the session's id, beside the new one under the other device's.
 * A one-sided move mark (`movedTo`) decides the pair deterministically regardless of clock skew (#642).
 * Without a deciding mark (older boards without `movedTo`, or stale mutual marks), fall back to
 * weighing activity (#641); an awake card beats a sleeping one of the same moment.
 */
const LEGACY_MASTER = 'board'

function pointsTo(src: Target, dstId: string, own: string, hasBoardNode: boolean): boolean {
  if (!src.movedTo || !dstId) return false
  if (typeof src.movedAt === 'number' && src.activity > src.movedAt) return false
  if (src.movedTo === dstId) return true
  return src.movedTo === LEGACY_MASTER && dstId === own && !hasBoardNode
}

function marksTarget(
  t: Target,
  by: Target,
  own: string,
  hasBoardNode: boolean,
): { tToBy: boolean; byToT: boolean } | null {
  if (by === t || by.device === t.device || !t.session || by.session !== t.session) return null
  const tHere = t.device ?? own
  const byHere = by.device ?? own
  return {
    tToBy: pointsTo(t, byHere, own, hasBoardNode),
    byToT: pointsTo(by, tHere, own, hasBoardNode),
  }
}

function movedByMark(t: Target, by: Target, own: string, hasBoardNode: boolean): boolean {
  const m = marksTarget(t, by, own, hasBoardNode)
  return !!m && m.tToBy && !m.byToT
}

function movedAway(t: Target, by: Target, own: string, hasBoardNode: boolean): boolean {
  const m = marksTarget(t, by, own, hasBoardNode)
  // Only pairs with no deciding mark (unmarked older boards, or stale mutual marks) fall back to #641 clocks.
  if (!m || m.tToBy !== m.byToT) return false
  if (by.activity !== t.activity) return by.activity > t.activity
  return t.sleeping && !by.sleeping
}

/** The cards of a payload's `items` a message can go to; anything else in the list is left out. */
export function targetsOf(items: unknown, own = '', o: { includePaneless?: boolean } = {}): Target[] {
  if (!Array.isArray(items)) return []
  const all: Target[] = []
  for (const i of items) {
    if (!isRecord(i) || !str(i.key)) continue
    // A node's names come from its payload: plain text only, so a name cannot add a line of its own.
    const names = [plainName(str(i.name)), plainName(str(i.autoName))].filter((n, k, l) => n && l.indexOf(n) === k)
    const [name] = names
    if (!name) continue
    all.push({
      key: str(i.key),
      name,
      names,
      session: str(i.session) || null,
      agent: str(i.agent) || null,
      device: str(i.device) || null,
      pane: str(i.pane) || null,
      cwd: str(i.cwd),
      sleeping: i.sleeping === true,
      status: str(i.status),
      day: i.day === true,
      activity: Math.max(num(i.activity), num(i.lastAt)),
      movedTo: str(i.movedTo) || null,
      movedAt: typeof i.movedAt === 'number' && Number.isFinite(i.movedAt) ? i.movedAt : null,
      ...(bgTaskActive(i.bgTasks as BgTaskSummary | undefined) && { bgTasks: i.bgTasks as BgTaskSummary }),
    })
  }
  const hasBoardNode = all.some(t => t.device === LEGACY_MASTER)
  const kept = all.filter(
    t => t.sleeping || (o.includePaneless && !t.pane) || ((t.pane || t.day) && !all.some(x => replaced(t, x))),
  )
  // Drop cards superseded by an explicit move mark first so a chain move (A -> B -> C) never lets
  // stale card A beat final card C by clock (#642), then apply #641 clock fallback on the rest.
  const unmoved = kept.filter(t => !kept.some(o => movedByMark(t, o, own, hasBoardNode)))
  return unmoved.filter(t => !unmoved.some(o => movedAway(t, o, own, hasBoardNode)))
}

/** A local session on this computer running an agent other than Claude Code (`agy`, `pi`, `codex`, ...). */
export const isOtherAgent = (t: Pick<Target, 'device' | 'agent'>): boolean =>
  t.device === null && t.agent !== null && t.agent !== 'claude'

/** JSON-friendly view of a reachable target for `board agents --json`. */
export interface AgentView {
  key: string
  name: string
  /** Every name it answers to: the card's and the automatic one (#639: a node matches by them). */
  names: string[]
  label: string
  agent: string | null
  device: string | null
  status: string
  sleeping: boolean
  self: boolean
  offline: boolean
  bgTasks?: BgTaskSummary
}

/** Structured views of `targets` (live first, then sleepers newest-active first). */
export function agentViewsOf(
  targets: readonly Target[],
  o: { selfKey?: string; offline?: ReadonlySet<string> } = {},
): AgentView[] {
  const live = targets.filter(t => !t.sleeping)
  const asleep = targets.filter(t => t.sleeping).sort((a, b) => b.activity - a.activity)
  return [...live, ...asleep].map(t => ({
    key: t.key,
    name: t.name,
    names: t.names,
    label: labelOf(t),
    agent: t.agent,
    device: t.device,
    status: t.sleeping ? 'asleep' : t.status || 'live',
    sleeping: t.sleeping,
    self: !!o.selfKey && t.key === o.selfKey,
    offline: !!t.device && !!o.offline?.has(t.device),
    ...(t.bgTasks && { bgTasks: t.bgTasks }),
  }))
}

/**
 * Human- and agent-readable lines for `board agents` and MCP `ListAgents`: live sessions first,
 * then sleepers (capped at `maxSleeping` when set).
 */
export function formatAgentLines(
  targets: readonly Target[],
  o: { selfKey?: string; offline?: ReadonlySet<string>; own?: string; maxSleeping?: number; now?: number } = {},
): string[] {
  const live = targets.filter(t => !t.sleeping)
  const asleep = targets.filter(t => t.sleeping).sort((a, b) => b.activity - a.activity)
  const shownAsleep = o.maxSleeping !== undefined ? asleep.slice(0, o.maxSleeping) : asleep
  const hasRemote = targets.some(t => t.device !== null)
  const row = (t: Target): string => {
    const stuck = t.bgTasks ? (o.now !== undefined ? isBgTaskStuck(t.bgTasks, o.now) : t.bgTasks.stuck === true) : false
    return [
      labelOf(t),
      t.agent ?? '',
      t.device ? `node ${t.device}` : hasRemote && o.own ? o.own : '',
      t.sleeping ? 'asleep' : t.status || 'live',
      o.selfKey && t.key === o.selfKey ? '(this session)' : '',
      stuck ? 'background task may be stuck' : '',
      t.device && o.offline?.has(t.device) ? 'node offline now: goes out once it is back' : '',
    ]
      .filter(Boolean)
      .join('  ·  ')
  }
  const rows = [...live, ...shownAsleep].map(row)
  if (asleep.length > shownAsleep.length)
    rows.push(`... and ${asleep.length - shownAsleep.length} more asleep; board send / SendMessage reaches them too`)
  return rows
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

/**
 * The targets `named` picks: by its whole key or session id, else by name and ref. A ref that fits
 * none of the name's cards (the sender ran /clear since, and has a new id) gives way to the name
 * when only one card has it.
 */
export function matching(targets: readonly Target[], named: string): Target[] {
  const { to, ref } = parseTo(named)
  if (!to) return []
  const exact = targets.filter(t => t.key.toLowerCase() === to || t.session?.toLowerCase() === to)
  if (exact.length) return exact
  // Compared as a reply carries names: "Fix [WIP] thing" signs as "Fix WIP thing [ref]".
  const wanted = nameKey(to)
  const byName = targets.filter(t => t.names.some(n => nameKey(n) === wanted))
  if (ref.length < 8) return byName
  const byRef = byName.filter(t => idOf(t.key, t.session).toLowerCase().startsWith(ref))
  return byRef.length || byName.length !== 1 ? byRef : byName
}

/**
 * Resolves a session reference (name, "Name [ref]", key, session id, `@<device>:<id>`, or local
 * pane id) against `targets` using the same matching and ambiguity rules as `board send` (#693).
 * Returns `{ target }` on a unique match, `{ error, ambiguous: true }` when several sessions fit,
 * or `null` when none fits.
 */
export function resolveTarget(
  targets: readonly Target[],
  word: string,
  own = '',
): { target: Target } | { error: string; ambiguous: true } | null {
  let fits = matching(targets, word)
  if (!fits.length) {
    const w = word.trim().toLowerCase()
    if (w) fits = targets.filter(t => t.device === null && t.pane?.toLowerCase() === w)
  }
  if (!fits.length) return null
  const [target] = fits
  if (!target || fits.length > 1)
    return {
      ambiguous: true,
      error:
        `"${word.trim()}" fits more than one session (${fits.map(t => `${labelOf(t)} ${whereOf(t, own)}`).join(', ')}): ` +
        'give its name with its ref, or its key',
    }
  return { target }
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
    replyTo: name && HEX_REF.test(id) ? `${name} [${id.slice(0, 8)}]` : from.key,
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
  const at = parseNodeKey(a.to.trim())
  const targetRef = at && a.own && at.device === a.own ? at.key : a.to
  const fits = matching(a.targets, targetRef)
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
        'send it to one of them as listed: its name with its ref, or its key',
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
