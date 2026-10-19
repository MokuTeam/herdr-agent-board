// What the board can do to a session, shared by the terminal board and the web board. Each
// returns { ok: true } or { ok: false, error } with a message for the user.
import { agentGet, herdr, herdrText, paneTerminals, snapshot } from '../adapters/herdr.ts'
import { possibleProfilePanes, provenProfilePanes } from '../adapters/profile-panes.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import { itemProfile } from '../core/item-profile.ts'
import { t } from '../core/lang.ts'
import { mayWake, type ProfileSet, profileLabel } from '../core/profiles.ts'
import type { AgentStatus, Item } from '../core/types.ts'
import { herdrWakeAnswers } from '../integrations/herdr-wake.ts'
import { raiseTerminal } from '../integrations/terminal-window.ts'
import type { Deps } from './deps.ts'

/** `busy` (plus `dialog` or `draft`) says send refused because the session is occupied, not broken. */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; busy?: boolean; dialog?: boolean; draft?: boolean }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Whether the board may have herdr-wake wake a session, by core/profiles.ts mayWake: the board's
 * own profile, or a pane the board opened in the session's profile, as herdr shows it now; never a
 * pane the board opened in another one. `refused`: the profile guard said no (the reason in
 * `error`); without it herdr did not answer the question. `set`: the profiles with the board's own
 * (the CLI asks for a board in another process: its own env may be the session's, not the board's).
 */
export type WakeGuard = { ok: true } | { ok: false; error: string; refused: boolean }

export async function checkWake(
  deps: Deps,
  item: Pick<Item, 'name' | 'pane' | 'profile' | 'profileFolder'>,
  set: ProfileSet = deps.profiles(),
): Promise<WakeGuard> {
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
      return { ok: false, refused: false, error: t('err.wake', { name: item.name, why: messageOf(err) }) }
    }
  }
  if (check.ok) return { ok: true }
  const error = check.pane
    ? t('err.wakePane', { profile: check.pane })
    : t('err.wakeProfile', { profile: check.profile })
  return { ok: false, refused: true, error }
}

/**
 * Wake a session herdr-wake put to sleep (takes 10 to 30 s), only where it resumes in the
 * session's own profile (checkWake). Focus, a message, a reminder and a restart wake through
 * here, so they are refused alike.
 */
export async function wake(deps: Deps, item: Item): Promise<ActionResult> {
  const check = await checkWake(deps, item)
  if (!check.ok) return { ok: false, error: check.error }
  return deps.wake.wake(item)
}

/**
 * Whether herdr-wake answers, which a restart needs: { ok } or { ok: false, why, error }, why the
 * reason as it came (empty when wakeUrl is not set) and error a message for the user.
 */
export async function wakeAnswers(
  deps: Pick<Deps, 'cfg'>,
): Promise<{ ok: true } | { ok: false; why: string; error: string }> {
  const url = deps.cfg.wakeUrl
  if (!url) return { ok: false, why: '', error: t('err.restart.noWake') }
  const r = await herdrWakeAnswers(String(url))
  return r.ok ? r : { ok: false, why: r.why, error: t('err.restart.wakeDown', { url, why: r.why }) }
}

/**
 * Whether a session can be put to sleep now, for a restart: { ok, status } (herdr's status as just
 * read) or { ok: false, why }, why being 'gone' (another session in its pane), 'busy' (herdr or
 * Claude says it works), 'dialog', 'draft' (the user's unsent text in its input box), 'tasks' (its
 * turn is over but a background command or a Monitor still runs: Claude's own registry says
 * `shell`, and herdr-wake keeps such a session up), or herdr's error. The registry is the one of
 * the session's own profile (its Claude home, deps.homes), the folder it reported when no profile
 * has it; a session whose profile is not known at all is not put to sleep (checkWake refuses it),
 * which `profile` says (the archive tells that refusal apart, services/archive.ts).
 */
export async function readyToSleep(
  deps: Deps,
  item: Pick<Item, 'pane' | 'session' | 'profile' | 'profileFolder'>,
): Promise<{ ok: true; status: AgentStatus } | { ok: false; why: string; profile?: true }> {
  const set = deps.profiles()
  const dir = itemProfile(item, set.list)?.dir ?? item.profileFolder
  if (!dir) return { ok: false, why: t('err.wakeProfile', { profile: profileLabel(item, set) }), profile: true }
  try {
    const agent = item.pane ? await agentGet(item.pane) : null
    if (!agent || agent.session !== (item.session ?? null)) return { ok: false, why: 'gone' }
    if (agent.status === 'blocked') return { ok: false, why: 'dialog' }
    if (agent.status === 'working') return { ok: false, why: 'busy' }
    const reg = item.session ? deps.homes.forDir(dir).liveSessions().get(item.session)?.status : undefined
    if (reg === 'busy') return { ok: false, why: 'busy' }
    if (reg === 'shell') return { ok: false, why: 'tasks' }
    const draft = inputDraft(
      await herdrText(['agent', 'read', item.pane ?? '', '--source', 'recent', '--lines', '40', '--ansi'], 10_000),
    )
    if (draft === null) return { ok: false, why: 'dialog' }
    return draft === '' ? { ok: true, status: agent.status } : { ok: false, why: 'draft' }
  } catch (err) {
    return { ok: false, why: t('err.restart.herdr', { why: messageOf(err) }) }
  }
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
