// The board's terminal: a session's own pane, or a shell the board opens in the session's folder,
// shown live on the web board and typed into from there. Everything goes through herdr: the
// shell is a herdr tab of its own in the session's workspace (so it can be opened in herdr too),
// the screen is read with `pane read`, keys go with `pane send-keys` and `pane send-text`.
//
// herdr has no output stream, so a pane on show is read again and again: fast right after a key
// or a change, slower while nothing moves. Each read goes out as a line diff (core/terminal/term-model.ts).
//
// What it may type into: the shell this board opened for that session (its pane in
// terminals.json, checked to be still that pane, in its tab, with the terminal it was opened
// with), or the session's own pane once herdr says the same session still runs there, as for a
// message. Nothing it reads or types is logged.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { herdr as realHerdr, herdrText as realHerdrText } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { terminalsFile } from '../adapters/paths.ts'
import { herdrCalls } from '../core/terminal/term-keys.ts'
import { applyDiff, diffLines, type LineDiff } from '../core/terminal/term-model.ts'
import type { Config, Item } from '../core/types.ts'

// How much of a pane goes to the page: the visible screen and the scrollback above it, each
// line at most so long (a minified file cat'ed is megabytes on one line).
export const READ_LINES = 400
export const MAX_LINE = 4000
// Panes that show up in the shell's tab this soon after the board made it came with the tab (a
// plugin's sidebar, say), not from the user: closing the shell closes them with the tab.
const FURNITURE_MS = 10_000
// Keys are typed only while the page still waits for them: a herdr call gets so long, and a
// request older than LATE_MS starts no call more. Together they stay under the page's own limit
// (8 s, hooks/useTerminal.ts): once it gave up on a request, nothing of it is typed any more.
const CALL_MS = 3000
const LATE_MS = 4000

/** The web board's terminal is on unless config.json says otherwise: only a missing setting or true. */
export const terminalOn = (cfg: Config): boolean => cfg.terminal === undefined || cfg.terminal === true

const codeOf = (err: unknown): unknown => (isRecord(err) ? err.code : undefined)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
// Only herdr's own word that the pane is not there: an error that says "not found" in another
// sense (a file, a timeout) must not make the board take a shell that still runs for closed.
const paneGone = (err: unknown): boolean => codeOf(err) === 'pane_not_found'

/** A line cut to MAX_LINE characters, without an escape left half there. */
export function clipLine(line: string): string {
  if (line.length <= MAX_LINE) return line
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape cut in half is what it removes
  return `${line.slice(0, MAX_LINE).replace(/\x1b[^m]*$/, '')}\x1b[0m…`
}

/** The pace of reading a pane: fast after a key or a change, slower while it stays the same. */
export function nextDelay({ now, pokedAt = 0, changedAt = 0 }: { now: number; pokedAt?: number; changedAt?: number }) {
  if (now - pokedAt < 1500 || now - changedAt < 1500) return 120
  if (now - changedAt < 20_000) return 400
  return 1000
}

/** The columns of a pane from its place in herdr's layout (its frame takes two). */
export function paneCols(layout: unknown, pane: string): number | null {
  const panes = isRecord(layout) && Array.isArray(layout.panes) ? layout.panes : []
  const found: unknown = panes.find(p => isRecord(p) && p.pane_id === pane)
  const rect = isRecord(found) ? found.rect : null
  const width = isRecord(rect) ? rect.width : null
  return typeof width === 'number' && width > 4 ? width - 2 : null
}

/** A tab name herdr takes as a value: no control characters, no leading dash, not too long. */
export function tabLabel(name: unknown): string {
  const clean = String(name ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control and direction characters are what it removes
    .replace(/[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/^[\s-]+/, '')
    .trim()
  return [...clean].slice(0, 40).join('') || 'shell'
}

/** A pane that came with the shell's tab, with its terminal. */
interface Furniture {
  pane: string
  terminal?: unknown
  [extra: string]: unknown
}

/** A shell the board opened (terminals.json). Fields it does not know are kept. */
interface ShellRecord {
  pane: string
  tab: string
  workspace: string
  terminal?: unknown
  cwd?: unknown
  at?: unknown
  others: Furniture[]
  [extra: string]: unknown
}

/** What goes to a page watching a pane. */
export type TermMessage =
  | ({ t: 'frame'; cols: number | null } & LineDiff)
  | { t: 'gone' }
  | { t: 'error'; why: string }
  | { t: 'ping' }

export type TermResult = { ok: true; [extra: string]: unknown } | { ok: false; error: string; why?: string }

/** The session as the terminal reads it. */
export type TermItem = Pick<Item, 'key' | 'session' | 'pane' | 'cwd'> & { sleeping?: boolean | undefined }

export type Herdr = (args: string[], timeoutMs?: number) => Promise<unknown>
export type HerdrText = (args: string[], timeoutMs?: number) => Promise<string>

export interface TerminalsOptions {
  /** The herdr CLI (tests pass fakes). */
  herdr?: Herdr
  herdrText?: HerdrText
  /** Where the shells it opened are kept. */
  file?: string
  /** A shell went away by itself: the page's list of them changed. */
  onChange?: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface Terminals {
  openShell(
    item: TermItem,
    label: string,
  ): Promise<{ ok: true; pane: string; cwd: unknown; created: boolean } | { ok: false; error: string; why?: string }>
  closeShell(key: string): Promise<{ ok: true }>
  shellOf(key: string): { pane: string; tab: string; cwd: unknown } | null
  inputPane(item: TermItem, target: string, session: unknown): Promise<{ pane: string } | { error: string }>
  input(pane: string, steps: unknown): Promise<TermResult>
  watch(pane: string, opts: { shell?: boolean; key?: string | null }, send: (msg: TermMessage) => void): () => void
  keys(): string[]
  prune(): Promise<void>
  stopAll(): void
}

/** The panes of a herdr answer that are records. */
const panesOf = (answer: unknown): Record<string, unknown>[] =>
  isRecord(answer) && Array.isArray(answer.panes) ? answer.panes.filter(isRecord) : []

/** The shells a board before this one opened: only entries that look like the board's own. */
function loadShells(file: string): Record<string, ShellRecord> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (!isRecord(raw)) return {}
  const out: Record<string, ShellRecord> = {}
  for (const [key, rec] of Object.entries(raw)) {
    if (!isRecord(rec)) continue
    const { pane, tab, workspace } = rec
    if (typeof pane !== 'string' || !pane || typeof tab !== 'string' || !tab) continue
    if (typeof workspace !== 'string' || !workspace) continue
    const others = Array.isArray(rec.others)
      ? rec.others.filter((o): o is Furniture => isRecord(o) && typeof o.pane === 'string')
      : []
    out[key] = { ...rec, pane, tab, workspace, others }
  }
  return out
}

interface Reader {
  add(send: (msg: TermMessage) => void): () => void
  poke(): void
  end(last?: TermMessage): void
}

/**
 * The terminals of this board process. `herdr` and `herdrText` are the CLI (tests pass fakes),
 * `file` where the shells it opened are kept, so a board that restarts finds them again;
 * `onChange` runs when a shell went away by itself (the page's list of them changed).
 */
export function createTerminals({
  herdr = realHerdr,
  herdrText = realHerdrText,
  file = terminalsFile(),
  onChange = () => {},
  now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
}: TerminalsOptions = {}): Terminals {
  const shells = loadShells(file)
  const readers = new Map<string, Reader>() // pane -> reader
  const queues = new Map<string, Promise<TermResult>>() // pane -> the promise of the input typed last
  const opening = new Map<string, ReturnType<Terminals['openShell']>>() // session key -> the shell being opened
  const age = (rec: ShellRecord | undefined) => now() - Number(rec?.at ?? 0)

  function save(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(shells, null, 2)}\n`)
      renameSync(tmp, file)
    } catch {}
  }

  /** The panes of a tab: [{ pane_id, agent }]. */
  async function tabPanes(workspace: string, tab: string): Promise<Record<string, unknown>[]> {
    return panesOf(await herdr(['pane', 'list', '--workspace', workspace], 8000)).filter(p => p.tab_id === tab)
  }

  /**
   * The panes in the shell's tab that came with it (looked at while it is still new), each with
   * its terminal: a pane id alone could be someone else's after herdr started over.
   */
  async function noteFurniture(rec: ShellRecord): Promise<void> {
    if (age(rec) > FURNITURE_MS) return
    try {
      const seen = (await tabPanes(rec.workspace, rec.tab)).filter(p => p.pane_id !== rec.pane)
      const known = rec.others ?? []
      const added = seen
        .filter(p => typeof p.pane_id === 'string' && !known.some(o => o.pane === p.pane_id))
        .map(p => ({ pane: String(p.pane_id), terminal: p.terminal_id ?? null }))
      if (added.length) {
        rec.others = [...known, ...added]
        save()
      }
    } catch {}
  }

  /** Close the shell's own pane (one already gone is fine). Only for a shell found the same. */
  async function closePane(rec: ShellRecord): Promise<void> {
    try {
      await herdr(['pane', 'close', rec.pane], 8000)
    } catch (err) {
      if (!paneGone(err)) throw err
    }
  }

  /**
   * The shell's tab goes when nothing but what came with it is left there: the same panes with
   * the same terminals. A pane the user added (a split, an agent) keeps it, and so does a tab
   * where a pane of another terminal holds one of those ids (herdr started over).
   */
  async function tidyTab(rec: ShellRecord): Promise<void> {
    try {
      const furniture = (p: Record<string, unknown>) =>
        (rec.others ?? []).some(o => o.pane === p.pane_id && (!o.terminal || o.terminal === p.terminal_id))
      const rest = await tabPanes(rec.workspace, rec.tab)
      if (rest.every(p => p.pane_id !== rec.pane && furniture(p) && !p.agent))
        await herdr(['tab', 'close', rec.tab], 8000)
    } catch {}
  }

  function forget(key: string): void {
    if (!shells[key]) return
    delete shells[key]
    save()
  }

  /**
   * Whether the board's shell is still the one it opened: 'same' (that pane, in its tab, with the
   * terminal it was opened with), 'gone' (no such pane), or 'other' (moved elsewhere, or a pane of
   * that id with another terminal, after herdr started over): not the board's to type into or to
   * close any more.
   */
  async function identity(rec: ShellRecord): Promise<'same' | 'gone' | 'other'> {
    let answer: unknown
    try {
      answer = await herdr(['pane', 'get', rec.pane], 5000)
    } catch (err) {
      if (paneGone(err)) return 'gone'
      throw err
    }
    const pane = isRecord(answer) ? answer.pane : null
    if (!isRecord(pane)) return 'gone'
    return pane.tab_id === rec.tab && (!rec.terminal || pane.terminal_id === rec.terminal) ? 'same' : 'other'
  }
  // When each shell was last found the same, so a burst of keys checks it once.
  const checkedAt = new WeakMap<ShellRecord, number>()

  /**
   * The shell for a session, opened when it has none: a tab in the session's workspace, in its
   * folder, named after it. { ok, pane, cwd, created } or { ok: false, error: <text key>, why }.
   * Asked twice at once (a double click), it opens one.
   */
  function openShell(item: TermItem, label: string): ReturnType<Terminals['openShell']> {
    let pending = opening.get(item.key)
    if (!pending) {
      pending = open(item, tabLabel(label)).finally(() => opening.delete(item.key))
      opening.set(item.key, pending)
    }
    return pending
  }

  async function open(item: TermItem, label: string): ReturnType<Terminals['openShell']> {
    const had = shells[item.key]
    if (had) {
      const state = await identity(had)
      if (state === 'same') return { ok: true, pane: had.pane, cwd: had.cwd, created: false }
      // A pane moved elsewhere is the user's now; the tab the board made goes if nothing but what
      // came with it is left there.
      await tidyTab(had)
      forget(item.key)
    }
    const cwd = String(item.cwd ?? '')
    if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      return { ok: false, error: 'term.err.cwd', why: cwd }
    if (!item.pane) return { ok: false, error: 'err.noPane' }
    const got = await herdr(['pane', 'get', item.pane], 5000)
    const own = isRecord(got) && isRecord(got.pane) ? got.pane.workspace_id : null
    if (typeof own !== 'string' || !own) return { ok: false, error: 'err.noPane' }
    const workspace = own
    const r = await herdr(
      ['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'],
      15_000,
    )
    const root = isRecord(r) && isRecord(r.root_pane) ? r.root_pane : null
    if (!root || typeof root.pane_id !== 'string') throw new Error('herdr tab create: no pane in its answer')
    const tabOf = isRecord(r) && isRecord(r.tab) ? r.tab.tab_id : undefined
    const rec: ShellRecord = {
      pane: root.pane_id,
      tab: String(tabOf ?? root.tab_id),
      terminal: root.terminal_id ?? null,
      workspace,
      cwd,
      at: now(),
      others: [],
    }
    shells[item.key] = rec
    save()
    // A plugin may add its own pane to every new tab a moment later.
    await sleep(700)
    await noteFurniture(rec)
    return { ok: true, pane: rec.pane, cwd, created: true }
  }

  /**
   * Close the board's shell for a session: its pane while it is still the one the board opened,
   * and its tab when nothing else is left there. A pane moved elsewhere, or one of that id with
   * another terminal, is not the board's: it is left alone (only the board's own tab may go).
   */
  async function closeShell(key: string): Promise<{ ok: true }> {
    const rec = shells[key]
    if (!rec) return { ok: true }
    const state = await identity(rec)
    stopReader(rec.pane, { t: 'gone' })
    if (state === 'same') await closePane(rec)
    await tidyTab(rec)
    forget(key)
    return { ok: true }
  }

  /** The tab of the board's shell for a session, to go to it in herdr. */
  const shellOf = (key: string) => {
    const rec = shells[key]
    return rec ? { pane: rec.pane, tab: rec.tab, cwd: rec.cwd } : null
  }

  /**
   * The pane input for `target` may go to: the board's own shell for the session, or the
   * session's pane while the same session runs there. { pane } or { error: <text key> }.
   */
  async function inputPane(
    item: TermItem,
    target: string,
    session: unknown,
  ): Promise<{ pane: string } | { error: string }> {
    if (target === 'shell') {
      const rec = shells[item.key]
      if (!rec) return { error: 'term.err.noShell' }
      // Still the shell the board opened: checked again once a burst of keys has paused.
      if (now() - (checkedAt.get(rec) ?? 0) > 3000) {
        const state = await identity(rec)
        if (state !== 'same') {
          forget(item.key)
          void tidyTab(rec)
          onChange()
          return { error: state === 'gone' ? 'term.err.gone' : 'term.err.noShell' }
        }
        checkedAt.set(rec, now())
      }
      return { pane: rec.pane }
    }
    if (target !== 'agent') return { error: 'term.err.target' }
    if (!item.pane) return { error: 'err.noPane' }
    if (item.sleeping) return { error: 'term.err.asleep' }
    if ((session ?? null) !== (item.session ?? null)) return { error: 'err.sessionChanged' }
    const answer = await herdr(['agent', 'get', item.pane], 5000)
    const agent = isRecord(answer) ? answer.agent : null
    const running = isRecord(agent) && isRecord(agent.agent_session) ? (agent.agent_session.value ?? null) : null
    if (!isRecord(agent) || running !== (item.session ?? null)) return { error: 'err.sessionChanged' }
    return { pane: item.pane }
  }

  /**
   * Type steps into a pane: checked first (core/terminal/term-keys.ts), then sent in order, one
   * request after the other for the same pane. { ok } or { ok: false, error: <text key>, why }.
   */
  function input(pane: string, steps: unknown): Promise<TermResult> {
    const checked = herdrCalls(steps)
    if (checked.error !== undefined) return Promise.resolve({ ok: false, error: 'term.err.input', why: checked.error })
    const { calls } = checked
    const received = now()
    // The first call that fails or comes too late stops the rest: an Enter never lands later on
    // its own, after the page gave up on the keys before it.
    const run = async () => {
      for (const c of calls) {
        if (now() - received > LATE_MS) throw Object.assign(new Error('late'), { code: 'late' })
        if (c.keys) await herdr(['pane', 'send-keys', pane, ...c.keys], CALL_MS)
        else await herdr(['pane', 'send-text', pane, c.text], CALL_MS)
      }
    }
    const next = (queues.get(pane) ?? Promise.resolve()).then(run, run)
    const done: Promise<TermResult> = next.then(
      () => ({ ok: true }),
      // herdr's error code only: a failed call's message can carry the text it was typing.
      err => ({
        ok: false,
        error: paneGone(err) ? 'term.err.gone' : codeOf(err) === 'late' ? 'term.err.late' : 'term.err.herdr',
        why: paneGone(err) ? '' : String(codeOf(err) || 'no answer'),
      }),
    )
    queues.set(pane, done)
    void done.then(() => {
      if (queues.get(pane) === done) queues.delete(pane)
      readers.get(pane)?.poke()
    })
    return done
  }

  // ------------------------------------------------------------ reading a pane for the page

  /**
   * Watch a pane for a page: `send(message)` gets the whole screen first, then line diffs as it
   * changes ({ t: 'frame', drop, keep, lines, cols }), { t: 'gone' } when the pane closed,
   * { t: 'error', why } while herdr does not answer. Returns the stop function.
   */
  function watch(
    pane: string,
    { shell = false, key = null }: { shell?: boolean; key?: string | null },
    send: (msg: TermMessage) => void,
  ): () => void {
    let r = readers.get(pane)
    if (!r) {
      r = reader(pane, { shell, key })
      readers.set(pane, r)
    }
    return r.add(send)
  }

  function stopReader(pane: string, last: TermMessage): void {
    readers.get(pane)?.end(last)
  }

  function reader(pane: string, { shell, key }: { shell: boolean; key: string | null }): Reader {
    const subs = new Set<(msg: TermMessage) => void>()
    let lines: string[] | null = null
    let cols: number | null = null
    let colsAt = 0
    let changedAt = 0
    let pokedAt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let reading = false
    let again = false
    let ended = false
    let failing = '' // why the reads fail, while they do
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let furnished = false

    const broadcast = (msg: TermMessage) => {
      for (const send of subs) {
        try {
          send(msg)
        } catch {}
      }
    }
    const frame = (d: LineDiff = { drop: 0, keep: 0, lines: lines ?? [] }): TermMessage => ({ t: 'frame', ...d, cols })

    async function tick(): Promise<void> {
      timer = null
      if (ended || reading) return
      reading = true
      try {
        const at = now()
        // The screen, and beside it now and then the pane's width (at once: each is a herdr
        // call of its own).
        const wantCols = at - colsAt > 10_000
        if (wantCols) colsAt = at
        const [text, layout] = await Promise.all([
          herdrText(
            ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(READ_LINES), '--ansi'],
            5000,
          ),
          wantCols ? herdr(['pane', 'layout', '--pane', pane], 5000).catch(() => null) : null,
        ])
        if (wantCols) cols = paneCols(isRecord(layout) ? layout.layout : null, pane) ?? cols
        // After a failed read the page is told it works again, even when nothing changed.
        const recovered = failing
        const next = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(clipLine)
        failing = ''
        if (!lines) {
          lines = next
          changedAt = now()
          broadcast(frame())
        } else {
          const d = diffLines(lines, next)
          const same = d.drop === 0 && d.keep === lines.length && !d.lines.length
          if (!same || recovered) {
            lines = applyDiff(lines, d)
            if (!same) changedAt = now()
            broadcast(frame(d))
          }
        }
        // Once more while the tab is new: a plugin's pane may have come after the first look.
        if (shell && key && !furnished && age(shells[key]) > 2000) {
          furnished = true
          noteFurnitureOf(key)
        }
      } catch (err) {
        if (paneGone(err)) {
          reading = false
          const rec = key ? shells[key] : undefined
          if (shell && key && rec?.pane === pane) {
            forget(key)
            // The shell exited (`exit`) or its pane was closed in herdr: there is no pane to
            // close, only its tab to tidy away when nothing else is left there.
            void tidyTab(rec)
            onChange()
          }
          return end({ t: 'gone' })
        }
        if (!failing) broadcast({ t: 'error', why: messageOf(err) })
        failing = messageOf(err)
      }
      reading = false
      schedule(again ? 0 : undefined)
      again = false
    }

    function schedule(delay?: number): void {
      if (ended || timer || !subs.size) return
      timer = setTimeout(() => void tick(), delay ?? nextDelay({ now: now(), pokedAt, changedAt }))
      timer.unref?.()
    }

    function end(last?: TermMessage): void {
      if (ended) return
      ended = true
      if (timer) clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      if (last) broadcast(last)
      subs.clear()
      if (readers.get(pane) === api) readers.delete(pane)
    }

    const api: Reader = {
      add(send) {
        subs.add(send)
        if (lines) send(frame())
        // A page that comes while the reads fail hears so at once, not only at the next change.
        if (failing) send({ t: 'error', why: failing })
        if (!heartbeat) {
          heartbeat = setInterval(() => broadcast({ t: 'ping' }), 15_000)
          heartbeat.unref?.()
        }
        if (subs.size === 1) schedule(0)
        return () => {
          subs.delete(send)
          if (!subs.size) end()
        }
      },
      // Keys went in: read again at once, or right after a read that began before they did.
      poke() {
        pokedAt = now()
        if (reading) {
          again = true
          return
        }
        if (timer) clearTimeout(timer)
        timer = null
        schedule(0)
      },
      end,
    }
    return api
  }

  function noteFurnitureOf(key: string): void {
    const rec = shells[key]
    if (rec && age(rec) <= FURNITURE_MS) void noteFurniture(rec)
  }

  /** The sessions that have a shell from the board, for the page. */
  const keys = () => Object.keys(shells)

  /** Shells whose session left the board stay; a shell that is not there any more is forgotten. */
  async function prune(): Promise<void> {
    for (const [key, rec] of Object.entries(shells)) {
      try {
        const state = await identity(rec)
        if (state === 'same') continue
        forget(key)
        void tidyTab(rec)
      } catch {}
    }
    onChange()
  }

  /** Every pane on show stops being read (the terminal was turned off). */
  function stopAll(): void {
    for (const r of [...readers.values()]) r.end({ t: 'gone' })
  }

  return { openShell, closeShell, shellOf, inputPane, input, watch, keys, prune, stopAll }
}
