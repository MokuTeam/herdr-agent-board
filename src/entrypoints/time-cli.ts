// `board time …` (#233): time entries in the board's database, for the sessions that log their
// work and the agents that bill it. The command writes to the database itself (adapters/db.ts),
// so it works while the web board is down. One line per answer for a person, the whole of it as
// JSON with --json for an agent; an error goes to stderr with a non-zero exit and says what to do.
//
//   board time add [--client <lane>] --project "<p>" [--start <t>] (--stop <t> | --minutes <n> | --hours <h>)
//                  [--tag <t>]... [--new-project] "<description>"
//   board time edit <id> [--description "…"] [--project "…"] [--client <lane>] [--start <t>] [--stop <t>]
//                  [--minutes <n> | --hours <h>] [--tag +<t> | --tag -<t>]... [--expect <rev>] [--force]
//   board time move <id> <date> [--expect <rev>] [--force]
//   board time rm <id> [--force]    board time restore <id> [--force]    board time show <id>
//   board time list [--date <d> | --from <d> --to <d>] [--client <lane>] [--tag <t>] [--deleted]
//   board time day [<d>] [--client <lane>]
//   board time projects [<lane>]
//   board time import <file> --tz <zone> [--map "<Toggl client>=<lane>"]... [--dry-run]
import { readFileSync } from 'node:fs'
import { readKey } from '../adapters/backup-store.ts'
import { addTimeProjects } from '../adapters/config-file.ts'
import { type BoardDb, openDb } from '../adapters/db.ts'
import {
  addEntry,
  editEntry,
  getEntry,
  importEntries,
  listEntries,
  moveEntry,
  removeEntry,
  restoreEntry,
  TimeError,
} from '../adapters/time-store.ts'
import { activeTargets, backupConfig } from '../core/backup.ts'
import { t } from '../core/lang.ts'
import {
  type Actor,
  type ClientDay,
  clientDay,
  clientOf,
  dateIn,
  durationOf,
  hm,
  instantIn,
  isDate,
  knownZone,
  parseWhen,
  secondsOf,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../core/time.ts'
import { dayTotals, parseMap, rowsFromCsv, rowsFromJson, type TogglRow } from '../core/time-import.ts'
import type { Config } from '../core/types.ts'

const FLAGS_WITH_VALUE = new Set([
  '--client',
  '--project',
  '--start',
  '--stop',
  '--minutes',
  '--hours',
  '--tag',
  '--description',
  '--date',
  '--from',
  '--to',
  '--expect',
  '--tz',
  '--map',
])

interface Args {
  words: string[]
  one(flag: string): string | undefined
  all(flag: string): string[]
  has(flag: string): boolean
}

export function parseArgs(rest: readonly string[]): Args {
  const words: string[] = []
  const values = new Map<string, string[]>()
  const bare = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = rest[i + 1]
      if (v === undefined) throw new TimeError('time.err.flagValue', { flag: a })
      values.set(a, [...(values.get(a) ?? []), v])
      i++
    } else if (a.startsWith('--')) bare.add(a)
    else words.push(a)
  }
  return {
    words,
    one: f => values.get(f)?.at(-1),
    all: f => values.get(f) ?? [],
    has: f => bare.has(f),
  }
}

export interface TimeCmdContext {
  cfg: Config
  /** Who runs it: the session, or the owner outside one. */
  actor: Actor
  /** The session's lane (its card's category), the client when none is named. */
  lane: string | null
  out?: (line: string) => void
}

const whoText = (a: Actor): string => (typeof a === 'string' ? t(`time.by.${a}`) : a.name || a.key)

function entryLine(e: TimeEntry): string {
  return `${e.id} · ${e.date} · ${e.client}/${e.project} · ${hm(secondsOf(e))} · ${e.description}${e.tags.length ? ` · #${e.tags.join(' #')}` : ''}${e.deleted ? ` · ${t('time.cli.removed')}` : ''}`
}

/** An entry as the JSON gives it: its seconds and its maker's name beside the stored fields. */
const entryJson = (e: TimeEntry) => ({ ...e, seconds: secondsOf(e) })

function dayLines(d: ClientDay, byId: Map<string, TimeEntry>): string[] {
  const lines = [`${d.client} · ${d.date} (${d.zone}) · ${hm(d.seconds)} → ${hm(d.billedSeconds)}`]
  for (const l of d.lines) {
    const label = l.ref ?? (l.project || t('time.cli.dayGroup'))
    const rule = l.round === 'exact' ? t('time.round.exact') : t(`time.round.${l.round}`, { step: l.step })
    lines.push(`  ${label} · ${l.project} · ${hm(l.seconds)} → ${hm(l.billedSeconds)} (${rule})`)
    for (const id of l.entries) {
      const e = byId.get(id)
      if (e) lines.push(`    ${e.id} ${e.start.slice(11, 16)}Z ${hm(secondsOf(e))} ${e.description}`)
    }
  }
  if (d.held.length) lines.push(`  ${t('time.cli.held')}: ${d.held.join(', ')}`)
  return lines
}

export async function timeCmd(rest: readonly string[], ctx: TimeCmdContext): Promise<void> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  const conf = timeConfig(ctx.cfg.time)
  if (!conf) throw new TimeError('time.err.off')
  const [sub = 'list', ...more] = rest
  const a = parseArgs(more)
  const json = a.has('--json')
  const print = (human: string | string[], value: unknown): void => {
    if (json) out(JSON.stringify(value, null, 2))
    else for (const line of Array.isArray(human) ? human : [human]) out(line)
  }
  const force = a.has('--force')
  const expect = a.one('--expect') !== undefined ? Number(a.one('--expect')) : undefined
  if (expect !== undefined && !Number.isInteger(expect)) throw new TimeError('time.err.flagValue', { flag: '--expect' })

  /** A write needs a backup target set up: what the board bills from never lives on this computer alone. */
  const writable = (): BoardDb => {
    if (!activeTargets(backupConfig(ctx.cfg.backup)).length || !readKey()) throw new TimeError('time.err.noBackup')
    const db = openDb()
    if (!db) throw new TimeError('time.err.noDb')
    return db
  }
  const readable = (): BoardDb | null => openDb({ create: false })
  const today = dateIn(Date.now(), conf.zone)
  const clientArg = (): string => {
    const c = a.one('--client') ?? ctx.lane
    if (!c) throw new TimeError('time.err.whichClient')
    return c
  }
  const dayOf = (db: BoardDb | null, client: string, date: string): { day: ClientDay; entries: TimeEntry[] } => {
    const entries = db ? listEntries(db, { from: date, to: date, client }) : []
    return { day: clientDay(conf, client, date, entries), entries }
  }
  const dayTotal = (db: BoardDb, e: TimeEntry): string => {
    const { day } = dayOf(db, e.client, e.date)
    return t('time.cli.dayTotal', { raw: hm(day.seconds), billed: hm(day.billedSeconds) })
  }

  switch (sub) {
    case 'add': {
      const description = a.words.join(' ')
      const client = clientArg()
      const project = a.one('--project') ?? ''
      const now = Date.now()
      const startArg = a.one('--start')
      const stopArg = a.one('--stop')
      const start = startArg !== undefined ? parseWhen(startArg, now) : null
      if (startArg !== undefined && start === null) throw new TimeError('time.err.when', { value: startArg })
      const stopGiven = stopArg !== undefined ? parseWhen(stopArg, now) : null
      if (stopArg !== undefined && stopGiven === null) throw new TimeError('time.err.when', { value: stopArg })
      const duration = durationOf({ minutes: a.one('--minutes'), hours: a.one('--hours') })
      let from: number
      let to: number
      if (start !== null && stopGiven !== null) [from, to] = [start, stopGiven]
      else if (start !== null && duration !== null) [from, to] = [start, start + duration * 1000]
      else if (duration !== null) {
        to = stopGiven ?? Math.floor(now / 60_000) * 60_000
        from = to - duration * 1000
      } else throw new TimeError('time.err.noDuration')
      const db = writable()
      try {
        const r = addEntry(
          db,
          conf,
          {
            client,
            project,
            description,
            tags: a.all('--tag'),
            start: from,
            stop: to,
            startGiven: start !== null,
            newProject: a.has('--new-project'),
          },
          ctx.actor,
        )
        if (a.has('--new-project') && !r.existing) addTimeProjects(client, [r.entry.project])
        print(
          `${r.existing ? t('time.cli.existing') : 'ok'} · ${r.entry.id} · ${r.entry.client}/${r.entry.project} · ${r.entry.date} · ${hm(secondsOf(r.entry))} · ${dayTotal(db, r.entry)}`,
          { ...entryJson(r.entry), existing: r.existing },
        )
      } finally {
        db.close()
      }
      return
    }
    case 'edit': {
      const id = a.words[0]
      if (!id) throw new TimeError('time.err.usage')
      const now = Date.now()
      const when = (flag: string): number | undefined => {
        const v = a.one(flag)
        if (v === undefined) return undefined
        const at = parseWhen(v, now)
        if (at === null) throw new TimeError('time.err.when', { value: v })
        return at
      }
      const duration = durationOf({ minutes: a.one('--minutes'), hours: a.one('--hours') })
      if ((a.one('--minutes') !== undefined || a.one('--hours') !== undefined) && duration === null)
        throw new TimeError('time.err.noDuration')
      const tags = a.all('--tag')
      const description = a.one('--description')
      const project = a.one('--project')
      const client = a.one('--client')
      const start = when('--start')
      const stop = when('--stop')
      const db = writable()
      try {
        const e = editEntry(
          db,
          conf,
          id,
          {
            ...(description !== undefined && { description }),
            ...(project !== undefined && { project }),
            ...(client !== undefined && { client }),
            ...(start !== undefined && { start }),
            ...(stop !== undefined && { stop }),
            ...(duration !== null && { seconds: duration }),
            addTags: tags.filter(x => !x.startsWith('-')).map(x => x.replace(/^\+/, '')),
            removeTags: tags.filter(x => x.startsWith('-')).map(x => x.slice(1)),
            newProject: a.has('--new-project'),
          },
          ctx.actor,
          { force, ...(expect !== undefined && { expect }) },
        )
        if (a.has('--new-project')) addTimeProjects(e.client, [e.project])
        print(`ok · ${entryLine(e)} · rev ${e.rev} · ${dayTotal(db, e)}`, entryJson(e))
      } finally {
        db.close()
      }
      return
    }
    case 'move': {
      const [id, date] = a.words
      if (!id || !date || !isDate(date)) throw new TimeError('time.err.usage')
      const db = writable()
      try {
        const e = moveEntry(db, conf, id, date, ctx.actor, { force, ...(expect !== undefined && { expect }) })
        print(`ok · ${entryLine(e)} · ${e.start} · ${dayTotal(db, e)}`, entryJson(e))
      } finally {
        db.close()
      }
      return
    }
    case 'rm':
    case 'restore': {
      const id = a.words[0]
      if (!id) throw new TimeError('time.err.usage')
      const db = writable()
      try {
        const e = sub === 'rm' ? removeEntry(db, id, ctx.actor, { force }) : restoreEntry(db, id, ctx.actor, { force })
        print(`ok · ${entryLine(e)}`, entryJson(e))
      } finally {
        db.close()
      }
      return
    }
    case 'show': {
      const id = a.words[0]
      if (!id) throw new TimeError('time.err.usage')
      const db = readable()
      const e = db ? getEntry(db, id) : null
      db?.close()
      if (!e) throw new TimeError('time.err.gone', { id })
      print(
        [entryLine(e), `${e.start} → ${e.stop} · rev ${e.rev} · ${whoText(e.by)} · ${whoText(e.changedBy)}`],
        entryJson(e),
      )
      return
    }
    case 'list': {
      const date = a.one('--date')
      const from = a.one('--from') ?? date ?? today
      const to = a.one('--to') ?? date ?? from
      if (!isDate(from) || !isDate(to)) throw new TimeError('time.err.usage')
      const db = readable()
      const list = db
        ? listEntries(db, { from, to, client: a.one('--client'), tag: a.one('--tag'), deleted: a.has('--deleted') })
        : []
      db?.close()
      const total = list.filter(e => !e.deleted).reduce((n, e) => n + secondsOf(e), 0)
      print(
        list.length
          ? [...list.map(entryLine), t('time.cli.total', { n: list.length, total: hm(total) })]
          : t('time.cli.none'),
        list.map(entryJson),
      )
      return
    }
    case 'day': {
      const date = a.words[0] ?? a.one('--date') ?? today
      if (!isDate(date)) throw new TimeError('time.err.usage')
      const db = readable()
      const entries = db ? listEntries(db, { from: date, to: date, client: a.one('--client') }) : []
      db?.close()
      const clients = [...new Set(entries.map(e => e.client))].sort()
      if (a.one('--client') && !clients.includes(a.one('--client') as string)) clients.push(a.one('--client') as string)
      const byId = new Map(entries.map(e => [e.id, e]))
      const days = clients.map(c =>
        clientDay(
          conf,
          c,
          date,
          entries.filter(e => e.client === c),
        ),
      )
      print(
        days.length ? days.flatMap(d => dayLines(d, byId)) : t('time.cli.none'),
        days.map(d => ({
          ...d,
          entries: d.lines
            .flatMap(l => l.entries)
            .concat(d.held)
            .map(id => entryJson(byId.get(id) as TimeEntry)),
        })),
      )
      return
    }
    case 'projects': {
      const lane = a.words[0]
      const clients = conf.clients ?? {}
      const lanes = lane ? [lane] : Object.keys(clients)
      if (!conf.clients) return print(t('time.cli.anyProject'), null)
      const value = Object.fromEntries(lanes.map(l => [l, clients[l]?.projects ?? null]))
      print(
        lanes.map(l => `${l}: ${(clients[l]?.projects ?? [t('time.cli.anyProject')]).join(', ') || '-'}`),
        value,
      )
      return
    }
    case 'import':
      return importCmd(a, conf, writable, print)
    default:
      throw new TimeError('time.err.usage')
  }
}

async function importCmd(
  a: Args,
  conf: TimeConfig,
  writable: () => BoardDb,
  print: (human: string | string[], value: unknown) => void,
): Promise<void> {
  const file = a.words[0]
  const tz = a.one('--tz')
  if (!file || !tz) throw new TimeError('time.err.importUsage')
  if (!knownZone(tz)) throw new TimeError('time.err.zone', { zone: tz })
  const map = parseMap(a.all('--map'))
  if (typeof map === 'string') throw new TimeError('time.err.map', { value: map })
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new TimeError('time.err.file', { file })
  }
  const zoned = (date: string, clock: [number, number, number]): number => instantIn(date, clock, tz)
  let rows: TogglRow[]
  let bad: number[]
  if (/^\s*[[{]/.test(text)) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new TimeError('time.err.importFormat')
    }
    ;({ rows, bad } = rowsFromJson(value))
  } else {
    const r = rowsFromCsv(text, zoned)
    if (r.missing.length) throw new TimeError('time.err.importColumns', { columns: r.missing.join(', ') })
    ;({ rows, bad } = r)
  }
  const unmapped = new Set<string>()
  const running: string[] = []
  const entries = []
  for (const r of rows) {
    if (r.running) {
      running.push(r.key)
      continue
    }
    const lane = map.get(r.client.toLowerCase())
    if (!lane) {
      unmapped.add(r.client)
      continue
    }
    entries.push({
      client: lane,
      project: r.project || '-',
      description: r.description,
      tags: r.tags,
      start: r.start,
      stop: r.stop,
      toggl: r.key,
    })
  }
  for (const lane of new Set(map.values())) {
    if (!clientOf(conf, lane).ok)
      throw new TimeError('time.err.client', { client: lane, known: Object.keys(conf.clients ?? {}).join(', ') })
  }
  if (unmapped.size)
    throw new TimeError('time.err.unmapped', {
      clients: [...unmapped].map(c => (c === '' ? '""' : `"${c}"`)).join(', '),
    })
  const totals = dayTotals(
    entries.map(e => ({
      date: dateIn(e.start, zoneOf(conf, e.client)),
      client: e.client,
      seconds: Math.round((e.stop - e.start) / 1000),
    })),
  )
  const summary = {
    rows: rows.length,
    entries: entries.length,
    running: running.length,
    unreadable: bad,
    days: totals.map(d => ({ ...d, hours: hm(d.seconds) })),
  }
  if (a.has('--dry-run')) {
    print(
      [
        ...totals.map(d => `${d.date} · ${d.client} · ${d.entries} · ${hm(d.seconds)}`),
        t('time.cli.importDry', { n: entries.length, running: running.length, bad: bad.length }),
      ],
      summary,
    )
    return
  }
  // projects found go into each lane's list, where the lane lists them
  const byLane = new Map<string, string[]>()
  for (const e of entries) byLane.set(e.client, [...(byLane.get(e.client) ?? []), e.project])
  for (const [lane, projects] of byLane) addTimeProjects(lane, projects)
  const db = writable()
  try {
    const r = importEntries(db, conf, entries)
    print(t('time.cli.imported', { added: r.added, already: r.already, running: running.length, bad: bad.length }), {
      ...summary,
      ...r,
    })
  } finally {
    db.close()
  }
}
