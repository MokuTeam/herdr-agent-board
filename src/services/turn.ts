// Stop and Send now (#330), from the board: the program's own keys (core/turn-keys.ts) pressed
// into the session's pane through herdr, as the user would in its terminal. Stop interrupts the
// running turn and says whether it took; Send now takes the messages waiting in the queue into the
// running turn at once. Only into a pane that still holds the session, works, and shows its input
// box with nothing over it: a key pressed into a dialog or an overlay would answer that instead.
import { statSync } from 'node:fs'
import { readTail } from '../adapters/claude-home.ts'
import { agentGet, type HerdrAgent, herdr, herdrText } from '../adapters/herdr.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import { t } from '../core/lang.ts'
import type { QueuedPrompt } from '../core/queue.ts'
import { interruptedSince, type TurnAction, turnKeys } from '../core/turn-keys.ts'
import type { Item } from '../core/types.ts'
import type { Deps } from './deps.ts'

/** Reading and typing in the session's pane, and reading its transcript. */
export interface TurnIO {
  agent(): Promise<HerdrAgent | null>
  /** The visible screen with its escapes, for the input box (core/dialogs/input-box.ts). */
  screen(): Promise<string>
  keys(...keys: string[]): Promise<void>
  /** The end of the session's transcript, '' without one. */
  transcript(): string
  /** The user's messages still in the session's queue (core/queue.ts). */
  queued(): QueuedPrompt[]
}

/** `already`: nothing was pressed, there was nothing left to do (the turn had ended, the message gone in). */
export type TurnResult = { ok: true; already?: boolean } | { ok: false; error: string; busy?: boolean }

export interface TurnOptions {
  io: TurnIO
  /** How long a stop may take to show in the transcript or in herdr's status, a sent message to leave the queue. */
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

type TurnItem = Pick<Item, 'agent' | 'session' | 'name' | 'pane' | 'sleeping'>

const TAIL_BYTES = 256 << 10
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Panes the board presses Stop or Send now in: one at a time, as answers and side questions are. A
 * second Esc soon after the first would be Claude Code's double Esc.
 */
const pressing = new Set<string>()

/** `run` while nothing else of this file presses keys in the pane; else refused as busy. */
async function alone(pane: string, name: string, run: () => Promise<TurnResult>): Promise<TurnResult> {
  if (pressing.has(pane)) return { ok: false, busy: true, error: t('turn.err.inFlight', { name }) }
  pressing.add(pane)
  try {
    return await run()
  } finally {
    pressing.delete(pane)
  }
}

/** The pane's io through herdr, the transcript's end from `transcript`, the queue from `queued`. */
export function turnIO(pane: string, transcript: string | null | undefined, queued: () => QueuedPrompt[]): TurnIO {
  return {
    agent: () => agentGet(pane),
    screen: () => herdrText(['agent', 'read', pane, '--source', 'visible', '--ansi'], 10_000),
    keys: async (...keys) => {
      await herdr(['agent', 'send-keys', pane, ...keys], 10_000)
    },
    transcript: () => {
      const st = transcript ? statSync(transcript, { throwIfNoEntry: false }) : undefined
      return transcript && st?.isFile() ? readTail(transcript, st.size, TAIL_BYTES) : ''
    },
    queued,
  }
}

/** Why the board presses nothing for `action` in `item`, or null with the keys it presses. */
function refusal(item: TurnItem, action: TurnAction): { error: string } | { keys: readonly string[] } {
  const name = item.name
  if (item.sleeping) return { error: t('turn.err.asleep', { name }) }
  if (!item.pane) return { error: t('err.noPane') }
  const keys = turnKeys(item, action)
  if (!keys) return { error: t(action === 'stop' ? 'turn.err.unknown' : 'turn.sendNow.err.unknown', { name }) }
  return { keys }
}

const changed = (item: TurnItem): TurnResult => ({ ok: false, error: t('err.sessionChanged', { name: item.name }) })

/**
 * Whether the pane still holds the session and its turn runs: null when it does, `ended` when the
 * turn is over already, else the refusal.
 */
function state(item: TurnItem, agent: HerdrAgent | null): TurnResult | 'ended' | null {
  if (!agent || agent.session !== item.session) return changed(item)
  if (agent.status === 'blocked') return { ok: false, busy: true, error: t('err.blocked', { name: item.name }) }
  return agent.status === 'working' ? null : 'ended'
}

/**
 * Interrupt `item`'s running turn, as Esc does in its terminal: the session and its conversation
 * stay. { ok: true } once Claude Code wrote that the turn was interrupted, or herdr no longer says
 * it works; { ok: true, already } with nothing pressed when the turn was over already; { ok: false }
 * when it was not pressed, or was and the turn went on.
 */
export async function stopTurn(
  deps: Pick<Deps, 'log'>,
  item: TurnItem,
  { io, waitMs = 6000, pollMs = 250, sleep = pause, now = Date.now }: TurnOptions,
): Promise<TurnResult> {
  const name = item.name
  const r = refusal(item, 'stop')
  if ('error' in r) return { ok: false, error: r.error }
  return alone(item.pane ?? '', name, async () => {
    try {
      const before = state(item, await io.agent())
      if (before === 'ended') return { ok: true, already: true }
      if (before) return before
      // Esc over an overlay or a dialog closes that one, and the turn goes on.
      if (inputDraft(await io.screen()) === null)
        return { ok: false, busy: true, error: t('turn.err.covered', { name }) }
      const after = state(item, await io.agent())
      if (after === 'ended') return { ok: true, already: true }
      if (after) return after
      // The transcript's clock is this computer's: Claude Code writes the marker after the key came.
      const pressed = now()
      await io.keys(...r.keys)
      for (const until = pressed + waitMs; ; ) {
        await sleep(pollMs)
        if (interruptedSince(io.transcript(), pressed)) break
        // A message waiting in the queue starts the next turn at once: still working is not yet "did not
        // stop". Over only once herdr says so; a dialog that came up instead is not a stop.
        const agent = await io.agent()
        if (!agent || agent.session !== item.session) return changed(item)
        if (agent.status === 'idle' || agent.status === 'done') break
        if (now() >= until) {
          deps.log(`stop ${name}: still working ${waitMs} ms after ${r.keys.join(' ')}`)
          return { ok: false, error: t('turn.err.still', { name, s: Math.round(waitMs / 1000) }) }
        }
      }
      deps.log(`stop ${name}: stopped in ${now() - pressed} ms`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: t('turn.err.herdr', { name, why: messageOf(err) }) }
    }
  })
}

/**
 * Take the messages waiting in `item`'s queue into its running turn at once, as Claude Code's
 * send-now key does (every waiting one goes, in their order). `text`, when given, is the queued
 * message the user pressed it on: gone from the queue already, nothing is pressed. Over an input
 * box with text in it the key would send that text instead: refused. Pressed, it says whether the
 * message left the queue within `waitMs` (a turn compacting its conversation lets that end first).
 */
export async function sendNow(
  deps: Pick<Deps, 'log'>,
  item: TurnItem,
  text: unknown,
  { io, waitMs = 5000, pollMs = 250, sleep = pause, now = Date.now }: TurnOptions,
): Promise<TurnResult> {
  const name = item.name
  const r = refusal(item, 'sendNow')
  if ('error' in r) return { ok: false, error: r.error }
  const waiting = (): boolean => {
    const queue = io.queued()
    return typeof text === 'string' && text.trim() ? queue.some(m => m.text === text) : queue.length > 0
  }
  return alone(item.pane ?? '', name, async () => {
    try {
      if (!waiting()) return { ok: true, already: true }
      // No turn running: the message starts the next one by itself.
      const before = state(item, await io.agent())
      if (before === 'ended') return { ok: true, already: true }
      if (before) return before
      const draft = inputDraft(await io.screen())
      if (draft === null) return { ok: false, busy: true, error: t('turn.err.covered', { name }) }
      if (draft !== '') return { ok: false, busy: true, error: t('turn.sendNow.err.draft', { name }) }
      const after = state(item, await io.agent())
      if (after === 'ended') return { ok: true, already: true }
      if (after) return after
      if (!waiting()) return { ok: true, already: true }
      const pressed = now()
      await io.keys(...r.keys)
      for (const until = pressed + waitMs; waiting(); await sleep(pollMs))
        if (now() >= until) {
          deps.log(`send now ${name}: still queued ${waitMs} ms after ${r.keys.join(' ')}`)
          return { ok: false, error: t('turn.sendNow.err.still', { name }) }
        }
      deps.log(`send now ${name}: in after ${now() - pressed} ms`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: t('turn.err.herdr', { name, why: messageOf(err) }) }
    }
  })
}
