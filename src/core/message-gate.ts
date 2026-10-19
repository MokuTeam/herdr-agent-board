// One in-flight message per session. Successful request IDs suppress HTTP replays
// within this server process; this does not make Herdr get/prompt atomic.
import { t } from './lang.ts'

export type GateResult = { ok: boolean; error?: string; [extra: string]: unknown }
export type MessageGate = (
  key: string,
  id: unknown,
  payload: unknown,
  action: () => GateResult | Promise<GateResult>,
) => Promise<GateResult>

type Entry = { token: string; signature: string; promise?: Promise<GateResult>; result?: GateResult }

export function messageGate(): MessageGate {
  const pending = new Map<string, Entry>()
  const completed = new Map<string, Entry>()
  return async (key, id, payload, action) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return { ok: false, error: t('err.msg.id') }
    const token = `${key}:${id}`
    const signature = JSON.stringify(payload)
    const previous = completed.get(token) ?? pending.get(key)
    if (previous) {
      if (previous.token !== token || previous.signature !== signature) return { ok: false, error: t('err.msg.busy') }
      return (previous.result ?? previous.promise) as GateResult | Promise<GateResult>
    }
    const entry: Entry = { token, signature }
    // Install the entry before invoking asynchronous work.
    pending.set(key, entry)
    const promise = Promise.resolve().then(action)
    entry.promise = promise
    try {
      const result = await promise
      if (result.ok) {
        completed.set(token, { ...entry, result })
        if (completed.size > 500) completed.delete(completed.keys().next().value as string)
      }
      return result
    } finally {
      pending.delete(key)
    }
  }
}
