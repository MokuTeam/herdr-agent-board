// What the board can do to a session, shared by the terminal board and the web board. Each
// returns { ok: true } or { ok: false, error } with a message for the user.
import { agentGet, herdr, herdrText, paneTerminals, snapshot } from '../adapters/herdr.ts'
import { possibleProfilePanes, provenProfilePanes } from '../adapters/profile-panes.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import { t } from '../core/lang.ts'
import { mayWake } from '../core/profiles.ts'
import type { Item } from '../core/types.ts'
import { raiseTerminal } from '../integrations/terminal-window.ts'
import type { Deps } from './deps.ts'

/** `busy` (plus `dialog` or `draft`) says send refused because the session is occupied, not broken. */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; busy?: boolean; dialog?: boolean; draft?: boolean }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Wake a session herdr-wake put to sleep (takes 10 to 30 s), only where it resumes in the
 * session's own profile (core/profiles.ts mayWake): the board's own, or a pane the board opened
 * in the session's profile, as herdr shows it now; never a pane the board opened in another one.
 * Focus, a message and a reminder wake through here, so they are refused alike.
 */
export async function wake(deps: Deps, item: Item): Promise<ActionResult> {
  const set = deps.profiles()
  // The board's records first, without asking herdr: the board's own profile in a pane no record
  // puts in another one wakes with the same herdr calls as before profiles.
  let check = mayWake(item, set, new Map(), item.pane ? possibleProfilePanes(new Map([[item.pane, null]])) : new Map())
  // Not the board's own profile, or a record puts the pane in another one: herdr is asked which
  // terminal each pane holds, as a record vouches only for the terminal the board opened, and
  // stops blocking only once herdr shows the pane holds another one.
  if (!check.ok && item.pane) {
    try {
      const live = paneTerminals(await snapshot())
      check = mayWake(item, set, provenProfilePanes(live), possibleProfilePanes(live))
    } catch (err) {
      return { ok: false, error: t('err.wake', { name: item.name, why: messageOf(err) }) }
    }
  }
  if (!check.ok) {
    const error = check.pane
      ? t('err.wakePane', { profile: check.pane })
      : t('err.wakeProfile', { profile: check.profile })
    return { ok: false, error }
  }
  return deps.wake.wake(item)
}

/**
 * Put a session to sleep through herdr-wake, as its reaper does after an idle hour: Claude exits,
 * the pane stays as "💤 <name>". Only an idle session; herdr-wake refuses one that works, has
 * background tasks or text in its input box.
 */
export async function sleepSession(deps: Deps, item: Item): Promise<ActionResult> {
  if (item.sleeping) return { ok: true }
  if (!item.session || !item.pane) return { ok: false, error: t('err.notClaude', { name: item.name }) }
  if (item.status === 'working' || item.status === 'blocked') {
    return {
      ok: false,
      error: t(item.status === 'working' ? 'err.sleepWorking' : 'err.sleepBlocked', { name: item.name }),
    }
  }
  return deps.wake.sleep(item)
}

/** Focus the session's pane in herdr, waking it first; `raise` also brings the terminal window up. */
export async function focus(
  deps: Deps,
  item: Item,
  { raise = false }: { raise?: boolean } = {},
): Promise<ActionResult> {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.sleeping) {
    const r = await wake(deps, item)
    if (!r.ok) return r
  }
  try {
    await herdr(['agent', 'focus', item.pane])
  } catch (err) {
    return { ok: false, error: t('err.focus', { name: item.name, why: messageOf(err) }) }
  }
  if (raise) raiseTerminal(deps.cfg)
  return { ok: true }
}

/**
 * Type a message into the session's prompt, waking it first. Refused while it waits for a
 * decision; with `free`, also while it works (instead of queueing into its turn); with `draft`,
 * also while the user has unsent text in its input box (the scheduler's guards). Those refusals
 * say `busy`, plus `dialog` or `draft` for those two.
 */
export async function send(
  deps: Deps,
  item: Item,
  message: string,
  { free = false, draft: guardDraft = false }: { free?: boolean; draft?: boolean } = {},
): Promise<ActionResult> {
  const text = String(message ?? '').trim()
  if (!text) return { ok: false, error: t('err.emptyMessage') }
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  const expectedSession = item.session ?? null
  if (item.sleeping) {
    const r = await wake(deps, item)
    if (!r.ok) return r
  }
  try {
    const agent = await agentGet(item.pane)
    // Recheck after wake too: the pane may now host a different session.
    if (!agent || agent.session !== expectedSession) {
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    }
    if (agent.status === 'blocked')
      return { ok: false, busy: true, dialog: true, error: t('err.blocked', { name: item.name }) }
    if (free && agent.status === 'working')
      return { ok: false, busy: true, error: t('err.working', { name: item.name }) }
    if (guardDraft && agent.kind === 'claude') {
      // Typed after what the user started in the input box, Enter would send both.
      const draft = inputDraft(
        await herdrText(['agent', 'read', item.pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000),
      )
      if (draft !== '') {
        return {
          ok: false,
          busy: true,
          draft: draft !== null,
          dialog: draft === null,
          error: t(draft === null ? 'err.blocked' : 'err.draft', { name: item.name }),
        }
      }
    }
    // This read and prompt are separate CLI calls, not an atomic identity check and send.
    // A leading dash would be read as an option by the herdr CLI.
    await herdr(['agent', 'prompt', item.pane, /^-/.test(text) ? ` ${text}` : text])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('err.send', { name: item.name, why: messageOf(err) }) }
  }
}
