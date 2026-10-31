// The Secrets panel's state (components/secrets/SecretsPanel.tsx): the list (GET /api/secrets,
// asked when the panel opens and again after each change it makes), the form, a request on its
// way, the Delete clicked once. A change is a POST /api/secrets `{ op: 'set' | 'rm', … }`; what the
// board refuses is toasted in its own words. The value typed is kept only until the board answered
// the POST that carries it, either way, and is dropped as the panel closes: it is never in the
// list, a toast, or anywhere else the page keeps things.
import { useEffect, useState } from 'react'
import type { SecretMeta, SecretsView } from '../../../src/core/secrets.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { EMPTY_FORM, formOf, isSecretsView, type SecretForm, setBody } from '../models/secrets.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** What the panel draws. */
export interface SecretsNow {
  /** The board's list; null until it answered. */
  view: SecretsView | null
  form: SecretForm
  /** A change on its way: the form and the rows wait. */
  busy: boolean
  /** The secret whose Delete was clicked once (the next click deletes it). */
  sure: string | null
  /** Counts each ask for the value field's focus (Replace). */
  focus: number
}

export interface SecretsActions {
  /** Typed or picked in the form; another scope forgets the place picked before. */
  edit(fields: Partial<SecretForm>): void
  /** The form for replacing `s`: its name and place, the value empty, the focus to the value. */
  replace(s: SecretMeta): void
  /** Delete clicked once (an id), or that taken back (null). */
  arm(id: string | null): void
  /** The form to the board. */
  save(): Promise<void>
  remove(s: SecretMeta): Promise<void>
}

export interface SecretsSource extends SecretsActions {
  now: Store<SecretsNow>
  /** The panel open or not: the list is asked on opening; closing drops the value typed. */
  sync(open: boolean): void
}

export interface SecretsDeps {
  t(): Translator
  toast(text: string, error?: boolean): void
  /** The board's sessions now: a session's name goes with a secret set for it. */
  items(): readonly Item[]
}

/** The panel's state and changes, without React: SecretsPanel draws from it. */
export function secretsSource(deps: SecretsDeps): SecretsSource {
  const now = new Store<SecretsNow>({ view: null, form: EMPTY_FORM, busy: false, sure: null, focus: 0 })
  const put = (fields: Partial<SecretsNow>) => now.set({ ...now.get(), ...fields })
  let open = false
  // Only the latest list asked for is drawn: an older one may come back after it.
  let asked = 0

  async function load(): Promise<void> {
    const mine = ++asked
    try {
      const view = await api.get('/api/secrets', isSecretsView, { cache: 'no-store' })
      if (mine === asked) put({ view })
    } catch (err) {
      if (mine === asked) deps.toast(errorText(err, deps.t()), true)
    }
  }

  /** One change to the board; true when it went through (a refusal is toasted). */
  async function send(body: object): Promise<boolean> {
    try {
      await api.post('/api/secrets', body)
      return true
    } catch (err) {
      deps.toast(errorText(err, deps.t()), true)
      return false
    }
  }

  return {
    now,
    sync(next) {
      if (next && !open) void load()
      // Closed: what was typed as a value, and a Delete clicked once, go.
      if (!next && open) put({ form: { ...now.get().form, value: '' }, sure: null })
      open = next
    },
    edit(fields) {
      const { form } = now.get()
      const next: SecretForm = { ...form, ...fields }
      const moved = fields.scope !== undefined && fields.scope !== form.scope
      if (moved && !('target' in fields)) next.target = null
      // Another place picked: the name kept of the one replaced is not its.
      if ((moved || 'target' in fields) && !('targetName' in fields)) delete next.targetName
      put({ form: next })
    },
    replace(s) {
      put({ form: formOf(s), sure: null, focus: now.get().focus + 1 })
    },
    arm(id) {
      put({ sure: id })
    },
    async save() {
      const { form, busy } = now.get()
      const body = setBody(form, deps.items())
      if (!body || busy) return
      put({ busy: true, sure: null })
      const ok = await send(body)
      // The value goes as soon as the board answered, whatever it said; after a save the name too,
      // the place kept for the next one.
      const after = now.get().form
      put({ busy: false, form: ok ? { ...after, name: '', value: '' } : { ...after, value: '' } })
      if (ok) deps.toast(deps.t()('secrets.saved', { name: body.name }))
      await load()
    },
    async remove(s) {
      if (now.get().busy) return
      put({ busy: true, sure: null })
      const ok = await send({ op: 'rm', id: s.id })
      put({ busy: false })
      if (ok) deps.toast(deps.t()('secrets.deleted', { name: s.name }))
      await load()
    },
  }
}

/** The panel's state while `open`, and its changes. */
export function useSecrets(open: boolean): { now: SecretsNow; source: SecretsSource } {
  const t = useT()
  const { data, toast } = useBoardContext()
  const latest = useLatest({ t, toast, items: data?.items ?? [] })
  const [source] = useState(() =>
    secretsSource({
      t: () => latest.current.t,
      toast: (text, error) => latest.current.toast(text, error),
      items: () => latest.current.items,
    }),
  )
  const now = useStore(source.now)
  useEffect(() => source.sync(open), [source, open])
  // Gone from the page: what was typed goes with it.
  useEffect(() => () => source.sync(false), [source])
  return { now, source }
}
