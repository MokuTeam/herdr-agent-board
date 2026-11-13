// The bridge's config.json (#384, design 9.2): read once at start and again on SIGHUP. Everything
// but `hub`, `name`, `allow` and `inbox.topic` has a default.
import { join } from 'node:path'
import { normalizeHub, validName } from '../../src/core/team.ts'
import { isLocation } from './protocol.ts'

export type Role = 'owner' | 'member'

/** A peer the assistant takes messages from (design 8.1): by roster name, pinned to `peer` when given. */
export interface AllowEntry {
  name: string
  role: Role
  peer?: string
}

/**
 * A name a location is published and spoken under (design 4.1): the `agent` of what it sends, and a
 * new topic titled `[<alias>] ...` goes there (rule 3 of 4.2) when the alias is published to its sender.
 */
export interface PublishEntry {
  alias: string
  /** `host:inbox`, `host:<topic id or name>` or `group:<agent group id>` (phase 3). */
  at: string
  about: string
  members: boolean
}

export interface BridgeConfig {
  /** The hub's base address, as a board's `team.hub`: ws:// or wss://, no path. */
  hub: string
  /** The bridge's roster name. */
  name: string
  socket: string
  allow: AllowEntry[]
  /** The inbox topic, by NanoClaw's thread id or the topic's name as the bot recorded it. */
  inbox: { topic: string; notice: 'title' | 'none' }
  publish: PublishEntry[]
  wake: { gapSec: number; maxPerHour: number }
  /** Times of day (server time, HH:MM) the batch is read. */
  batch: { at: string[] }
  loop: number
  refuse: 'once' | 'silent'
}

export type ConfigResult = { ok: true; cfg: BridgeConfig } | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ALIAS = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Reads config.json's object; `dir` is the state directory (the socket's default home). */
export function parseConfig(raw: unknown, dir: string): ConfigResult {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['config.json is not a JSON object'] }
  const hub = normalizeHub(raw.hub)
  if (!hub) errors.push('hub: a ws:// or wss:// address')
  const name = typeof raw.name === 'string' && validName(raw.name) ? raw.name : null
  if (!name) errors.push('name: 1 to 40 printable characters')

  const allow: AllowEntry[] = []
  if (!Array.isArray(raw.allow) || raw.allow.length === 0) errors.push('allow: at least one peer')
  else
    for (const [i, a] of raw.allow.entries()) {
      if (!isRecord(a) || typeof a.name !== 'string' || !validName(a.name)) {
        errors.push(`allow[${i}]: a name`)
        continue
      }
      const role = a.role === undefined ? 'owner' : a.role
      if (role !== 'owner' && role !== 'member') {
        errors.push(`allow[${i}].role: owner or member`)
        continue
      }
      if (a.peer !== undefined && (typeof a.peer !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.peer))) {
        errors.push(`allow[${i}].peer: a peer id (43 characters)`)
        continue
      }
      if (allow.some(x => x.name === a.name)) {
        errors.push(`allow[${i}]: ${a.name} twice`)
        continue
      }
      allow.push({ name: a.name, role, ...(typeof a.peer === 'string' && { peer: a.peer }) })
    }
  if (allow.length > 0 && !allow.some(a => a.role === 'owner')) errors.push('allow: one peer with role owner')

  const inboxRaw = isRecord(raw.inbox) ? raw.inbox : {}
  const topic = typeof inboxRaw.topic === 'string' && inboxRaw.topic.trim() ? inboxRaw.topic.trim() : null
  if (!topic) errors.push('inbox.topic: the inbox topic, by thread id or name')
  const notice = inboxRaw.notice === undefined ? 'title' : inboxRaw.notice
  if (notice !== 'title' && notice !== 'none') errors.push('inbox.notice: title or none')

  const publish: PublishEntry[] = []
  if (raw.publish !== undefined && !Array.isArray(raw.publish)) errors.push('publish: a list')
  for (const [i, p] of (Array.isArray(raw.publish) ? raw.publish : []).entries()) {
    if (!isRecord(p) || typeof p.alias !== 'string' || !ALIAS.test(p.alias)) {
      errors.push(`publish[${i}].alias: lowercase letters, digits and -, up to 32`)
      continue
    }
    if (!isLocation(p.at) || (p.at.startsWith('group:') && p.at.includes('/'))) {
      errors.push(`publish[${i}].at: host:inbox, host:<topic> or group:<agent group id>`)
      continue
    }
    if (publish.some(x => x.alias === p.alias)) {
      errors.push(`publish[${i}]: ${p.alias} twice`)
      continue
    }
    publish.push({
      alias: p.alias,
      at: p.at,
      about: typeof p.about === 'string' ? p.about.slice(0, 160) : '',
      members: p.members === true,
    })
  }

  const wakeRaw = isRecord(raw.wake) ? raw.wake : {}
  const gapSec = wakeRaw.gapSec === undefined ? 60 : wakeRaw.gapSec
  const maxPerHour = wakeRaw.maxPerHour === undefined ? 10 : wakeRaw.maxPerHour
  if (!intIn(gapSec, 0, 3600)) errors.push('wake.gapSec: 0 to 3600')
  if (!intIn(maxPerHour, 1, 1000)) errors.push('wake.maxPerHour: 1 to 1000')

  const batchRaw = isRecord(raw.batch) ? raw.batch : {}
  const at = batchRaw.at === undefined ? ['09:00', '18:00'] : batchRaw.at
  if (!Array.isArray(at) || at.length === 0 || !at.every(t => typeof t === 'string' && HHMM.test(t)))
    errors.push('batch.at: a list of HH:MM times')

  const loop = raw.loop === undefined ? 20 : raw.loop
  if (!intIn(loop, 1, 100)) errors.push('loop: 1 to 100')
  const refuse = raw.refuse === undefined ? 'once' : raw.refuse
  if (refuse !== 'once' && refuse !== 'silent') errors.push('refuse: once or silent')
  const socket = raw.socket === undefined ? join(dir, 'bridge.sock') : raw.socket
  if (typeof socket !== 'string' || !socket) errors.push('socket: a path')

  if (errors.length > 0 || !hub || !name || !topic) return { ok: false, errors }
  return {
    ok: true,
    cfg: {
      hub,
      name,
      socket: socket as string,
      allow,
      inbox: { topic, notice: notice as 'title' | 'none' },
      publish,
      wake: { gapSec: gapSec as number, maxPerHour: maxPerHour as number },
      batch: { at: [...new Set(at as string[])].sort() },
      loop: loop as number,
      refuse: refuse as 'once' | 'silent',
    },
  }
}
