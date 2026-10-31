// `board time …` (#233): time entries in the board's database, for the sessions that log their
// work and the agents that bill it. The command writes to the database itself (adapters/db.ts),
// so it works while the web board is down. One line per answer for a person, the whole of it as
// JSON with --json for an agent; an error goes to stderr with a non-zero exit and says what to do,
// and under --json it is JSON too ({ ok: false, error: <code>, message }). `--` ends the flags: a
// description after it may start with "--".
//
//   board time add [--client <lane>] --project "<p>" [--start <t>] (--stop <t> | --minutes <n> | --hours <h>)
//                  [--tag <t>]... [--billable | --non-billable] [--new-project] [--] "<description>"
//   board time edit <id> [--description "…"] [--project "…"] [--client <lane>] [--start <t>] [--stop <t>]
//                  [--minutes <n> | --hours <h>] [--tag +<t> | --tag -<t>]...
//                  [--billable | --non-billable | --default-billable] [--expect <rev>] [--force]
//   board time move <id> <date> [--expect <rev>] [--force]
//   board time rm <id> [--force]    board time restore <id> [--force]    board time show <id>
//   board time list [--date <d> | --from <d> --to <d>] [--client <lane>] [--project "<p>"] [--tag <t>] [--deleted]
//                  [--not-posted [--system <id>] | --changed-after-post [--system <id>]] [--totals]
//   board time post <id>[@<rev>]... --system <id> [--record <their id>]   entered into a client's system
//   board time post --client <lane> --to <d> [--from <d>] --system <id> [--dry-run]   all before, at once
//   board time unpost <id>[@<rev>]... --system <id>
//   board time day [<d>] [--client <lane>]
//   board time projects [<lane>]
//   board time import <file> --tz <zone> [--map "<Toggl client>=<lane>"]... [--date-format dmy|mdy]
//                  [--dry-run] [--update] [--billable-from-toggl]
//   board time export [--csv] [--date <d> | --from <d> --to <d>] [--client <lane>] [--bom]   CSV of the entries
//   board time [<command>] --help   a command's usage with all its flags (time.usage.<command>), or every one's;
//                  a usage error says the command's usage too
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
  importVerdicts,
  listEntries,
  type Mark,
  marksOf,
  moveEntry,
  type PostItem,
  postEntries,
  removeEntry,
  restoreEntry,
  TimeError,
  unpostEntries,
} from '../adapters/time-store.ts'
import { t } from '../core/lang.ts'
import {
  type Actor,
  addDays,
  billableOf,
  type ClientDay,
  clientDay,
  clientOf,
  clockIn,
  dateIn,
  durationOf,
  durationText,
  entryView,
  hm,
  instantIn,
  isDate,
  knownZone,
  outsideProject,
  parseWhen,
  plausible,
  problemsText,
  projectIn,
  projectKey,
  secondsOf,
  systemsFor,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../core/time.ts'
import { type DateFormat, dayTotals, parseMap, rowsFromCsv, rowsFromJson, type TogglRow } from '../core/time-import.ts'
import type { Config } from '../core/types.ts'
import { withNewProject, writeRefusal } from '../services/time.ts'

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
  '--system',
  '--record',
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

/** The commands, each with its usage (time.usage.<command>). */
const COMMANDS: readonly string[] = [
  'add',
  'edit',
  'move',
  'rm',
  'restore',
  'show',
  'list',
  'day',
  'post',
  'unpost',
  'projects',
  'import',
  'export',
]

/** The generic usage: a command's own takes its place. */
const GENERIC_USAGE = new Set(['time.err.usage', 'time.err.importUsage'])
/** How a command was called, not what it was asked: its usage goes after the error. */
const USAGE_ERRORS = new Set([
  'time.err.flagValue',
  'time.err.noDuration',
  'time.err.noSystem',
  'time.err.billableFlags',
  'time.err.dryRunById',
  'time.err.idsAndRange',
  'time.err.noProject',
  'time.err.noDescription',
  'time.err.whichClient',
])

/** A command's usage: its forms ("board time …"), then a note or two (indented); `notes` false: the forms. */
function usageOf(command: string, notes = true): string[] {
  const lines = t(`time.usage.${command}`).split('\n')
  return notes ? lines : lines.filter(l => !l.startsWith(' '))
}

/** `board time <command> --help`, or every command's forms. */
const helpOf = (command: string | undefined): string[] =>
  command && COMMANDS.includes(command)
    ? [t('time.usage'), ...usageOf(command).map(l => `  ${l}`)]
    : [t('time.usage'), ...COMMANDS.flatMap(c => usageOf(c, false).map(l => `  ${l}`)), t('time.usage.more')]

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** An instant on this computer's clock, as the command takes times: "09:30". */
const clockText = (iso: string): string => {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
/** An entry's start and stop on this computer's clock: "09:00-10:05" (a change of its duration keeps its start). */
const intervalText = (e: TimeEntry): string => `${clockText(e.start)}-${clockText(e.stop)}`

const whoText = (a: Actor): string => (typeof a === 'string' ? t(`time.who.${a}`) : a.name || a.key)

/** Where an entry was entered, as a line says it: "posted erp, tracker (changed after: tracker)". */
function postsText(e: TimeEntry, marks: readonly Mark[]): string {
  if (!marks.length) return ''
  const stale = marks.filter(m => m.rev < e.rev).map(m => m.system)
  return ` · ${t('time.cli.posted', { systems: marks.map(m => m.system).join(', ') })}${stale.length ? ` (${t('time.cli.changedAfter')}: ${stale.join(', ')})` : ''}`
}

/** An entry in a line; `interval`: its start and stop after its duration, as a change of it says. */
function entryLine(
  e: TimeEntry,
  conf: TimeConfig,
  marks: readonly Mark[] = [],
  o: { interval?: boolean } = {},
): string {
  return `${e.id} · ${e.date} · ${e.client}/${e.project} · ${hm(secondsOf(e))}${o.interval ? ` (${intervalText(e)})` : ''} · ${e.description}${e.tags.length ? ` · #${e.tags.join(' #')}` : ''}${billableOf(conf, e) ? '' : ` · ${t('time.cli.nonBillable')}`}${postsText(e, marks)}${e.deleted ? ` · ${t('time.cli.removed')}` : ''}`
}

/** An entry as the JSON gives it (core/time.ts entryView: billable, billableDefault, posts). */
const entryJson = (e: TimeEntry, conf: TimeConfig, marks: readonly Mark[] = []) => entryView(conf, e, marks)

/** `<id>` or `<id>@<rev>` (the revision read: refused when the entry changed since). */
function postItem(word: string): PostItem {
  const m = /^([0-9a-f]{8})(?:@(\d+))?$/i.exec(word)
  if (!m) throw new TimeError('time.err.usage')
  return { id: (m[1] as string).toLowerCase(), ...(m[2] !== undefined && { rev: Number(m[2]) }) }
}

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
  if (d.nonBillable.length) lines.push(`  ${t('time.cli.nonBillable')}: ${d.nonBillable.join(', ')}`)
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
  const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  const json = flags.includes('--json')
  // help, whether time is on or not: a command's usage with all its flags, or every command's
  if (flags.includes('--help') || flags.includes('-h') || rest[0] === 'help') {
    const lines = helpOf(rest[0] === 'help' ? rest[1] : rest[0])
    if (json) out(JSON.stringify({ usage: lines.join('\n') }, null, 2))
    else for (const line of lines) out(line)
    return 0
  }
  try {
    await run(rest, ctx, out)
    return 0
  } catch (err) {
    // called wrong: the command's usage goes with the error (the generic usage gives way to it)
    const command = rest[0] ?? 'list'
    const usage =
      err instanceof TimeError &&
      COMMANDS.includes(command) &&
      (GENERIC_USAGE.has(err.key) || USAGE_ERRORS.has(err.key))
        ? helpOf(command)
        : null
    if (usage && err instanceof TimeError)
      err.message = GENERIC_USAGE.has(err.key) ? usage.join('\n') : `${err.message}\n${usage.join('\n')}`
    if (!json) throw err
    out(
      JSON.stringify({
        ok: false,
        error: codeOf(err),
        message: err instanceof Error ? err.message : String(err),
        ...(usage && { usage: usageOf(command).join('\n') }),
      }),
    )
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
  /** --billable, --non-billable, --default-billable (back to the config's): the change; undefined: none. */
  const billableFlag = (): boolean | null | undefined => {
    const set = ['--billable', '--non-billable', '--default-billable'].filter(f => a.has(f))
    if (set.length > 1) throw new TimeError('time.err.billableFlags')
    return set[0] === '--billable' ? true : set[0] === '--non-billable' ? false : set[0] ? null : undefined
  }
  /**
   * An entry entered somewhere, as a change of it is printed: the change is to be made there too;
   * only when it changed (`was`, the entry before: a change that changed nothing asks for none).
   */
  const there = (key: string, was: TimeEntry | null, e: TimeEntry, marks: readonly Mark[] = []): string[] =>
    marks.length && was?.rev !== e.rev ? [t(key, { systems: marks.map(m => m.system).join(', ') })] : []
  /** The marks of entries read from `db`, by entry. */
  const marksFor = (db: BoardDb | null, list: readonly TimeEntry[]): Map<string, Mark[]> =>
    db
      ? marksOf(
          db,
          list.map(e => e.id),
        )
      : new Map()
  /** The entry's day, worked → billed, as durations: not read as the entry's own start and stop. */
  const dayTotal = (db: BoardDb, e: TimeEntry): string => {
    const { day } = dayOf(db, e.client, e.date)
    return t('time.cli.dayTotal', { raw: durationText(day.seconds, t), billed: durationText(day.billedSeconds, t) })
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
      const billable = billableFlag()
      const db = writable()
      try {
        const add = (c: TimeConfig) =>
          addEntry(
            db,
            c,
            {
              client,
              project,
              description,
              tags: a.all('--tag'),
              start: from,
              stop: to,
              startGiven: start !== null,
              newProject: a.has('--new-project'),
              ...(typeof billable === 'boolean' && { billable }),
            },
            ctx.actor,
            now,
          )
        // a new project: the entry and the client's list under config.json's lock
        const r = a.has('--new-project') ? withNewProject(conf, add, x => x.entry) : add(conf)
        const said = !r.existing ? 'ok' : r.reason === 'repeat-window' ? t('time.cli.repeat') : t('time.cli.existing')
        print(
          `${said} · ${r.entry.id} · ${r.entry.client}/${r.entry.project} · ${r.entry.date} · ${hm(secondsOf(r.entry))} (${intervalText(r.entry)}) · ${dayTotal(db, r.entry)}`,
          {
            ...entryJson(r.entry, conf, marksFor(db, [r.entry]).get(r.entry.id)),
            existing: r.existing,
            ...(r.reason && { reason: r.reason }),
          },
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
      const billable = billableFlag()
      const db = writable()
      try {
        const was = getEntry(db, id)
        const edit = (c: TimeConfig) =>
          editEntry(
            db,
            c,
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
              ...(billable !== undefined && { billable }),
            },
            ctx.actor,
            { force, ...(expect !== undefined && { expect }) },
          )
        const e = a.has('--new-project') ? withNewProject(conf, edit, x => x) : edit(conf)
        // entered somewhere already: the change is to be made there too
        const marks = marksFor(db, [e]).get(e.id) ?? []
        print(
          [
            `ok · ${entryLine(e, conf, marks, { interval: true })} · rev ${e.rev} · ${dayTotal(db, e)}`,
            ...there('time.cli.changeThere', was, e, marks),
          ],
          entryJson(e, conf, marks),
        )
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
        const was = getEntry(db, id)
        const e = moveEntry(db, conf, id, date, ctx.actor, { force, ...(expect !== undefined && { expect }) })
        const marks = marksFor(db, [e]).get(e.id)
        print(
          [
            `ok · ${entryLine(e, conf, marks, { interval: true })} · ${e.start} · ${dayTotal(db, e)}`,
            ...there('time.cli.changeThere', was, e, marks),
          ],
          entryJson(e, conf, marks),
        )
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
        const o = { force, ...(expect !== undefined && { expect }) }
        const was = getEntry(db, id)
        const e = sub === 'rm' ? removeEntry(db, id, ctx.actor, o) : restoreEntry(db, id, ctx.actor, o)
        const marks = marksFor(db, [e]).get(e.id)
        // removed, entered somewhere: to be taken out there too; back: to be entered again there
        print(
          [
            `ok · ${entryLine(e, conf, marks)}`,
            ...there(sub === 'rm' ? 'time.cli.removeThere' : 'time.cli.changeThere', was, e, marks),
          ],
          entryJson(e, conf, marks),
        )
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
      const marks = e ? (marksFor(db, [e]).get(e.id) ?? []) : []
      db?.close()
      if (!e) throw new TimeError('time.err.gone', { id })
      print(
        [
          entryLine(e, conf, marks),
          `${e.start} → ${e.stop} · rev ${e.rev} · ${whoText(e.by)} · ${whoText(e.changedBy)}`,
          ...marks.map(
            m =>
              `  ${m.system}${m.record ? ` ${m.record}` : ''} · ${new Date(m.at).toISOString()} · ${whoText(m.by)} · rev ${m.rev}${m.rev < e.rev ? ` · ${t('time.cli.changedAfter')}` : ''}`,
          ),
        ],
        entryJson(e, conf, marks),
      )
      return
    }
    case 'list': {
      const date = a.one('--date')
      const from = a.one('--from') ?? date ?? today
      const to = a.one('--to') ?? date ?? from
      if (!isDate(from) || !isDate(to)) throw new TimeError('time.err.usage')
      const system = a.one('--system')
      const project = a.one('--project')
      const changedAfter = a.has('--changed-after-post')
      if (system !== undefined && !a.has('--not-posted') && !changedAfter) throw new TimeError('time.err.usage')
      if (a.has('--not-posted') && changedAfter) throw new TimeError('time.err.usage')
      const db = readable()
      // changed after entering takes in removed entries: one removed on the board is to be taken out there
      const read = db
        ? listEntries(db, {
            from,
            to,
            client: a.one('--client'),
            tag: a.one('--tag'),
            project,
            deleted: a.has('--deleted') || changedAfter,
          })
        : []
      const marks = marksFor(db, read)
      db?.close()
      const held = (e: TimeEntry) => e.tags.some(tag => conf.excludeTags.includes(tag))
      const list = read.filter(e => {
        const own = marks.get(e.id) ?? []
        // what a billing agent still has to enter: billable, not held, missing a mark in a system
        // its project is entered in (or in the one named)
        if (a.has('--not-posted')) {
          if (e.deleted || held(e) || !billableOf(conf, e)) return false
          const systems = systemsFor(conf, e.client, e.project).map(x => x.id)
          const wanted = system === undefined ? systems : systems.filter(x => x === system)
          return wanted.some(x => !own.some(m => m.system === x))
        }
        // entered, then changed on the board (removed too): to change there too, in the system named;
        // a mark in a system its project is not entered in is none of its own
        if (changedAfter)
          return own.some(
            m => m.rev < e.rev && (system === undefined || m.system === system) && !outsideProject(conf, e, m.system),
          )
        return true
      })
      // the total as a day's would be: removed and held entries out of it
      const counted = list.filter(e => !e.deleted && !held(e))
      const heldCount = list.filter(e => !e.deleted).length - counted.length
      // removed ones listed (--deleted, or changed after entering): counted apart, as the held ones
      const removedCount = list.filter(e => e.deleted).length
      const total = counted.reduce((n, e) => n + secondsOf(e), 0)
      // per project, as the board tells names apart, under the name the client's list has for it
      const projects = new Map<string, { client: string; project: string; count: number; seconds: number }>()
      for (const e of counted) {
        const key = `${e.client}\u0000${projectKey(e.project)}`
        const p = projects.get(key) ?? {
          client: e.client,
          project: projectIn(conf.clients?.[e.client]?.projects ?? [], e.project) ?? e.project,
          count: 0,
          seconds: 0,
        }
        p.count++
        p.seconds += secondsOf(e)
        projects.set(key, p)
      }
      const byProject = [...projects.values()].sort(
        (x, y) => x.client.localeCompare(y.client) || x.project.localeCompare(y.project),
      )
      // a person reads them per project when the list is a client's or a project's (or asked for)
      const perProject =
        (a.one('--client') !== undefined || project !== undefined || a.has('--totals')) && byProject.length > 1
      const entries = list.map(e => entryJson(e, conf, marks.get(e.id)))
      print(
        list.length
          ? [
              ...warn(),
              ...list.map(e => entryLine(e, conf, marks.get(e.id))),
              `${t('time.cli.total', { n: counted.length, total: hm(total) })}${heldCount ? ` · ${t('time.cli.heldCount', { n: heldCount })}` : ''}${removedCount ? ` · ${t('time.cli.removedCount', { n: removedCount })}` : ''}`,
              ...(perProject
                ? byProject.map(
                    p => `  ${p.client}/${p.project} · ${t('time.cli.total', { n: p.count, total: hm(p.seconds) })}`,
                  )
                : []),
            ]
          : [...warn(), t('time.cli.none')],
        // the list as agents read it; with --totals, the list and its totals
        a.has('--totals')
          ? {
              entries,
              total: {
                count: counted.length,
                seconds: total,
                held: heldCount,
                removed: removedCount,
                projects: byProject,
              },
            }
          : entries,
      )
      return
    }
    case 'day': {
      const date = a.words[0] ?? a.one('--date') ?? today
      if (!isDate(date)) throw new TimeError('time.err.usage')
      const db = readable()
      const entries = db ? listEntries(db, { from: date, to: date, client: a.one('--client') }) : []
      const marks = marksFor(db, entries)
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
            .concat(d.nonBillable, d.held)
            .map(id => entryJson(byId.get(id) as TimeEntry, conf, marks.get(id))),
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
    case 'export': {
      const date = a.one('--date')
      const from = a.one('--from') ?? date ?? today
      const to = a.one('--to') ?? date ?? from
      if (!isDate(from) || !isDate(to)) throw new TimeError('time.err.usage')
      const db = readable()
      const list = db ? listEntries(db, { from, to, client: a.one('--client') }) : []
      db?.close()
      // --csv says what it is (the only form there is); --bom for Excel, which reads UTF-8 by it
      out(`${a.has('--bom') ? '\uFEFF' : ''}${csvOf(list)}`)
      return
    }
    case 'post':
    case 'unpost': {
      const system = a.one('--system')
      if (!system) throw new TimeError('time.err.noSystem')
      const bulk = sub === 'post' && !a.words.length && a.one('--to') !== undefined
      if (!bulk && !a.words.length) throw new TimeError('time.err.usage')
      // a post or unpost by id writes: a dry run, or a range, is the switch-over's alone
      if (!bulk && a.has('--dry-run')) throw new TimeError('time.err.dryRunById')
      if (a.words.length && ['--client', '--to', '--from'].some(f => a.one(f) !== undefined))
        throw new TimeError('time.err.idsAndRange')
      let items: PostItem[]
      let dryList: TimeEntry[] = []
      if (bulk) {
        // the switch-over: what was entered before the board took over, all at once: the client's
        // billable entries, live and not held, up to --to (from --from), of projects entered there,
        // not marked there yet
        const client = a.one('--client')
        const to = a.one('--to') as string
        const from = a.one('--from') ?? '0000-01-01'
        if (!client || !isDate(to) || !isDate(from)) throw new TimeError('time.err.usage')
        if (!systemsFor(conf, client).some(x => x.id === system))
          throw new TimeError('time.err.system', {
            client,
            system,
            known:
              systemsFor(conf, client)
                .map(x => x.id)
                .join(', ') || '-',
          })
        const db = readable()
        const read = db ? listEntries(db, { from, to, client }) : []
        const marks = marksFor(db, read)
        db?.close()
        dryList = read.filter(
          e =>
            billableOf(conf, e) &&
            !e.tags.some(tag => conf.excludeTags.includes(tag)) &&
            systemsFor(conf, e.client, e.project).some(x => x.id === system) &&
            !(marks.get(e.id) ?? []).some(m => m.system === system),
        )
        // each with the revision read: one changed since refuses the run, all or none
        items = dryList.map(e => ({ id: e.id, rev: e.rev }))
      } else items = a.words.map(postItem)
      const seconds = (list: readonly TimeEntry[]) => list.reduce((n, e) => n + secondsOf(e), 0)
      if (bulk && a.has('--dry-run')) {
        print(t('time.cli.postDry', { n: dryList.length, total: hm(seconds(dryList)), system }), {
          system,
          dryRun: true,
          count: dryList.length,
          seconds: seconds(dryList),
          entries: dryList.map(e => entryJson(e, conf)),
        })
        return
      }
      const db = writable()
      try {
        const record = a.one('--record')
        // what was written: a mark already as it would be, or none to take off, is no change
        const changed = new Set(
          (sub === 'post'
            ? postEntries(db, conf, items, system, ctx.actor, { ...(record !== undefined && { record }) })
            : unpostEntries(db, conf, items, system, ctx.actor)
          ).map(m => m.entry),
        )
        const after = items.map(i => getEntry(db, i.id)).filter((e): e is TimeEntry => e !== null)
        const done = after.filter(e => changed.has(e.id))
        const marks = marksFor(db, after)
        print(
          [
            ...after.map(e => entryLine(e, conf, marks.get(e.id))),
            t(sub === 'post' ? 'time.cli.postedCount' : 'time.cli.unpostedCount', {
              n: done.length,
              total: hm(seconds(done)),
              system,
            }),
          ],
          {
            system,
            count: done.length,
            seconds: seconds(done),
            entries: after.map(e => entryJson(e, conf, marks.get(e.id))),
          },
        )
      } finally {
        db.close()
      }
      return
    }
    case 'import':
      return importCmd(a, conf, writable, readable, print)
    default:
      throw new TimeError('time.err.usage')
  }
}

/** A CSV field: quoted when it holds a comma, a quote or a line break, its quotes doubled. */
const csvField = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/**
 * A text a person or an agent wrote, as a spreadsheet must not run it: one that starts as a formula
 * would (= + - @, a tab or a line break) gets a ' before it, which the spreadsheet shows as text.
 */
const asText = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)

/**
 * Entries as CSV, a header first: what a spreadsheet or another tool reads. `start` and `stop` are
 * UTC (Z); `date` is the work date in the client's zone; `tags` are joined by ", " (a tag holds no
 * comma); the text columns are kept from running as formulas (asText).
 */
export function csvOf(list: readonly TimeEntry[]): string {
  const rows = [['id', 'date', 'client', 'project', 'description', 'tags', 'start', 'stop', 'hours', 'by']]
  for (const e of list)
    rows.push([
      e.id,
      e.date,
      asText(e.client),
      asText(e.project),
      asText(e.description),
      asText(e.tags.join(', ')),
      e.start,
      e.stop,
      String(Math.round((secondsOf(e) / 3600) * 10000) / 10000),
      asText(typeof e.by === 'string' ? e.by : e.by.name || e.by.key),
    ])
  return rows.map(r => r.map(csvField).join(',')).join('\n')
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
  const fromToggl = a.has('--billable-from-toggl')
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
      // Toggl's Billable only when asked: its free plan says No on every row
      ...(fromToggl && r.billable !== undefined && { billable: r.billable }),
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
  /** Toggl's row as a person finds it there: its day and start in --tz, its description's start, the entry's id. */
  const rowText = (c: ImportChange): string => {
    const at = Date.parse(c.row.start)
    const [h, m] = clockIn(at, tz)
    // cut by what a reader takes for one character (a grapheme): an emoji is never halved
    const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(c.row.description)].map(
      x => x.segment,
    )
    const words = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : c.row.description
    return `${dateIn(at, tz)} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} "${words}"${c.id ? ` · ${c.id}` : ''}`
  }
  /** A row the store has otherwise: changed in Toggl (or on the board) since its import, or made by a session at that start. */
  const changeLines = (key: string, list: readonly ImportChange[]): string[] =>
    list.map(c =>
      c.by === 'import'
        ? t(key, { row: rowText(c), fields: c.fields.join(', ') })
        : t('time.cli.importClash', { row: rowText(c), who: whoText(c.by), fields: c.fields.join(', ') }),
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
    // the file's rows paired with the store as the run pairs them: rows of one start meet together
    const verdicts = importVerdicts(index, conf, entries)
    const fresh = verdicts.filter(v => v.kind === 'new').length
    const already = verdicts.filter(v => v.kind === 'already').length
    const changed = verdicts.flatMap(v => (v.kind === 'changed' ? [changeOf(v)] : []))
    // with Toggl's Billable: how many rows the run would make non-billable, said before it does
    const nonBillable = verdicts.filter(
      v =>
        (v.kind === 'new' && v.entry.billable === false) ||
        // a row that differs is rewritten only with --update, and only an entry the board never changed
        (v.kind === 'changed' &&
          !v.alike &&
          a.has('--update') &&
          v.stored.by === 'import' &&
          v.stored.changedBy === 'import' &&
          v.fields.includes('billable') &&
          v.next.billable === false),
    ).length
    print(
      [
        ...totals(t('time.cli.byWorkDate', { zone: conf.zone }), byWorkDate),
        ...totals(t('time.cli.byTogglDay', { zone: tz }), byTogglDay),
        ...changeLines('time.cli.importChanged', changed),
        ...(fromToggl ? [t('time.cli.importNonBillable', { n: nonBillable })] : []),
        t('time.cli.importDry', {
          n: fresh,
          already,
          changed: changed.length,
          running: running.length,
          bad: bad.length,
        }),
      ],
      { ...summary, dryRun: true, new: fresh, already, changed, ...(fromToggl && { nonBillable }) },
    )
    return
  }
  const db = writable()
  try {
    const projects = new Map<string, string[]>()
    const r = importEntries(db, conf, entries, {
      update: a.has('--update'),
      wrote: e => {
        if (e.project !== '-') projects.set(e.client, [...(projects.get(e.client) ?? []), e.project])
      },
    })
    // the projects of the entries it wrote go into each lane's list, where the lane lists them: a
    // row already there (or one that differs, a project renamed on the board since) brings none back
    const refusals = [...projects].flatMap(([lane, names]) => {
      const added = addTimeProjects(lane, names)
      return added.ok ? [] : [added.error]
    })
    const listNote = refusals.length ? t('time.cli.projectsNotAdded', { error: refusals[0] ?? '' }) : null
    print(
      [
        ...(listNote ? [listNote] : []),
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
      { ...summary, ...r, ...(listNote && { projectsNotAdded: listNote }) },
    )
  } finally {
    db.close()
  }
}
