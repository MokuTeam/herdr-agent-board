// What the board can do to a session, shared by the terminal board and the web board. Each
// returns { ok: true } or { ok: false, error } with a message for the user.
import { herdr, herdrText } from './adapters/herdr.ts'
import { t } from './core/lang.ts'
import { inputDraft } from './core/dialogs/input-box.ts'
import { sharedHerdrWake } from './integrations/herdr-wake.ts'
import { raiseTerminal } from './integrations/terminal-window.ts'

/** Wake a session herdr-wake put to sleep (takes 10 to 30 s). */
export const wake = (cfg, item) => sharedHerdrWake(cfg.wakeUrl).wake(item)

/**
 * Put a session to sleep through herdr-wake, as its reaper does after an idle hour: Claude exits,
 * the pane stays as "💤 <name>". Only an idle session; herdr-wake refuses one that works, has
 * background tasks or text in its input box.
 */
export async function sleepSession(cfg, item) {
  if (item.sleeping) return { ok: true }
  if (!item.session || !item.pane) return { ok: false, error: t('err.notClaude', { name: item.name }) }
  if (item.status === 'working' || item.status === 'blocked') return { ok: false, error: t(item.status === 'working' ? 'err.sleepWorking' : 'err.sleepBlocked', { name: item.name }) }
  return sharedHerdrWake(cfg.wakeUrl).sleep(item)
}

/** Focus the session's pane in herdr, waking it first; `raise` also brings the terminal window up. */
export async function focus(cfg, item, { raise = false } = {}) {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.sleeping) {
    const r = await wake(cfg, item)
    if (!r.ok) return r
  }
  try {
    await herdr(['agent', 'focus', item.pane])
  } catch (err) {
    return { ok: false, error: t('err.focus', { name: item.name, why: err.message }) }
  }
  if (raise) raiseTerminal(cfg)
  return { ok: true }
}

/**
 * Type a message into the session's prompt, waking it first. Refused while it waits for a
 * decision; with `free`, also while it works (instead of queueing into its turn); with `draft`,
 * also while the user has unsent text in its input box (the scheduler's guards). Those refusals
 * say `busy`, plus `dialog` or `draft` for those two.
 */
export async function send(cfg, item, text, { free = false, draft: guardDraft = false } = {}) {
  text = String(text ?? '').trim()
  if (!text) return { ok: false, error: t('err.emptyMessage') }
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  const expectedSession = item.session ?? null
  if (item.sleeping) {
    const r = await wake(cfg, item)
    if (!r.ok) return r
  }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    // Recheck after wake too: the pane may now host a different session.
    if (!agent || (agent.agent_session?.value ?? null) !== expectedSession) {
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    }
    if (agent.agent_status === 'blocked') return { ok: false, busy: true, dialog: true, error: t('err.blocked', { name: item.name }) }
    if (free && agent.agent_status === 'working') return { ok: false, busy: true, error: t('err.working', { name: item.name }) }
    if (guardDraft && agent.agent === 'claude') {
      // Typed after what the user started in the input box, Enter would send both.
      const draft = inputDraft(await herdrText(['agent', 'read', item.pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000))
      if (draft !== '') return { ok: false, busy: true, draft: draft !== null, dialog: draft === null, error: t(draft === null ? 'err.blocked' : 'err.draft', { name: item.name }) }
    }
    // This read and prompt are separate CLI calls, not an atomic identity check and send.
    // A leading dash would be read as an option by the herdr CLI.
    await herdr(['agent', 'prompt', item.pane, /^-/.test(text) ? ` ${text}` : text])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('err.send', { name: item.name, why: err.message }) }
  }
}
