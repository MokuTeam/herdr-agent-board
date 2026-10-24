// The Remote access panel's view (GET /api/access, local only) and its changes (POST /api/access
// `{ op, … }`). The board's payload carries only `accessRev`, never the view (Call 28): the view is
// fetched when the panel opens and again whenever that number changes while it is open. A change
// the board refuses is toasted; one it asks to be confirmed (`confirm`), or that needs a password
// (`need`: 'password', the login's; 'sudoPassword', sudo's own), is left to the panel.
import { useEffect, useState } from 'react'
import type { AccessView } from '../../../src/core/access.ts'
import type { TestStep } from '../../../src/core/tunnel.ts'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { isAccessView, isTestStep } from '../models/access.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** One change: the board's answer (a refusal's too, so the caller sees `confirm`); null with no answer. */
export type AccessSend = (op: string, body?: Record<string, unknown>) => Promise<Record<string, unknown> | null>

/** What the panel draws: the view, Test connection's last steps, and whether a test runs. */
export interface AccessNow {
  view: AccessView | null
  steps: TestStep[] | null
  testing: boolean
}

export interface AccessSource {
  now: Store<AccessNow>
  send: AccessSend
  /** The panel open or not, and the payload's accessRev: the view is fetched on opening and on each new revision while open. */
  sync(open: boolean, rev: number): void
}

export interface AccessDeps {
  t(): Translator
  toast(text: string, error?: boolean): void
}

const stepsOf = (reply: Record<string, unknown> | null): TestStep[] | null =>
  Array.isArray(reply?.steps) && reply.steps.every(isTestStep) ? reply.steps : null

/** The view and its changes, without React: useAccess draws from it. */
export function accessSource(deps: AccessDeps): AccessSource {
  const now = new Store<AccessNow>({ view: null, steps: null, testing: false })
  let open = false
  let rev = 0
  // Only the latest fetch's view is drawn: an older one may come back after it.
  let asked = 0

  async function load(): Promise<void> {
    const mine = ++asked
    try {
      const view = await api.get('/api/access', isAccessView, { cache: 'no-store' })
      if (mine === asked) now.set({ ...now.get(), view })
    } catch (err) {
      if (mine === asked) deps.toast(errorText(err, deps.t()), true)
    }
  }

  const send: AccessSend = async (op, body = {}) => {
    const test = op === 'test'
    if (test) now.set({ ...now.get(), steps: null, testing: true })
    let reply: Record<string, unknown> | null
    try {
      reply = await api.post('/api/access', { op, ...body })
    } catch (err) {
      reply = err instanceof ApiError ? err.reply : null
      // A change the board asks to be confirmed, or a password it needs (the login's, sudo's own), is asked by the panel, not toasted.
      if (!reply?.confirm && reply?.need !== 'password' && reply?.need !== 'sudoPassword')
        deps.toast(errorText(err, deps.t()), true)
    }
    if (test) now.set({ ...now.get(), steps: stepsOf(reply), testing: false })
    void load()
    return reply
  }

  return {
    now,
    send,
    sync(nextOpen, nextRev) {
      if (nextOpen && (!open || nextRev !== rev)) void load()
      open = nextOpen
      rev = nextRev
    },
  }
}

/** The panel's view while `open`, and how to change it. */
export function useAccess(open: boolean): {
  view: AccessView | null
  send: AccessSend
  steps: TestStep[] | null
  testing: boolean
} {
  const t = useT()
  const { data, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [source] = useState(() =>
    accessSource({ t: () => latest.current.t, toast: (text, error) => latest.current.toast(text, error) }),
  )
  const { view, steps, testing } = useStore(source.now)
  const rev = data?.accessRev ?? 0
  useEffect(() => source.sync(open, rev), [source, open, rev])
  return { view, send: source.send, steps, testing }
}
