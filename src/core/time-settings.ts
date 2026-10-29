// Settings → Time (#237): what the owner changes in config.json's `time` from the board, as changes
// of the raw section (the file's own object, every key it has kept). Pure: the service applies one
// under the file's lock (services/time-settings.ts), checks the result with timeConfig, and moves
// the entries a rename moves.
//
// What it changes: time on and off (`on: false` keeps the settings), the zone; a lane taking time
// (a client with an empty list of projects), every lane's choice made explicit, a client off and
// on; a client's projects added, renamed, retired and brought back, billed or not; its `billable`
// and its `systems`, and a project's own systems (`projectSystems`, #260). Not its billing rules
// nor its `ref`: those stay in config.json.

import { cleanText, knownZone, projectIn, sameProject, type TimeProblem } from './time.ts'

type Raw = Record<string, unknown>

export type TimeEdit =
  | { op: 'on'; on: boolean }
  | { op: 'zone'; zone: string }
  /** Every lane took time: from now on these do, each with any project as before. */
  | { op: 'lanes'; lanes: string[] }
  /** A lane takes time (a client with no projects yet), or a client on or off again. */
  | { op: 'client'; client: string; on: boolean }
  /** A client that took any project keeps a list from now on: these. */
  | { op: 'list'; client: string; projects: string[] }
  | { op: 'project'; client: string; name: string }
  | { op: 'rename'; client: string; from: string; to: string }
  | { op: 'retire'; client: string; project: string }
  | { op: 'restore'; client: string; project: string }
  | { op: 'billable'; client: string; billable: boolean }
  | { op: 'projectBillable'; client: string; project: string; billable: boolean }
  | { op: 'systems'; client: string; systems: { id: string; title: string }[] }
  /** The systems a project's entries are entered in; null: the client's, all of them. */
  | { op: 'projectSystems'; client: string; project: string; systems: string[] | null }

/** A refusal: a text key and what it says. */
export type EditRefusal = { key: string; vars?: Record<string, string> }

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const SYSTEM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A project's name as kept: one line, at most 120 characters (the entries' own limit). */
const projectName = (s: string): string => cleanText(s, 120)
/** The ids of a raw `systems` list (a string, or { id }). */
const systemIds = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap(s => (typeof s === 'string' ? [s] : isObject(s) && typeof s.id === 'string' ? [s.id] : []))
    : []
/** `projectSystems` kept, or taken out when it holds none. */
function setProjectSystems(c: Raw, next: Raw): void {
  if (Object.keys(next).length) c.projectSystems = next
  else delete c.projectSystems
}

/**
 * The raw `time` after the edit, or why not. `time` is config.json's value as it is (a missing one
 * is undefined); `zone` the computer's, for time turned on from nothing (no lane takes time then
 * until one is picked).
 */
export function editedTime(time: unknown, e: TimeEdit, zone: string): { time: unknown } | EditRefusal {
  if (e.op === 'on') {
    if (e.on) {
      if (time === true) return { time }
      if (!isObject(time)) return { time: { zone, clients: {} } }
      const { on: _on, ...rest } = time
      return { time: rest }
    }
    if (time === true) return { time: { on: false, zone } }
    if (!isObject(time)) return { time }
    return { time: { ...time, on: false } }
  }
  // the rest change settings that are there: `true` becomes the object it means; none at all is set
  // up off (lanes picked, projects added, then On), nothing but On turns time on
  const t: Raw = time === true ? { zone } : isObject(time) ? structuredClone(time) : { on: false, zone, clients: {} }
  if (e.op === 'zone') {
    const z = e.zone.trim()
    if (!knownZone(z)) return { key: 'time.err.zone', vars: { zone: z } }
    t.zone = z
    return { time: t }
  }
  if (e.op === 'lanes') {
    // only where every lane took time (none set up yet: these are the first ones)
    if (isObject(t.clients) && isObject(time)) return { time: t }
    t.clients = Object.fromEntries([...new Set(e.lanes)].map(id => [id, {}]))
    return { time: t }
  }
  if (!isObject(t.clients)) return { key: 'time.set.err.every' }
  const clients = t.clients
  if (e.op === 'client') {
    const had = clients[e.client]
    if (had === undefined) {
      if (e.on) clients[e.client] = { projects: [] }
      return { time: t }
    }
    if (!isObject(had)) return { key: 'time.set.err.client', vars: { client: e.client } }
    if (e.on) delete had.on
    else had.on = false
    return { time: t }
  }
  const c = clients[e.client]
  if (!isObject(c)) return { key: 'time.set.err.client', vars: { client: e.client } }
  switch (e.op) {
    case 'list': {
      if (Array.isArray(c.projects)) return { time: t }
      const list: string[] = []
      for (const p of e.projects.map(projectName)) if (p && !projectIn(list, p)) list.push(p)
      c.projects = list
      return { time: t }
    }
    case 'project': {
      if (!Array.isArray(c.projects)) return { key: 'time.set.err.anyProject' }
      const name = projectName(e.name)
      if (!name) return { key: 'time.err.noProject' }
      const listed = projectIn(names(c.projects), name)
      if (listed) return { key: 'time.set.err.exists', vars: { project: listed } }
      // a retired one typed again: brought back, as it was spelled
      const retired = projectIn(names(c.retired), name)
      if (retired) return editedTime(t, { op: 'restore', client: e.client, project: retired }, zone)
      c.projects = [...c.projects, name]
      return { time: t }
    }
    case 'rename': {
      const to = projectName(e.to)
      if (!to) return { key: 'time.err.noProject' }
      const listed = names(c.projects).includes(e.from)
      const retired = names(c.retired).includes(e.from)
      if (!listed && !retired) return { key: 'time.set.err.noSuch', vars: { project: e.from } }
      if (to === e.from) return { time: t }
      // another of its names (a case or a space of its own may change)
      const other = [...names(c.projects), ...names(c.retired)].find(p => p !== e.from && sameProject(p, to))
      if (other) return { key: 'time.set.err.exists', vars: { project: other } }
      const swap = (v: unknown) => names(v).map(p => (p === e.from ? to : p))
      if (listed) c.projects = swap(c.projects)
      if (retired) c.retired = swap(c.retired)
      if (Array.isArray(c.nonBillable)) c.nonBillable = swap(c.nonBillable)
      // its own systems go with it, under the new name
      if (isObject(c.projectSystems))
        c.projectSystems = Object.fromEntries(
          Object.entries(c.projectSystems).map(([p, v]) => [sameProject(p, e.from) ? to : p, v]),
        )
      return { time: t }
    }
    case 'retire': {
      if (!names(c.projects).includes(e.project)) return { key: 'time.set.err.noSuch', vars: { project: e.project } }
      c.projects = names(c.projects).filter(p => p !== e.project)
      c.retired = [...names(c.retired).filter(p => p !== e.project), e.project]
      return { time: t }
    }
    case 'restore': {
      if (!names(c.retired).includes(e.project)) return { key: 'time.set.err.noSuch', vars: { project: e.project } }
      const left = names(c.retired).filter(p => p !== e.project)
      if (left.length) c.retired = left
      else delete c.retired
      if (Array.isArray(c.projects)) c.projects = [...names(c.projects), e.project]
      return { time: t }
    }
    case 'billable': {
      // billed is what a client is unless it says otherwise
      if (e.billable) delete c.billable
      else c.billable = false
      return { time: t }
    }
    case 'projectBillable': {
      const known = [...names(c.projects), ...names(c.retired)]
      if (Array.isArray(c.projects) && !known.includes(e.project))
        return { key: 'time.set.err.noSuch', vars: { project: e.project } }
      const rest = names(c.nonBillable).filter(p => p !== e.project)
      const next = e.billable ? rest : [...rest, e.project]
      if (next.length) c.nonBillable = next
      else delete c.nonBillable
      return { time: t }
    }
    case 'systems': {
      const seen = new Set<string>()
      const out: (string | { id: string; title: string })[] = []
      for (const s of e.systems) {
        const id = s.id.trim()
        if (!SYSTEM_ID.test(id) || seen.has(id)) return { key: 'time.set.err.system', vars: { id } }
        seen.add(id)
        const title = cleanText(s.title, 40)
        out.push(title && title !== id ? { id, title } : id)
      }
      if (out.length) c.systems = out
      else delete c.systems
      // a system taken off goes from the projects' own lists too (one that was only there: entered nowhere)
      if (isObject(c.projectSystems)) {
        const ids = systemIds(out)
        setProjectSystems(
          c,
          ids.length
            ? Object.fromEntries(
                Object.entries(c.projectSystems).map(([p, v]) => [p, names(v).filter(id => ids.includes(id))]),
              )
            : {},
        )
      }
      return { time: t }
    }
    case 'projectSystems': {
      const known = [...names(c.projects), ...names(c.retired)]
      if (Array.isArray(c.projects) && !projectIn(known, e.project))
        return { key: 'time.set.err.noSuch', vars: { project: e.project } }
      const all = systemIds(c.systems)
      const rest = Object.fromEntries(
        Object.entries(isObject(c.projectSystems) ? c.projectSystems : {}).filter(([p]) => !sameProject(p, e.project)),
      )
      // in the client's order; every one of them is the client's own, no list of its own
      const ids = e.systems === null ? null : all.filter(id => e.systems?.includes(id))
      const unknown = e.systems?.find(id => !all.includes(id))
      if (unknown !== undefined) return { key: 'time.set.err.system', vars: { id: unknown } }
      setProjectSystems(
        c,
        ids === null || ids.length === all.length ? rest : { ...rest, [projectIn(known, e.project) ?? e.project]: ids },
      )
      return { time: t }
    }
  }
}

/** The problems `after` has that `before` had not (each by its place, why and value). */
export function newProblems(before: readonly TimeProblem[], after: readonly TimeProblem[]): TimeProblem[] {
  const had = new Set(before.map(p => JSON.stringify([p.at, p.why, p.value ?? null])))
  return after.filter(p => !had.has(JSON.stringify([p.at, p.why, p.value ?? null])))
}
