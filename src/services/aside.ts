// A side question to a session from the board (core/aside.ts says what it is): Claude Code's own
// /btw, typed into the session's pane through herdr, its answer read off the screen, the overlay
// closed again. Nothing goes into the session's conversation: /btw answers apart from it. Only
// where it can be typed safely: a live Claude session, no dialog or overlay open, nothing typed in
// its input box. Otherwise it says why and types nothing; there is no other way it asks.
import { agentGet, type HerdrAgent, herdr, herdrText } from '../adapters/herdr.ts'
import { ASIDE_MAX, btwLine, mergeScroll, readBtw } from '../core/aside.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import { t } from '../core/lang.ts'
import { callable } from '../core/mokupilot.ts'
import type { Item } from '../core/types.ts'
import type { Deps } from './deps.ts'

/** Reading and typing in the session's pane. */
export interface BtwIO {
  agent(): Promise<HerdrAgent | null>
  /** The visible screen with its escapes, for the input box (core/dialogs/input-box.ts). */
  screen(): Promise<string>
  /** The visible screen as plain text, for the overlay. */
  read(): Promise<string>
  keys(...keys: string[]): Promise<void>
  /** Type a line and Enter, as the board sends a message (`agent prompt`). */
  prompt(text: string): Promise<void>
}

/** The pane's io through herdr, as services/actions.ts send() and services/answer.ts use it. */
export function btwIO(pane: string): BtwIO {
  return {
    agent: () => agentGet(pane),
    screen: () => herdrText(['agent', 'read', pane, '--source', 'visible', '--ansi'], 10_000),
    read: () => herdrText(['agent', 'read', pane, '--source', 'visible'], 10_000),
    keys: async (...keys) => {
      await herdr(['agent', 'send-keys', pane, ...keys], 10_000)
    },
    // The line starts with "/btw": no leading dash for herdr to read as an option.
    prompt: async text => {
      await herdr(['agent', 'prompt', pane, text])
    },
  }
}

export type AsideReply = { ok: true; text: string; ms: number } | { ok: false; error: string; busy?: boolean }

export interface AsideOptions {
  /** The page went away or cancelled: the overlay is closed. */
  signal?: AbortSignal
  /** How long an answer may take. */
  timeoutMs?: number
  /** How long the overlay may take to show up once the line is typed. */
  showMs?: number
  /** How often the screen is read. */
  pollMs?: number
  /** How long the overlay may say something other than an answer, unchanged, before that is its error. */
  stopMs?: number
  /** How long reading an answer that is in may take, scrolling down a long one. */
  readMs?: number
  /** How many times Down is pressed at most (each shows three lines more). */
  maxScrolls?: number
  io?: BtwIO
  sleep?: (ms: number) => Promise<void>
}

/** Panes with a side question on the way: one at a time, the overlay holds one. */
const asking = new Set<string>()

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Ask `item` a side question with /btw in its pane: { ok, text, ms } with the answer, or { ok:
 * false, error } with why there is none (busy: the session is occupied, try again later).
 */
export async function askAside(
  deps: Pick<Deps, 'log'>,
  item: Pick<Item, 'agent' | 'session' | 'name' | 'pane' | 'sleeping'>,
  question: unknown,
  {
    signal,
    timeoutMs = 180_000,
    showMs = 10_000,
    pollMs = 400,
    stopMs = 5_000,
    readMs = 60_000,
    maxScrolls = 200,
    io = btwIO(item.pane ?? ''),
    sleep = pause,
  }: AsideOptions = {},
): Promise<AsideReply> {
  const q = String(question ?? '').trim()
  const name = item.name
  const line = btwLine(q)
  if (!q) return { ok: false, error: t('aside.err.empty') }
  // What is typed counts: the question on one line, so an indented paste may fit once collapsed.
  if (line.length - '/btw '.length > ASIDE_MAX) return { ok: false, error: t('aside.err.long', { n: ASIDE_MAX }) }
  if (!callable(item) || !item.session) return { ok: false, error: t('aside.err.notClaude', { name }) }
  // /btw runs in the live session; the board does not wake one to ask it something aside.
  if (item.sleeping) return { ok: false, error: t('aside.err.asleep', { name }) }
  const pane = item.pane
  if (!pane) return { ok: false, error: t('err.noPane') }
  if (asking.has(pane)) return { ok: false, busy: true, error: t('aside.err.already', { name }) }
  asking.add(pane)
  const started = Date.now()
  let typed = false
  const ours = async (): Promise<boolean> => {
    const shown = readBtw(await io.read(), q).state
    return shown !== 'none' && shown !== 'other'
  }
  // Close our overlay, and only ours: a key pressed into anything else would answer it. A second
  // Esc only when the overlay stays up a while after the first: the screen may show it a moment
  // after it closed, and Esc into the session itself stops a running turn.
  const closeOurs = async (): Promise<void> => {
    if (!(await ours())) return
    await io.keys('esc')
    for (let i = 0; i < 3; i++) {
      await sleep(pollMs)
      if (!(await ours())) return
    }
    await io.keys('esc')
  }
  const fail = async (error: string, busy = false): Promise<AsideReply> => {
    if (typed) await closeOurs().catch(() => {})
    deps.log(`aside ${name}: ${error} in ${Date.now() - started} ms`)
    return busy ? { ok: false, busy, error } : { ok: false, error }
  }
  try {
    // As send() checks before it types (services/actions.ts): the same session, no dialog, an
    // empty input box (Enter would send a draft with it), checked again after the screen read.
    const refused = (agent: HerdrAgent | null): { error: string; busy: boolean } | null => {
      if (!agent || agent.session !== item.session) return { error: t('err.sessionChanged', { name }), busy: false }
      if (agent.status === 'blocked') return { error: t('err.blocked', { name }), busy: true }
      return null
    }
    const before = refused(await io.agent())
    if (before) return await fail(before.error, before.busy)
    const draft = inputDraft(await io.screen())
    if (draft === null) return await fail(t('aside.err.covered', { name }), true)
    if (draft !== '') return await fail(t('err.draft', { name }), true)
    const after = refused(await io.agent())
    if (after) return await fail(after.error, after.busy)
    if (signal?.aborted) return await fail(t('aside.err.cancelled'))
    await io.prompt(line)
    typed = true
    // Its overlay shows up at once and answers in a while.
    const deadline = started + timeoutMs
    let shown = readBtw(await io.read(), q)
    for (const showBy = Date.now() + showMs; shown.state === 'none' || shown.state === 'other'; ) {
      if (signal?.aborted) return await fail(t('aside.err.cancelled'))
      if (Date.now() > showBy) return await fail(t('aside.err.noOverlay', { name }))
      await sleep(pollMs)
      shown = readBtw(await io.read(), q)
    }
    // Neither answering nor an answer, and so for a while: /btw failed, and says why on the screen.
    let said = { text: '', at: 0 }
    while (shown.state !== 'answered') {
      if (signal?.aborted) return await fail(t('aside.err.cancelled'))
      if (Date.now() > deadline) return await fail(t('aside.err.timeout', { s: Math.round(timeoutMs / 1000) }))
      if (shown.state === 'stopped') {
        if (shown.text !== said.text) said = { text: shown.text, at: Date.now() }
        else if (Date.now() - said.at >= stopMs)
          return await fail(t('aside.err.failed', { name, why: said.text.slice(0, 300) }))
      } else if (shown.state === 'answering') said = { text: '', at: 0 }
      else return await fail(t('aside.err.lost', { name }))
      await sleep(pollMs)
      shown = readBtw(await io.read(), q)
    }
    // The whole answer: Down (three lines further each time) until nothing more comes into sight,
    // still so a while later (a slow redraw is not the end), within a time of its own.
    let lines = shown.lines
    let window = shown.lines
    const readBy = Date.now() + readMs
    for (let i = 0, end = false; !end; i++) {
      if (signal?.aborted) return await fail(t('aside.err.cancelled'))
      if (i >= maxScrolls || Date.now() > readBy) return await fail(t('aside.err.tooLong', { name }))
      await io.keys('down')
      await sleep(Math.min(pollMs, 150))
      let next = readBtw(await io.read(), q)
      const same = (): boolean => next.state === 'answered' && next.lines.join('\n') === window.join('\n')
      if (same()) {
        await sleep(pollMs)
        next = readBtw(await io.read(), q)
        end = same()
      }
      if (next.state !== 'answered') return await fail(t('aside.err.lost', { name }))
      lines = mergeScroll(lines, next.lines)
      window = next.lines
    }
    await closeOurs()
    const text = lines.join('\n').trim()
    const ms = Date.now() - started
    deps.log(`aside ${name}: answered with /btw in ${ms} ms`)
    return text ? { ok: true, text, ms } : { ok: false, error: t('aside.err.none') }
  } catch (err) {
    return await fail(t('aside.err.herdr', { name, why: messageOf(err) }))
  } finally {
    asking.delete(pane)
  }
}
