// Pure Telegram routing helpers across a master and its nodes (#701).
// No I/O: used by the wake process, master board, and node door handlers.
import { nodeConfig, nodesConfig } from '../nodes.ts'
import type { Item } from '../types.ts'
import { type RouteItem, samePath } from './route.ts'

/** What tg-mcp is told about a topic's messages: delivered, skipped (left in its queue), or retried in `retry` seconds. */
export type RouteResult = { ok: true; note?: string } | { skip: true; note: string } | { retry: number; note?: string }

export interface NodeRouteCandidate {
  id: string
  title: string
  online: boolean
  machine?: string
  items: readonly Item[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when this board is configured only as a node (not a master): a node never polls Telegram itself. */
export function isNodeOnly(cfg: { nodes?: unknown; node?: unknown }): boolean {
  return nodeConfig(cfg.node) !== null && nodesConfig(cfg.nodes) === null
}

/** Machine prefix in an `X-Herdr-Pane` hint (`<machine>:<pane id>`, where `<pane id>` itself has `:`). */
export function hintMachine(hint: string | null | undefined): string | null {
  if (!hint) return null
  const parts = hint.split(':')
  if (parts.length < 3) return null
  return parts[0] ? parts[0] : null
}

/** Pane id part of an `X-Herdr-Pane` hint (stripping the `<machine>:` prefix when present). */
export function hintPane(hint: string | null | undefined): string | null {
  if (!hint) return null
  const parts = hint.split(':')
  if (parts.length < 3) return hint
  return parts.slice(1).join(':') || null
}

/** Returns the remote machine name if `hint` names a machine other than `machine`; else null. */
export function remoteMachineHint(hint: string | null | undefined, machine: string): string | null {
  const m = hintMachine(hint)
  return m !== null && m.toLowerCase() !== machine.toLowerCase() ? m : null
}

/** Compares two Telegram routing keys: exact for `topic:` keys (preserving trailing `/`), path-normalized otherwise. */
export function sameTgKey(a: string, b: string): boolean {
  if (a.startsWith('topic:') || b.startsWith('topic:')) return a === b
  return samePath(a) === samePath(b)
}

const byActivity = (a: Item, b: Item): number =>
  Number(!!a.sleeping) - Number(!!b.sleeping) || (b.activity ?? 0) - (a.activity ?? 0)

/** Matches a node's cached items against a Telegram RouteItem (pane hint, live_panes, tgKey, or cwd). */
export function matchNodeItem(item: RouteItem, items: readonly Item[], machine?: string): Item | null {
  const claudes = items.filter(i => i.agent === 'claude' || !i.agent)
  if (!claudes.length) return null

  const findByPane = (paneId: string | null): Item | null => {
    if (!paneId) return null
    const hits = claudes
      .filter(i => i.pane === paneId || (Array.isArray(i.formerPanes) && i.formerPanes.includes(paneId)))
      .sort(byActivity)
    return hits[0] ?? null
  }

  if (machine && item.pane) {
    const m = hintMachine(item.pane)
    if (m && m.toLowerCase() === machine.toLowerCase()) {
      const hit = findByPane(hintPane(item.pane))
      if (hit) return hit
    }
  }

  if (machine && item.live_panes?.length) {
    for (const hint of item.live_panes) {
      const m = hintMachine(hint)
      if (m && m.toLowerCase() === machine.toLowerCase()) {
        const hit = findByPane(hintPane(hint))
        if (hit) return hit
      }
    }
  }

  const keyHits = claudes
    .filter(
      i =>
        (typeof i.tgKey === 'string' && i.tgKey !== '' && sameTgKey(i.tgKey, item.key)) ||
        (!item.key.startsWith('topic:') && i.cwd && samePath(i.cwd) === samePath(item.key)),
    )
    .sort(byActivity)
  return keyHits[0] ?? null
}

/** Orders candidate node devices by likelihood of owning `item`, preserving input order on ties. */
export function orderNodeDevices(item: RouteItem, devices: readonly NodeRouteCandidate[]): NodeRouteCandidate[] {
  const paneMach = hintMachine(item.pane)?.toLowerCase() ?? null
  const liveMachs = new Set(
    (item.live_panes ?? []).map(h => hintMachine(h)?.toLowerCase()).filter((m): m is string => !!m),
  )

  const rank = (d: NodeRouteCandidate): number => {
    const m = d.machine?.toLowerCase()
    if (m && paneMach === m) return 0
    if (m && liveMachs.has(m)) return 1
    const hit = matchNodeItem(item, d.items, d.machine)
    if (hit) return hit.sleeping ? 3 : 2
    return 4
  }

  return devices
    .map((d, index) => ({ d, index, score: rank(d) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(x => x.d)
}

export const MAX_ROUTE_ITEMS = 100
const MAX_KEY_LEN = 1024
const MAX_HINT_LEN = 256
const MAX_TEXT_LEN = 16_000
const MAX_LIVE_PANES = 50
const MAX_META_KEYS = 30

function parseRouteItem(raw: unknown): RouteItem | null {
  if (!isRecord(raw)) return null
  if (typeof raw.key !== 'string' || !raw.key || raw.key.length > MAX_KEY_LEN) return null
  const item: RouteItem = { key: raw.key }

  if (raw.pane !== undefined) {
    if (typeof raw.pane !== 'string' || raw.pane.length > MAX_HINT_LEN) return null
    item.pane = raw.pane
  }
  if (raw.topic !== undefined) {
    if (typeof raw.topic !== 'string' || raw.topic.length > MAX_HINT_LEN) return null
    item.topic = raw.topic
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT_LEN) return null
    item.text = raw.text
  }
  if (raw.queued_at !== undefined) {
    if (typeof raw.queued_at !== 'string' || raw.queued_at.length > 64) return null
    item.queued_at = raw.queued_at
  }
  if (raw.live_panes !== undefined) {
    if (
      !Array.isArray(raw.live_panes) ||
      raw.live_panes.length > MAX_LIVE_PANES ||
      !raw.live_panes.every(p => typeof p === 'string' && p.length <= MAX_HINT_LEN)
    )
      return null
    item.live_panes = raw.live_panes as string[]
  }
  if (raw.meta !== undefined) {
    if (!isRecord(raw.meta)) return null
    const entries = Object.entries(raw.meta)
    if (entries.length > MAX_META_KEYS) return null
    const meta: Record<string, string | undefined> = {}
    for (const [k, v] of entries) {
      if (k.length > 64) return null
      if (typeof v === 'string') meta[k] = v.slice(0, MAX_TEXT_LEN)
      else if (typeof v === 'number' && Number.isFinite(v)) meta[k] = String(v)
      else if (v !== undefined) return null
    }
    item.meta = meta
  }
  if (raw.id !== undefined) {
    if (typeof raw.id === 'number') {
      if (!Number.isFinite(raw.id)) return null
      item.id = raw.id
    } else if (typeof raw.id === 'string') {
      if (raw.id.length > 128) return null
      item.id = raw.id
    } else return null
  }
  return item
}

/** Validates an incoming `/api/nodes/telegram`, `/api/node/telegram`, or `/route` request body. */
export function parseRouteItemsBody(raw: unknown): { items: RouteItem[]; liveOnly: boolean } | null {
  if (!isRecord(raw)) return null
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_ROUTE_ITEMS) return null
  if (raw.liveOnly !== undefined && typeof raw.liveOnly !== 'boolean') return null
  const items: RouteItem[] = []
  for (const entry of raw.items) {
    const parsed = parseRouteItem(entry)
    if (!parsed) return null
    items.push(parsed)
  }
  return { items, liveOnly: raw.liveOnly === true }
}

/** Runtime type guard for a RouteResult returned over HTTP/RPC. */
export function isRouteResult(v: unknown): v is RouteResult {
  if (!isRecord(v)) return false
  if (v.ok === true) return v.note === undefined || typeof v.note === 'string'
  if (v.skip === true) return typeof v.note === 'string'
  if (typeof v.retry === 'number' && Number.isFinite(v.retry) && v.retry > 0)
    return v.note === undefined || typeof v.note === 'string'
  return false
}

export const NODE_WAKE_TIMEOUT_SLACK_SEC = 45
export const MASTER_NODE_TIMEOUT_SLACK_SEC = 60
export const WAKE_MASTER_TIMEOUT_SLACK_SEC = 90

export const nodeWakeTimeoutMs = (wakeTimeoutSec: number): number =>
  (wakeTimeoutSec + NODE_WAKE_TIMEOUT_SLACK_SEC) * 1000
export const masterNodeTimeoutMs = (wakeTimeoutSec: number): number =>
  (wakeTimeoutSec + MASTER_NODE_TIMEOUT_SLACK_SEC) * 1000
export const wakeMasterTimeoutMs = (wakeTimeoutSec: number): number =>
  (wakeTimeoutSec + WAKE_MASTER_TIMEOUT_SLACK_SEC) * 1000

const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ConnectionRefused', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'])

/** True only for definite pre-connect failures where the request could not have reached the node. */
export function isPreConnectError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const rec = err as { code?: unknown; cause?: unknown }
  const direct = typeof rec.code === 'string' ? rec.code : null
  if (direct && PRE_CONNECT_CODES.has(direct)) return true
  if (typeof rec.cause === 'object' && rec.cause !== null) {
    const c = (rec.cause as { code?: unknown }).code
    if (typeof c === 'string' && PRE_CONNECT_CODES.has(c)) return true
  }
  return false
}

export const offlineHeldNote = (title: string): string =>
  `💤 Устройство «${title}» не в сети. Сообщение сохранено и будет доставлено, когда оно подключится.`

export const offlineRetryNote = (title: string): string =>
  `💤 Устройство «${title}» не в сети. Доставлю, когда оно подключится.`

export const ambiguousDeliveryNote = (title: string): string =>
  `⚠️ Устройство «${title}» не подтвердило доставку вовремя. Сообщение не дублировано: проверьте сессию.`
