// Renaming a session in Claude (/rename, what SendMessage, ListAgents and herdr-wake see) and in
// herdr. The board's own name for a card is kept on the card (server); this types into the session.
// And renaming the herdr workspace a session is in, which every session there shows.
import { agentGet, herdr, herdrText, snapshot, workspaceRename } from '../../adapters/herdr.ts'
import { inputDraft } from '../../core/dialogs/input-box.ts'
import { t } from '../../core/lang.ts'
import { checkWorkspaceName, NAME_MAX, slugName, uniqueSlug } from '../../core/launch/names.ts'
import type { Item } from '../../core/types.ts'
import { claudeRename, takenNames } from './prompt.ts'

/** `confirmed`: Claude said "Session renamed" (only then does herdr's name follow). */
export type RenameResult = { ok: true; confirmed: boolean } | { ok: false; error: string }

export type WorkspaceRenameResult = { ok: true } | { ok: false; error: string }

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

/**
 * Give the herdr workspace a session is in the name `label`: the workspace its pane is in now, as
 * herdr says. The board's own workspace (`board`; '' when the board has none) keeps its name, and
 * no other one takes that name: the board finds its own by it.
 */
export async function renameWorkspace(item: Item, label: string, board: string): Promise<WorkspaceRenameResult> {
  const name = label.trim()
  const bad = checkWorkspaceName(name)
  if (bad) return { ok: false, error: t(bad, { max: NAME_MAX }) }
  if (board && name === board) return { ok: false, error: t('rename.err.workspaceBoardName', { name }) }
  try {
    const snap = await snapshot()
    const pane = snap.panes.find(p => !!item.pane && p.pane_id === item.pane)
    const workspace = snap.workspaces.find(w => !!pane?.workspace_id && w.workspace_id === pane.workspace_id)
    if (!workspace) return { ok: false, error: t('rename.err.workspaceGone', { name: item.name }) }
    if (board && workspace.label === board) return { ok: false, error: t('rename.err.workspaceBoard', { name: board }) }
    if (workspace.label !== name) await workspaceRename(workspace.workspace_id, name)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('rename.err.workspace', { why: messageOf(err) }) }
  }
}
