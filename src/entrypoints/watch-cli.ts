// The board command's side of watches (#486): `board wait "<who/what>" --probe "<command>"` and the
// lines `board schedule` prints for a watch. Only while config.json's `watches` is on does
// entrypoints/cli.ts hand `board wait` here; off, the flags are words of the wait's text, as before.
import { addWatch } from '../adapters/schedule-store.ts'
import { runProbe } from '../adapters/watch-probe.ts'
import { translator } from '../core/i18n/translator.ts'
import type { SessionRef } from '../core/schedule-rules.ts'
import { FIRST_CHECK_MS, outcomeOf, parseWaitProbe, type WatchEntry, watchState } from '../core/watches.ts'
import { span } from '../core/when-format.ts'

const en = translator('en')
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface WaitProbeCtx {
  /** Where the watch is for (cli.ts entryFor): the session, its pane and folder, who set it. */
  entry: { key: string; name: string; pane?: string; cwd?: string; from?: SessionRef }
  /** The words before a `--`, and after it. */
  flagWords: readonly string[]
  after: readonly string[]
  now: number
  /** Puts the card in "waiting" (cli.ts writeCard). */
  setWait: (text: string) => void
  /** The scheduler note when no board runs it (cli.ts schedulerNote). */
  note: () => Promise<string>
  /** Watches of the session before a /clear that this one took over (services/watches.ts takenOver): they end too. */
  alsoEnd?: readonly string[]
  /** The tests' probe. */
  probe?: typeof runProbe
}

/**
 * The probe is run once at once, in the session's folder: exit 1 sets the watch (one per session,
 * the earlier one ends) and puts the card in "waiting"; exit 0 says it is true already and sets
 * nothing; an error refuses, so a broken command is fixed before the turn ends. The scheduler's own
 * first check follows within a minute: it runs in the board's environment, not this one.
 */
export async function waitProbe(ctx: WaitProbeCtx): Promise<string> {
  const parsed = parseWaitProbe(ctx.flagWords, ctx.after)
  if ('error' in parsed)
    throw new Error(
      `${parsed.error}. usage: board wait "<who/what>" --probe "<command>" [--every 10m] [--timeout 20s] [--silence 3d]`,
    )
  const { text, probe } = parsed
  const run = await (ctx.probe ?? runProbe)(probe.cmd, ctx.entry.cwd, probe.timeoutMs)
  const outcome = outcomeOf(run)
  if (outcome.kind === 'error')
    throw new Error(`the probe failed when tried once (${outcome.why}); no watch set, the card unchanged`)
  if (outcome.kind === 'fired')
    return `ok · already true: the probe exited 0${outcome.output ? ` and printed "${outcome.output}"` : ''}; no watch set, the card unchanged`
  const { watch, ended } = addWatch(
    {
      ...ctx.entry,
      text,
      probe,
      next: ctx.now + Math.min(FIRST_CHECK_MS, probe.everyMs),
      by: 'agent',
    },
    ctx.alsoEnd,
  )
  ctx.setWait(text)
  const silence = probe.silenceMs ? `, or after ${span(probe.silenceMs, en)} with nothing` : ''
  const replaced = ended.length ? ` (watch ${ended.map(w => w.id).join(', ')} ended)` : ''
  return `ok · watch ${watch.id}${replaced}: nothing yet (exit 1). The board checks every ${span(probe.everyMs, en)} in ${watch.cwd ?? 'the session folder'}, first within a minute, and wakes this session when the probe exits 0${silence} · waiting: ${text} · stop: board unschedule ${watch.id}${await ctx.note()}`
}

/** A watch's line in `board schedule`: its interval, its state, the whole command. */
export function watchLine(w: WatchEntry, now: number, withSession: boolean, on: boolean): string {
  const parts = [
    w.id,
    `watch every ${span(w.probe.everyMs, en)}`,
    on ? watchState(w, now, en) : 'not checked: watches are off in config.json',
  ]
  if (withSession) parts.push(w.name || w.key)
  if (w.probe.silenceMs)
    parts.push(`tells after ${span(w.probe.silenceMs, en)} of nothing${w.silenceTold ? ' (told)' : ''}`)
  parts.push(`probe: ${w.probe.cmd}`, `waits for: ${clip(w.text)}`)
  return parts.join(' · ')
}
