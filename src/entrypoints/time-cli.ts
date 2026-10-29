// `board time …` (#233): time entries in the board's database, for the sessions that log their
// work and the agents that bill it. The command writes to the database itself (adapters/db.ts),
// so it works while the web board is down. One line per answer for a person, the whole of it as
// JSON with --json for an agent; an error goes to stderr with a non-zero exit and says what to do,
// and under --json it is JSON too ({ ok: false, error: <code>, message }). `--` ends the flags: a
// description after it may start with "--".
//
//   board time add [--client <lane>] --project "<p>" [--start <t>] (--stop <t> | --minutes <n> | --hours <h>)
//                  [--tag <t>]... [--new-project] [--] "<description>"
//   board time edit <id> [--description "…"] [--project "…"] [--client <lane>] [--start <t>] [--stop <t>]
//                  [--minutes <n> | --hours <h>] [--tag +<t> | --tag -<t>]... [--expect <rev>] [--force]
//   board time move <id> <date> [--expect <rev>] [--force]
//   board time rm <id> [--force]    board time restore <id> [--force]    board time show <id>
//   board time list [--date <d> | --from <d> --to <d>] [--client <lane>] [--tag <t>] [--deleted]
//   board time day [<d>] [--client <lane>]
//   board time projects [<lane>]
//   board time import <file> --tz <zone> [--map "<Toggl client>=<lane>"]... [--date-format dmy|mdy]
//                  [--dry-run] [--update]
import { readFileSync } from 'node:fs'
import { addTimeProjects } from '../adapters/config-file.ts'
import { type BoardDb, openDb } from '../adapters/db.ts'
import {
  addEntry,
  changeOf,
  editEntry,
  getEntry,
  type ImportChange,
  ImportIndex,
  type ImportRow,
  importEntries,
  importVerdict,
  listEntries,
  moveEntry,
  removeEntry,
  restoreEntry,
  TimeError,
} from '../adapters/time-store.ts'
import { t } from '../core/lang.ts'
import {
  type Actor,
  addDays,
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
  plausible,
  problemsText,
  secondsOf,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../core/time.ts'
import { type DateFormat, dayTotals, parseMap, rowsFromCsv, rowsFromJson, type TogglRow } from '../core/time-import.ts'
import type { Config } from '../core/types.ts'
import { writeRefusal } from '../services/time.ts'

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
  '--date-format',
])

interface Args {
  words: string[]
  one(flag: string): string | undefined
  all(flag: string): string[]
  has(flag: string): boolean
}

/** The command's words and flags; after `--`, words only. */
export function parseArgs(rest: readonly string[]): Args {
  const words: string[] = []
  const values = new Map<string, string[]>()
  const bare = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--') {
      words.push(...rest.slice(i + 1))
      break
    }
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
  now?: number
}

const whoText = (a: Actor): string => (typeof a === 'string' ? t(`time.who.${a}`) : a.name || a.key)

function entryLine(e: TimeEntry): string {
  return `${e.id} · ${e.date} · ${e.client}/${e.project} · ${hm(secondsOf(e))} · ${e.description}${e.tags.length ? ` · #${e.tags.join(' #')}` : ''}${e.deleted ? ` · ${t('time.cli.removed')}` : ''}`
}

/** An entry as the JSON gives it: its seconds beside the stored fields. */
const entryJson = (e: TimeEntry) => ({ ...e, seconds: secondsOf(e) })

function dayLines(d: ClientDay, byId: Map<string, TimeEntry>): string[] {
  const lines = [`${d.client} · ${d.date} (${d.zone}) · ${hm(d.seconds)} → ${hm(d.billedSeconds)}`]
  for (const l of d.lines) {
    const label = l.group === 'day' ? t('time.cli.dayGroup') : l.group === 'project' ? l.project : (l.ref ?? l.project)
    const rule = l.round === 'exact' ? t('time.round.exact') : t(`time.round.${l.round}`, { step: l.step })
    const project = l.project && l.project !== label ? ` · ${l.project}` : ''
    lines.push(`  ${label}${project} · ${hm(l.seconds)} → ${hm(l.billedSeconds)} (${rule})`)
    for (const id of l.entries) {
      const e = byId.get(id)
      if (e) lines.push(`    ${e.id} ${e.start.slice(11, 16)}Z ${hm(secondsOf(e))} ${e.description}`)
    }
  }
  if (d.held.length) lines.push(`  ${t('time.cli.held')}: ${d.held.join(', ')}`)
  return lines
}

/** An error's code under --json: the text key's last part (notYours, noBackup…), else `failed`. */
const codeOf = (err: unknown): string => (err instanceof TimeError ? (err.key.split('.').at(-1) ?? 'failed') : 'failed')

/**
 * The command; its exit code. An error throws, but under --json it is printed as JSON and the
 * answer is 1.
 */
export async function timeCmd(rest: readonly string[], ctx: TimeCmdContext): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  const json = rest.includes('--json') && !rest.slice(0, rest.indexOf('--json')).includes('--')
  try {
    await run(rest, ctx, out)
    return 0
  } catch (err) {
    if (!json) throw err
    out(JSON.stringify({ ok: false, error: codeOf(err), message: err instanceof Error ? err.message : String(err) }))
    return 1
  }
}

async function run(rest: readonly string[], ctx: TimeCmdContext, out: (line: string) => void): Promise<void> {
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
  const now = ctx.now ?? Date.now()
  /** A note for a person reading a day while the config does not check out (JSON carries `problems`). */
  const problems = conf.problems.length ? problemsText(conf.problems, t) : null
  const warn = (): string[] => (problems ? [t('time.cli.problems', { problems })] : [])

  /** A write: the config checks out and a backup went through (services/time.ts), then the database. */
  const writable = (): BoardDb => {
    const refused = writeRefusal(ctx.cfg, conf)
    if (refused) throw refused
    const db = openDb()
    if (!db) throw new TimeError('time.err.noDb')
    return db
  }
  const readable = (): BoardDb | null => openDb({ create: false })
  const today = dateIn(now, conf.zone)
  const clientArg = (): string => {
    const c = a.one('--client') ?? ctx.lane
    if (!c) throw new TimeError('time.err.whichClient')
    return c
  }
  /** A time flag: what parseWhen takes, within a day ahead and a year back. */
  const when = (flag: string, o: { yesterday?: boolean } = {}): number | null => {
    const v = a.one(flag)
    if (v === undefined) return null
    const at = parseWhen(v, now, o)
    if (at === null) throw new TimeError('time.err.when', { value: v })
    if (!plausible(at, now)) throw new TimeError('time.err.whenRange', { value: v })
    return at
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
      const start = when('--start')
      // a stop with no start is the end of what was just done: HH:MM ahead of now is a slip, not
      // yesterday's (with a start, the pair may be last evening's)
      const stopGiven = when('--stop', { yesterday: start !== null })
      if (start === null && stopGiven !== null && stopGiven > now + 60 * 60_000)
        throw new TimeError('time.err.stopAhead', { value: a.one('--stop') ?? '' })
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
          now,
        )
        if (a.has('--new-project') && !r.existing) addTimeProjects(client, [r.entry.project])
        const said = !r.existing ? 'ok' : r.reason === 'repeat-window' ? t('time.cli.repeat') : t('time.cli.existing')
        print(
          `${said} · ${r.entry.id} · ${r.entry.client}/${r.entry.project} · ${r.entry.date} · ${hm(secondsOf(r.entry))} · ${dayTotal(db, r.entry)}`,
          { ...entryJson(r.entry), existing: r.existing, ...(r.reason && { reason: r.reason }) },
        )
      } finally {
        db.close()
      }
      return
    }
    case 'edit': {
      const id = a.words[0]
      if (!id) throw new TimeError('time.err.usage')
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
            ...(start !== null && { start }),
            ...(stop !== null && { stop }),
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
      if (date > addDays(today, 1) || date < addDays(today, -366))
        throw new TimeError('time.err.whenRange', { value: date })
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
      // the total as a day's would be: removed and held entries out of it
      const counted = list.filter(e => !e.deleted && !e.tags.some(tag => conf.excludeTags.includes(tag)))
      const held = list.filter(e => !e.deleted).length - counted.length
      const total = counted.reduce((n, e) => n + secondsOf(e), 0)
      print(
        list.length
          ? [
              ...warn(),
              ...list.map(entryLine),
              `${t('time.cli.total', { n: counted.length, total: hm(total) })}${held ? ` · ${t('time.cli.heldCount', { n: held })}` : ''}`,
            ]
          : [...warn(), t('time.cli.none')],
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
      print([...warn(), ...(days.length ? days.flatMap(d => dayLines(d, byId)) : [t('time.cli.none')])], {
        date,
        problems: conf.problems.map(p => `${p.at}: ${t(`time.problem.${p.why}`, { value: p.value ?? '' })}`),
        days: days.map(d => ({
          ...d,
          entries: d.lines
            .flatMap(l => l.entries)
            .concat(d.held)
            .map(id => entryJson(byId.get(id) as TimeEntry)),
        })),
      })
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
      return importCmd(a, conf, writable, readable, print)
    default:
      throw new TimeError('time.err.usage')
  }
}

async function importCmd(
  a: Args,
  conf: TimeConfig,
  writable: () => BoardDb,
  readable: () => BoardDb | null,
  print: (human: string | string[], value: unknown) => void,
): Promise<void> {
  const file = a.words[0]
  const tz = a.one('--tz')
  if (!file || !tz) throw new TimeError('time.err.importUsage')
  if (!knownZone(tz)) throw new TimeError('time.err.zone', { zone: tz })
  const format = a.one('--date-format')
  if (format !== undefined && format !== 'dmy' && format !== 'mdy')
    throw new TimeError('time.err.flagValue', { flag: '--date-format' })
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
    const r = rowsFromCsv(text, zoned, (format as DateFormat | undefined) ?? null)
    if (r.missing.length) throw new TimeError('time.err.importColumns', { columns: r.missing.join(', ') })
    if (r.dates === 'ambiguous') throw new TimeError('time.err.dateFormat')
    if (r.dates === 'mixed') throw new TimeError('time.err.dateOrder')
    if (r.dates === 'conflict') throw new TimeError('time.err.dateConflict', { format: format ?? '' })
    ;({ rows, bad } = r)
  }
  const unmapped = new Set<string>()
  const running: string[] = []
  const entries: ImportRow[] = []
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
      ...(r.key && { toggl: r.key }),
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
  const seconds = (e: ImportRow) => Math.round((e.stop - e.start) / 1000)
  // per day twice: the board's work date (as it will bill) and Toggl's own day in --tz (as its
  // report shows it), so the run can be held against that report day by day
  const byWorkDate = dayTotals(
    entries.map(e => ({ date: dateIn(e.start, zoneOf(conf, e.client)), client: e.client, seconds: seconds(e) })),
  )
  const byTogglDay = dayTotals(entries.map(e => ({ date: dateIn(e.start, tz), client: e.client, seconds: seconds(e) })))
  const summary = {
    rows: rows.length,
    entries: entries.length,
    running: running.length,
    unreadable: bad,
    days: byWorkDate.map(d => ({ ...d, hours: hm(d.seconds) })),
    togglDays: byTogglDay.map(d => ({ ...d, hours: hm(d.seconds) })),
  }
  const totals = (title: string, list: typeof byWorkDate): string[] => [
    title,
    ...list.map(d => `  ${d.date} · ${d.client} · ${d.entries} · ${hm(d.seconds)}`),
  ]
  /** A row the store has otherwise: changed in Toggl (or on the board) since its import, or made by a session at that start. */
  const changeLines = (key: string, list: readonly ImportChange[]): string[] =>
    list.map(c =>
      c.by === 'import'
        ? t(key, { id: c.id, fields: c.fields.join(', ') })
        : t('time.cli.importClash', { id: c.id, who: whoText(c.by), fields: c.fields.join(', ') }),
    )
  if (a.has('--dry-run')) {
    // read only: what a run would do against the database as it is
    const db = readable()
    const index = (() => {
      try {
        return new ImportIndex(db)
      } finally {
        db?.close()
      }
    })()
    // a row the run would add goes into the index, as the run does: two of one file meet
    const verdicts = entries.map(e => {
      const v = importVerdict(index, conf, e)
      if (v.kind === 'new') index.add(v.entry)
      return v
    })
    const fresh = verdicts.filter(v => v.kind === 'new').length
    const already = verdicts.filter(v => v.kind === 'already').length
    const changed = verdicts.flatMap(v => (v.kind === 'changed' ? [changeOf(v)] : []))
    print(
      [
        ...totals(t('time.cli.byWorkDate', { zone: conf.zone }), byWorkDate),
        ...totals(t('time.cli.byTogglDay', { zone: tz }), byTogglDay),
        ...changeLines('time.cli.importChanged', changed),
        t('time.cli.importDry', {
          n: fresh,
          already,
          changed: changed.length,
          running: running.length,
          bad: bad.length,
        }),
      ],
      { ...summary, dryRun: true, new: fresh, already, changed },
    )
    return
  }
  const db = writable()
  try {
    const r = importEntries(db, conf, entries, { update: a.has('--update') })
    // projects found go into each lane's list, where the lane lists them: only once the gate let the run in
    const byLane = new Map<string, string[]>()
    for (const e of entries) if (e.project !== '-') byLane.set(e.client, [...(byLane.get(e.client) ?? []), e.project])
    for (const [lane, projects] of byLane) addTimeProjects(lane, projects)
    print(
      [
        ...changeLines('time.cli.importChanged', r.changed),
        ...changeLines('time.cli.importUpdated', r.updated),
        t('time.cli.imported', {
          added: r.added,
          already: r.already,
          changed: r.changed.length,
          updated: r.updated.length,
          running: running.length,
          bad: bad.length,
        }),
      ],
      { ...summary, ...r },
    )
  } finally {
    db.close()
  }
}
