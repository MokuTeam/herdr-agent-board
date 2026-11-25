// A node's part of the master's payload (#500, docs/design/nodes 5, 17): the items, launches and
// schedule entries of a node's payload, each checked field by field against the board's own types
// before the master shows them. Pure: services/nodes/aggregate.ts reads the payloads and keeps the
// offline copy.
//
// - Only the fields the types name pass, each only when it is what the type says; strings are cut
//   to the lengths the board's own items carry. A required field that is not what the type says
//   gets the value a card has with nothing known (no pane, status unknown, the 'other' lane).
// - An item without a usable key or name is left out whole, as is an item the node itself took
//   from another device (its key is prefixed, or it has a device): a node shows its own sessions.
// - With a device: each key, and each reference to a key or a session of that node, gets the
//   `@<device>:` prefix (core/nodes.ts nodeKey), and each item, launch and entry the device. The
//   node's own `device` field is never read, so a node cannot make an item claim another device.
// - Without one: the same check, keys as the node has them. That is what the offline copy keeps.
import { type BgTaskSummary, MAX_BG_TASK_DETAIL } from './bg-task.ts'
import { checklistActive, MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT } from './checklist.ts'
import { linkDecisionOf } from './node-uplink.ts'
import { nodeKey, parseNodeKey } from './nodes.ts'
import { MAX_REPORT, type ScheduleEntry } from './schedule-rules.ts'
import type { Item, LaunchView } from './types.ts'

/** What a node's payload gives the master's: never its fsToken, profiles, setup or limits. */
export interface NodePart {
  items: Item[]
  launches: LaunchView[]
  schedules: ScheduleEntry[]
  /** The node's machine name (COMPUTERNAME / hostname) for matching Telegram pane hints (#701). */
  machine?: string
}

/** The longest strings kept, as long as the board's own items carry. */
const LEN = {
  /** A key: a Claude session id, `pane-<id>`, a pi session file's path. Longer: the item is left out. */
  key: 1024,
  /** A session, pane, workspace, profile or helper id. */
  id: 256,
  name: 200,
  lane: 64,
  path: 1024,
  /** A card's own words (doing, wait, result, a question) and a schedule entry's text (core/schedule-rules.ts MAX_TEXT). */
  text: 2000,
  /** What a transcript gives (core/transcript.ts): its last words, a model, an effort, a tool's line. */
  lastText: 700,
  model: 60,
  effort: 20,
  toolLine: 160,
} as const

/** The most entries a list keeps. */
const MOST = { items: 2000, launches: 200, schedules: 2000, list: 200 } as const

/** What a field is: its value as the type has it, or undefined when it is not that. */
type Check = (v: unknown, k: Rekey) => unknown
/** A key, or a session id, of the node as the master names it. */
type Rekey = (key: string) => string

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const str =
  (max: number): Check =>
  v =>
    typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined
const nonEmpty =
  (max: number): Check =>
  v =>
    typeof v === 'string' && v ? (v.length > max ? v.slice(0, max) : v) : undefined
/** A key or a session id of the node: kept whole or not at all, and prefixed. */
const ref: Check = (v, k) => (typeof v === 'string' && v && v.length <= LEN.key ? k(v) : undefined)
/** A call parent reference (#700, #730): already device-prefixed parents stay for later validation; bare keys get prefixed. */
const parentRef: Check = (v, k) => {
  if (typeof v !== 'string' || !v || v.length > LEN.key) return undefined
  const at = parseNodeKey(v)
  if (!at) return k(v)
  return parseNodeKey(at.key) ? null : v
}
const num: Check = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool: Check = v => (typeof v === 'boolean' ? v : undefined)
const yes: Check = v => (v === true ? true : undefined)
const oneOf =
  (...values: unknown[]): Check =>
  v =>
    values.includes(v) ? v : undefined
const orNull =
  (c: Check): Check =>
  (v, k) =>
    v === null ? null : c(v, k)
/** A list: what is not what the type says is left out of it, and it is cut at `most`. */
const list =
  (c: Check, most: number = MOST.list): Check =>
  (v, k) => {
    if (!Array.isArray(v)) return undefined
    const out: unknown[] = []
    for (const x of v) {
      if (out.length >= most) break
      const got = c(x, k)
      if (got !== undefined) out.push(got)
    }
    return out
  }
/** An object of these fields; one of `required` that is not what the type says leaves the object out. */
const shape =
  (fields: Record<string, Check>, required: readonly string[] = []): Check =>
  (v, k) => {
    if (!isObject(v)) return undefined
    const out: Record<string, unknown> = {}
    for (const [name, c] of Object.entries(fields)) {
      if (!Object.hasOwn(v, name)) continue
      const got = c(v[name], k)
      if (got !== undefined) out[name] = got
    }
    return required.every(name => Object.hasOwn(out, name)) ? out : undefined
  }
/** A map of strings to strings, without a prototype. */
const words =
  (max: number): Check =>
  v => {
    if (!isObject(v)) return undefined
    const out: Record<string, string> = Object.create(null)
    for (const [name, value] of Object.entries(v).slice(0, MOST.list))
      if (name.length <= LEN.id && typeof value === 'string') out[name] = value.slice(0, max)
    return out
  }

const COLUMN = oneOf('work', 'me', 'ext', 'done', 'idle')
const STATUS = oneOf('idle', 'working', 'blocked', 'done', 'unknown', 'sleeping')
const ATTENTION = oneOf('', 'decision', 'ask', 'question', 'later', 'access')

const option = shape({ label: str(500), description: str(LEN.text), preview: str(8000) }, ['label', 'description'])
const question = shape(
  { question: str(LEN.text), header: str(100), multiSelect: bool, preview: bool, options: list(option, 8) },
  ['question', 'header', 'multiSelect', 'preview', 'options'],
)
/** A tool call as a card shows it; its input never: the page does not read it, and it may be big. */
const tool = shape(
  {
    id: str(LEN.id),
    name: str(LEN.id),
    label: str(LEN.toolLine),
    detail: str(LEN.toolLine),
    pending: bool,
    questions: orNull(list(question, 4)),
    reported: num,
  },
  ['id', 'name'],
)
const sessionRef = shape({ key: ref, name: str(LEN.name), at: num, fork: yes }, ['key', 'name', 'at'])
const talk = shape({ key: ref, name: str(LEN.name), at: num, fork: yes, in: num, out: num }, [
  'key',
  'name',
  'at',
  'in',
  'out',
])
const links = shape({ from: orNull(sessionRef), started: list(sessionRef), talks: list(talk) }, [
  'from',
  'started',
  'talks',
])
const helpers = shape(
  {
    running: num,
    total: num,
    workflows: num,
    live: list(
      shape(
        {
          id: str(LEN.id),
          kind: oneOf('agent', 'fork', 'workflow', 'teammate'),
          label: str(LEN.toolLine),
          color: str(32),
        },
        ['id', 'kind', 'label', 'color'],
      ),
      4,
    ),
    at: num,
  },
  ['running', 'total', 'workflows', 'live', 'at'],
)
const call = shape(
  {
    phase: oneOf('on', 'after'),
    since: num,
    parent: orNull(parentRef),
    helpers: orNull(num),
    tasks: list(
      shape(
        {
          id: str(LEN.id),
          text: str(200),
          status: oneOf('doing', 'next', 'done'),
          steps: shape({ done: num, total: num }, ['done', 'total']),
        },
        ['id', 'text', 'status'],
      ),
      60,
    ),
  },
  ['phase', 'since', 'parent', 'helpers', 'tasks'],
)
const compactRun = shape(
  {
    state: oneOf('sent', 'done', 'failed'),
    at: num,
    from: num,
    limit: num,
    setting: str(32),
    to: num,
    doneAt: num,
    measured: yes,
    hold: yes,
  },
  ['state', 'at', 'from', 'limit', 'setting'],
)
const compact = shape(
  {
    own: str(32),
    note: str(LEN.text),
    limit: str(32),
    source: oneOf('session', 'default', 'never', 'off'),
    tokens: orNull(num),
    run: orNull(compactRun),
    done: list(num, 20),
  },
  ['own', 'note', 'limit', 'source', 'tokens', 'run'],
)
const todo = shape(
  {
    id: str(LEN.id),
    text: str(500),
    owner: oneOf('user', 'agent'),
    by: oneOf('user', 'agent'),
    at: num,
    anchor: shape({ id: str(LEN.id), at: num }),
    done: num,
    doneBy: oneOf('user', 'agent'),
    n: num,
    ref: str(300),
    why: str(300),
    proposed: shape({ at: num, why: str(300) }, ['at']),
    doneWhy: str(300),
  },
  ['id', 'text', 'owner', 'by', 'at'],
)
const checklistItem = shape(
  {
    content: str(MAX_CHECKLIST_TEXT),
    status: oneOf('pending', 'in_progress', 'completed'),
    activeForm: str(MAX_CHECKLIST_TEXT),
  },
  ['content', 'status'],
)
const rawChecklist = shape(
  {
    done: num,
    total: num,
    current: str(MAX_CHECKLIST_TEXT),
    items: list(checklistItem, MAX_CHECKLIST_ITEMS),
    at: num,
  },
  ['done', 'total', 'current', 'items'],
)
const checklist: Check = (v, k) => {
  const got = rawChecklist(v, k) as
    | { done: number; total: number; current: string; items: { content: string; status: string }[] }
    | undefined
  if (!got || got.done < 0 || got.total <= 0 || got.done >= got.total || got.items.length === 0) return undefined
  return checklistActive(got as Parameters<typeof checklistActive>[0]) ? got : undefined
}
const rawBgTasks = shape(
  { count: num, since: orNull(num), detail: str(MAX_BG_TASK_DETAIL), stuckMin: num, stuck: yes },
  ['count', 'since', 'detail', 'stuckMin'],
)
const bgTasks: Check = (v, k) => {
  const got = rawBgTasks(v, k) as BgTaskSummary | undefined
  if (!got || !Number.isInteger(got.count) || got.count <= 0 || got.stuckMin < 0) return undefined
  return got
}
const secret = shape(
  {
    id: str(LEN.id),
    title: str(LEN.name),
    sink: str(LEN.id),
    sinkTitle: str(LEN.name),
    kind: oneOf('file', 'bitwarden', 'env', 'http'),
    where: str(LEN.path),
    detail: str(LEN.text),
    fingerprint: str(LEN.text),
    fields: list(shape({ name: str(LEN.id), hidden: bool, once: yes }, ['name', 'hidden']), 20),
    params: words(LEN.text),
    at: num,
    expires: num,
    problem: str(LEN.text),
  },
  ['id', 'title', 'sink', 'sinkTitle', 'kind', 'where', 'detail', 'fingerprint', 'fields', 'params', 'at', 'expires'],
)

/** A launch as the payload shows it (core/types.ts LaunchView). */
const LAUNCH: Record<string, Check> = {
  id: ref,
  resume: orNull(ref),
  fork: orNull(ref),
  name: str(LEN.name),
  cwd: str(LEN.path),
  category: str(LEN.lane),
  workspace: str(LEN.name),
  workspaceId: orNull(str(LEN.id)),
  state: oneOf('starting', 'waiting', 'trust', 'done', 'failed'),
  step: oneOf(
    'prepare',
    'worktree',
    'workspace',
    'tab',
    'agent',
    'dialog',
    'rename',
    'message',
    'command',
    'trust',
    'trusting',
  ),
  error: str(LEN.text),
  kind: str(32),
  pane: orNull(str(LEN.id)),
  key: orNull(ref),
  startedAt: num,
  doneAt: orNull(num),
  message: str(LEN.text),
  worktree: orNull(shape({ branch: str(LEN.name) }, ['branch'])),
  newWorkspace: bool,
  profile: str(LEN.id),
  parent: orNull(ref),
  agent: str(32),
  model: orNull(str(LEN.model)),
}
const LAUNCH_REQUIRED = [
  'id',
  'name',
  'cwd',
  'category',
  'workspace',
  'workspaceId',
  'state',
  'step',
  'error',
  'kind',
  'pane',
  'key',
  'startedAt',
  'doneAt',
  'message',
  'worktree',
  'newWorkspace',
]
const launch = shape(LAUNCH, LAUNCH_REQUIRED)

/** The optional fields of an item (core/types.ts Item). Server-only ones (transcript, pipe, ...) are not among them. */
const ITEM: Record<string, Check> = {
  sleeping: bool,
  movedTo: nonEmpty(LEN.id),
  movedAt: num,
  formerPanes: list(str(LEN.id), 20),
  fromFile: yes,
  agent: str(32),
  focused: bool,
  doing: str(LEN.text),
  doingAt: orNull(num),
  wait: str(LEN.text),
  waitSince: orNull(num),
  result: str(LEN.text),
  title: str(LEN.text),
  prompt: str(LEN.text),
  lastText: str(LEN.lastText),
  lastAt: orNull(num),
  recap: str(LEN.text),
  recapAt: orNull(num),
  context: orNull(num),
  contextPct: orNull(num),
  contextSize: orNull(num),
  model: orNull(str(LEN.model)),
  modelAsked: str(LEN.model),
  modelWrong: shape({ runs: str(LEN.model), want: str(LEN.model) }, ['runs', 'want']),
  effort: orNull(str(LEN.effort)),
  effortLive: yes,
  tool: orNull(tool),
  question: str(LEN.text),
  askSince: orNull(num),
  activity: num,
  pin: oneOf('', 'me', 'ext', 'done', 'idle'),
  auto: COLUMN,
  favorite: bool,
  helpers: orNull(helpers),
  links: orNull(links),
  fork: orNull(shape({ of: ref, at: num }, ['of', 'at'])),
  call: orNull(call),
  day: yes,
  profile: orNull(str(LEN.id)),
  profileFolder: str(LEN.path),
  profileWanted: str(LEN.id),
  todos: list(todo),
  checklist,
  bgTasks,
  compact,
  secrets: list(secret, 20),
  launch: orNull(launch),
  lostAccess: shape(
    {
      kind: oneOf('limit', 'logged_out', 'expired'),
      resetsAt: orNull(num),
      resetText: str(100),
      at: num,
    },
    ['kind', 'resetsAt', 'at'],
  ),
  tgKey: nonEmpty(LEN.path),
  // Its open question's decision (#781): the master shows its own copy while the card carries this.
  decision: v => linkDecisionOf(v) ?? undefined,
}

/** One item of a node, or null when it has no usable key or name, or is not the node's own. */
function itemOf(
  raw: unknown,
  k: Rekey,
  device: string | null,
  allowParent?: (parentKey: string) => boolean,
): Item | null {
  if (!isObject(raw) || Object.hasOwn(raw, 'device')) return null
  const key = raw.key
  if (typeof key !== 'string' || !key || key.length > LEN.key || parseNodeKey(key)) return null
  const name = str(LEN.name)(raw.name, k)
  if (typeof name !== 'string' || !name.trim()) return null
  const pick = <T>(field: string, c: Check, otherwise: T): T => {
    const got = c(raw[field], k)
    return got === undefined ? otherwise : (got as T)
  }
  const item: Item = {
    key: k(key),
    session: pick('session', orNull(str(LEN.id)), null),
    pane: pick('pane', orNull(str(LEN.id)), null),
    workspace: pick('workspace', orNull(str(LEN.id)), null),
    cwd: pick('cwd', str(LEN.path), ''),
    status: pick('status', STATUS, 'unknown'),
    name,
    autoName: pick('autoName', str(LEN.name), ''),
    category: pick('category', str(LEN.lane), 'other') || 'other',
    categorySet: pick('categorySet', bool, false),
    column: pick('column', COLUMN, 'idle'),
    attention: pick('attention', ATTENTION, ''),
  }
  const more = shape(ITEM)(raw, k) as Record<string, unknown>
  if (device && isObject(more.call) && typeof more.call.parent === 'string') {
    const at = parseNodeKey(more.call.parent)
    if (at && at.device !== device && !allowParent?.(more.call.parent)) {
      more.call = { ...more.call, parent: null }
    }
  }
  Object.assign(item, more)
  if (device) item.device = device
  return item
}

/** A schedule entry of a node (core/schedule-rules.ts ScheduleEntry), the scheduler's own fields the page shows among them. */
const ENTRY: Record<string, Check> = {
  id: ref,
  key: ref,
  // A MokuPilot call's results are longer than a reminder's text.
  text: str(MAX_REPORT),
  next: num,
  name: str(60),
  pane: str(LEN.id),
  cwd: str(LEN.path),
  at: num,
  cron: str(LEN.id),
  created: num,
  by: str(LEN.name),
  from: shape({ key: ref, name: str(60) }, ['key', 'name']),
  movedFrom: shape({ key: ref, name: str(60) }, ['key', 'name']),
  kind: str(32),
  fromProfile: str(LEN.name),
  replyTo: str(LEN.name),
  noWake: bool,
  idle: bool,
  runs: num,
  missed: num,
  lastRun: num,
  gone: num,
  pendingSince: num,
  why: str(LEN.text),
  step: str(32),
  attempts: num,
  retryAt: num,
  failed: str(LEN.text),
  tasksSince: num,
}

/**
 * Drops source cards marked `movedTo` when the same session has another card on the device `movedTo`
 * names (#642). `masterId` names this computer, whose own cards carry no `device` (a move back from
 * a node writes `moved.to = masterId`, #616). Only the mark decides, never clocks: a chain move
 * drops every superseded source card, a card whose target device has no card stays (offline node or
 * unfinished move), a stale mutual mark between two devices drops neither, and items without a
 * session id are untouched. Input order is preserved.
 */
const LEGACY_MASTER = 'board'

/**
 * Drop a source card whose own board still reports it after a move to another device (#642):
 * the session already has a card on the device its move mark (`movedTo`) names, and that target
 * does not itself point back here. Cards without a move mark (older boards), solo cards without a
 * counterpart on the target, and locally resumed cards (`activity > movedAt`) stay untouched.
 */
export function dropMovedCards(items: readonly Item[], masterId = ''): Item[] {
  if (!items.some(i => i.movedTo && i.session)) return [...items]
  const bySession = new Map<string, Item[]>()
  for (const i of items) {
    if (!i.session) continue
    const list = bySession.get(i.session)
    if (list) list.push(i)
    else bySession.set(i.session, [i])
  }
  const here = (x: Item): string => x.device ?? masterId
  const hasBoardNode = items.some(i => i.device === LEGACY_MASTER)
  const pointsTo = (src: Item, dstId: string): boolean => {
    if (!src.movedTo || !dstId) return false
    if (src.movedTo === dstId) return true
    // Legacy marks saved before master hostname fallback defaulted `moved.to` to 'board'.
    return src.movedTo === LEGACY_MASTER && dstId === masterId && !hasBoardNode
  }
  const staleMark = (x: Item): boolean =>
    typeof x.movedAt === 'number' && Math.max(x.activity ?? 0, x.lastAt ?? 0) > x.movedAt
  return items.filter(i => {
    if (!i.movedTo || !i.session || staleMark(i)) return true
    const src = here(i)
    const group = bySession.get(i.session)
    if (!group || group.length < 2) return true
    return !group.some(j => {
      if (j === i) return false
      const dst = here(j)
      return dst !== '' && dst !== src && pointsTo(i, dst) && (staleMark(j) || !pointsTo(j, src))
    })
  })
}

/**
 * The part of a node's payload the master shows, checked; null when it is not a payload's shape
 * at all. `device`: the node's id, for the master's payload; null for the offline copy, which keeps
 * the node's own keys.
 */
export function nodePart(
  raw: unknown,
  device: string | null,
  options?: { allowParent?: (parentKey: string) => boolean },
): NodePart | null {
  if (!isObject(raw)) return null
  const k: Rekey = device ? key => nodeKey(device, key) : key => key
  const tag = <T extends object>(x: T): T => (device ? { ...x, device } : x)
  const items: Item[] = []
  const launches: LaunchView[] = []
  const schedules: ScheduleEntry[] = []
  const seen = new Set<string>()
  for (const x of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= MOST.items) break
    const item = itemOf(x, k, device, options?.allowParent)
    // Two items with one key: the first, as find() on the node would.
    if (item && !seen.has(item.key)) {
      seen.add(item.key)
      items.push(item)
    }
  }
  for (const x of Array.isArray(raw.launches) ? raw.launches : []) {
    if (launches.length >= MOST.launches) break
    const l = isObject(x) && !Object.hasOwn(x, 'device') ? launch(x, k) : undefined
    if (l) launches.push(tag(l as LaunchView))
  }
  for (const x of Array.isArray(raw.schedules) ? raw.schedules : []) {
    if (schedules.length >= MOST.schedules) break
    const e = isObject(x) && !Object.hasOwn(x, 'device') ? shape(ENTRY, ['id', 'key', 'text', 'next'])(x, k) : undefined
    // A node's watch (#486) runs on the node's own board and stays there: the master would show it
    // as a plain reminder due at its next check.
    if (e && (e as ScheduleEntry).kind !== 'watch') schedules.push(tag(e as ScheduleEntry))
  }
  const machine = nonEmpty(LEN.id)(raw.machine, k) as string | undefined
  return { items, launches, schedules, ...(machine && { machine }) }
}
