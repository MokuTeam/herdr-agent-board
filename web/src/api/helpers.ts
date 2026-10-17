// One helper of a session, as GET /api/session/<key>/helper/<id> answers it
// (src/server/routes/helpers.ts), for the helpers window. The answer is checked before use.
import type { HelperDetail } from '../../../src/core/helpers.ts'
import type { ConversationTurn } from '../../../src/core/transcript.ts'
import type { Translator } from '../../../src/core/types.ts'
import { isHelper, isReply, isTurn, isWorkflowRun } from './client.ts'

export type HelperReply = HelperDetail<ConversationTurn>

export const isHelperReply = (value: unknown): value is HelperReply =>
  isReply(value) &&
  isHelper(value.helper) &&
  (value.workflow === null || isWorkflowRun(value.workflow)) &&
  Array.isArray(value.conversation) &&
  value.conversation.every(isTurn)

/** The helper read, or why not: `gone` when asking again will not change that (a 404). */
export type HelperRead = { ok: true; data: HelperReply } | { ok: false; error: string; gone: boolean }

export async function readHelper(key: string, id: string, t: Translator): Promise<HelperRead> {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(key)}/helper/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    })
    const d: unknown = await res.json().catch(() => null)
    if (res.ok && isHelperReply(d)) return { ok: true, data: d }
    const said = isReply(d) && typeof d.error === 'string' ? d.error : ''
    return { ok: false, error: said || t('err.status', { code: res.status }), gone: res.status === 404 }
  } catch (err) {
    return {
      ok: false,
      error: t('err.offline', { why: err instanceof Error ? err.message : String(err) }),
      gone: false,
    }
  }
}
