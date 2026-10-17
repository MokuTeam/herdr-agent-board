// The message box of the open session (models/composer-session.ts): its text kept per session in
// localStorage (board.draft.<session>, models/drafts.ts), the files that go with it
// (useAttachments), and sending it — Enter, or the send button.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import type { Attachment } from '../models/composer.ts'
import { composerSession } from '../models/composer-session.ts'
import { draftBook } from '../models/drafts.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useAttachments } from './useAttachments.ts'
import { useLatest } from './useLatest.ts'
import { useSessionActions } from './useSessionActions.ts'

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
}

// localStorage may be missing or refuse (a private window): the draft book's try/catch takes it.
const drafts = draftBook({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
})

/** `reload`: reads the session's detail again (the reply shows in the conversation). */
export function useComposer(reload: (key: string) => void): ComposerControls {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const attachments = useAttachments()
  const [text, setText] = useState('')
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set())
  // The box's text as of now, for a send or an opening between two draws.
  const typed = useRef(text)
  const latest = useLatest({ board, t, attachments, actions, reload })
  const messageRef = useRef<HTMLTextAreaElement>(null)

  const [session] = useState(() => {
    const show = (value: string) => {
      typed.current = value
      setText(value)
    }
    return composerSession({
      drafts,
      page: () => {
        const { board, t, attachments } = latest.current
        return {
          open: board.ui.open,
          text: typed.current,
          files: attachments.list,
          canMutate: board.canMutate,
          item: key => board.data?.items.find(i => i.key === key),
          t,
        }
      },
      setText: show,
      clearFiles: () => latest.current.attachments.clear(),
      sending: setSending,
      toast: (text, error) => latest.current.board.toast(text, error),
      busy: (key, label) => latest.current.board.dispatch({ type: 'busy', key, label }),
      post: (key, body) => latest.current.actions.act(key, 'message', body),
      reload: key => latest.current.reload(key),
      focus: () => messageRef.current?.focus(),
      later: (run, ms) => void setTimeout(run, ms),
    })
  })

  const { open, opened, compose } = board.ui
  // biome-ignore lint/correctness/useExhaustiveDependencies: an opening is when to take the session's draft, not something it reads
  useLayoutEffect(() => session.opened(open, compose), [open, opened, session])

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
  }
}
