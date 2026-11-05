// The message box of the open session (models/composer-session.ts): its text kept per session in
// localStorage (board.draft.<session>, models/drafts.ts), the files that go with it
// (useAttachments), and sending it — Enter, or the send button. A message sent leaves the box for
// the foot of the thread at once (the outbox: its bubble, Retry and Edit).

import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { SessionDetail } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { Attachment } from '../models/composer.ts'
import { composerSession, type OutboxEntry } from '../models/composer-session.ts'
import type { DetailValue } from '../models/detail-resource.ts'
import { draftBook } from '../models/drafts.ts'
import { quoteDraft } from '../models/todos.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useAttachments } from './useAttachments.ts'
import { useLatest } from './useLatest.ts'
import { useSessionActions } from './useSessionActions.ts'

/** The board's own messages at the foot of the thread (models/composer-session.ts). */
export interface OutboxControls {
  /** The ones the thread of `key` shows now: on their way, taken but not in its transcript yet, or not sent. */
  waiting(key: string | null): readonly OutboxEntry[]
  retry(id: string): void
  edit(id: string): void
  /** Counts their changes: the thread's foot is drawn anew. */
  version: number
  /** Counts the messages that went out to the open session: its thread goes to its foot. */
  foot: number
}

/** No messages of the board's own (a sheet drawn without its composer's state). */
export const NO_OUTBOX: OutboxControls = { waiting: () => [], retry() {}, edit() {}, version: 0, foot: 0 }

export interface ComposerControls {
  text: string
  attachments: readonly Attachment[]
  /** A message to the open session is on its way. */
  sending: boolean
  messageRef: RefObject<HTMLTextAreaElement | null>
  input(text: string): void
  send(): void
  discard(): void
  addFiles(files: readonly File[]): void
  removeFile(id: number): void
  outbox: OutboxControls
}

// localStorage may be missing or refuse (a private window): the draft book's try/catch takes it.
const drafts = draftBook({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
})

/**
 * A task's "To chat" (#202): its point quoted at the top of the session's draft, which its sheet
 * puts in the box as it opens. `session`: the draft's key (models/sheet.ts draftKey).
 */
export function quoteInDraft(session: string | null, text: string): void {
  drafts.save(session, quoteDraft(text, drafts.read(session)?.text ?? ''))
}

/**
 * `reload`: reads the session's detail again (the reply shows in the conversation); `detail`: the
 * sheet's, what a message sent now must come after and what settles the outbox.
 */
export function useComposer(
  reload: (key: string) => void,
  detail: DetailValue<SessionDetail> | null = null,
): ComposerControls {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const attachments = useAttachments()
  const [text, setText] = useState('')
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set())
  const [version, setVersion] = useState(0)
  const [foot, setFoot] = useState(0)
  // The box's text as of now, for a send or an opening between two draws.
  const typed = useRef(text)
  const latest = useLatest({ board, t, attachments, actions, reload, detail })
  const messageRef = useRef<HTMLTextAreaElement>(null)

  const [session] = useState(() => {
    const show = (value: string) => {
      typed.current = value
      setText(value)
    }
    return composerSession({
      drafts,
      page: () => {
        const { board, t, attachments, detail } = latest.current
        const open = board.ui.open
        return {
          open,
          text: typed.current,
          files: attachments.list,
          canMutate: board.canMutate,
          detail: open !== null && detail?.key === open ? detail.data : null,
          item: key => board.data?.items.find(i => i.key === key),
          t,
        }
      },
      setText: show,
      clearFiles: () => latest.current.attachments.clear(),
      releaseFiles: () => latest.current.attachments.release(),
      restoreFiles: files => latest.current.attachments.restore(files),
      revoke: url => URL.revokeObjectURL(url),
      sending: setSending,
      changed: () => setVersion(n => n + 1),
      foot: () => setFoot(n => n + 1),
      toast: (text, error) => latest.current.board.toast(text, error),
      busy: (key, label) => latest.current.board.dispatch({ type: 'busy', key, label }),
      post: (key, body) => latest.current.actions.act(key, 'message', body),
      reload: key => latest.current.reload(key),
      focus: () => messageRef.current?.focus(),
      later: (run, ms) => void setTimeout(run, ms),
      now: () => Date.now(),
    })
  })

  const { open, opened, compose } = board.ui
  // biome-ignore lint/correctness/useExhaustiveDependencies: an opening is when to take the session's draft, not something it reads
  useLayoutEffect(() => session.opened(open, compose), [open, opened, session])
  // The open session's detail as this draw has it.
  const openDetail = open !== null && detail?.key === open ? detail.data : null
  // The open session's thread has some of them now, or they waited long enough: they go for good.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new detail, a change or a redraw is when to look
  useLayoutEffect(() => session.settle(), [session, open, openDetail, version])

  return {
    text,
    attachments: attachments.list,
    sending: !!open && sending.has(open),
    messageRef,
    input: session.input,
    send: () => void session.send(),
    discard: session.discard,
    addFiles: attachments.add,
    removeFile: attachments.remove,
    outbox: {
      waiting: key => session.waiting(key, open, openDetail),
      retry: id => void session.retry(id),
      edit: session.edit,
      version,
      foot,
    },
  }
}
