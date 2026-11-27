// A successful Herdr prompt RPC admits input. The intended Codex rollout is the submission receipt.
import { type FileHandle, open, stat } from 'node:fs/promises'
import { knobMs, pause } from '../adapters/pacing.ts'
import { cliWakeHerdr } from '../adapters/wake-herdr.ts'
import { CODEX_AGENT, codexUserEcho } from '../core/codex.ts'
import { t } from '../core/lang.ts'
import type { Item } from '../core/types.ts'
import type { ActionResult } from './actions.ts'
import type { Deps } from './deps.ts'

const CONFIRM_MS = 8000
const POLL_MS = 200
const MAX_APPEND = 2 << 20

async function readPart(file: FileHandle, offset: number, size: number): Promise<string> {
  const bytes = Buffer.alloc(size)
  const { bytesRead } = await file.read(bytes, 0, size, offset)
  return bytes.toString('utf8', 0, bytesRead)
}

async function rolloutStart(file: FileHandle, session: string) {
  try {
    const mark = await file.stat()
    if (!mark.isFile()) return null
    const [head] = (await readPart(file, 0, Math.min(mark.size, 64 << 10))).split('\n', 1)
    const meta = JSON.parse(head ?? '')
    return meta.type === 'session_meta' && meta.payload?.id === session ? mark : null
  } catch {
    return null
  }
}

export async function submitCodexReminder(
  deps: Deps,
  item: Item,
  pane: string,
  text: string,
  free: boolean,
): Promise<ActionResult> {
  const session = item.session
  const path = deps.codex.transcriptPath(session ?? null)
  const file = path && session ? await open(path, 'r').catch(() => null) : null
  if (!session || !path || !file) return { ok: false, error: t('err.codexDeliveryUnavailable') }
  try {
    const before = await rolloutStart(file, session)
    if (!before) return { ok: false, error: t('err.codexDeliveryUnavailable') }

    const identity = () => cliWakeHerdr.pane(pane, { verifyCodexResume: true })
    const target = await identity()
    if (!target?.terminal_id || target.agent !== CODEX_AGENT || target.agent_session?.value !== session)
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    if (target.agent_status === 'blocked')
      return { ok: false, busy: true, dialog: true, error: t('err.blocked', { name: item.name }) }
    const status = target.agent_status
    if (status !== 'idle' && status !== 'done' && (free || status !== 'working'))
      return { ok: false, busy: true, error: t('err.working', { name: item.name }) }

    // Even an RPC error can arrive after typing. Confirm from the journal before deciding the outcome.
    await cliWakeHerdr.prompt(pane, text).catch(() => {})
    const unknown = { ok: false, deliveryUnknown: true, error: t('err.codexDeliveryUnknown') } as const
    try {
      const end = Date.now() + knobMs('BOARD_CODEX_DELIVERY_MS', CONFIRM_MS)
      do {
        const live = await identity()
        if (
          live?.terminal_id !== target.terminal_id ||
          live.agent !== CODEX_AGENT ||
          live.agent_session?.value !== session
        )
          return unknown
        const after = await stat(path)
        const size = after.size - before.size
        if (after.dev !== before.dev || after.ino !== before.ino || size < 0 || size > MAX_APPEND) return unknown
        if (size > 0) {
          const appended = await readPart(file, before.size, size)
          if (
            appended
              .split('\n')
              .slice(0, -1)
              .some(line => codexUserEcho(line, text))
          )
            return { ok: true, codexDeliveryConfirmed: true }
        }
        await pause(POLL_MS)
      } while (Date.now() < end)
    } catch {
      // A new rollout, an unreadable pane, or an interrupted read cannot prove non-delivery.
    }
    return unknown
  } finally {
    await file.close().catch(() => {})
  }
}
