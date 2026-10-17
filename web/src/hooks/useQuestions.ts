// The page's question forms (models/question-desk.ts): one desk for every session, so a
// form keeps what was picked on it while the sheet shows another session. The sheet asks it for
// the open session's form; digits 1 to 9 pick on it (useBoardKeys). Answers go through
// useSessionActions (POST /api/session/<key>/answer or /permit with X-Board; the browser's Origin
// is what the server checks).
import { useCallback, useState } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { digitFocus, type FormView, type QuestionDesk, questionDesk } from '../models/question-desk.ts'
import type { DialogDetail } from '../models/questions.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import { useSessionActions } from './useSessionActions.ts'

export interface Questions {
  desk: QuestionDesk
  /** Counts the desk's changes: its form draws again on each. */
  version: Store<number>
  /** The sheet draws `item`: its form, or null when it has none. */
  mount(item: Item, detail: DialogDetail | null): FormView | null
  /** A digit while the sheet or the session's card has the focus; true when it took it. */
  pickOption(e: KeyboardEvent): boolean
}

export function useQuestions(): Questions {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const latest = useLatest({ t, board, actions })
  const [version] = useState(() => new Store(0))
  const [desk] = useState(() =>
    questionDesk({
      now: Date.now,
      clock: () => performance.now(),
      t: () => latest.current.t,
      canMutate: () => latest.current.board.canMutate,
      act: (key, action, body) => latest.current.actions.act(key, action, body),
      toast: (text, error) => latest.current.board.toast(text, error),
      focusSession: key => void latest.current.actions.focusSession(key),
      focus: ({ q, n }) =>
        document
          .querySelector<HTMLElement>(
            n === 'other'
              ? `#sheet-question .qa-input[data-q="${q}"]`
              : `#sheet-question .qa-opt[data-q="${q}"][data-n="${n}"]`,
          )
          ?.focus(),
      changed: () => version.set(version.get() + 1),
    }),
  )
  const mount = useCallback((item: Item, detail: DialogDetail | null) => desk.mount(item, detail), [desk])
  const pickOption = useCallback((e: KeyboardEvent) => desk.key(e, digitFocus(document.activeElement)), [desk])
  return { desk, version, mount, pickOption }
}
