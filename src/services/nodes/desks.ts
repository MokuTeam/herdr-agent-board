// The master's side of the owner's desk (#788, core/desk.ts). Made by server/app.ts; it does
// anything only while config.json has `nodes` (`on`), and a board without them never calls it.
//
// - Presence: each detection step asks every online node the owner's mesh counts (not turned off,
//   `nodes.devices.<id>.owner: false`, nor revoked) for its desk over the node's door
//   (GET /api/node/desk), and this computer too where it has a desktop; the most recently active
//   desk is the observation presence detection reads. A desk heard from before that does not
//   answer now (its lid closed, its link gone) counts as idle since the owner last touched it, so
//   the owner goes away once every desk is past the limit. A headless master that never heard a
//   desk says nothing, so it never puts the owner "at the computer" by itself.
// - Notifications: a calendar reminder or a Team message goes to that one desk, once: a node's
//   through its door (POST /api/node/desk-toast), which shows it with its own notifier; this
//   computer's with its own. A node that does not take it gives way to the next desk; no desk at
//   all: this computer's, only where it has a desktop. Readings older than FRESH_MS are asked again
//   first, and asks that overlap share one round.
import { combineDesks, type DeskReading, type DeskToast, deskReadingOf, rankDesks } from '../../core/desk.ts'
import type { Observation } from '../../core/presence.ts'
import type { ReminderDesktop, ReminderToast } from '../../integrations/reminder-toast.ts'
import type { TeamDesktop, TeamToast } from '../../integrations/team-toast.ts'
import type { NodeLinks } from './links.ts'

export interface Desks {
  /** Whether the desks are asked: `nodes` on. Off, the board reads its own computer as before. */
  on(): boolean
  /** Every desk asked now; what they say together (core/desk.ts combineDesks). */
  observe(): Promise<Observation>
  /** The reminders' notifications, each on the active desk. */
  reminder: ReminderDesktop
  /** Team's notifications, each on the active desk. */
  team: TeamDesktop
}

export interface DesksOptions {
  on(): boolean
  links(): Pick<NodeLinks, 'link'> | null
  /** The device ids of `nodes.devices`, this computer's left out. */
  deviceIds(): readonly string[]
  /** The device counts as the owner's: not `owner: false`, not revoked. */
  ownerAllowed(id: string): boolean
  /** Whether this computer has a desktop (adapters/idle.ts hasDesktop). */
  desktopHere(): boolean
  /** This computer's reading (adapters/idle.ts observe). */
  observeHere(): Promise<Observation>
  /** This computer's own notifiers, made when first used. */
  local: { reminder(): ReminderDesktop; team(): TeamDesktop }
  log(text: string): void
  now?: () => number
  /** How long a node has to answer the ask: its own reading may take PowerShell some seconds. */
  askMs?: number
}

/** Readings this old are asked again before a notification picks its desk. */
export const FRESH_MS = 45_000
/** As adapters/idle.ts gives each reader of the computer. */
const ASK_MS = 10_000
const TOAST_MS = 5000
/** How many reminders' desks are remembered, for their clear. */
const SHOWN_MAX = 200

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const timedOut = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError'

export function createDesks(o: DesksOptions): Desks {
  const now = o.now ?? Date.now
  const askMs = o.askMs ?? ASK_MS
  /** The last round: the desks that answered in it. */
  let last: { at: number; readings: DeskReading[] } | null = null
  let round: Promise<DeskReading[]> | null = null
  /** Each desk's last answer, by device (`''` this computer): one gone quiet counts as idle since then. */
  const heard = new Map<string, DeskReading>()
  /** The devices that did not answer the last ask, so a quiet one is logged once. */
  const quiet = new Set<string>()
  /** Each reminder by id: where it went (`''` this computer, null nowhere), or the route still on its way. */
  const shownOn = new Map<string, Promise<string | null>>()

  async function here(): Promise<DeskReading | null> {
    if (!o.desktopHere()) return null
    try {
      const obs = await o.observeHere()
      const at = now()
      return obs.idleSec === null && obs.locked === null
        ? null
        : { device: '', idleSec: obs.idleSec, locked: obs.locked, at }
    } catch {
      return null
    }
  }

  async function ask(id: string): Promise<DeskReading | null> {
    const link = o.links()?.link(id)
    if (link?.state().state !== 'online' || !o.ownerAllowed(id)) return null
    try {
      const res = await link.fetch('/api/node/desk', { signal: AbortSignal.timeout(askMs) })
      // A node without the route (an older version) is no desk.
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const r = deskReadingOf(await res.json(), id, now())
      quiet.delete(id)
      return r
    } catch (err) {
      if (!quiet.has(id)) o.log(`desk: ${id} did not answer: ${messageOf(err)}`)
      quiet.add(id)
      return null
    }
  }

  /** One round of asks; one already on its way is shared. */
  function poll(): Promise<DeskReading[]> {
    round ??= (async () => {
      try {
        const ids = o.deviceIds()
        const got = await Promise.all([here(), ...ids.map(ask)])
        const readings = got.filter((r): r is DeskReading => r !== null)
        last = { at: now(), readings }
        for (const r of readings) heard.set(r.device, r)
        // A device gone from config.json, or no longer the owner's, is forgotten.
        for (const id of heard.keys()) if (id !== '' && (!ids.includes(id) || !o.ownerAllowed(id))) heard.delete(id)
        if (!o.desktopHere()) heard.delete('')
        return readings
      } finally {
        round = null
      }
    })()
    return round
  }

  /** For presence: each desk heard from, a quiet one as idle since the owner last touched it there. */
  function withQuiet(readings: readonly DeskReading[]): DeskReading[] {
    const at = now()
    const answered = new Set(readings.map(r => r.device))
    const out = [...readings]
    for (const [device, r] of heard) {
      if (answered.has(device)) continue
      const idleSec = r.locked === true ? null : (at - r.at) / 1000 + (r.idleSec ?? 0)
      out.push({ device, idleSec, locked: r.locked === true ? true : null, at })
    }
    return out
  }

  /** The desks a notification may go to, the most recently active first. */
  async function targets(): Promise<DeskReading[]> {
    const kept = last && now() - last.at <= FRESH_MS ? last.readings : null
    const online = (r: DeskReading): boolean => r.device === '' || o.links()?.link(r.device)?.state().state === 'online'
    const ranked = kept ? rankDesks(kept).filter(online) : []
    // Kept readings with no desk online in them (a node may have come online since) are asked again.
    return ranked.length ? ranked : rankDesks(await poll())
  }

  /** 'ok' taken, 'no' refused or not reached (the next desk may have it), 'unknown' timed out (it may show). */
  async function post(id: string, body: DeskToast): Promise<'ok' | 'no' | 'unknown'> {
    const link = o.links()?.link(id)
    if (link?.state().state !== 'online') return 'no'
    try {
      const res = await link.fetch('/api/node/desk-toast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TOAST_MS),
      })
      await res.body?.cancel().catch(() => {})
      return res.ok ? 'ok' : 'no'
    } catch (err) {
      return timedOut(err) ? 'unknown' : 'no'
    }
  }

  /** Shown on the most recently active desk that takes it, else on this computer where it has a desktop; where it went. */
  async function route(what: string, body: DeskToast, locally: () => void): Promise<string | null> {
    let desks: DeskReading[] = []
    try {
      desks = await targets()
    } catch (err) {
      o.log(`desk: ${messageOf(err)}`)
    }
    for (const d of desks) {
      if (d.device === '') break
      const r = await post(d.device, body)
      if (r === 'ok') return d.device
      // Its readings are not to be trusted now: asked again next time.
      last = null
      if (r === 'unknown') {
        o.log(`desk: ${d.device} did not answer in time for the ${what} notification`)
        return d.device
      }
      o.log(`desk: ${d.device} did not take the ${what} notification`)
    }
    if (!o.desktopHere()) {
      o.log(`desk: no desk for the ${what} notification`)
      return null
    }
    locally()
    return ''
  }

  const reminder: ReminderDesktop = {
    show(toast: ReminderToast) {
      const went = route('reminder', { kind: 'reminder', toast }, () => o.local.reminder().show(toast))
      shownOn.delete(toast.id)
      shownOn.set(toast.id, went)
      while (shownOn.size > SHOWN_MAX) shownOn.delete(shownOn.keys().next().value as string)
    },
    clear(id) {
      const went = shownOn.get(id)
      shownOn.delete(id)
      // One shown before a restart: wherever this computer would have shown it, as before.
      if (!went) {
        if (o.desktopHere()) o.local.reminder().clear(id)
        return
      }
      void went.then(desk => {
        if (desk === '') o.local.reminder().clear(id)
        else if (desk !== null) void post(desk, { kind: 'reminder-clear', id })
      })
    },
  }

  const team: TeamDesktop = {
    show(toast: TeamToast) {
      void route('team', { kind: 'team', toast }, () => o.local.team().show(toast))
    },
  }

  return {
    on: () => o.on(),
    async observe() {
      return combineDesks(withQuiet(await poll()))
    },
    reminder,
    team,
  }
}
