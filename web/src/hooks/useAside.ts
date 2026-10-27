// Side questions to sessions (/btw from the board, services/aside.ts): what was asked of each
// session and how each went, kept beside the page for as long as it is open (never in the
// session's conversation, nor on the server), so the answers stay with their session while the
// panel shows another one. Asking posts the question and waits for the answer; Cancel or Close
// while it waits closes the /btw overlay in the session too.
import { useMemo } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, errorText, postJson } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** One side question and how it went. */
export interface Aside {
  id: number
  key: string
  question: string
  state: 'asking' | 'answered' | 'failed'
  text: string
  error: string
  ms: number
}

/** The questions asked by session key, oldest first. */
export const asides = new Store<ReadonlyMap<string, readonly Aside[]>>(new Map())
const running = new Map<number, AbortController>()
let next = 0

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function change(key: string, update: (list: readonly Aside[]) => readonly Aside[]): void {
  const now = asides.get()
  const list = update(now.get(key) ?? [])
  const map = new Map(now)
  if (list.length) map.set(key, list)
  else map.delete(key)
  asides.set(map)
}

const patch = (id: number, fields: Partial<Aside>) => (list: readonly Aside[]) =>
  list.map(a => (a.id === id ? { ...a, ...fields } : a))

export interface AsideControls {
  /** The questions asked of `key`, oldest first. */
  of(key: string | null): readonly Aside[]
  ask(key: string, question: string): Promise<void>
  /** Close it; one still waiting is cancelled. */
  close(key: string, id: number): void
  /** Ask the same again (a failed one). */
  again(key: string, id: number): void
}

/** Post one question and record how it went. */
async function post(key: string, question: string, t: () => Translator): Promise<void> {
  const id = ++next
  const control = new AbortController()
  running.set(id, control)
  const entry: Aside = { id, key, question, state: 'asking', text: '', error: '', ms: 0 }
  change(key, list => [...list, entry])
  try {
    const res = await postJson(
      `/api/session/${encodeURIComponent(key)}/aside`,
      { question },
      { signal: control.signal },
    )
    const r: unknown = await res.json().catch(() => null)
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
    if (!res.ok || o.ok !== true) throw new ApiError(res.status, o)
    change(
      key,
      patch(id, {
        state: 'answered',
        text: String(o.text ?? ''),
        ms: num(o.ms),
      }),
    )
  } catch (err) {
    if (control.signal.aborted) return
    change(key, patch(id, { state: 'failed', error: errorText(err, t()) || t()('aside.err.none') }))
  } finally {
    running.delete(id)
  }
}

export function useAside(): AsideControls {
  const t = useT()
  const latest = useLatest({ t })
  const all = useStore(asides)
  return useMemo(() => {
    const t = () => latest.current.t
    return {
      of: key => (key ? (all.get(key) ?? []) : []),
      ask: (key, question) => post(key, question, t),
      close(key, id) {
        running.get(id)?.abort()
        running.delete(id)
        change(key, list => list.filter(a => a.id !== id))
      },
      again(key, id) {
        const was = asides
          .get()
          .get(key)
          ?.find(a => a.id === id)
        if (!was) return
        change(key, list => list.filter(a => a.id !== id))
        void post(key, was.question, t)
      },
    }
  }, [all, latest])
}
