// Wake's Telegram router (#119): long-polls tg-mcp's router queue (`/router/wait`, tg-mcp started
// with ROUTER=1), finds the herdr pane each topic's messages are for (core/wake/route.ts resolve),
// wakes the pane's sleeping session first through the engine (`board resume <id> --profile <id>`,
// so in its own profile), types the messages in as one `[telegram …]` prompt and acks each one. A
// port of herdr-wake's router.mjs (route, deliverLive, ack, handleGroup, groupByKey, pollLoop), its
// notes to Telegram word for word.
//
// It polls only while `target()` gives tg-mcp's url and token, which core/wake/config.ts does only
// with Telegram set to Auto: off by default, with no request at all, tg-mcp in ~/.claude.json or
// not. The token goes into the Authorization header and nowhere else: never into the log, nor into
// the state it reports (off, polling the host, or the last poll's error).
import type { HerdrSnapshot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { knobMs } from '../../adapters/pacing.ts'
import type { WakeHerdr } from '../../adapters/wake-herdr.ts'
import { AGY_AGENT } from '../../core/agy.ts'
import { agyDraft } from '../../core/dialogs/agy-dialogs.ts'
import { inputDraft } from '../../core/dialogs/input-box.ts'
import { piDraft } from '../../core/dialogs/pi-dialogs.ts'
import type { TelegramTarget } from '../../core/wake/config.ts'
import { isRouteResult, MAX_ROUTE_ITEMS, type RouteResult, remoteMachineHint } from '../../core/wake/node-route.ts'
import { formatPrompt, type RouteItem, type RouteTarget, resolve } from '../../core/wake/route.ts'
import type { TelegramStatus } from '../../core/wake/status.ts'
import type { WakeEngine } from './engine.ts'
import { type Timing, type WakeOutcome, waitReady, withPane } from './pane-ops.ts'

/** What tg-mcp is told about a topic's messages: delivered, skipped (left in its queue), or retried in `retry` seconds. */
export type { RouteResult }

export interface TelegramDeps {
  engine: WakeEngine
  herdr: WakeHerdr
  /** tg-mcp's url and token now (core/wake/config.ts telegramTarget); null while Telegram is off or none is found. Read at each poll. */
  target(): TelegramTarget | null
  /** This computer's name, as sessions put it before their pane id in X-Herdr-Pane. */
  machine: string
  /** How long tg-mcp may hold a poll (wake.pollTimeoutSec), read at each poll. */
  pollTimeoutSec(): number
  log(text: string): void
  /** The router's state changed: off, polling, or its last poll failed. */
  onState?(state: TelegramStatus): void
  /** Remote node delivery on a master (#701); returns null when no node owns the topic. */
  remote?(items: RouteItem[], o?: { liveOnly?: boolean }): Promise<RouteResult | null>
  /** Whether remote routing is active now (nodes configured); when false, local routing skips `remote`. */
  hasRemote?(): boolean
  /** Tests: the HTTP client and the pause between failed polls. */
  fetch?(url: string, init: RequestInit): Promise<Response>
  sleep?(ms: number): Promise<void>
}

export interface Telegram {
  /** Polls tg-mcp from now on, when `target()` gives its url and token; nothing while it polls already. */
  start(): void
  /** No more polls: the one under way is cut off; messages it already got are still delivered. */
  stop(): void
  /** Delivers one topic's messages (a poll's group, or --deliver's one): no request to tg-mcp. */
  route(items: RouteItem[]): Promise<RouteResult>
  /** Delivers locally on this machine if a local target matches; returns `{ matched: false }` otherwise (#701). */
  routeLocal(
    items: RouteItem[],
    o?: { liveOnly?: boolean },
  ): Promise<{ matched: false } | { matched: true; result: RouteResult }>
}

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000
/** How much longer than its own timeout a poll may take before it is given up. */
const POLL_GRACE_SEC = 20
const ACK_TIMEOUT_MS = 30_000
/** How long a running session that waits for a decision has before its message is retried. */
const BLOCKED_WAIT_MS = 30_000
/** A routing that threw: retried after this many seconds, without a note. */
const RETRY_AFTER_ERROR_SEC = 30
const NO_ROUTER = 'the server has no router endpoints (ROUTER=1 not set?)'

// herdr-wake's notes to Telegram (router.mjs), word for word.
export const BLOCKED: RouteResult = {
  retry: 60,
  note: '⏳ Сессия ждёт решения в терминале. Доставлю, когда освободится.',
}
export const TRUST: RouteResult = {
  retry: 60,
  note: '🔐 Сессия спрашивает, доверять ли папке проекта. Ответь в терминале, и я доставлю.',
}
export const BUSY: RouteResult = {
  retry: 120,
  note: '⏳ Панель сессии занята другой программой. Доставлю, когда она освободится.',
}
export const LATE: RouteResult = { retry: 60, note: '⏳ Сессия не успела запуститься, попробую ещё раз.' }
export const DIALOG: RouteResult = { retry: 30, note: '⏳ В сессии открыт диалог. Доставлю, когда закроется.' }
export const DRAFT: RouteResult = {
  retry: 30,
  note: '✍️ В поле ввода сессии недописанный текст. Доставлю, когда оно освободится.',
}
export const missing = (topic: string): RouteResult => ({
  skip: true,
  note: `🤷 Не нашёл в herdr сессию для «${topic}». Сообщение ждёт в очереди: агент получит его, когда подключится.`,
})
export const wokeNote = (title: string): string => `⏰ Разбудил сессию${title ? ` «${title}»` : ''}.`

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A topic's messages in the order they came, one group per key. */
export function groupByKey(items: readonly RouteItem[]): RouteItem[][] {
  const groups = new Map<string, RouteItem[]>()
  for (const it of items) groups.set(it.key, [...(groups.get(it.key) ?? []), it])
  return [...groups.values()]
}

/** One message as tg-mcp hands it out, each field only when of its type (meta's numbers as text). */
export function asRouteItem(it: Record<string, unknown>): RouteItem {
  const meta = isRecord(it.meta)
    ? Object.fromEntries(
        Object.entries(it.meta).flatMap(([k, v]) =>
          typeof v === 'string' ? [[k, v]] : typeof v === 'number' ? [[k, String(v)]] : [],
        ),
      )
    : null
  const id = typeof it.id === 'number' || typeof it.id === 'string' ? it.id : undefined
  return {
    key: typeof it.key === 'string' ? it.key : '',
    ...(typeof it.pane === 'string' && { pane: it.pane }),
    ...(Array.isArray(it.live_panes) && { live_panes: it.live_panes.filter(p => typeof p === 'string') }),
    ...(typeof it.topic === 'string' && { topic: it.topic }),
    ...(typeof it.text === 'string' && { text: it.text }),
    ...(meta && { meta }),
    ...(typeof it.queued_at === 'string' && { queued_at: it.queued_at }),
    ...(id !== undefined && { id }),
  }
}

/** `/router/wait`'s `{ items }`; an answer without an items list is an error, as it was for the old router. */
function routeItems(body: unknown): RouteItem[] {
  const items = isRecord(body) ? body.items : undefined
  if (!Array.isArray(items)) throw new Error('tg-mcp answered without items')
  return items.flatMap(it => (isRecord(it) ? [asRouteItem(it)] : []))
}

/** herdr's snapshot as resolve reads it: the tabs' labels and numbers, and the agents' order, only when of their type. */
export function routeSnapshot(snap: HerdrSnapshot): Parameters<typeof resolve>[1] {
  const agents = Array.isArray(snap.agents) ? snap.agents : []
  return {
    workspaces: snap.workspaces,
    tabs: snap.tabs.map(t => ({
      tab_id: t.tab_id,
      workspace_id: t.workspace_id,
      ...(typeof t.label === 'string' && { label: t.label }),
      ...(typeof t.number === 'number' && { number: t.number }),
    })),
    panes: snap.panes,
    agents: agents.flatMap(a =>
      isRecord(a) && typeof a.pane_id === 'string'
        ? [
            {
              pane_id: a.pane_id,
              ...(typeof a.state_change_seq === 'number' && { state_change_seq: a.state_change_seq }),
            },
          ]
        : [],
    ),
  }
}

/** A poll loop's own: stopped, and what cuts its request and its pause short. */
interface Run {
  stopped: boolean
  abort: AbortController
}

/** Types the prompt into a running Claude, unless it waits for a decision, shows a dialog, or has text in its input box. */
export async function deliverLive(herdr: WakeHerdr, pane: string, text: string, timing: Timing): Promise<RouteResult> {
  const agent = await herdr.agent(pane)
  if (!agent) throw new Error(`no agent runs in ${pane}`)
  // A pi or agy session only ever gets here woken from its sleep (#178, #631): its own input box.
  if (agent.kind === 'pi' || agent.kind === AGY_AGENT) {
    if (agent.status === 'blocked') return BLOCKED
    const draft = agent.kind === AGY_AGENT ? agyDraft(await herdr.inputBox(pane)) : piDraft(await herdr.screen(pane))
    if (draft === null) return DIALOG
    if (draft) return DRAFT
    await herdr.prompt(pane, text)
    return { ok: true }
  }
  if (agent.status === 'blocked') {
    const state = await waitReady(herdr, pane, knobMs('BOARD_TG_BLOCKED_WAIT_MS', BLOCKED_WAIT_MS), timing)
    if (state !== 'ready') return state === 'trust' ? TRUST : BLOCKED
  }
  const draft = inputDraft(await herdr.inputBox(pane))
  if (draft === null) return DIALOG
  if (draft) return DRAFT
  await herdr.prompt(pane, text)
  return { ok: true }
}

/** Why the pane's session did not wake, as Telegram is told; one wake cannot reach is left in tg-mcp's queue. */
export function notWoken(
  pane: string,
  woke: Exclude<WakeOutcome, { ok: true }>,
  topic: string,
  log: (text: string) => void,
): RouteResult {
  switch (woke.why) {
    case 'busy':
      return BUSY
    case 'timeout':
      return LATE
    case 'trust':
      return TRUST
    case 'blocked':
      return BLOCKED
    case 'line':
      log(`cannot wake the session in ${pane}: ${woke.error}`)
      return missing(topic)
  }
}

/** Posts a topic batch to the master board's `/api/nodes/telegram`; 400/413 are terminal skips, 404/405 mean disabled. */
export async function postMasterTelegram(
  url: string,
  items: RouteItem[],
  opts: { liveOnly?: boolean } | undefined,
  timeoutMs: number,
  log: (line: string) => void,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<RouteResult | null> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ items, ...(opts?.liveOnly && { liveOnly: true }) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 404 || res.status === 405) return null
  if (res.status === 400 || res.status === 413) {
    log(`telegram: master board rejected ${items.length} item(s) with HTTP ${res.status}; skipping batch`)
    return {
      skip: true,
      note: '⚠️ Не удалось передать сообщение на ноду: некорректный или слишком большой запрос.',
    }
  }
  if (!res.ok) throw new Error(`master board HTTP ${res.status}`)
  const data: unknown = await res.json().catch(() => null)
  if (isRecord(data) && data.matched === true && isRouteResult(data.result)) return data.result
  return null
}

/** Delivers `items` to `target` (waking a sleeping target first when `target.session` is set). */
export function deliverTarget(
  target: RouteTarget,
  items: RouteItem[],
  opts: {
    herdr: WakeHerdr
    wakePane: (target: RouteTarget) => Promise<WakeOutcome>
    timing: Timing
    log: (text: string) => void
  },
): Promise<RouteResult> {
  const first = items[0]
  if (!first) return Promise.resolve({ ok: true })
  const topic = first.topic ?? first.key
  return withPane(target.pane, async (): Promise<RouteResult> => {
    // A sleeper whose pane wake closed wakes in a new tab (#204): the message goes there.
    let pane = target.pane
    let wokeHere = Boolean(target.session)
    if (target.session) {
      const woke = await opts.wakePane(target)
      if (!woke.ok) return notWoken(target.pane, woke, topic, opts.log)
      pane = woke.pane ?? pane
      if (woke.already) wokeHere = false
    }
    const r = await withPane(pane, () => deliverLive(opts.herdr, pane, formatPrompt(items), opts.timing))
    if (!('ok' in r)) return r
    opts.log(`delivered ${items.length} message(s) for ${first.key} to ${pane}${wokeHere ? ' after waking it' : ''}`)
    return wokeHere ? { ok: true, note: wokeNote(target.title) } : r
  })
}

export function createTelegram(o: TelegramDeps): Telegram {
  const fetchFn = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const timing: Timing = { log: text => o.log(text), ...(o.sleep && { sleep: o.sleep }) }
  const now = o.engine.telegram
  /** Message id → the notes already sent with it, so a retry's note is said once. */
  const notified = new Map<RouteItem['id'], Set<string>>()
  let run: Run | null = null

  function report(next: TelegramStatus): void {
    const was = now.status
    if (was.state === next.state && was.host === next.host && was.error === next.error) return
    now.status = next
    o.onState?.(next)
  }

  /** `ms`, or less once the loop is stopped. */
  const pauseFor = (ms: number, r: Run): Promise<void> =>
    new Promise(resolve => {
      const signal = r.abort.signal
      if (signal.aborted) return resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done)
      if (o.sleep) void o.sleep(ms).then(done)
      else timer = setTimeout(done, ms)
    })

  const deliver = (target: RouteTarget, items: RouteItem[]): Promise<RouteResult> =>
    deliverTarget(target, items, {
      herdr: o.herdr,
      wakePane: t => o.engine.wakePane(t.pane),
      timing,
      log: o.log,
    })

  function routeLocal(
    items: RouteItem[],
    opts?: { liveOnly?: boolean },
  ): Promise<{ matched: false } | { matched: true; result: RouteResult }> {
    const first = items[0]
    if (!first) return Promise.resolve({ matched: true, result: { ok: true } })
    return o.engine.deliver(async () => {
      const { snap, sessions } = await o.engine.seen()
      const target = resolve(first, routeSnapshot(snap), sessions, o.machine)
      if (!target || (opts?.liveOnly && target.session)) return { matched: false }
      return { matched: true, result: await deliver(target, items) }
    })
  }

  function route(items: RouteItem[]): Promise<RouteResult> {
    const first = items[0]
    if (!first) return Promise.resolve({ ok: true })
    const topic = first.topic ?? first.key
    const remoteFn = o.remote && (!o.hasRemote || o.hasRemote()) ? o.remote : null
    if (!remoteFn) {
      return o.engine.deliver(async () => {
        const { snap, sessions } = await o.engine.seen()
        const target = resolve(first, routeSnapshot(snap), sessions, o.machine)
        if (!target) return missing(topic)
        return deliver(target, items)
      })
    }
    return o.engine.deliver(async () => {
      const remoteFirst = remoteMachineHint(first.pane, o.machine) !== null
      if (remoteFirst) {
        const r = await remoteFn(items)
        if (r !== null) return r
      }
      const { snap, sessions } = await o.engine.seen()
      const target = resolve(first, routeSnapshot(snap), sessions, o.machine)
      if (target && !target.session) return deliver(target, items)
      if (target?.session) {
        if (!remoteFirst) {
          const liveRemote = await remoteFn(items, { liveOnly: true })
          if (liveRemote !== null) return liveRemote
        }
        return deliver(target, items)
      }
      if (!remoteFirst) {
        const r = await remoteFn(items)
        if (r !== null) return r
      }
      return missing(topic)
    })
  }

  async function ack(
    t: TelegramTarget,
    id: RouteItem['id'],
    outcome: string,
    note: string | undefined,
    retrySec: number | undefined,
  ): Promise<void> {
    const res = await fetchFn(`${t.url}/router/ack`, {
      method: 'POST',
      headers: { Authorization: t.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ id, outcome, note, retry_sec: retrySec }),
      signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async function ackGroupItems(
    t: TelegramTarget,
    chunk: RouteItem[],
    r: RouteResult,
    key: string,
  ): Promise<'delivered' | 'skipped' | 'retry'> {
    const outcome = 'ok' in r ? 'delivered' : 'skip' in r ? 'skipped' : 'retry'
    if (outcome !== 'delivered') o.log(`${outcome} ${chunk.length} message(s) for ${key}${r.note ? `: ${r.note}` : ''}`)
    const retrySec = 'retry' in r ? r.retry : undefined
    for (const [i, it] of chunk.entries()) {
      let note = i === 0 ? r.note : undefined
      if (outcome === 'retry' && note) {
        const said = notified.get(it.id) ?? new Set<string>()
        if (said.has(note)) note = undefined
        else said.add(note)
        notified.set(it.id, said)
      }
      if (outcome !== 'retry') notified.delete(it.id)
      await ack(t, it.id, outcome, note, retrySec).catch(err => o.log(`ack ${it.id} failed: ${messageOf(err)}`))
    }
    return outcome
  }

  /** Routes a topic's messages and acks each to the tg-mcp that handed them out; under way until the last ack. */
  function handleGroup(items: RouteItem[], t: TelegramTarget): Promise<void> {
    const key = items[0]?.key ?? ''
    return o.engine.deliver(async () => {
      const remoteActive = Boolean(o.remote && (!o.hasRemote || o.hasRemote()))
      const chunks =
        remoteActive && items.length > MAX_ROUTE_ITEMS
          ? Array.from({ length: Math.ceil(items.length / MAX_ROUTE_ITEMS) }, (_, i) =>
              items.slice(i * MAX_ROUTE_ITEMS, (i + 1) * MAX_ROUTE_ITEMS),
            )
          : [items]
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx] ?? []
        let r: RouteResult
        try {
          r = await route(chunk)
        } catch (err) {
          o.log(`routing ${key} failed: ${messageOf(err)}`)
          r = { retry: RETRY_AFTER_ERROR_SEC }
        }
        const outcome = await ackGroupItems(t, chunk, r, key)
        if (outcome !== 'delivered' && idx + 1 < chunks.length) {
          const rest = items.slice((idx + 1) * MAX_ROUTE_ITEMS)
          await ackGroupItems(t, rest, r, key)
          return
        }
      }
    })
  }

  /** Polls until stopped, or until tg-mcp's url and token are gone; a failed poll is retried after 1 s, doubling to 60 s. */
  async function poll(r: Run): Promise<void> {
    let backoff = MIN_BACKOFF_MS
    while (!r.stopped) {
      const t = o.target()
      if (!t) {
        if (run === r) stop()
        return
      }
      try {
        const timeoutSec = o.pollTimeoutSec()
        const res = await fetchFn(`${t.url}/router/wait?timeout=${timeoutSec}`, {
          headers: { Authorization: t.authorization },
          signal: AbortSignal.any([r.abort.signal, AbortSignal.timeout((timeoutSec + POLL_GRACE_SEC) * 1000)]),
        })
        if (res.status === 404) throw new Error(NO_ROUTER)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const items = routeItems(await res.json())
        // Handed out by tg-mcp: delivered even when the poll was stopped meanwhile.
        for (const group of groupByKey(items))
          void handleGroup(group, t).catch(err => o.log(`routing ${group[0]?.key ?? ''} failed: ${messageOf(err)}`))
        if (r.stopped) return
        now.lastPoll = new Date().toISOString()
        if (now.lastError !== null) o.log('connected to tg-mcp again')
        now.lastError = null
        report({ state: 'polling', host: t.host })
        backoff = MIN_BACKOFF_MS
      } catch (err) {
        if (r.stopped) return
        const message = messageOf(err)
        if (now.lastError !== message) o.log(`poll failed: ${message}`)
        now.lastError = message
        report({ state: 'error', host: t.host, error: message })
        await pauseFor(backoff, r)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  function start(): void {
    if (run) return
    const t = o.target()
    if (!t) return
    const r: Run = { stopped: false, abort: new AbortController() }
    run = r
    o.log(`Telegram on: polling tg-mcp at ${t.host}`)
    report({ state: 'polling', host: t.host })
    void poll(r).catch(err => o.log(`Telegram's poll ended: ${messageOf(err)}`))
  }

  function stop(): void {
    const r = run
    if (!r) return
    run = null
    r.stopped = true
    r.abort.abort()
    now.lastError = null
    o.log('Telegram off')
    report({ state: 'off' })
  }

  return { start, stop, route, routeLocal }
}
