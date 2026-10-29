// Settings → Time tracking… (#237) as the page has it: GET /api/time-settings's view read with a
// guard, the zones a select offers, the order the clients and the lanes without time are listed
// in, and a client's line of what it has. The board's own words for each change are its answers.
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { TimeSystem } from '../../../src/core/time.ts'
import type { Translator } from '../../../src/core/types.ts'

export interface TimeClientView {
  on: boolean
  /** null: any project. */
  projects: string[] | null
  retired: string[]
  billable: boolean
  nonBillable: string[]
  systems: TimeSystem[]
  /** Its billing rules and its own `ref`, kept in config.json. */
  rules: number
  ref: boolean
  zone: string | null
  /** Its live entries by project. */
  use: Record<string, number>
}

export interface TimeSettingsView {
  on: boolean
  set: boolean
  zone: string
  localZone: string
  every: boolean
  /** config.json is there but does not read as JSON: nothing can be changed until it is fixed by hand. */
  unreadable?: boolean
  clients: Record<string, TimeClientView>
  problems: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isTimeSettingsView(v: unknown): v is TimeSettingsView {
  return (
    isObject(v) &&
    typeof v.on === 'boolean' &&
    typeof v.zone === 'string' &&
    typeof v.every === 'boolean' &&
    isObject(v.clients) &&
    Object.values(v.clients).every(c => isObject(c) && typeof c.on === 'boolean' && Array.isArray(c.retired)) &&
    Array.isArray(v.problems)
  )
}

/** The zones a select offers: the ones this browser knows, the one set and the computer's among them. */
export function zonesOf(set: string, local: string): string[] {
  let known: string[] = []
  try {
    known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {}
  return [...new Set([...known, set, local, 'UTC'])].filter(Boolean).sort()
}

/** The clients in the lanes' order, then any the board has no lane for (an agent's own id). */
export function clientOrder(view: TimeSettingsView, lanes: readonly Pick<BoardCategory, 'id'>[]): string[] {
  const ids = Object.keys(view.clients)
  const laid = lanes.map(l => l.id).filter(id => ids.includes(id))
  return [...laid, ...ids.filter(id => !laid.includes(id))]
}

/** The lanes that take no time yet, in their order. */
export const lanesWithout = <T extends Pick<BoardCategory, 'id'>>(view: TimeSettingsView, lanes: readonly T[]): T[] =>
  lanes.filter(l => !(l.id in view.clients))

/** A client's line under its name: how many projects, never billed, where its time is entered. */
export function clientLine(c: TimeClientView, t: Translator): string {
  const projects = c.projects === null ? t('time.set.anyProject') : t('time.set.projectsN', { n: c.projects.length })
  const systems = c.systems.length ? `${t('time.set.systems')} ${c.systems.map(s => s.title).join(', ')}` : ''
  return [projects, c.billable ? '' : t('time.set.unbilled'), systems].filter(Boolean).join(' · ')
}
