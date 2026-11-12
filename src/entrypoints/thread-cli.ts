// `board thread …` (#379, docs/design/threads): threads for agents. It reads and writes the board's
// database by itself, so a write is durable the moment it prints ok, with the board running or not;
// the watchers' events go into the schedule, which the board's scheduler delivers. Every write
// prints one line, every command takes --json (an error then is { ok: false, error: <code>,
// message } on stdout, with a non-zero exit). Off unless config.json's `threads` turns it on.
//
//   board thread new [--lane <id>] [--parent <key>] [--to <session>] [--doing] "<title>"
//   board thread post <key> [--status <s>] [--summary "<line>"] [--waiting "<on what>"]
//                           [--file <path>]... [--link <url>]... [--reply <entry>] [--private] ["<text>"]
//   board thread done <key> ["<summary>"]
//   board thread ask <key> "<question for the owner>"
//   board thread set <key> [--title "<t>"] [--assignee <session|none>] [--lane <id>] [--parent <key|none>]
//   board thread show <key> [--last <n>] [--since <n>] [--full]
//   board thread list [--mine | --lane <id> | --all] [--status <s>] [--done]
//   board thread changes [--peek]
//   board thread watch <key> | --lane <id> | --mine  [--what status|asks|all] [--idle] [--wake]
//   board thread unwatch <key> | --lane <id> | --mine
//   board thread link <key> | --base
//   board thread open <key>
//   board thread import <task board file> [--lane <id>]
// <key>: a key (atlas-12), the first 8 characters of an id, or a bare number in the session's lane.
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { type BoardDb, DbError, openDb } from '../adapters/db.ts'
import {
  childrenOf,
  entriesOf,
  entryCount,
  findEntry,
  findThread,
  getThread,
  listThreads,
  mineIds,
  ThreadError,
  watchesOf,
} from '../adapters/work-thread-store.ts'
import { parseTaskFile, TaskFileError } from '../core/thread-import.ts'
import type { Config } from '../core/types.ts'
import {
  isOpen,
  isThreadStatus,
  isWatchWhat,
  LANE,
  LIST_MAX,
  laneTarget,
  listLine,
  MINE,
  type Party,
  partyName,
  SHOW_LAST,
  showText,
  type ThreadHead,
  type ThreadsConfig,
  threadLink,
  threadsConfig,
  type Watch,
  writeLine,
} from '../core/work-threads.ts'
import { importTaskFile } from '../services/thread-import.ts'
import {
  askOwner,
  changesFor,
  type EventSchedule,
  filePath,
  newThread,
  postEntry,
  setFields,
  type ThreadsCtx,
  unwatch,
  type Written,
  watch,
} from '../services/work-threads.ts'

export const THREAD_USAGE = `board thread new [--lane <id>] [--parent <key>] [--to <session>] [--doing] "<title>"
board thread post <key> [--status next|doing|waiting|owner|done|dropped] [--summary "<line>"] [--waiting "<on what>"]
                        [--file <path>]... [--link <url>]... [--reply <entry>] [--private] ["<text>"]
board thread done <key> ["<summary>"] [--file <path>]... [--link <url>]...
board thread ask <key> "<question for the owner>"
board thread set <key> [--title "<t>"] [--assignee <session|none>] [--lane <id>] [--parent <key|none>]
board thread show <key> [--last <n>] [--since <n>] [--full]
board thread list [--mine | --lane <id> | --all] [--status <s>] [--done]
board thread changes [--peek] [--all]
board thread watch <key> | --lane <id> | --mine  [--what status|asks|all] [--idle] [--wake]
board thread unwatch <key> | --lane <id> | --mine
board thread link <key> | --base
board thread open <key>
board thread import <task board file> [--lane <id>]
  <key>: a key (atlas-12), the first 8 characters of an id, or a bare number in your lane. Every
  command takes --json. A thread's creator hears of its status changes, its assignee of the owner's
  answers: one line, "[board reminder from threads] atlas-13 done: <summary>", never its own changes.`

/** The flags each command takes: with a value, and bare. `--json` and `--help` go with every one. */
const FLAGS: Record<string, { values: readonly string[]; bare: readonly string[] }> = {
  new: { values: ['--lane', '--parent', '--to'], bare: ['--doing'] },
  post: { values: ['--status', '--summary', '--waiting', '--file', '--link', '--reply'], bare: ['--private'] },
  done: { values: ['--summary', '--file', '--link', '--reply'], bare: ['--private'] },
  ask: { values: [], bare: [] },
  set: { values: ['--title', '--assignee', '--lane', '--parent'], bare: [] },
  show: { values: ['--last', '--since'], bare: ['--full'] },
  list: { values: ['--lane', '--status'], bare: ['--mine', '--all', '--done'] },
  changes: { values: [], bare: ['--peek', '--all'] },
  watch: { values: ['--lane', '--what'], bare: ['--mine', '--idle', '--wake'] },
  unwatch: { values: ['--lane'], bare: ['--mine'] },
  link: { values: [], bare: ['--base'] },
  open: { values: [], bare: [] },
  import: { values: ['--lane'], bare: ['--todos'] },
}
const EVERY = ['--json', '--help']

class Usage extends ThreadError {
  constructor(message: string) {
    super('usage', message)
  }
}

interface Args {
  words: string[]
  one(flag: string): string | undefined
  all(flag: string): string[]
  has(flag: string): boolean
}

/**
 * The words and flags of `board thread <sub> …`. A flag the command does not take is refused, so a
 * mistyped one never turns into text; text that starts with `--` goes after a lone `--`.
 */
export function parseArgs(sub: string, rest: readonly string[]): Args {
  const known = FLAGS[sub] ?? { values: [], bare: [] }
  const words: string[] = []
  const values = new Map<string, string[]>()
  const bare = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--') {
      words.push(...rest.slice(i + 1))
      break
    }
    if (known.values.includes(a)) {
      const v = rest[i + 1]
      if (v === undefined) throw new Usage(`${a} needs a value`)
      values.set(a, [...(values.get(a) ?? []), v])
      i++
    } else if (known.bare.includes(a) || EVERY.includes(a)) bare.add(a)
    else if (a.startsWith('--') && FLAGS[sub])
      throw new Usage(`board thread ${sub} does not take ${a} (put -- before text that starts with --)`)
    else words.push(a)
  }
  return { words, one: f => values.get(f)?.at(-1), all: f => values.get(f) ?? [], has: f => bare.has(f) }
}

export interface ThreadCmdContext {
  cfg: Pick<Config, 'threads' | 'port'>
  /** Who runs it: the session (its card key and name), or the owner outside one. */
  actor: Party
  /** The session's lane (its card's category, else the folder's), null outside one. */
  lane: string | null
  /** A session on the board by its name, pane or key, for --to and --assignee; null when none is. */
  findSession: (word: string) => Promise<Party | null>
  /** A session on the board by its key alone (an imported item's owner_id); null when none has it. */
  sessionByKey?: (key: string) => Promise<Party | null>
  /** Puts the question on the session's card, as `board ask` does. */
  setAsk?: (question: string) => void
  /** Raises the board's window; its address, or why not. */
  openBoard?: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>
  /** `--idle`, which the `board` command takes out of the words for every command. */
  idle?: boolean
  out?: (line: string) => void
  /** Where an error goes without --json (stderr). */
  err?: (line: string) => void
  now?: number
  /** The tests' database, schedule and state folder. */
  db?: BoardDb
  schedule?: EventSchedule
  state?: string
}

const intOf = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined
  if (!/^\d{1,9}$/.test(v)) throw new Usage(`${flag} takes a number`)
  return Number(v)
}

/** Runs `board thread <rest>`; the exit code. */
export async function threadCmd(rest: readonly string[], ctx: ThreadCmdContext): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  // --json among the flags; after a lone -- it is text.
  const json = (rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest).includes('--json')
  let db: BoardDb | null = null
  try {
    const [sub = 'help', ...args] = rest
    if (sub === 'help' || sub === '--help' || args.includes('--help')) {
      if (json) out(JSON.stringify({ ok: true, usage: THREAD_USAGE }))
      else out(THREAD_USAGE)
      return 0
    }
    const a = parseArgs(sub, args)
    const base = `http://127.0.0.1:${typeof ctx.cfg.port === 'number' ? ctx.cfg.port : 12422}/`
    const cfg = threadsConfig(ctx.cfg.threads)
    // How MokuPilot finds the board (9.1): its address and whether threads are on, on or off.
    if (sub === 'link' && a.has('--base')) {
      const on = !!cfg
      if (json) out(JSON.stringify({ ok: true, url: base, threads: on, agents: !!cfg?.agents }))
      else out(`${base} · threads ${on ? 'on' : 'off'}`)
      return 0
    }
    if (!cfg) throw new ThreadError('off', 'threads are off')
    if (sub === 'share') throw new ThreadError('later', `board thread ${sub} is not built yet on this board`)
    db = ctx.db ?? openDb({ create: true })
    if (!db) throw new ThreadError('db', 'no database')
    const now = ctx.now ?? Date.now()
    // A lane id as categories have them, whatever case config.json wrote it in.
    const lane = ctx.lane ? ctx.lane.toLowerCase() : null
    const run = new Run(db, cfg, { ...ctx, lane }, a, base, now, out, json)
    await run.dispatch(sub)
    return 0
  } catch (err) {
    const code = err instanceof ThreadError ? err.code : err instanceof DbError ? `db_${err.problem}` : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else (ctx.err ?? console.error)(code === 'usage' ? `${message}\n${THREAD_USAGE}` : message)
    return 1
  } finally {
    if (db && !ctx.db) db.close()
  }
}

class Run {
  constructor(
    readonly db: BoardDb,
    readonly cfg: ThreadsConfig,
    readonly ctx: ThreadCmdContext,
    readonly a: Args,
    readonly base: string,
    readonly now: number,
    readonly out: (line: string) => void,
    readonly json: boolean,
  ) {}

  get write(): ThreadsCtx {
    return {
      db: this.db,
      cfg: this.cfg,
      actor: this.ctx.actor,
      now: this.now,
      ...(this.ctx.schedule && { schedule: this.ctx.schedule }),
      ...(this.ctx.state && { state: this.ctx.state }),
    }
  }

  thread(word: string | undefined): ThreadHead {
    if (!word) throw new Usage('which thread? give its key')
    return findThread(this.db, word, this.ctx.lane)
  }

  /** The session running it, for what only a session has (watches, changes). */
  session(): { key: string; name: string } {
    const p = this.ctx.actor
    if (p.kind !== 'session') throw new ThreadError('no_session', 'run it from a session, or pass --session')
    return { key: p.key, name: p.name }
  }

  async party(word: string, flag: string): Promise<Party | null> {
    if (word.toLowerCase() === 'none') return null
    const p = await this.ctx.findSession(word)
    if (!p) throw new ThreadError('no_session', `${flag}: no session "${word}" on the board`)
    return p
  }

  /** A write's one line, or its JSON. */
  wrote(w: Written, extra: string[] = []): void {
    if (this.json)
      this.out(JSON.stringify({ ok: true, thread: w.head, entry: w.entry, told: w.told.length, untold: w.untold }))
    else
      this.out(
        writeLine(w.head, [
          ...extra,
          ...(w.untold ? [`${w.untold} watching not told: they read board thread changes`] : []),
        ]),
      )
  }

  async dispatch(sub: string): Promise<void> {
    const a = this.a
    switch (sub) {
      case 'new': {
        const title = a.words.join(' ')
        if (!title.trim()) throw new Usage('usage: board thread new [--lane <id>] "<title>"')
        const lane = a.one('--lane') ?? this.ctx.lane
        if (!lane)
          throw new ThreadError('no_lane', 'this session has no lane: board cat <id> first, or give --lane <id>')
        const parentWord = a.one('--parent')
        const parent = parentWord ? this.thread(parentWord) : null
        const toWord = a.one('--to')
        const to = toWord ? await this.party(toWord, '--to') : null
        const w = newThread(this.write, { lane, title, parent, to, doing: a.has('--doing') })
        return this.wrote(w, w.head.assignee ? [partyName(w.head.assignee)] : [])
      }
      case 'post':
      case 'done': {
        const [key, ...words] = a.words
        const head = this.thread(key)
        const text = words.join(' ')
        const status = sub === 'done' ? 'done' : a.one('--status')
        if (status !== undefined && !isThreadStatus(status))
          throw new Usage(`--status is next, doing, waiting, owner, done or dropped, not "${status}"`)
        const reply = a.one('--reply')
        const files = a.all('--file')
        // done's words are its summary, unless --summary gives one: then they are a note.
        const summary = sub === 'done' && a.one('--summary') === undefined && text ? text : a.one('--summary')
        const note = sub === 'done' && a.one('--summary') === undefined ? '' : text
        const waiting = a.one('--waiting')
        const w = postEntry(this.write, head, {
          text: note,
          ...(status && { status }),
          ...(summary !== undefined && { summary }),
          ...(waiting !== undefined && { waitingOn: waiting }),
          files,
          links: a.all('--link'),
          ...(reply && { replyTo: findEntry(this.db, head.id, reply).id }),
          ...(a.has('--private') && { private: true }),
        })
        const n = w.entry.files?.length ?? 0
        return this.wrote(w, n ? [`${n} ${n === 1 ? 'file' : 'files'}`] : [])
      }
      case 'ask': {
        const [key, ...words] = a.words
        const head = this.thread(key)
        const question = words.join(' ')
        const w = askOwner(this.write, head, question)
        if (this.ctx.actor.kind === 'session') this.ctx.setAsk?.(w.head.waitingOn)
        return this.wrote(w)
      }
      case 'set': {
        const head = this.thread(a.words[0])
        const assignee = a.one('--assignee')
        const parent = a.one('--parent')
        const title = a.one('--title')
        const lane = a.one('--lane')
        const w = setFields(this.write, head, {
          ...(title !== undefined && { title }),
          ...(assignee !== undefined && { assignee: await this.party(assignee, '--assignee') }),
          ...(lane !== undefined && { lane }),
          ...(parent !== undefined && {
            parent: parent.toLowerCase() === 'none' ? null : this.thread(parent),
          }),
        })
        return this.wrote(w, w.head.assignee ? [partyName(w.head.assignee)] : [])
      }
      case 'show':
        return this.show()
      case 'list':
        return this.list()
      case 'changes':
        return this.changes()
      case 'watch':
      case 'unwatch':
        return this.watch(sub === 'watch')
      case 'link': {
        const head = this.thread(a.words[0])
        const url = threadLink(this.base, head.key)
        if (this.json) this.out(JSON.stringify({ ok: true, key: head.key, url }))
        else this.out(url)
        return
      }
      case 'open': {
        const head = this.thread(a.words[0])
        const url = threadLink(this.base, head.key)
        const r = this.ctx.openBoard
          ? await this.ctx.openBoard()
          : { ok: false as const, error: 'cannot open the board' }
        if (this.json) this.out(JSON.stringify({ ok: r.ok, key: head.key, url, ...(!r.ok && { message: r.error }) }))
        else this.out(r.ok ? `ok · ${head.key} · ${url}` : `${r.error} · ${head.key} · ${url}`)
        return
      }
      case 'import':
        return this.importFile()
      default:
        throw new Usage(`no command "board thread ${sub}"`)
    }
  }

  show(): void {
    const head = this.thread(this.a.words[0])
    const full = this.a.has('--full')
    const since = intOf(this.a.one('--since'), '--since')
    const last = intOf(this.a.one('--last'), '--last')
    const entries =
      since !== undefined
        ? entriesOf(this.db, head.id, { since })
        : full && last === undefined
          ? entriesOf(this.db, head.id)
          : entriesOf(this.db, head.id, { last: last ?? SHOW_LAST })
    const total = entryCount(this.db, head.id)
    const kids = childrenOf(this.db, head.id)
    const parent = head.parent ? getThread(this.db, head.parent) : null
    const link = threadLink(this.base, head.key)
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          thread: head,
          link,
          parent: parent?.key ?? null,
          children: kids.map(k => ({ key: k.key, status: k.status, title: k.title })),
          entries: entries.map(e => ({
            ...e,
            ...(e.files && { files: e.files.map(f => ({ ...f, path: filePath(f.ref, this.ctx.state) })) }),
          })),
          earlier: Math.max(0, (entries[0]?.n ?? total + 1) - 1),
        }),
      )
      return
    }
    const first = entries[0]?.n ?? total + 1
    this.out(
      showText(head, entries, {
        now: this.now,
        link,
        parentKey: parent?.key ?? null,
        children: { done: kids.filter(k => k.status === 'done').length, all: kids.length },
        earlier: Math.max(0, first - 1),
        keyOfId: id => getThread(this.db, id)?.key ?? id.slice(0, 8),
        fileAt: f => filePath(f.ref, this.ctx.state),
        full,
      }),
    )
  }

  list(): void {
    const a = this.a
    const status = a.one('--status')
    if (status !== undefined && !isThreadStatus(status))
      throw new Usage(`--status is next, doing, waiting, owner, done or dropped, not "${status}"`)
    const closed = a.has('--done') || (status !== undefined && !isOpen(status))
    const all = a.has('--all')
    let heads: ThreadHead[]
    if (a.has('--mine')) {
      const me = this.session()
      const watched = watchesOf(this.db, me.key)
        .map(w => w.target)
        .filter(t => t !== MINE && !t.startsWith('lane:'))
      const ids = [...new Set([...mineIds(this.db, me.key), ...watched])]
      heads = listThreads(this.db, { ids, closed, ...(status && { status }) })
    } else {
      const lane = a.one('--lane') ?? (all ? undefined : (this.ctx.lane ?? undefined))
      heads = listThreads(this.db, { ...(lane && { lane }), closed, ...(status && { status }) })
    }
    // Open ones first, then the closed ones asked for; the newest change first within each.
    heads.sort((x, y) => Number(!isOpen(x.status)) - Number(!isOpen(y.status)) || y.updatedAt - x.updatedAt)
    const shown = all ? heads : heads.slice(0, LIST_MAX)
    const more = heads.length - shown.length
    if (this.json) {
      this.out(JSON.stringify({ ok: true, threads: shown, more }))
      return
    }
    if (!shown.length) {
      this.out(closed ? 'no threads' : 'no open threads')
      return
    }
    for (const h of shown) this.out(listLine(h))
    if (more > 0) this.out(`and ${more} more (--all)`)
  }

  changes(): void {
    const me = this.session()
    const all = this.a.has('--all')
    // More than a screen: the newest are shown and nothing is marked read, so none is lost.
    const r = changesFor(this.write, me.key, { peek: this.a.has('--peek'), shown: all ? Infinity : LIST_MAX })
    const shown = all ? r.changes : r.changes.slice(0, LIST_MAX)
    const more = r.changes.length - shown.length
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          changes: shown.map(c => ({ thread: c.head, entries: c.entries, status: c.status })),
          more,
          read: r.moved,
          since: r.since,
          rev: r.rev,
        }),
      )
      return
    }
    if (!shown.length) {
      this.out('nothing new since you last asked')
      return
    }
    for (const c of shown) this.out(`${listLine(c.head)} · +${c.entries}`)
    if (more > 0)
      this.out(`and ${more} more: board thread changes --all lists them all; none is marked read until then`)
  }

  /** `import <file>` (#393, 13.1): a task board's items as threads, again and again without doubles. */
  async importFile(): Promise<void> {
    const a = this.a
    if (a.has('--todos'))
      throw new ThreadError('later', 'board thread import --todos comes with the to-do points as threads (#395)')
    const path = a.words[0]
    if (!path || a.words.length > 1) throw new Usage('usage: board thread import <task board file> [--lane <id>]')
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      throw new ThreadError('file', `${path}: no such file`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ThreadError('format', `${path}: not JSON`)
    }
    let file: ReturnType<typeof parseTaskFile>
    try {
      const at = resolve(path)
      file = parseTaskFile(raw, { harness: basename(dirname(at)), session: basename(at).replace(/\.json$/i, '') })
    } catch (err) {
      if (err instanceof TaskFileError) throw new ThreadError('format', `${path}: ${err.message}`)
      throw err
    }
    const lane = a.one('--lane') ?? this.ctx.lane
    if (!lane) throw new ThreadError('no_lane', 'this session has no lane: board cat <id> first, or give --lane <id>')
    // Each owner_id looked up once on the board, before the write.
    const owners = new Map<string, Party>()
    for (const id of new Set(file.items.map(i => i.owner?.id ?? '').filter(Boolean))) {
      const p = await this.ctx.sessionByKey?.(id).catch(() => null)
      if (p) owners.set(id, p)
    }
    const r = importTaskFile(this.write, file, { lane, sessionOf: key => owners.get(key) ?? null })
    const from = `${file.harness}/${file.session.slice(0, 8)}`
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          harness: file.harness,
          session: file.session,
          created: r.created,
          updated: r.updated,
          dropped: r.dropped,
          unchanged: r.unchanged,
          skipped: r.skipped,
          keys: r.keys,
          told: r.told.length,
          untold: r.untold,
        }),
      )
      return
    }
    const parts = [
      ...(r.created.length ? [`${r.created.length} new`] : []),
      ...(r.updated.length ? [`${r.updated.length} updated`] : []),
      ...(r.unchanged ? [`${r.unchanged} unchanged`] : []),
      ...(r.skipped ? [`${r.skipped} skipped`] : []),
      ...(r.untold ? [`${r.untold} watching not told: they read board thread changes`] : []),
    ]
    this.out(['ok', from, ...(parts.length ? parts : ['no items'])].join(' · '))
  }

  watch(on: boolean): void {
    const a = this.a
    const me = this.session()
    const lane = a.one('--lane')
    if (lane !== undefined && !LANE.test(lane.toLowerCase())) throw new Usage(`"${lane}" is not a lane id`)
    const target = a.has('--mine')
      ? MINE
      : lane !== undefined
        ? laneTarget(lane.toLowerCase())
        : a.words[0]
          ? this.thread(a.words[0]).id
          : ''
    if (!target) throw new Usage(`usage: board thread ${on ? 'watch' : 'unwatch'} <key> | --lane <id> | --mine`)
    const named = target === MINE ? 'your threads' : target.startsWith('lane:') ? `lane ${target.slice(5)}` : null
    const label = named ?? getThread(this.db, target)?.key ?? target
    if (!on) {
      const n = unwatch(this.write, me.key, target)
      if (this.json) this.out(JSON.stringify({ ok: true, removed: n }))
      else this.out(n ? `ok · ${label} · not watched` : `${label} was not watched`)
      return
    }
    const what = a.one('--what') ?? 'status'
    if (!isWatchWhat(what)) throw new Usage(`--what is status, asks or all, not "${what}"`)
    const w: Watch = watch(this.write, {
      session: this.ctx.actor,
      target,
      what,
      idle: a.has('--idle') || !!this.ctx.idle,
      wake: a.has('--wake'),
    })
    if (this.json) this.out(JSON.stringify({ ok: true, watch: w }))
    else
      this.out(
        ['ok', label, `watched: ${w.what}`, ...(w.idle ? ['when free'] : []), ...(w.wake ? ['wakes you'] : [])].join(
          ' · ',
        ),
      )
  }
}
