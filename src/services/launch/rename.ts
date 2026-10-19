// Renaming a session in Claude (/rename, what SendMessage, ListAgents and herdr-wake see) and in
// herdr. The board's own name for a card is kept on the card (server); this types into the session.
import { agentGet, herdr, herdrText } from '../../adapters/herdr.ts'
import { inputDraft } from '../../core/dialogs/input-box.ts'
import { t } from '../../core/lang.ts'
import { slugName, uniqueSlug } from '../../core/launch/names.ts'
import type { Item } from '../../core/types.ts'
import { claudeRename, takenNames } from './prompt.ts'

/** `confirmed`: Claude said "Session renamed" (only then does herdr's name follow). */
export type RenameResult = { ok: true; confirmed: boolean } | { ok: false; error: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Rename a session in Claude and its herdr name. Typed into the session, so only into an idle one
 * that is still the same session.
 */
export async function renameSession(item: Item, name: string): Promise<RenameResult> {
  if (item.sleeping) return { ok: false, error: t('rename.err.asleep', { name: item.name }) }
  if (!item.session || !item.pane || item.agent !== 'claude')
    return { ok: false, error: t('rename.err.notClaude', { name: item.name }) }
  const pane = item.pane
  try {
    const agent = await agentGet(pane)
    if (!agent || agent.session !== item.session)
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    // Only a session that waits for input: not mid-turn, not at a dialog, not in a state herdr cannot tell.
    if (agent.status !== 'idle' && agent.status !== 'done')
      return { ok: false, error: t('rename.err.busy', { name: item.name }) }
    // /rename typed after what the user started in the input box would send both; no input box
    // on screen (a picker, a dialog) is no place to type either.
    const draft = inputDraft(
      await herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000),
    )
    if (draft !== '')
      return { ok: false, error: t(draft === null ? 'rename.err.screen' : 'err.draft', { name: item.name }) }
    const confirmed = await claudeRename(pane, name)
    // herdr's name follows only a rename Claude confirmed, so the two do not drift apart.
    if (confirmed) {
      const taken = await takenNames()
      if (agent.name) taken.delete(agent.name)
      const slug = uniqueSlug(slugName(name), taken)
      if (slug !== agent.name) await herdr(['agent', 'rename', pane, slug]).catch(() => {})
    }
    return { ok: true, confirmed }
  } catch (err) {
    return { ok: false, error: t('rename.err.claude', { why: messageOf(err) }) }
  }
}
