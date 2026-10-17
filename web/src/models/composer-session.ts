// The message box across sessions (web/app.js openSheet, saveDraft, the composer's submit and the
// discard button): the text stays with its session as a draft (models/drafts.ts) through a close,
// a switch to another session or a reload; the files belong to the session they were added for;
// a send goes out once, carries the draft's id, and what was sent leaves the box only if nothing
// new was typed meanwhile. The page's state and effects come in as `deps`.
import type { Item, Translator } from '../../../src/core/types.ts'
import { type Attachment, canSubmit, isUploading, sentText, uploadedPaths } from './composer.ts'
import type { Draft, DraftBook } from './drafts.ts'
import { draftKey } from './sheet.ts'

export type SendResult = { ok: true } | { ok: false; error: string }

export interface ComposerPage {
  /** The open session's key, null once the sheet closed. */
  open: string | null
  /** The box's text. */
  text: string
  files: readonly Attachment[]
  canMutate: boolean
  item(key: string): Item | undefined
  t: Translator
}

export interface ComposerDeps {
  drafts: DraftBook
  /** The page as of now. */
  page(): ComposerPage
  setText(text: string): void
  clearFiles(): void
  /** The sessions with a message on its way changed. */
  sending(keys: ReadonlySet<string>): void
  toast(text: string, error?: boolean): void
  busy(key: string, label: string | null): void
  /** POST /api/session/<key>/message (useSessionActions.act). */
  post(key: string, body: Record<string, unknown>): Promise<SendResult>
  /** The session's detail again: the reply shows in the conversation. */
  reload(key: string): void
  focus(): void
  later(run: () => void, ms: number): void
}

export interface ComposerSession {
  /** The sheet opened `key` (again), or closed (null); `compose`: the box takes the focus. */
  opened(key: string | null, compose: boolean): void
  input(text: string): void
  send(): Promise<void>
  discard(): void
}

/** A message sent: the conversation is read again a little later, with the reply on its way. */
export const RELOAD_AFTER_SEND_MS = 800
/** "Write" opens the sheet, then the box takes the focus. */
export const COMPOSE_FOCUS_MS = 50

export function composerSession(deps: ComposerDeps): ComposerSession {
  const { drafts } = deps
  let draft: Draft | null = null // as last saved
  let identity: string | null = null // the session it is saved under
  let filesFor: string | null = null // the session the files were added for; outlives a close
  let open: string | null = null // the session open as of the last opening
  let onTheirWay: ReadonlySet<string> = new Set()

  function save(text: string): void {
    const key = open && identity
    if (!key || draft?.text === text) return
    draft = drafts.save(key, text)
  }

  function mark(key: string, on: boolean): void {
    const next = new Set(onTheirWay)
    if (on) next.add(key)
    else next.delete(key)
    onTheirWay = next
    deps.sending(next)
  }

  return {
    opened(key, compose) {
      const page = deps.page()
      if (key === null) {
        if (open) save(page.text)
        open = null
        return
      }
      // Files belong to the session they were added for, never to the next one; the same one
      // opened again keeps them.
      if (filesFor !== key && page.files.length) {
        deps.clearFiles()
        deps.toast(page.t('toast.attachDropped'))
      }
      if (open && open !== key) save(page.text)
      filesFor = key
      open = key
      const it = page.item(key)
      identity = draftKey(it) || key
      draft = drafts.read(draftKey(it))
      deps.setText(draft?.text ?? '')
      if (compose) deps.later(deps.focus, COMPOSE_FOCUS_MS)
    },

    input(text) {
      deps.setText(text)
      save(text)
    },

    async send() {
      const page = deps.page()
      const { open: key, t } = page
      const text = page.text.trim()
      const files = uploadedPaths(page.files)
      const sending = !!key && onTheirWay.has(key)
      if (!canSubmit({ canMutate: page.canMutate, key, sending, text, files, uploading: isUploading(page.files) }))
        return
      const it = key ? page.item(key) : undefined
      if (!key || !it) return
      save(page.text)
      draft ??= drafts.save(draftKey(it), page.text)
      const request = draft
      if (!request) return
      mark(key, true)
      if (it.sleeping) deps.busy(key, t('busy.waking'))
      const r = await deps.post(key, { text, files, session: it.session ?? null, requestId: request.id })
      mark(key, false)
      deps.busy(key, null)
      if (!r.ok) return deps.toast(r.error, true)
      drafts.clear(draftKey(it), request.id)
      if (deps.page().open === key && draft?.id === request.id) {
        deps.setText('')
        draft = null
        deps.clearFiles()
      }
      deps.toast(sentText(it.name, files.length, t))
      deps.later(() => {
        if (deps.page().open === key) deps.reload(key)
      }, RELOAD_AFTER_SEND_MS)
    },

    discard() {
      if (open && onTheirWay.has(open)) return
      drafts.clear(identity)
      draft = null
      deps.setText('')
      deps.clearFiles()
      deps.focus()
    },
  }
}
